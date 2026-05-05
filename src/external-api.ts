/**
 * External HTTP API — webhook input.
 *
 * POST /api/webhook — JSON event from external systems (e.g. Home Assistant).
 *
 * Auth: bearer token. Each token resolves to a v2 user identity (`userId`)
 * and a routing target (`platformId`) via api-tokens.json. Trust comes from
 * the user's `user_roles` row, not the token — there is no "isFromMe" shim.
 * The synthetic 'api' channel adapter (src/channels/api.ts) hands authenticated
 * webhook events to v2's router via `onInbound`, which runs the same identity
 * + access + command gates as every other channel.
 *
 * Body cap: 256 KB (DoS guard).
 *
 * Runs on EXTERNAL_API_PORT (default 3002), bound to EXTERNAL_API_HOST
 * (default 127.0.0.1) — separate from v2's webhook server (which routes
 * /webhook/{adapter} for Chat SDK adapters). The default loopback bind
 * keeps bearer tokens off the LAN clear-text path; opt into a broader
 * bind (`0.0.0.0` or a specific LAN IP) when an external service like
 * Home Assistant needs to POST to this endpoint over the network. TLS
 * still has to be terminated upstream — this server speaks plain HTTP.
 */
import http from 'http';

import type { InboundEvent, InboundMessage } from './channels/adapter.js';
import { log } from './log.js';
import { namespacedPlatformId } from './platform-id.js';
import type { ApiTokenIdentity } from './api-tokens.js';

const WEBHOOK_MAX_BYTES = 256 * 1024;
const API_CHANNEL_TYPE = 'api';

export interface ExternalApiDeps {
  identities: Map<string, ApiTokenIdentity>;
  /** Hand the synthetic message to the channel adapter's setup callback. */
  onInbound: (platformId: string, threadId: string | null, message: InboundMessage) => void | Promise<void>;
  /**
   * Hand a fully-built event to the router. Used when the token declares a
   * `replyTo` so the agent's reply is routed to a different channel than the
   * api inbound origin (which has no return surface). For tokens without
   * `replyTo` the simpler `onInbound` path is used.
   */
  onInboundEvent: (event: InboundEvent) => void | Promise<void>;
}

/**
 * Starts the HTTP server. Resolves once it is bound and listening, so the
 * caller (the 'api' channel adapter's setup) fails fast on port-in-use
 * instead of letting a later async listen-error crash the process.
 */
export function startExternalApi(port: number, host: string, deps: ExternalApiDeps): Promise<http.Server> {
  if (deps.identities.size === 0) {
    log.warn('External API has no registered identities — every request will 401');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const identity = authenticate(req, deps.identities);
    if (!identity) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      // Parse against a constant base so a malformed Host header can't crash
      // the request before the handler's catch can render a 500.
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/api/webhook') {
        await handleWebhook(req, res, identity, deps);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      log.error('External API error', { err });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    const onListenError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onListenError);
      log.info('External API started', { port, host });
      resolve(server);
    };
    server.once('error', onListenError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function authenticate(req: http.IncomingMessage, identities: Map<string, ApiTokenIdentity>): ApiTokenIdentity | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);
  if (!token) return null;
  return identities.get(token) || null;
}

/** Read the request body with a streaming size cap. Returns null on overflow. */
async function readBodyWithLimit(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      req.destroy();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function formatWebhookEvent(data: Record<string, unknown>): string {
  const lines = ['[Webhook Event]'];
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  return lines.join('\n');
}

async function handleWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: ApiTokenIdentity,
  deps: ExternalApiDeps,
): Promise<void> {
  const body = await readBodyWithLimit(req, WEBHOOK_MAX_BYTES);
  if (body === null) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Webhook payload too large (max 256KB)' }));
    return;
  }
  const raw = body.toString('utf-8').trim();

  if (!raw) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Empty body' }));
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  // The endpoint is documented as accepting JSON event objects.
  // Non-objects (null, arrays, primitives) would either crash
  // formatWebhookEvent or render meaninglessly — reject up front.
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Body must be a JSON object' }));
    return;
  }
  const obj = data as Record<string, unknown>;

  const text = formatWebhookEvent(obj);

  // Construct a synthetic message. The senderResolver picks up `senderId`
  // (already namespaced via the token's userId) and upserts the users row;
  // downstream gates use that identity to decide trust. Normalize the
  // platform ID the same way setup-side wiring does so a token with
  // `platformId: "hass-main"` matches a messaging_groups row pre-wired via
  // `namespacedPlatformId('api', 'hass-main')`.
  const platformId = namespacedPlatformId(API_CHANNEL_TYPE, identity.platformId);
  const id = `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();
  const content = {
    text,
    sender: identity.displayName,
    senderId: identity.userId,
  };

  if (identity.replyTo) {
    // Token-declared reply override — route through the full-event path so
    // the router stamps the outbound delivery address from `replyTo` instead
    // of the (dropped-on-deliver) api channel origin.
    await deps.onInboundEvent({
      channelType: API_CHANNEL_TYPE,
      platformId,
      threadId: null,
      message: {
        id,
        kind: 'chat',
        content: JSON.stringify(content),
        timestamp,
        isMention: true,
        isGroup: false,
      },
      replyTo: identity.replyTo,
    });
  } else {
    await deps.onInbound(platformId, null, {
      id,
      kind: 'chat',
      content,
      timestamp,
      isMention: true,
      isGroup: false,
    });
  }

  log.info('External webhook injected', {
    userId: identity.userId,
    platformId: identity.platformId,
    event: obj.event ?? 'unknown',
    replyTo: identity.replyTo ? `${identity.replyTo.channelType}:${identity.replyTo.platformId}` : undefined,
  });

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

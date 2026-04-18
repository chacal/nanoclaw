/**
 * HTTP API for external input — voice, text, and webhook events.
 *
 * POST /voice   — audio file upload → transcribe → inject as message
 * POST /message — text body → inject as message
 * POST /webhook — JSON event from external systems (e.g. Home Assistant)
 *
 * Auth: Bearer token. Each token is bound to an identity (sender,
 * senderName, isFromMe) via ~/.config/nanoclaw/api-tokens.json (see
 * api-tokens.ts). Identity drives how injected messages are treated:
 *   - isFromMe=true  → full owner/admin trust (session-command + remote-control gates pass)
 *   - isFromMe=false → routine sender, subject to sender-allowlist + trigger flow
 *
 * Per-endpoint body caps enforced while streaming:
 *   - /voice   25 MB (OpenAI transcription limit)
 *   - /message  1 MB
 *   - /webhook 256 KB
 */
import http from 'http';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

import { ApiTokenIdentity } from './api-tokens.js';
import { logger } from './logger.js';
import { transcribeAudio } from './transcription.js';
import { NewMessage } from './types.js';

const VOICE_MAX_BYTES = 25 * 1024 * 1024;
const MESSAGE_MAX_BYTES = 1 * 1024 * 1024;
const WEBHOOK_MAX_BYTES = 256 * 1024;

export interface HttpApiDeps {
  onMessage: (chatJid: string, message: NewMessage) => void;
  defaultJid: string;
  identities: Map<string, ApiTokenIdentity>;
}

export function startHttpApi(port: number, deps: HttpApiDeps): http.Server {
  if (deps.identities.size === 0) {
    logger.warn(
      'HTTP API has no registered identities — all requests will 401. Add tokens to ~/.config/nanoclaw/api-tokens.json.',
    );
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type',
    );
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

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const jid = url.searchParams.get('jid') || deps.defaultJid;

    try {
      if (req.method === 'POST' && url.pathname === '/voice') {
        await handleVoice(req, res, jid, identity, deps);
      } else if (req.method === 'POST' && url.pathname === '/message') {
        await handleMessage(req, res, jid, identity, deps);
      } else if (req.method === 'POST' && url.pathname === '/webhook') {
        await handleWebhook(req, res, jid, identity, deps);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      logger.error({ err }, 'HTTP API error');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'HTTP API started');
  });

  return server;
}

function authenticate(
  req: http.IncomingMessage,
  identities: Map<string, ApiTokenIdentity>,
): ApiTokenIdentity | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);
  if (!token) return null;
  return identities.get(token) || null;
}

/**
 * Read the request body with a streaming size cap. Returns the buffer
 * on success or `null` if the body exceeds `maxBytes` (caller then
 * writes 413 and aborts).
 */
async function readBodyWithLimit(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
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
    lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}

async function handleVoice(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jid: string,
  identity: ApiTokenIdentity,
  deps: HttpApiDeps,
): Promise<void> {
  const body = await readBodyWithLimit(req, VOICE_MAX_BYTES);
  if (body === null) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Audio too large (max 25MB)' }));
    return;
  }
  if (body.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Empty audio' }));
    return;
  }

  const contentType = req.headers['content-type'] || 'audio/m4a';
  const tmpFile = path.join(os.tmpdir(), `nanoclaw-voice-${Date.now()}.audio`);
  await fsp.writeFile(tmpFile, body);

  try {
    const transcript = await transcribeAudio(tmpFile, contentType);

    if (!transcript) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Transcription failed' }));
      return;
    }

    deps.onMessage(
      jid,
      buildMessage(jid, identity, `[Voice: ${transcript}]`, 'voice'),
    );

    logger.info(
      { jid, sender: identity.sender, chars: transcript.length },
      'Voice API: message injected',
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, transcript }));
  } finally {
    await fsp.unlink(tmpFile).catch(() => {});
  }
}

async function handleMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jid: string,
  identity: ApiTokenIdentity,
  deps: HttpApiDeps,
): Promise<void> {
  const body = await readBodyWithLimit(req, MESSAGE_MAX_BYTES);
  if (body === null) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Message too large (max 1MB)' }));
    return;
  }
  const text = body.toString('utf-8').trim();

  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Empty message' }));
    return;
  }

  deps.onMessage(jid, buildMessage(jid, identity, text, 'api'));

  logger.info(
    { jid, sender: identity.sender, chars: text.length },
    'Voice API: text message injected',
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function handleWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jid: string,
  identity: ApiTokenIdentity,
  deps: HttpApiDeps,
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

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const content = formatWebhookEvent(data);

  deps.onMessage(jid, buildMessage(jid, identity, content, 'webhook'));

  logger.info(
    { jid, sender: identity.sender, event: data.event || 'unknown' },
    'Webhook event injected',
  );

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function buildMessage(
  jid: string,
  identity: ApiTokenIdentity,
  content: string,
  idPrefix: string,
): NewMessage {
  return {
    id: `${idPrefix}-${Date.now()}`,
    chat_jid: jid,
    sender: identity.sender,
    sender_name: identity.senderName,
    content,
    timestamp: new Date().toISOString(),
    is_from_me: identity.isFromMe,
  };
}

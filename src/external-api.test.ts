import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

import { startExternalApi, formatWebhookEvent, type ExternalApiDeps } from './external-api.js';
import type { ApiTokenIdentity } from './api-tokens.js';

const OWNER_TOKEN = 'owner-secret';
const HASS_TOKEN = 'hass-secret';

const identities = new Map<string, ApiTokenIdentity>([
  [OWNER_TOKEN, { userId: 'phone:+358401112222', platformId: 'owner-main', displayName: 'External (Jouni)' }],
  [HASS_TOKEN, { userId: 'api:hass', platformId: 'hass-main', displayName: 'Home Assistant' }],
]);

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body?: string | Buffer,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, hostname: '127.0.0.1', port }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode!, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      // readBodyWithLimit destroys oversize streams; ECONNRESET surfaces here
      // before the 413 response body is read. Tests for oversize tolerate it.
      if (err.code === 'ECONNRESET') return resolve({ statusCode: 413, body: '' });
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

function createDeps(overrides?: Partial<ExternalApiDeps>): ExternalApiDeps {
  return {
    identities,
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    ...overrides,
  };
}

describe('external-api', () => {
  let server: http.Server;
  let port: number;
  let deps: ExternalApiDeps;

  beforeEach(async () => {
    vi.clearAllMocks();
    deps = createDeps();
    server = await startExternalApi(0, '127.0.0.1', deps);
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('auth', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/api/webhook', headers: { 'Content-Type': 'application/json' } },
        '{"event":"x"}',
      );
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with malformed Authorization header', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/api/webhook', headers: { Authorization: 'NotBearer xyz' } },
        '{"event":"x"}',
      );
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with unknown token', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/api/webhook', headers: { Authorization: 'Bearer wrong' } },
        '{"event":"x"}',
      );
      expect(res.statusCode).toBe(401);
    });

    it('answers OPTIONS preflight without auth', async () => {
      const res = await makeRequest(port, { method: 'OPTIONS', path: '/api/webhook' });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('routing', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/api/voice', headers: { Authorization: `Bearer ${OWNER_TOKEN}` } },
        '{}',
      );
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for the v1 /api/message path (dropped in v2)', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/api/message', headers: { Authorization: `Bearer ${OWNER_TOKEN}` } },
        'hello',
      );
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for non-POST methods', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/webhook',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/webhook', () => {
    it('emits an InboundEvent stamped with the token identity', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/webhook',
          headers: { Authorization: `Bearer ${HASS_TOKEN}`, 'Content-Type': 'application/json' },
        },
        JSON.stringify({ event: 'door_opened', door: 'front' }),
      );
      expect(res.statusCode).toBe(202);
      expect(deps.onInbound).toHaveBeenCalledTimes(1);
      const [platformId, threadId, message] = (deps.onInbound as ReturnType<typeof vi.fn>).mock.calls[0];
      // The token's "hass-main" must be emitted namespaced as "api:hass-main"
      // so it matches messaging_groups rows pre-wired via namespacedPlatformId.
      expect(platformId).toBe('api:hass-main');
      expect(threadId).toBeNull();
      expect(message.kind).toBe('chat');
      expect(message.isMention).toBe(true);
      expect(message.isGroup).toBe(false);
      const content = message.content as { text: string; sender: string; senderId: string };
      expect(content.senderId).toBe('api:hass');
      expect(content.sender).toBe('Home Assistant');
      expect(content.text).toContain('[Webhook Event]');
      expect(content.text).toContain('event: door_opened');
      expect(content.text).toContain('door: front');
    });

    it('rejects empty bodies with 400', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/api/webhook', headers: { Authorization: `Bearer ${OWNER_TOKEN}` } },
        '',
      );
      expect(res.statusCode).toBe(400);
      expect(deps.onInbound).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON with 400', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/api/webhook', headers: { Authorization: `Bearer ${OWNER_TOKEN}` } },
        '{not json',
      );
      expect(res.statusCode).toBe(400);
      expect(deps.onInbound).not.toHaveBeenCalled();
    });

    it.each([
      ['null', 'null'],
      ['array', '[1,2,3]'],
      ['number', '42'],
      ['string', '"hello"'],
    ])('rejects non-object JSON body (%s) with 400', async (_label, body) => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/webhook',
          headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
        },
        body,
      );
      expect(res.statusCode).toBe(400);
      expect(deps.onInbound).not.toHaveBeenCalled();
    });

    it('survives a malformed Host header without 500', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/webhook',
          headers: {
            Authorization: `Bearer ${OWNER_TOKEN}`,
            'Content-Type': 'application/json',
            Host: 'bad host with spaces',
          },
        },
        JSON.stringify({ event: 'x' }),
      );
      expect(res.statusCode).toBe(202);
      expect(deps.onInbound).toHaveBeenCalledTimes(1);
    });

    it('rejects payloads over 256KB with 413', async () => {
      const big = JSON.stringify({ event: 'big', data: 'x'.repeat(300 * 1024) });
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/webhook',
          headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
        },
        big,
      );
      expect(res.statusCode).toBe(413);
      expect(deps.onInbound).not.toHaveBeenCalled();
    });

    it('routes via onInboundEvent with replyTo when the token declares one', async () => {
      const REPLY_TOKEN = 'reply-secret';
      const customDeps = createDeps({
        identities: new Map([
          [
            REPLY_TOKEN,
            {
              userId: 'api:hass',
              platformId: 'hass-main',
              displayName: 'Home Assistant',
              replyTo: { channelType: 'signal', platformId: 'sig-uuid-1', threadId: null },
            },
          ],
        ]),
      });
      const customServer = await startExternalApi(0, '127.0.0.1', customDeps);
      const customPort = (customServer.address() as AddressInfo).port;
      try {
        const res = await makeRequest(
          customPort,
          {
            method: 'POST',
            path: '/api/webhook',
            headers: { Authorization: `Bearer ${REPLY_TOKEN}`, 'Content-Type': 'application/json' },
          },
          JSON.stringify({ event: 'jouni_woke_up' }),
        );
        expect(res.statusCode).toBe(202);
        expect(customDeps.onInbound).not.toHaveBeenCalled();
        expect(customDeps.onInboundEvent).toHaveBeenCalledTimes(1);
        const [event] = (customDeps.onInboundEvent as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(event.channelType).toBe('api');
        expect(event.platformId).toBe('api:hass-main');
        expect(event.threadId).toBeNull();
        expect(event.replyTo).toEqual({ channelType: 'signal', platformId: 'sig-uuid-1', threadId: null });
        // InboundEvent.message.content is a JSON-encoded string (not an object).
        expect(typeof event.message.content).toBe('string');
        const decoded = JSON.parse(event.message.content);
        expect(decoded.senderId).toBe('api:hass');
        expect(decoded.text).toContain('event: jouni_woke_up');
        expect(event.message.isMention).toBe(true);
      } finally {
        await new Promise<void>((resolve) => customServer.close(() => resolve()));
      }
    });

    it('uses onInbound (no event path) for tokens without replyTo', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/webhook',
          headers: { Authorization: `Bearer ${HASS_TOKEN}`, 'Content-Type': 'application/json' },
        },
        JSON.stringify({ event: 'door_opened' }),
      );
      expect(res.statusCode).toBe(202);
      expect(deps.onInbound).toHaveBeenCalledTimes(1);
      expect(deps.onInboundEvent).not.toHaveBeenCalled();
    });

    it('passes through tokens whose platformId already carries the api: prefix', async () => {
      const PREFIXED = 'prefixed-secret';
      const customDeps = createDeps({
        identities: new Map([[PREFIXED, { userId: 'api:hass', platformId: 'api:hass-main', displayName: 'HA' }]]),
      });
      const customServer = await startExternalApi(0, '127.0.0.1', customDeps);
      const customPort = (customServer.address() as AddressInfo).port;
      try {
        const res = await makeRequest(
          customPort,
          {
            method: 'POST',
            path: '/api/webhook',
            headers: { Authorization: `Bearer ${PREFIXED}`, 'Content-Type': 'application/json' },
          },
          '{"event":"x"}',
        );
        expect(res.statusCode).toBe(202);
        const [platformId] = (customDeps.onInbound as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(platformId).toBe('api:hass-main');
      } finally {
        await new Promise<void>((resolve) => customServer.close(() => resolve()));
      }
    });
  });

  describe('startup', () => {
    it('rejects when the port is already in use', async () => {
      const blocker = await startExternalApi(0, '127.0.0.1', createDeps());
      const blockedPort = (blocker.address() as AddressInfo).port;
      try {
        await expect(startExternalApi(blockedPort, '127.0.0.1', createDeps())).rejects.toThrow(/EADDRINUSE/);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  });
});

describe('formatWebhookEvent', () => {
  it('produces a labelled key:value listing', () => {
    const out = formatWebhookEvent({ event: 'doorbell', who: 'unknown' });
    expect(out).toBe('[Webhook Event]\nevent: doorbell\nwho: unknown');
  });

  it('JSON-stringifies nested objects', () => {
    const out = formatWebhookEvent({ event: 'sensor', payload: { temp: 21 } });
    expect(out).toContain('payload: {"temp":21}');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockTranscribeAudio = vi.fn();
vi.mock('./transcription.js', () => ({
  transcribeAudio: (...args: any[]) => mockTranscribeAudio(...args),
}));

const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockUnlink = vi.fn().mockResolvedValue(undefined);
vi.mock('fs', () => ({
  promises: {
    writeFile: (...args: any[]) => mockWriteFile(...args),
    unlink: (...args: any[]) => mockUnlink(...args),
  },
}));

vi.mock('os', () => ({
  default: { tmpdir: () => '/tmp' },
}));

import { startHttpApi, HttpApiDeps } from './voice-api.js';
import type { ApiTokenIdentity } from './api-tokens.js';

const TRUSTED_TOKEN = 'trusted-secret';
const HASS_TOKEN = 'hass-secret';

const identities = new Map<string, ApiTokenIdentity>([
  [TRUSTED_TOKEN, { sender: 'api:jouni', senderName: 'Jouni', isFromMe: true }],
  [
    HASS_TOKEN,
    { sender: 'api:hass', senderName: 'Home Assistant', isFromMe: false },
  ],
]);

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body?: string | Buffer,
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      // readBodyWithLimit calls req.destroy() to abort oversized streams; the
      // kernel returns ECONNRESET to the client before it's read the response.
      // Tests for oversize behavior tolerate this and fall through to resolve.
      if (err.code === 'ECONNRESET')
        return resolve({ statusCode: 413, body: '', headers: {} });
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

function createDeps(overrides?: Partial<HttpApiDeps>): HttpApiDeps {
  return {
    onMessage: vi.fn(),
    defaultJid: 'signal:+1234567890',
    identities,
    ...overrides,
  };
}

describe('voice-api', () => {
  let server: http.Server;
  let port: number;
  let deps: HttpApiDeps;

  beforeEach(async () => {
    vi.clearAllMocks();
    deps = createDeps();
    server = startHttpApi(0, deps);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  describe('auth', () => {
    it('returns 401 for unknown token', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/voice',
        headers: { authorization: 'Bearer unknown-token' },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe('Unauthorized');
    });

    it('returns 401 for missing authorization header', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/voice',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 for non-Bearer scheme', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/voice',
        headers: { authorization: 'Basic something' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('any known token can hit any endpoint (no voice/webhook split)', async () => {
      const res1 = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/webhook',
          headers: {
            authorization: `Bearer ${TRUSTED_TOKEN}`,
            'content-type': 'application/json',
          },
        },
        JSON.stringify({ event: 'test' }),
      );
      expect(res1.statusCode).toBe(202);

      const res2 = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/message',
          headers: { authorization: `Bearer ${HASS_TOKEN}` },
        },
        'Hello',
      );
      expect(res2.statusCode).toBe(200);
    });

    it('returns 401 when identity map is empty', async () => {
      await new Promise<void>((r) => server.close(() => r()));
      server = startHttpApi(0, createDeps({ identities: new Map() }));
      await new Promise<void>((resolve) => server.on('listening', resolve));
      port = (server.address() as AddressInfo).port;

      const res = await makeRequest(port, {
        method: 'POST',
        path: '/voice',
        headers: { authorization: `Bearer ${TRUSTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('CORS', () => {
    it('responds to OPTIONS with 204 and CORS headers', async () => {
      const res = await makeRequest(port, { method: 'OPTIONS', path: '/' });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });
  });

  describe('identity binding', () => {
    it('trusted token injects is_from_me=true with its identity', async () => {
      await makeRequest(
        port,
        {
          method: 'POST',
          path: '/message',
          headers: { authorization: `Bearer ${TRUSTED_TOKEN}` },
        },
        'trusted text',
      );
      expect(deps.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({
          content: 'trusted text',
          sender: 'api:jouni',
          sender_name: 'Jouni',
          is_from_me: true,
        }),
      );
    });

    it('untrusted token injects is_from_me=false with its identity', async () => {
      await makeRequest(
        port,
        {
          method: 'POST',
          path: '/message',
          headers: { authorization: `Bearer ${HASS_TOKEN}` },
        },
        'hass text',
      );
      expect(deps.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({
          content: 'hass text',
          sender: 'api:hass',
          sender_name: 'Home Assistant',
          is_from_me: false,
        }),
      );
    });

    it('webhook endpoint uses caller identity (sender + senderName)', async () => {
      await makeRequest(
        port,
        {
          method: 'POST',
          path: '/webhook',
          headers: {
            authorization: `Bearer ${HASS_TOKEN}`,
            'content-type': 'application/json',
          },
        },
        JSON.stringify({ event: 'state_changed' }),
      );
      expect(deps.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({
          sender: 'api:hass',
          sender_name: 'Home Assistant',
          is_from_me: false,
          content: expect.stringContaining('[Webhook Event]'),
        }),
      );
    });

    it('query sender param does NOT override identity', async () => {
      await makeRequest(
        port,
        {
          method: 'POST',
          path: '/message?sender=ImpersonatedName',
          headers: { authorization: `Bearer ${HASS_TOKEN}` },
        },
        'try impersonation',
      );
      expect(deps.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({
          sender: 'api:hass',
          sender_name: 'Home Assistant',
        }),
      );
    });
  });

  describe('POST /voice', () => {
    const voiceHeaders = {
      authorization: `Bearer ${TRUSTED_TOKEN}`,
      'content-type': 'audio/m4a',
    };

    it('transcribes audio and injects message', async () => {
      mockTranscribeAudio.mockResolvedValueOnce('Hello from voice');

      const res = await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: voiceHeaders },
        Buffer.from('fake-audio'),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.transcript).toBe('Hello from voice');
      expect(deps.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({
          content: '[Voice: Hello from voice]',
          sender: 'api:jouni',
          sender_name: 'Jouni',
          is_from_me: true,
        }),
      );
    });

    it('returns 400 for empty body', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: voiceHeaders },
        Buffer.alloc(0),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Empty audio');
    });

    it('returns 413 for oversized body (streaming reject)', async () => {
      const bigBuf = Buffer.alloc(25 * 1024 * 1024 + 1, 0x41);
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: voiceHeaders },
        bigBuf,
      );
      expect(res.statusCode).toBe(413);
      expect(mockTranscribeAudio).not.toHaveBeenCalled();
    });

    it('returns 500 when transcription fails', async () => {
      mockTranscribeAudio.mockResolvedValueOnce(null);

      const res = await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: voiceHeaders },
        Buffer.from('audio-data'),
      );
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe('Transcription failed');
    });

    it('cleans up temp file after transcription', async () => {
      mockTranscribeAudio.mockResolvedValueOnce('text');

      await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: voiceHeaders },
        Buffer.from('audio'),
      );

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });

    it('cleans up temp file even when transcription fails', async () => {
      mockTranscribeAudio.mockResolvedValueOnce(null);

      await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: voiceHeaders },
        Buffer.from('audio'),
      );

      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /message', () => {
    const authHeaders = { authorization: `Bearer ${TRUSTED_TOKEN}` };

    it('injects text message', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/message', headers: authHeaders },
        'Hello text',
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
    });

    it('returns 400 for empty body', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/message', headers: authHeaders },
        '',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Empty message');
    });

    it('returns 413 for oversized text (streaming reject)', async () => {
      const bigText = 'A'.repeat(1 * 1024 * 1024 + 1);
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/message', headers: authHeaders },
        bigText,
      );
      expect(res.statusCode).toBe(413);
      expect(deps.onMessage).not.toHaveBeenCalled();
    });

    it('uses custom jid from query param', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/message?jid=tg:123',
          headers: authHeaders,
        },
        'Custom target',
      );
      expect(res.statusCode).toBe(200);
      expect(deps.onMessage).toHaveBeenCalledWith(
        'tg:123',
        expect.objectContaining({
          content: 'Custom target',
        }),
      );
    });
  });

  describe('POST /webhook', () => {
    const webhookHeaders = {
      authorization: `Bearer ${HASS_TOKEN}`,
      'content-type': 'application/json',
    };

    it('accepts valid JSON and returns 202', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/webhook', headers: webhookHeaders },
        JSON.stringify({ event: 'morning_wakeup', entity: 'sensor.battery' }),
      );
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).ok).toBe(true);
      expect(deps.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({
          content: expect.stringContaining('[Webhook Event]'),
          sender: 'api:hass',
          is_from_me: false,
        }),
      );
    });

    it('formats event fields into readable text', async () => {
      await makeRequest(
        port,
        { method: 'POST', path: '/webhook', headers: webhookHeaders },
        JSON.stringify({
          event: 'state_changed',
          entity: 'sensor.battery',
          from: 'Charging',
          to: 'Not Charging',
        }),
      );

      const injected = (deps.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1];
      expect(injected.content).toBe(
        '[Webhook Event]\nevent: state_changed\nentity: sensor.battery\nfrom: Charging\nto: Not Charging',
      );
    });

    it('returns 400 for empty body', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/webhook', headers: webhookHeaders },
        '',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Empty body');
    });

    it('returns 400 for invalid JSON', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/webhook', headers: webhookHeaders },
        'not json {{{',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Invalid JSON');
    });

    it('returns 413 for oversized webhook payload (streaming reject)', async () => {
      const bigJson = JSON.stringify({ blob: 'A'.repeat(256 * 1024 + 1) });
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/webhook', headers: webhookHeaders },
        bigJson,
      );
      expect(res.statusCode).toBe(413);
      expect(deps.onMessage).not.toHaveBeenCalled();
    });

    it('routes to custom jid from query param', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/webhook?jid=tg:family-group',
          headers: webhookHeaders,
        },
        JSON.stringify({ event: 'sauna_ready' }),
      );
      expect(res.statusCode).toBe(202);
      expect(deps.onMessage).toHaveBeenCalledWith(
        'tg:family-group',
        expect.objectContaining({
          chat_jid: 'tg:family-group',
        }),
      );
    });

    it('defaults to main group jid when no jid param', async () => {
      await makeRequest(
        port,
        { method: 'POST', path: '/webhook', headers: webhookHeaders },
        JSON.stringify({ event: 'test' }),
      );
      expect(deps.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({ chat_jid: 'signal:+1234567890' }),
      );
    });
  });

  describe('routing', () => {
    const authHeaders = { authorization: `Bearer ${TRUSTED_TOKEN}` };

    it('returns 404 for unknown path', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/unknown',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for GET request', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/voice',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

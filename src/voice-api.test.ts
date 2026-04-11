import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// --- Mocks ---

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    VOICE_API_TOKEN: 'test-secret',
    WEBHOOK_TOKEN: 'webhook-secret',
  })),
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockTranscribeAudio = vi.fn();
vi.mock('./transcription.js', () => ({
  transcribeAudio: (...args: any[]) => mockTranscribeAudio(...args),
}));

const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
vi.mock('fs', () => ({
  default: {
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
  },
}));

vi.mock('os', () => ({
  default: { tmpdir: () => '/tmp' },
}));

import { startHttpApi, HttpApiDeps } from './voice-api.js';

// --- Helpers ---

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
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createDeps(overrides?: Partial<HttpApiDeps>): HttpApiDeps {
  return {
    onMessage: vi.fn(),
    defaultJid: 'signal:+1234567890',
    defaultSender: 'Jouni',
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

  // --- Auth ---

  describe('auth', () => {
    it('returns 401 for wrong token', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/voice',
        headers: { authorization: 'Bearer wrong-token' },
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
  });

  // --- CORS ---

  describe('CORS', () => {
    it('responds to OPTIONS with 204 and CORS headers', async () => {
      const res = await makeRequest(port, { method: 'OPTIONS', path: '/' });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });
  });

  // --- POST /voice ---

  describe('POST /voice', () => {
    const authHeaders = {
      authorization: 'Bearer test-secret',
      'content-type': 'audio/m4a',
    };

    it('transcribes audio and injects message', async () => {
      mockTranscribeAudio.mockResolvedValueOnce('Hello from voice');

      const res = await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: authHeaders },
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
          sender_name: 'Jouni',
        }),
      );
    });

    it('returns 400 for empty body', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: authHeaders },
        Buffer.alloc(0),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Empty audio');
    });

    it('returns 413 for oversized body', async () => {
      // 25MB + 1 byte
      const bigBuf = Buffer.alloc(25 * 1024 * 1024 + 1, 0x41);
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: authHeaders },
        bigBuf,
      );
      expect(res.statusCode).toBe(413);
    });

    it('returns 500 when transcription fails', async () => {
      mockTranscribeAudio.mockResolvedValueOnce(null);

      const res = await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: authHeaders },
        Buffer.from('audio-data'),
      );
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe('Transcription failed');
    });

    it('cleans up temp file after transcription', async () => {
      mockTranscribeAudio.mockResolvedValueOnce('text');

      await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: authHeaders },
        Buffer.from('audio'),
      );

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    });

    it('cleans up temp file even when transcription fails', async () => {
      mockTranscribeAudio.mockResolvedValueOnce(null);

      await makeRequest(
        port,
        { method: 'POST', path: '/voice', headers: authHeaders },
        Buffer.from('audio'),
      );

      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    });
  });

  // --- POST /message ---

  describe('POST /message', () => {
    const authHeaders = { authorization: 'Bearer test-secret' };

    it('injects text message', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/message', headers: authHeaders },
        'Hello text',
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
      expect(deps.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({
          content: 'Hello text',
          sender_name: 'Jouni',
        }),
      );
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

    it('uses custom jid and sender from query params', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/message?jid=tg:123&sender=Alice',
          headers: authHeaders,
        },
        'Custom target',
      );
      expect(res.statusCode).toBe(200);
      expect(deps.onMessage).toHaveBeenCalledWith(
        'tg:123',
        expect.objectContaining({
          sender_name: 'Alice',
          content: 'Custom target',
        }),
      );
    });
  });

  // --- POST /webhook ---

  describe('POST /webhook', () => {
    const webhookHeaders = {
      authorization: 'Bearer webhook-secret',
      'content-type': 'application/json',
    };

    it('returns 401 for missing token', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/webhook',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 for wrong token', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/webhook',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('voice token does not work on /webhook', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/webhook',
          headers: { authorization: 'Bearer test-secret' },
        },
        JSON.stringify({ event: 'test' }),
      );
      expect(res.statusCode).toBe(401);
    });

    it('webhook token does not work on /message', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/message',
          headers: { authorization: 'Bearer webhook-secret' },
        },
        'Hello',
      );
      expect(res.statusCode).toBe(401);
    });

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
          is_trusted: true,
          sender: 'webhook',
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

  // --- Routing ---

  describe('routing', () => {
    const authHeaders = { authorization: 'Bearer test-secret' };

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

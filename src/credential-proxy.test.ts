import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy, detectAuthMode } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
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
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastUpstreamRequest: {
    method?: string;
    url?: string;
    body: string;
  };

  beforeEach(async () => {
    lastUpstreamHeaders = {};
    lastUpstreamRequest = { body: '' };

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastUpstreamRequest = {
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString(),
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('ANTHROPIC_AUTH_TOKEN is used when CLAUDE_CODE_OAUTH_TOKEN is absent', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer anthropic-auth-token',
    );
  });

  it('API-key mode takes priority over OAuth when both are set and strips Authorization', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    // API key is injected; container-sent Authorization is dropped so upstream
    // never sees dual auth (avoids ambiguity if upstream behavior changes).
    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  describe('header handling', () => {
    it('strips hop-by-hop headers', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            connection: 'keep-alive',
            'keep-alive': 'timeout=5',
            'transfer-encoding': 'chunked',
          },
        },
        '{}',
      );

      // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
      // its own Connection header (standard HTTP/1.1 behavior), but the client's
      // custom keep-alive and transfer-encoding must not be forwarded.
      expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
      expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
    });

    it('strips all RFC 7230 hop-by-hop headers', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            te: 'trailers',
            trailer: 'expires',
            upgrade: 'websocket',
            'proxy-authorization': 'Basic spy',
            'proxy-authenticate': 'Basic realm="x"',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['te']).toBeUndefined();
      expect(lastUpstreamHeaders['trailer']).toBeUndefined();
      expect(lastUpstreamHeaders['upgrade']).toBeUndefined();
      expect(lastUpstreamHeaders['proxy-authorization']).toBeUndefined();
      expect(lastUpstreamHeaders['proxy-authenticate']).toBeUndefined();
    });

    it('strips headers named by the Connection token list', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            connection: 'close, x-custom-drop, x-another-drop',
            'x-custom-drop': 'should-not-be-forwarded',
            'x-another-drop': 'also-stripped',
            'x-keep-me': 'should-survive',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['x-custom-drop']).toBeUndefined();
      expect(lastUpstreamHeaders['x-another-drop']).toBeUndefined();
      expect(lastUpstreamHeaders['x-keep-me']).toBe('should-survive');
    });

    it('sets host header to upstream host', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-key' });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['host']).toBe(`127.0.0.1:${upstreamPort}`);
    });

    it('forwards correct content-length for body', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-key' });

      const body = '{"hello":"world"}';
      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        body,
      );

      expect(lastUpstreamHeaders['content-length']).toBe(
        String(Buffer.byteLength(body)),
      );
    });

    it('forwards request body to upstream', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-key' });

      const body = '{"model":"claude-sonnet-4-6"}';
      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        body,
      );

      expect(lastUpstreamRequest.body).toBe(body);
    });

    it('forwards request path and method to upstream', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-key' });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages?beta=true',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );

      expect(lastUpstreamRequest.method).toBe('POST');
      expect(lastUpstreamRequest.url).toBe('/v1/messages?beta=true');
    });
  });

  describe('path allowlist', () => {
    let port: number;
    beforeEach(async () => {
      port = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-key' });
    });

    it('allows /v1/messages', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/v1/messages',
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows /v1/completions', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/v1/completions',
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows /api/oauth/claude_cli/ paths', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows /api/auth/ paths', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/auth/whoami',
      });
      expect(res.statusCode).toBe(200);
    });

    it('blocks /v1/billing/usage with 403', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/v1/billing/usage',
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks /admin/settings with 403', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/admin/settings',
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks root path / with 403', async () => {
      const res = await makeRequest(port, { method: 'GET', path: '/' });
      expect(res.statusCode).toBe(403);
    });

    it('blocks /v1/organizations with 403', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/v1/organizations',
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks /v1/models with 403', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/v1/models',
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks prefix-bypass attempts that share an allowed prefix', async () => {
      // startsWith('/v1/messages') would naively pass /v1/messageses.
      // The segment-boundary allowlist must reject it.
      const res1 = await makeRequest(port, {
        method: 'GET',
        path: '/v1/messageses',
      });
      expect(res1.statusCode).toBe(403);

      const res2 = await makeRequest(port, {
        method: 'GET',
        path: '/v1/messages-batch',
      });
      expect(res2.statusCode).toBe(403);

      const res3 = await makeRequest(port, {
        method: 'GET',
        path: '/v1/completionsx',
      });
      expect(res3.statusCode).toBe(403);

      // Legit sub-path under /v1/messages/ still allowed.
      const res4 = await makeRequest(port, {
        method: 'POST',
        path: '/v1/messages/batches',
      });
      expect(res4.statusCode).toBe(200);
    });

    it('blocks path traversal via ..', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/v1/messages/../billing/usage',
      });
      // path.posix.normalize resolves .. before the prefix check
      expect(res.statusCode).toBe(403);
    });

    it('blocks percent-encoded traversal (%2e%2e)', async () => {
      // Without decodePath, the allowlist would see /v1/messages/%2e%2e/...
      // (starts with /v1/messages) and pass, but the upstream would decode
      // and resolve to the billing path.
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/v1/messages/%2e%2e/billing/usage',
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks percent-encoded slash traversal (%2f)', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/v1/messages%2f..%2f..%2fadmin',
      });
      expect(res.statusCode).toBe(403);
    });

    it('double-encoded traversal is not a bypass (%252e%252e stays literal)', async () => {
      // %252e decodes to %2e (literal), so the path becomes
      // /v1/messages/%2e%2e/foo — not a traversal.
      // Since it still starts with /v1/messages it's allowed through; upstream
      // receives literal %2e%2e which is just a filename component.
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/v1/messages/%252e%252e/foo',
      });
      expect(res.statusCode).toBe(200);
    });

    it('handles malformed percent encoding without crashing', async () => {
      // decodeURIComponent throws on '%' not followed by two hex digits.
      // decodePath's catch returns the path as-is; allowlist still applies.
      // `/v1/messages%ZZ` is not a segment boundary of `/v1/messages`, so
      // the segment-boundary allowlist rejects it — the important assertion
      // is that we get a clean 403 (not a crash / 500).
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/v1/messages%ZZ',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  describe('OAuth credentials file', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-proxy-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads token from credentials file and injects it', async () => {
      const credsFile = path.join(tmpDir, 'credentials.json');
      fs.writeFileSync(
        credsFile,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'file-access-token',
            refreshToken: 'file-refresh-token',
            expiresAt: Date.now() + 3600_000,
          },
        }),
      );

      proxyPort = await startProxy({ CLAUDE_CREDENTIALS_FILE: credsFile });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/api/oauth/claude_cli/create_api_key',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer placeholder',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['authorization']).toBe(
        'Bearer file-access-token',
      );
    });

    it('falls back to static token when credentials file is missing', async () => {
      proxyPort = await startProxy({
        CLAUDE_CODE_OAUTH_TOKEN: 'static-token',
        CLAUDE_CREDENTIALS_FILE: path.join(tmpDir, 'nonexistent.json'),
      });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/api/oauth/claude_cli/create_api_key',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer placeholder',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['authorization']).toBe('Bearer static-token');
    });

    it('falls back to static token when credentials file has invalid schema', async () => {
      const credsFile = path.join(tmpDir, 'credentials.json');
      fs.writeFileSync(credsFile, JSON.stringify({ claudeAiOauth: {} }));

      proxyPort = await startProxy({
        CLAUDE_CODE_OAUTH_TOKEN: 'static-fallback',
        CLAUDE_CREDENTIALS_FILE: credsFile,
      });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/api/oauth/claude_cli/create_api_key',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer placeholder',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['authorization']).toBe(
        'Bearer static-fallback',
      );
    });

    it('falls back to static token when credentials file is not valid JSON', async () => {
      const credsFile = path.join(tmpDir, 'credentials.json');
      fs.writeFileSync(credsFile, 'not json at all {{{');

      proxyPort = await startProxy({
        CLAUDE_CODE_OAUTH_TOKEN: 'static-fallback',
        CLAUDE_CREDENTIALS_FILE: credsFile,
      });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/api/oauth/claude_cli/create_api_key',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer placeholder',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['authorization']).toBe(
        'Bearer static-fallback',
      );
    });

    it('credentials file is ignored in API-key mode', async () => {
      const credsFile = path.join(tmpDir, 'credentials.json');
      fs.writeFileSync(
        credsFile,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'should-not-be-used',
            refreshToken: 'refresh',
            expiresAt: Date.now() + 3600_000,
          },
        }),
      );

      proxyPort = await startProxy({
        ANTHROPIC_API_KEY: 'sk-ant-api-key',
        CLAUDE_CREDENTIALS_FILE: credsFile,
      });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'placeholder',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-api-key');
      expect(lastUpstreamHeaders['authorization']).toBeUndefined();
    });
  });

  describe('detectAuthMode', () => {
    it('returns api-key when ANTHROPIC_API_KEY is set', () => {
      Object.assign(mockEnv, { ANTHROPIC_API_KEY: 'sk-ant-key' });
      expect(detectAuthMode()).toBe('api-key');
    });

    it('returns oauth when only OAuth token is set', () => {
      Object.assign(mockEnv, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' });
      expect(detectAuthMode()).toBe('oauth');
    });

    it('returns oauth when no keys are set', () => {
      expect(detectAuthMode()).toBe('oauth');
    });

    it('returns api-key when both API key and OAuth are set', () => {
      Object.assign(mockEnv, {
        ANTHROPIC_API_KEY: 'sk-ant-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      });
      expect(detectAuthMode()).toBe('api-key');
    });
  });
});

// --- Service routes: Home Assistant ---
// Path-prefix routing with credential isolation. Wolfram arrives in Stage 12
// and reuses the same dispatch; only the HA route is exercised here.
describe('service routes — HA', () => {
  let proxyServer: http.Server;
  let anthropicUpstream: http.Server;
  let haUpstream: http.Server;
  let anthropicUpstreamPort: number;
  let haUpstreamPort: number;

  let anthropicReq: {
    headers: http.IncomingHttpHeaders;
    path: string;
    method: string;
    body: string;
  };
  let haReq: {
    headers: http.IncomingHttpHeaders;
    path: string;
    method: string;
    body: string;
  };

  function createUpstreamServer(): http.Server {
    return http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const data = {
          headers: { ...req.headers },
          path: req.url || '',
          method: req.method || '',
          body: Buffer.concat(chunks).toString(),
        };
        const port = (req.socket.address() as AddressInfo).port;
        if (port === anthropicUpstreamPort) Object.assign(anthropicReq, data);
        else if (port === haUpstreamPort) Object.assign(haReq, data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
  }

  beforeEach(async () => {
    anthropicReq = { headers: {}, path: '', method: '', body: '' };
    haReq = { headers: {}, path: '', method: '', body: '' };
    anthropicUpstream = createUpstreamServer();
    haUpstream = createUpstreamServer();
    await Promise.all([
      new Promise<void>((r) => anthropicUpstream.listen(0, '127.0.0.1', r)),
      new Promise<void>((r) => haUpstream.listen(0, '127.0.0.1', r)),
    ]);
    anthropicUpstreamPort = (anthropicUpstream.address() as AddressInfo).port;
    haUpstreamPort = (haUpstream.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await Promise.all([
      new Promise<void>((r) => proxyServer?.close(() => r())),
      new Promise<void>((r) => anthropicUpstream?.close(() => r())),
      new Promise<void>((r) => haUpstream?.close(() => r())),
    ]);
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string> = {}): Promise<number> {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicUpstreamPort}`,
      HA_URL: `http://127.0.0.1:${haUpstreamPort}`,
      HA_TOKEN: 'ha-secret-token',
      ...env,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('injects Bearer token on HA requests', async () => {
    const port = await startProxy();
    await makeRequest(port, {
      method: 'GET',
      path: '/ha/api/states',
    });
    expect(haReq.headers['authorization']).toBe('Bearer ha-secret-token');
  });

  it('strips container-sent Authorization before injecting HA token', async () => {
    const port = await startProxy();
    await makeRequest(port, {
      method: 'GET',
      path: '/ha/api/states',
      headers: { authorization: 'Bearer container-supplied-garbage' },
    });
    expect(haReq.headers['authorization']).toBe('Bearer ha-secret-token');
  });

  it('strips /ha prefix — upstream sees /api/...', async () => {
    const port = await startProxy();
    await makeRequest(port, {
      method: 'GET',
      path: '/ha/api/states/sensor.temp',
    });
    expect(haReq.path).toBe('/api/states/sensor.temp');
  });

  it('preserves query string on HA requests', async () => {
    const port = await startProxy();
    await makeRequest(port, {
      method: 'GET',
      path: '/ha/api/history/period/2026-04-18?filter_entity_id=sensor.temp',
    });
    expect(haReq.path).toBe(
      '/api/history/period/2026-04-18?filter_entity_id=sensor.temp',
    );
  });

  it('allows /ha/api/mcp (MCP endpoint used by agent homeassistant server)', async () => {
    const port = await startProxy();
    const res = await makeRequest(port, {
      method: 'POST',
      path: '/ha/api/mcp',
    });
    expect(res.statusCode).toBe(200);
    expect(haReq.path).toBe('/api/mcp');
  });

  it('blocks /ha/config with 403 (not under /api/)', async () => {
    const port = await startProxy();
    const res = await makeRequest(port, {
      method: 'GET',
      path: '/ha/config',
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks /ha/ with 403 (empty path after prefix)', async () => {
    const port = await startProxy();
    const res = await makeRequest(port, { method: 'GET', path: '/ha/' });
    expect(res.statusCode).toBe(403);
  });

  it('/ha without trailing slash does not match service route → 403', async () => {
    const port = await startProxy();
    const res = await makeRequest(port, { method: 'GET', path: '/ha' });
    // Falls through to Anthropic allowlist which doesn't contain /ha → 403
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for /ha/api/* when HA is not configured', async () => {
    // Only Anthropic env set — HA route never registered.
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicUpstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    const port = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(port, {
      method: 'GET',
      path: '/ha/api/states',
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks raw `..` traversal inside /ha', async () => {
    const port = await startProxy();
    const res = await makeRequest(port, {
      method: 'GET',
      path: '/ha/api/../v1/messages',
    });
    // path.posix.normalize collapses .. to yield /ha/v1/messages — still in
    // the HA branch but stripped path /v1/messages fails the /api/ allowlist.
    // Neither upstream is contacted; proxy returns 403.
    expect(res.statusCode).toBe(403);
    expect(haReq.path).toBe('');
    expect(anthropicReq.path).toBe('');
  });

  it('scrubs caller-supplied Cookie and X-Auth-Token before calling HA', async () => {
    const port = await startProxy();
    await makeRequest(port, {
      method: 'GET',
      path: '/ha/api/states',
      headers: {
        cookie: 'sid=exfiltrate-me',
        'x-auth-token': 'leaked-token',
      },
    });
    expect(haReq.headers['cookie']).toBeUndefined();
    expect(haReq.headers['x-auth-token']).toBeUndefined();
    expect(haReq.headers['authorization']).toBe('Bearer ha-secret-token');
  });

  it('blocks percent-encoded traversal from /ha into Anthropic paths', async () => {
    const port = await startProxy();
    const res = await makeRequest(port, {
      method: 'GET',
      path: '/ha/api/%2e%2e/v1/messages',
    });
    // Decoded+normalized to /ha/v1/messages → no longer starts with /ha/api/ → 403
    expect(res.statusCode).toBe(403);
    expect(haReq.path).toBe('');
    expect(anthropicReq.path).toBe('');
  });

  it('strips hop-by-hop headers on HA route', async () => {
    const port = await startProxy();
    await makeRequest(port, {
      method: 'POST',
      path: '/ha/api/services/light/turn_on',
      headers: {
        'content-type': 'application/json',
        te: 'trailers',
        'proxy-authorization': 'Basic spy',
        connection: 'close, x-drop-me',
        'x-drop-me': 'should-be-dropped',
      },
    });
    expect(haReq.headers['te']).toBeUndefined();
    expect(haReq.headers['proxy-authorization']).toBeUndefined();
    expect(haReq.headers['x-drop-me']).toBeUndefined();
  });

  it('sets Host header to HA upstream host', async () => {
    const port = await startProxy();
    await makeRequest(port, { method: 'GET', path: '/ha/api/states' });
    expect(haReq.headers['host']).toBe(`127.0.0.1:${haUpstreamPort}`);
  });

  it('forwards POST body + content-length to HA', async () => {
    const port = await startProxy();
    const body = '{"entity_id":"light.kitchen"}';
    await makeRequest(
      port,
      {
        method: 'POST',
        path: '/ha/api/services/light/turn_on',
        headers: { 'content-type': 'application/json' },
      },
      body,
    );
    expect(haReq.method).toBe('POST');
    expect(haReq.body).toBe(body);
    expect(haReq.headers['content-length']).toBe(
      String(Buffer.byteLength(body)),
    );
  });

  it('HA token does NOT leak into Anthropic requests', async () => {
    const port = await startProxy();
    await makeRequest(port, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
    });
    expect(anthropicReq.headers['authorization']).toBeUndefined();
    // api-key mode: anthropic upstream sees our real api key, not HA's
    expect(anthropicReq.headers['x-api-key']).toBe('sk-ant-real-key');
  });

  it('Anthropic API key does NOT leak into HA requests', async () => {
    const port = await startProxy();
    await makeRequest(port, {
      method: 'GET',
      path: '/ha/api/states',
      headers: { 'x-api-key': 'sk-client-supplied' },
    });
    // HA route should never receive x-api-key; auth is Bearer HA_TOKEN.
    expect(haReq.headers['x-api-key']).toBeUndefined();
    expect(haReq.headers['authorization']).toBe('Bearer ha-secret-token');
  });

  it('returns 502 when HA upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicUpstreamPort}`,
      HA_URL: 'http://127.0.0.1:59999',
      HA_TOKEN: 'ha-secret-token',
    });
    proxyServer = await startCredentialProxy(0);
    const port = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(port, {
      method: 'GET',
      path: '/ha/api/states',
    });
    expect(res.statusCode).toBe(502);
  });
});

// --- OAuth token refresh (auto-refresh + retry + rotation + dedup) ---
//
// These tests use vi.resetModules() + vi.doMock('https', ...) to intercept
// refresh calls made by the proxy's refreshOAuthTokenOnce helper, while the
// real http module continues to handle the proxy <-> upstream hop.

describe('OAuth token refresh', () => {
  let tmpDir: string;
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let proxyServer: http.Server;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  let httpsRequestCalls: Array<{ url: string; body: string }>;
  let mockHttpsResponse: { statusCode: number; body: string };

  const mockEnvRefresh: Record<string, string> = {};

  beforeEach(async () => {
    vi.resetModules();

    httpsRequestCalls = [];
    mockHttpsResponse = {
      statusCode: 200,
      body: JSON.stringify({
        access_token: 'refreshed-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }),
    };

    vi.doMock('https', async () => {
      const { EventEmitter } = await import('events');
      const { PassThrough } = await import('stream');
      return {
        request: vi.fn((url: string | URL, _opts: any, cb: any) => {
          const urlStr = typeof url === 'string' ? url : url.toString();

          const reqStream = new PassThrough();
          const chunks: Buffer[] = [];
          reqStream.on('data', (c: Buffer) => chunks.push(c));
          reqStream.on('end', () => {
            httpsRequestCalls.push({
              url: urlStr,
              body: Buffer.concat(chunks).toString(),
            });

            const res = new PassThrough() as InstanceType<
              typeof PassThrough
            > & { statusCode: number };
            res.statusCode = mockHttpsResponse.statusCode;
            cb(res);
            res.end(mockHttpsResponse.body);
          });

          return Object.assign(new EventEmitter(), {
            write: (data: string) => reqStream.write(data),
            end: () => reqStream.end(),
            destroy: vi.fn(),
          });
        }),
      };
    });

    vi.doMock('./env.js', () => ({
      readEnvFile: vi.fn(() => ({ ...mockEnvRefresh })),
    }));

    vi.doMock('./logger.js', () => ({
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      },
    }));

    lastUpstreamHeaders = {};
    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-refresh-test-'));
  });

  async function startFreshProxy(
    env: Record<string, string>,
  ): Promise<{ port: number; server: http.Server }> {
    for (const key of Object.keys(mockEnvRefresh)) delete mockEnvRefresh[key];
    Object.assign(mockEnvRefresh, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });

    const { startCredentialProxy: start } =
      await import('./credential-proxy.js');
    const server = await start(0);
    proxyServer = server;
    const port = (server.address() as AddressInfo).port;
    return { port, server };
  }

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(mockEnvRefresh)) delete mockEnvRefresh[key];
    vi.restoreAllMocks();
  });

  it('uses cached token when not expired', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'valid-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 3600_000,
        },
      }),
    );

    const { port } = await startFreshProxy({
      CLAUDE_CREDENTIALS_FILE: credsFile,
    });

    await makeRequest(port, {
      method: 'POST',
      path: '/api/oauth/claude_cli/create_api_key',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder',
      },
    });

    expect(lastUpstreamHeaders['authorization']).toBe('Bearer valid-token');
    expect(httpsRequestCalls).toHaveLength(0);
  });

  it('refreshes expired token and uses new one', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          refreshToken: 'my-refresh-token',
          expiresAt: Date.now() - 1000,
        },
      }),
    );

    mockHttpsResponse = {
      statusCode: 200,
      body: JSON.stringify({
        access_token: 'brand-new-token',
        refresh_token: 'rotated-refresh',
        expires_in: 7200,
      }),
    };

    const { port } = await startFreshProxy({
      CLAUDE_CREDENTIALS_FILE: credsFile,
    });

    await makeRequest(port, {
      method: 'POST',
      path: '/api/oauth/claude_cli/create_api_key',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder',
      },
    });

    expect(lastUpstreamHeaders['authorization']).toBe('Bearer brand-new-token');
    expect(httpsRequestCalls).toHaveLength(1);
    const refreshBody = JSON.parse(httpsRequestCalls[0].body);
    expect(refreshBody.grant_type).toBe('refresh_token');
    expect(refreshBody.refresh_token).toBe('my-refresh-token');
  });

  it('refreshes token within the 5-minute margin', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'about-to-expire-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 2 * 60 * 1000, // within 5-min margin
        },
      }),
    );

    const { port } = await startFreshProxy({
      CLAUDE_CREDENTIALS_FILE: credsFile,
    });

    await makeRequest(port, {
      method: 'POST',
      path: '/api/oauth/claude_cli/create_api_key',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder',
      },
    });

    expect(lastUpstreamHeaders['authorization']).toBe('Bearer refreshed-token');
    expect(httpsRequestCalls).toHaveLength(1);
  });

  it('does not relax credentials-file permissions on atomic rename', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old',
          refreshToken: 'old-refresh',
          expiresAt: Date.now() - 1000,
        },
      }),
    );
    fs.chmodSync(credsFile, 0o600);

    const { port } = await startFreshProxy({
      CLAUDE_CREDENTIALS_FILE: credsFile,
    });

    await makeRequest(port, {
      method: 'POST',
      path: '/api/oauth/claude_cli/create_api_key',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder',
      },
    });

    const stat = fs.statSync(credsFile);
    // fs.renameSync transfers the tmp file's mode bits; we force 0o600 on tmp
    // so the permissions survive the rename.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('saves refreshed credentials atomically via tmp file', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old-token',
          refreshToken: 'old-refresh',
          expiresAt: Date.now() - 1000,
        },
      }),
    );

    mockHttpsResponse = {
      statusCode: 200,
      body: JSON.stringify({
        access_token: 'saved-token',
        refresh_token: 'saved-refresh',
        expires_in: 3600,
      }),
    };

    const { port } = await startFreshProxy({
      CLAUDE_CREDENTIALS_FILE: credsFile,
    });

    await makeRequest(port, {
      method: 'POST',
      path: '/api/oauth/claude_cli/create_api_key',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder',
      },
    });

    const saved = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
    expect(saved.claudeAiOauth.accessToken).toBe('saved-token');
    expect(saved.claudeAiOauth.refreshToken).toBe('saved-refresh');
    // No leftover tmp file — atomic rename cleaned up
    const tmpLeft = fs.readdirSync(tmpDir).filter((n) => n.includes('.tmp.'));
    expect(tmpLeft).toHaveLength(0);
  });

  it('preserves other fields in credentials file after refresh', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old-token',
          refreshToken: 'old-refresh',
          expiresAt: Date.now() - 1000,
          customField: 'should-be-preserved',
        },
        otherSection: { key: 'value' },
      }),
    );

    const { port } = await startFreshProxy({
      CLAUDE_CREDENTIALS_FILE: credsFile,
    });

    await makeRequest(port, {
      method: 'POST',
      path: '/api/oauth/claude_cli/create_api_key',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder',
      },
    });

    const saved = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
    expect(saved.otherSection).toEqual({ key: 'value' });
    expect(saved.claudeAiOauth.customField).toBe('should-be-preserved');
    expect(saved.claudeAiOauth.accessToken).toBe('refreshed-token');
  });

  it('falls back to cached token on refresh failure', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'cached-fallback-token',
          refreshToken: 'bad-refresh',
          expiresAt: Date.now() - 1000,
        },
      }),
    );

    mockHttpsResponse = {
      statusCode: 401,
      body: JSON.stringify({ error: 'invalid_grant' }),
    };

    const { port } = await startFreshProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'static-backup',
      CLAUDE_CREDENTIALS_FILE: credsFile,
    });

    await makeRequest(port, {
      method: 'POST',
      path: '/api/oauth/claude_cli/create_api_key',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder',
      },
    });

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer cached-fallback-token',
    );
  });

  it('retries refresh on transient 5xx with exponential backoff', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 1000,
        },
      }),
    );

    let callCount = 0;
    vi.doMock('https', async () => {
      const { EventEmitter } = await import('events');
      const { PassThrough } = await import('stream');
      return {
        request: vi.fn((url: string | URL, _opts: any, cb: any) => {
          const reqStream = new PassThrough();
          const chunks: Buffer[] = [];
          reqStream.on('data', (c: Buffer) => chunks.push(c));
          reqStream.on('end', () => {
            callCount++;
            httpsRequestCalls.push({
              url: typeof url === 'string' ? url : url.toString(),
              body: Buffer.concat(chunks).toString(),
            });

            const res = new PassThrough() as InstanceType<
              typeof PassThrough
            > & { statusCode: number };
            if (callCount <= 2) {
              res.statusCode = 503;
              cb(res);
              res.end(JSON.stringify({ error: 'upstream unavailable' }));
            } else {
              res.statusCode = 200;
              cb(res);
              res.end(
                JSON.stringify({
                  access_token: 'retry-success-token',
                  refresh_token: 'refresh-after-retry',
                  expires_in: 3600,
                }),
              );
            }
          });
          return Object.assign(new EventEmitter(), {
            write: (data: string) => reqStream.write(data),
            end: () => reqStream.end(),
            destroy: vi.fn(),
          });
        }),
      };
    });

    // Patch setTimeout so the test doesn't wait for real backoff delays.
    const realSetTimeout = global.setTimeout;
    (global as any).setTimeout = (fn: () => void) => realSetTimeout(fn, 0);

    try {
      const { startCredentialProxy: start } =
        await import('./credential-proxy.js');

      for (const key of Object.keys(mockEnvRefresh)) delete mockEnvRefresh[key];
      Object.assign(mockEnvRefresh, {
        CLAUDE_CREDENTIALS_FILE: credsFile,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      });

      proxyServer = await start(0);
      const port = (proxyServer.address() as AddressInfo).port;

      await makeRequest(port, {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      });

      expect(lastUpstreamHeaders['authorization']).toBe(
        'Bearer retry-success-token',
      );
      expect(callCount).toBe(3);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  it('retries refresh with rotated token from file', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old-token',
          refreshToken: 'old-refresh-token',
          expiresAt: Date.now() - 1000,
        },
      }),
    );

    let callCount = 0;
    vi.doMock('https', async () => {
      const { EventEmitter } = await import('events');
      const { PassThrough } = await import('stream');
      return {
        request: vi.fn((url: string | URL, _opts: any, cb: any) => {
          const reqStream = new PassThrough();
          const chunks: Buffer[] = [];
          reqStream.on('data', (c: Buffer) => chunks.push(c));
          reqStream.on('end', () => {
            callCount++;
            const body = Buffer.concat(chunks).toString();
            const parsed = JSON.parse(body);

            httpsRequestCalls.push({
              url: typeof url === 'string' ? url : url.toString(),
              body,
            });

            const res = new PassThrough() as InstanceType<
              typeof PassThrough
            > & { statusCode: number };

            if (parsed.refresh_token === 'old-refresh-token') {
              res.statusCode = 401;
              cb(res);
              res.end(JSON.stringify({ error: 'invalid_grant' }));

              // Simulate external rotation — update file with new token
              fs.writeFileSync(
                credsFile,
                JSON.stringify({
                  claudeAiOauth: {
                    accessToken: 'stale',
                    refreshToken: 'rotated-refresh-token',
                    expiresAt: Date.now() - 1000,
                  },
                }),
              );
            } else if (parsed.refresh_token === 'rotated-refresh-token') {
              res.statusCode = 200;
              cb(res);
              res.end(
                JSON.stringify({
                  access_token: 'token-from-retry',
                  refresh_token: 'final-refresh',
                  expires_in: 3600,
                }),
              );
            }
          });
          return Object.assign(new EventEmitter(), {
            write: (data: string) => reqStream.write(data),
            end: () => reqStream.end(),
            destroy: vi.fn(),
          });
        }),
      };
    });

    const { startCredentialProxy: start } =
      await import('./credential-proxy.js');

    for (const key of Object.keys(mockEnvRefresh)) delete mockEnvRefresh[key];
    Object.assign(mockEnvRefresh, {
      CLAUDE_CREDENTIALS_FILE: credsFile,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });

    proxyServer = await start(0);
    const port = (proxyServer.address() as AddressInfo).port;

    await makeRequest(port, {
      method: 'POST',
      path: '/api/oauth/claude_cli/create_api_key',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder',
      },
    });

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer token-from-retry',
    );
    expect(callCount).toBe(2);
  });

  it('deduplicates concurrent refresh requests', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 1000,
        },
      }),
    );

    const { port } = await startFreshProxy({
      CLAUDE_CREDENTIALS_FILE: credsFile,
    });

    const [res1, res2] = await Promise.all([
      makeRequest(port, {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      }),
      makeRequest(port, {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      }),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    // Only one refresh should have been made (deduplication)
    expect(httpsRequestCalls).toHaveLength(1);
  });
});

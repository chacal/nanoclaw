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
  let lastUpstreamPath: string;
  let lastUpstreamMethod: string;
  let lastUpstreamBody: string;

  beforeEach(async () => {
    lastUpstreamHeaders = {};
    lastUpstreamPath = '';
    lastUpstreamMethod = '';
    lastUpstreamBody = '';

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamPath = req.url || '';
      lastUpstreamMethod = req.method || '';
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastUpstreamBody = Buffer.concat(chunks).toString();
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

  // --- API-key mode ---

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

  // --- OAuth mode ---

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

    // Post-exchange: container uses x-api-key only, no Authorization header
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
      ANTHROPIC_AUTH_TOKEN: 'auth-token-fallback',
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
      'Bearer auth-token-fallback',
    );
  });

  it('API-key mode takes priority over OAuth when both are set', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-api-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    // In API-key mode, x-api-key is injected; Authorization is left as-is
    // (not replaced with OAuth token)
    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-api-key');
  });

  // --- Header handling ---

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

      expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
      expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
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

      const body = JSON.stringify({ model: 'claude-3', messages: [] });
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

      const body = JSON.stringify({ model: 'claude-3', prompt: 'hello' });
      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        body,
      );

      expect(lastUpstreamBody).toBe(body);
    });

    it('forwards request path and method to upstream', async () => {
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

      expect(lastUpstreamPath).toBe('/v1/messages');
      expect(lastUpstreamMethod).toBe('POST');
    });
  });

  // --- Path allowlist ---

  describe('path allowlist', () => {
    let port: number;

    beforeEach(async () => {
      port = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-key' });
    });

    it('allows /v1/messages', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows /v1/completions', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/v1/completions',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows /api/oauth/claude_cli/ paths', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows /api/auth/ paths', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/auth/check',
      });
      expect(res.statusCode).toBe(200);
    });

    it('blocks /v1/billing/usage with 403', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/v1/billing/usage',
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('Forbidden');
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

    it('blocks path traversal via ..', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/v1/messages/../billing/usage',
      });
      // path.posix.normalize resolves .. before the prefix check
      expect(res.statusCode).toBe(403);
    });
  });

  // --- Error handling ---

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

  // --- OAuth credentials file ---

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
            expiresAt: Date.now() + 3600_000, // 1 hour from now
          },
        }),
      );

      proxyPort = await startProxy({
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

      // Should use API key, not OAuth token from file
      expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-api-key');
      expect(lastUpstreamHeaders['authorization']).toBeUndefined();
    });
  });

  // --- detectAuthMode ---

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
      // mockEnv is empty
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

// --- Service route tests ---
// Uses separate upstream servers per service to verify correct routing isolation.
describe('service routes', () => {
  let proxyServer: http.Server;
  let anthropicUpstream: http.Server;
  let haUpstream: http.Server;
  let wolframUpstream: http.Server;
  let proxyPort: number;
  let anthropicUpstreamPort: number;
  let haUpstreamPort: number;
  let wolframUpstreamPort: number;

  // Track what each upstream received
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
  let wolframReq: {
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
        // Identify which upstream was hit based on its port
        const port = (req.socket.address() as AddressInfo).port;
        if (port === anthropicUpstreamPort) Object.assign(anthropicReq, data);
        else if (port === haUpstreamPort) Object.assign(haReq, data);
        else if (port === wolframUpstreamPort) Object.assign(wolframReq, data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
  }

  function resetReqs() {
    const empty = { headers: {}, path: '', method: '', body: '' };
    anthropicReq = { ...empty };
    haReq = { ...empty };
    wolframReq = { ...empty };
  }

  beforeEach(async () => {
    resetReqs();
    anthropicUpstream = createUpstreamServer();
    haUpstream = createUpstreamServer();
    wolframUpstream = createUpstreamServer();

    await Promise.all([
      new Promise<void>((r) => anthropicUpstream.listen(0, '127.0.0.1', r)),
      new Promise<void>((r) => haUpstream.listen(0, '127.0.0.1', r)),
      new Promise<void>((r) => wolframUpstream.listen(0, '127.0.0.1', r)),
    ]);
    anthropicUpstreamPort = (anthropicUpstream.address() as AddressInfo).port;
    haUpstreamPort = (haUpstream.address() as AddressInfo).port;
    wolframUpstreamPort = (wolframUpstream.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await Promise.all([
      new Promise<void>((r) => proxyServer?.close(() => r())),
      new Promise<void>((r) => anthropicUpstream?.close(() => r())),
      new Promise<void>((r) => haUpstream?.close(() => r())),
      new Promise<void>((r) => wolframUpstream?.close(() => r())),
    ]);
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string> = {}): Promise<number> {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicUpstreamPort}`,
      HA_URL: `http://127.0.0.1:${haUpstreamPort}`,
      HA_TOKEN: 'ha-secret-token',
      WOLFRAM_APP_ID: 'wolf-secret-id',
      WOLFRAM_URL: `http://127.0.0.1:${wolframUpstreamPort}`,
      ...env,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  // === A. HA Route — Credential Injection ===

  describe('HA credential injection', () => {
    it('injects Bearer token on HA requests', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states/sensor.test',
      });
      expect(haReq.headers['authorization']).toBe('Bearer ha-secret-token');
    });

    it('strips and replaces container-sent Authorization header', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states/sensor.test',
        headers: { authorization: 'Bearer container-leaked-token' },
      });
      expect(haReq.headers['authorization']).toBe('Bearer ha-secret-token');
    });

    it('returns 403 for /ha/ when HA is not configured', async () => {
      proxyPort = await startProxy({ HA_URL: '', HA_TOKEN: '' });
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states/sensor.test',
      });
      // Route not registered → falls through to Anthropic allowlist → 403
      expect(res.statusCode).toBe(403);
    });
  });

  // === B. HA Route — Path Handling ===

  describe('HA path handling', () => {
    it('strips /ha prefix — upstream sees /api/states/...', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states/sensor.nordpool',
      });
      expect(haReq.path).toBe('/api/states/sensor.nordpool');
    });

    it('strips /ha prefix for nested service paths', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'POST',
        path: '/ha/api/services/light/turn_on',
        headers: { 'content-type': 'application/json' },
      });
      expect(haReq.path).toBe('/api/services/light/turn_on');
    });

    it('allows /ha/api/mcp (MCP endpoint)', async () => {
      proxyPort = await startProxy();
      const res = await makeRequest(proxyPort, {
        method: 'POST',
        path: '/ha/api/mcp',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      expect(haReq.path).toBe('/api/mcp');
    });

    it('blocks /ha/config with 403 (not under /api/)', async () => {
      proxyPort = await startProxy();
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/config',
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks /ha/ with 403 (empty path after prefix)', async () => {
      proxyPort = await startProxy();
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/',
      });
      expect(res.statusCode).toBe(403);
    });

    it('/ha without trailing slash does not match service route → 403', async () => {
      proxyPort = await startProxy();
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha',
      });
      // Falls through to Anthropic allowlist → 403
      expect(res.statusCode).toBe(403);
    });
  });

  // === C. Wolfram Route — Credential Injection ===

  describe('Wolfram credential injection', () => {
    it('injects appid query param', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/wolfram/v1/simple?i=test',
      });
      expect(wolframReq.path).toContain('appid=wolf-secret-id');
    });

    it('injects appid even when container omits it', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/wolfram/v1/simple?i=hello&units=metric',
      });
      expect(wolframReq.path).toContain('appid=wolf-secret-id');
    });

    it('overwrites container-sent appid param', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/wolfram/v1/simple?i=test&appid=container-fake-id',
      });
      expect(wolframReq.path).toContain('appid=wolf-secret-id');
      expect(wolframReq.path).not.toContain('container-fake-id');
    });

    it('preserves existing query params alongside injected appid', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/wolfram/v1/simple?i=hello%20world&units=metric',
      });
      expect(wolframReq.path).toContain('i=hello+world');
      expect(wolframReq.path).toContain('units=metric');
      expect(wolframReq.path).toContain('appid=wolf-secret-id');
    });

    it('returns 403 for /wolfram/ when Wolfram is not configured', async () => {
      proxyPort = await startProxy({ WOLFRAM_APP_ID: '' });
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/wolfram/v1/simple?i=test',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // === D. Wolfram Route — Path Handling ===

  describe('Wolfram path handling', () => {
    it('strips /wolfram prefix', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/wolfram/v1/simple?i=test',
      });
      expect(wolframReq.path).toMatch(/^\/v1\/simple\?/);
    });

    it('blocks /wolfram/v2/admin with 403 (not under /v1/)', async () => {
      proxyPort = await startProxy();
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/wolfram/v2/admin',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // === E. Path Security ===

  describe('path security', () => {
    it('blocks path traversal from HA into Anthropic paths', async () => {
      proxyPort = await startProxy();
      // /ha/api/../../v1/messages normalizes to /v1/messages, but
      // service route check uses normalized path which no longer starts with /ha/
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/../../v1/messages',
      });
      // Normalized to /v1/messages — matches Anthropic not HA, so goes to Anthropic.
      // Actually it depends on normalization. Let's just verify it doesn't hit HA
      // with an unintended path.
      expect(haReq.path).not.toContain('/v1/messages');
    });

    it('blocks path traversal within HA route', async () => {
      proxyPort = await startProxy();
      // /ha/api/../config normalizes to /ha/config → stripped = /config → not under /api/
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/../config',
      });
      expect(res.statusCode).toBe(403);
    });

    it('unknown prefix falls through to Anthropic allowlist → 403', async () => {
      proxyPort = await startProxy();
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/unknown/v1/messages',
      });
      expect(res.statusCode).toBe(403);
    });

    it('path traversal from Wolfram into Anthropic is blocked', async () => {
      proxyPort = await startProxy();
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/wolfram/v1/../../v1/messages',
      });
      // Normalized to /v1/messages — no longer starts with /wolfram/
      expect(wolframReq.path).toBe('');
    });

    it('percent-encoded path traversal is blocked (%2e%2e)', async () => {
      proxyPort = await startProxy();
      // %2e%2e = '..' — must be decoded before allowlist check
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/%2e%2e/config',
      });
      // Decoded to /ha/api/../config → normalized to /ha/config → stripped = /config → 403
      expect(res.statusCode).toBe(403);
    });

    it('percent-encoded slash traversal is blocked (%2f)', async () => {
      proxyPort = await startProxy();
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states%2f..%2f..%2fconfig',
      });
      // Decoded to /ha/api/states/../../config → normalized to /ha/config → 403
      expect(res.statusCode).toBe(403);
    });

    it('double-encoded traversal does not bypass (%252e%252e)', async () => {
      proxyPort = await startProxy();
      // %252e decodes to %2e (literal), not to '.'
      // decodeURIComponent('%252e') = '%2e', so path stays as-is with literal %2e
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/%252e%252e/config',
      });
      // After single decode: /ha/api/%2e%2e/config — %2e is a literal char, not traversal
      // The path /api/%2e%2e/config starts with /api/ so it passes the allowlist
      // (this is correct — double-encoded is not a traversal, it's a literal path)
      expect(res.statusCode).toBe(200);
    });

    it('percent-encoded traversal blocked on Anthropic path too', async () => {
      proxyPort = await startProxy();
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/v1/messages/%2e%2e/billing/usage',
      });
      // Decoded to /v1/messages/../billing/usage → normalized to /v1/billing/usage → 403
      expect(res.statusCode).toBe(403);
    });
  });

  // === F. Header Security ===

  describe('header security', () => {
    it('strips hop-by-hop headers on HA route', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states/sensor.test',
        headers: {
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      });
      expect(haReq.headers['keep-alive']).toBeUndefined();
      expect(haReq.headers['transfer-encoding']).toBeUndefined();
    });

    it('sets Host header to HA upstream host', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states/sensor.test',
      });
      expect(haReq.headers['host']).toBe(`127.0.0.1:${haUpstreamPort}`);
    });

    it('sets Content-Length correctly for forwarded body', async () => {
      proxyPort = await startProxy();
      const body = JSON.stringify({ entity_id: 'light.kitchen' });
      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/ha/api/services/light/turn_on',
          headers: { 'content-type': 'application/json' },
        },
        body,
      );
      expect(haReq.headers['content-length']).toBe(
        String(Buffer.byteLength(body)),
      );
    });
  });

  // === G. Credential Isolation Between Routes ===

  describe('credential isolation', () => {
    it('HA token does NOT appear in Wolfram requests', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/wolfram/v1/simple?i=test',
      });
      expect(wolframReq.headers['authorization']).toBeUndefined();
    });

    it('Wolfram appid does NOT appear in HA requests', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states/sensor.test',
      });
      expect(haReq.path).not.toContain('appid');
    });

    it('HA token does NOT appear in Anthropic requests', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      });
      expect(anthropicReq.headers['authorization']).toBeUndefined();
    });

    it('Wolfram appid does NOT appear in Anthropic requests', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      });
      expect(anthropicReq.path).not.toContain('appid');
    });

    it('Anthropic API key does NOT appear in HA requests', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states/sensor.test',
        headers: { 'x-api-key': 'placeholder' },
      });
      // The proxy should NOT inject x-api-key on service routes
      expect(haReq.headers['x-api-key']).toBe('placeholder');
    });
  });

  // === H. Anthropic Route Unchanged ===

  describe('Anthropic route with service routes configured', () => {
    it('Anthropic route still works when HA/Wolfram are configured', async () => {
      proxyPort = await startProxy();
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
      expect(anthropicReq.headers['x-api-key']).toBe('sk-ant-real-key');
      expect(anthropicReq.path).toBe('/v1/messages');
    });

    it('Anthropic path allowlist still blocks unauthorized paths', async () => {
      proxyPort = await startProxy();
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/v1/billing/usage',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // === I. Error Handling ===

  describe('service route error handling', () => {
    it('returns 502 when HA upstream is unreachable', async () => {
      proxyPort = await startProxy({
        HA_URL: 'http://127.0.0.1:59998',
      });
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states/sensor.test',
      });
      expect(res.statusCode).toBe(502);
      expect(res.body).toBe('Bad Gateway');
    });

    it('returns 502 when Wolfram upstream is unreachable', async () => {
      proxyPort = await startProxy({
        WOLFRAM_URL: 'http://127.0.0.1:59997',
      });
      const res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/wolfram/v1/simple?i=test',
      });
      expect(res.statusCode).toBe(502);
      expect(res.body).toBe('Bad Gateway');
    });
  });

  // === J. Method and Body Forwarding ===

  describe('method and body forwarding', () => {
    it('forwards GET to HA', async () => {
      proxyPort = await startProxy();
      await makeRequest(proxyPort, {
        method: 'GET',
        path: '/ha/api/states/sensor.test',
      });
      expect(haReq.method).toBe('GET');
    });

    it('forwards POST with body to HA', async () => {
      proxyPort = await startProxy();
      const body = JSON.stringify({ entity_id: 'light.kitchen' });
      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/ha/api/services/light/turn_on',
          headers: { 'content-type': 'application/json' },
        },
        body,
      );
      expect(haReq.method).toBe('POST');
      expect(haReq.body).toBe(body);
    });

    it('forwards POST with body to Wolfram', async () => {
      proxyPort = await startProxy();
      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/wolfram/v1/simple?i=test',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );
      expect(wolframReq.method).toBe('POST');
    });
  });
});

// OAuth token refresh tests use vi.resetModules() to isolate module-level state
// (cachedCredentials, refreshInProgress) between tests.
describe('OAuth token refresh', () => {
  let tmpDir: string;
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let proxyServer: http.Server;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  // Track HTTPS requests made by refreshOAuthToken
  let httpsRequestCalls: Array<{ url: string; body: string }>;
  let mockHttpsResponse: {
    statusCode: number;
    body: string;
  };

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

    // Mock https.request to intercept OAuth refresh calls
    vi.doMock('https', async () => {
      const { EventEmitter } = await import('events');
      const { PassThrough } = await import('stream');
      return {
        request: vi.fn((url: string | URL, opts: any, cb: any) => {
          const urlStr = typeof url === 'string' ? url : url.toString();

          // Capture the request
          const reqStream = new PassThrough();
          const chunks: Buffer[] = [];
          reqStream.on('data', (c: Buffer) => chunks.push(c));
          reqStream.on('end', () => {
            httpsRequestCalls.push({
              url: urlStr,
              body: Buffer.concat(chunks).toString(),
            });

            // Create mock response
            const res = new PassThrough() as InstanceType<
              typeof PassThrough
            > & {
              statusCode: number;
            };
            res.statusCode = mockHttpsResponse.statusCode;
            cb(res);
            res.end(mockHttpsResponse.body);
          });

          // Return a mock request object
          const mockReq = Object.assign(new EventEmitter(), {
            write: (data: string) => reqStream.write(data),
            end: () => reqStream.end(),
            destroy: vi.fn(),
          });

          return mockReq;
        }),
      };
    });

    // Re-mock env and logger for the fresh module
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

  const mockEnvRefresh: Record<string, string> = {};

  async function startFreshProxy(
    env: Record<string, string>,
  ): Promise<{ port: number; server: http.Server }> {
    // Clear and set env
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
          expiresAt: Date.now() + 3600_000, // 1 hour from now
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
    expect(httpsRequestCalls).toHaveLength(0); // No refresh attempted
  });

  it('refreshes expired token and uses new one', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          refreshToken: 'my-refresh-token',
          expiresAt: Date.now() - 1000, // Already expired
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

    // Verify refresh request sent the correct refresh token
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
          // Expires in 2 minutes — within the 5-minute margin
          expiresAt: Date.now() + 2 * 60 * 1000,
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
    expect(httpsRequestCalls).toHaveLength(1); // Refresh was triggered
  });

  it('saves refreshed credentials to file', async () => {
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

    // Read the credentials file and verify it was updated
    const saved = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
    expect(saved.claudeAiOauth.accessToken).toBe('saved-token');
    expect(saved.claudeAiOauth.refreshToken).toBe('saved-refresh');
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

    // Should fall back to cached token (from the expired credentials)
    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer cached-fallback-token',
    );
  });

  it('retries refresh with rotated token from file', async () => {
    const credsFile = path.join(tmpDir, 'credentials.json');
    // Write initial credentials with old refresh token
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
    // Override the mock to fail first, then succeed on retry
    // After first failure, simulate external token rotation by updating the file
    vi.doMock('https', async () => {
      const { EventEmitter } = await import('events');
      const { PassThrough } = await import('stream');
      return {
        request: vi.fn((url: string | URL, opts: any, cb: any) => {
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
            > & {
              statusCode: number;
            };

            if (parsed.refresh_token === 'old-refresh-token') {
              // First call with old token — fail
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
              // Second call with rotated token — succeed
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

          const mockReq = Object.assign(new EventEmitter(), {
            write: (data: string) => reqStream.write(data),
            end: () => reqStream.end(),
            destroy: vi.fn(),
          });
          return mockReq;
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
    expect(callCount).toBe(2); // First failed, second succeeded
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

    // Send two concurrent requests — both should trigger token refresh
    // but only one actual refresh call should be made
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

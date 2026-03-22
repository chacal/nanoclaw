/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * OAuth credentials can come from a credentials JSON file (with auto-refresh)
 * or from a static token in .env. Set CLAUDE_CREDENTIALS_FILE in .env to
 * point to a Claude credentials.json file for automatic token refresh.
 */
import fs from 'fs';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

// Only allow API paths that containers legitimately need.
// Blocks access to billing, admin, and other sensitive endpoints.
const ALLOWED_PATH_PREFIXES = [
  '/v1/messages',
  '/v1/completions',
  '/api/oauth/claude_cli/',
  '/api/auth/',
];

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** In-memory cache of current OAuth credentials. */
let cachedCredentials: OAuthCredentials | null = null;
let credentialsFilePath: string | null = null;
let refreshInProgress: Promise<string> | null = null;

function loadCredentialsFile(filePath: string): OAuthCredentials | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const oauth = data.claudeAiOauth;
    if (oauth?.accessToken && oauth?.refreshToken && oauth?.expiresAt) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      };
    }
    logger.warn('Credentials file missing required OAuth fields');
    return null;
  } catch (err) {
    logger.error({ err, filePath }, 'Failed to read credentials file');
    return null;
  }
}

function saveCredentialsFile(filePath: string, creds: OAuthCredentials): void {
  try {
    // Read existing file to preserve other fields
    let data: Record<string, any> = {};
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      // File doesn't exist or is invalid, start fresh
    }
    data.claudeAiOauth = {
      ...data.claudeAiOauth,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    };
    // Atomic write: write to temp file then rename to prevent corruption on crash
    const tmpFile = filePath + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(data) + '\n');
    fs.renameSync(tmpFile, filePath);
    logger.info('OAuth credentials saved to file');
  } catch (err) {
    logger.error({ err }, 'Failed to save credentials file');
  }
}

async function refreshOAuthToken(
  refreshToken: string,
): Promise<OAuthCredentials> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    });

    const req = httpsRequest(
      OAUTH_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Token refresh failed (${res.statusCode}): ${responseBody}`,
              ),
            );
            return;
          }
          try {
            const data = JSON.parse(responseBody);
            resolve({
              accessToken: data.access_token,
              refreshToken: data.refresh_token || refreshToken,
              expiresAt: Date.now() + data.expires_in * 1000,
            });
          } catch (err) {
            reject(new Error(`Failed to parse refresh response: ${err}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('OAuth token refresh timed out'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Get a valid OAuth access token. Refreshes automatically if expired or
 * about to expire. Deduplicates concurrent refresh requests.
 */
async function getOAuthToken(fallbackToken: string): Promise<string> {
  if (!cachedCredentials) {
    return fallbackToken;
  }

  const now = Date.now();
  if (now < cachedCredentials.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return cachedCredentials.accessToken;
  }

  // Token expired or about to expire — refresh
  if (!refreshInProgress) {
    refreshInProgress = (async () => {
      try {
        logger.info('Refreshing OAuth token...');
        const newCreds = await refreshOAuthToken(
          cachedCredentials!.refreshToken,
        );
        cachedCredentials = newCreds;
        if (credentialsFilePath) {
          saveCredentialsFile(credentialsFilePath, newCreds);
        }
        logger.info(
          {
            expiresAt: new Date(newCreds.expiresAt).toISOString(),
          },
          'OAuth token refreshed',
        );
        return newCreds.accessToken;
      } catch (err) {
        logger.error({ err }, 'OAuth token refresh failed');
        // Return current token as fallback — it may still work briefly
        return cachedCredentials?.accessToken || fallbackToken;
      } finally {
        refreshInProgress = null;
      }
    })();
  }

  return refreshInProgress;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CREDENTIALS_FILE',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  // Load OAuth credentials from file if configured (enables auto-refresh)
  if (authMode === 'oauth' && secrets.CLAUDE_CREDENTIALS_FILE) {
    credentialsFilePath = secrets.CLAUDE_CREDENTIALS_FILE;
    cachedCredentials = loadCredentialsFile(credentialsFilePath);
    if (cachedCredentials) {
      logger.info(
        {
          credentialsFile: credentialsFilePath,
          expiresAt: new Date(cachedCredentials.expiresAt).toISOString(),
        },
        'OAuth credentials loaded from file (auto-refresh enabled)',
      );
    }
  }

  const staticOAuthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN || '';

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const reqPath = req.url || '/';
        if (!ALLOWED_PATH_PREFIXES.some((p) => reqPath.startsWith(p))) {
          logger.warn({ path: reqPath }, 'Blocked request to disallowed path');
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            const token = await getOAuthToken(staticOAuthToken);
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

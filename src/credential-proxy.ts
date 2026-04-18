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
const REFRESH_MAX_RETRIES = 3;
const REFRESH_BASE_DELAY_MS = 2_000;

// Only allow API paths that containers legitimately need.
// Blocks access to billing, admin, and other sensitive endpoints.
const ALLOWED_PATH_PREFIXES = [
  '/v1/messages',
  '/v1/completions',
  '/api/oauth/claude_cli/',
  '/api/auth/',
];

// Hop-by-hop headers per RFC 7230 §6.1. Must not be forwarded by proxies.
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Match `p` against a list of allowed prefixes using segment boundaries, so
 * `/v1/messageses` does NOT pass `/v1/messages`. A prefix ending in `/` is
 * treated as a directory prefix (exact `startsWith` is already boundary-safe).
 */
function matchesPrefix(p: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (prefix.endsWith('/')) {
      if (p.startsWith(prefix)) return true;
    } else if (p === prefix || p.startsWith(prefix + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Strip all hop-by-hop headers, including any token nominated by a
 * `Connection:` header value per RFC 7230.
 */
function stripHopByHop(
  headers: Record<string, string | number | string[] | undefined>,
): void {
  const connection = headers['connection'];
  if (typeof connection === 'string') {
    for (const token of connection.split(',')) {
      const name = token.trim().toLowerCase();
      if (name) delete headers[name];
    }
  }
  for (const h of HOP_BY_HOP_HEADERS) {
    delete headers[h];
  }
}

/**
 * A path-prefix route for non-Anthropic upstreams (e.g. Home Assistant).
 * The proxy strips the prefix, validates the remaining path against
 * `allowedPaths`, injects credentials via `injectCredentials`, and forwards
 * to `upstream`.
 */
interface ServiceRoute {
  /** URL prefix that selects this route (e.g. `/ha`, `/wolfram`). */
  prefix: string;
  /** Upstream base URL the route forwards to. */
  upstream: URL;
  /**
   * Allowed path prefixes *after* the service prefix is stripped. Segment
   * boundaries are honored via `matchesPrefix` — `/config` is not reachable
   * via `/ha/configuration`.
   */
  allowedPaths: readonly string[];
  /** Mutate headers to inject route-specific credentials. */
  injectCredentials: (
    headers: Record<string, string | number | string[] | undefined>,
  ) => void;
  /** Optional: transform the upstream path (e.g. inject query params). */
  transformPath?: (path: string) => string;
}

/**
 * Decode percent-encoded characters in the path portion of a URL.
 * Query string is excluded — only the path is decoded.
 * This prevents bypasses where %2e%2e encodes '..' but path.posix.normalize
 * doesn't decode percent-encoding, so the allowlist check would pass while
 * the upstream server decodes and resolves the traversal.
 */
function decodePath(url: string): string {
  const qIdx = url.indexOf('?');
  const pathPart = qIdx >= 0 ? url.slice(0, qIdx) : url;
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart; // malformed encoding — use as-is, will fail allowlist
  }
}

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
    // Atomic write: write to temp file then rename to prevent corruption on crash.
    // Force 0o600 so `rename` can't silently downgrade an existing 0o600 file to
    // 0o644 via the default umask.
    const tmpFile = filePath + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(data) + '\n', { mode: 0o600 });
    fs.renameSync(tmpFile, filePath);
    logger.info('OAuth credentials saved to file');
  } catch (err) {
    logger.error({ err }, 'Failed to save credentials file');
  }
}

function refreshOAuthTokenOnce(
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

function isRetryable(err: Error): boolean {
  // Retry on 5xx server errors, network errors, and timeouts
  const msg = err.message;
  return (
    /\(5\d{2}\)/.test(msg) ||
    /timed out|ECONNR|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)
  );
}

async function refreshOAuthToken(
  refreshToken: string,
): Promise<OAuthCredentials> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
    try {
      return await refreshOAuthTokenOnce(refreshToken);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < REFRESH_MAX_RETRIES && isRetryable(lastErr)) {
        const delay = REFRESH_BASE_DELAY_MS * 2 ** attempt;
        logger.warn(
          { attempt: attempt + 1, delay, err: lastErr.message },
          'OAuth token refresh failed, retrying...',
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        break;
      }
    }
  }
  throw lastErr!;
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
        // Refresh token may have been rotated by a prior refresh — re-read
        // the credentials file and retry once with the updated token.
        if (credentialsFilePath) {
          const reloaded = loadCredentialsFile(credentialsFilePath);
          if (
            reloaded &&
            reloaded.refreshToken !== cachedCredentials!.refreshToken
          ) {
            logger.info(
              'Retrying OAuth refresh with updated credentials from file',
            );
            try {
              const newCreds = await refreshOAuthToken(reloaded.refreshToken);
              cachedCredentials = newCreds;
              saveCredentialsFile(credentialsFilePath, newCreds);
              logger.info(
                { expiresAt: new Date(newCreds.expiresAt).toISOString() },
                'OAuth token refreshed (retry)',
              );
              return newCreds.accessToken;
            } catch (retryErr) {
              logger.error(
                { err: retryErr },
                'OAuth token refresh retry also failed',
              );
            }
          }
        }
        logger.error({ err }, 'OAuth token refresh failed');
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
    'HA_URL',
    'HA_TOKEN',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const staticOAuthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN || '';

  // Reset module state so each proxy instance is self-contained.
  cachedCredentials = null;
  credentialsFilePath = null;
  refreshInProgress = null;

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

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );

  // --- Service routes (path-prefix-based non-Anthropic upstreams) ---
  const serviceRoutes: ServiceRoute[] = [];

  if (secrets.HA_URL && secrets.HA_TOKEN) {
    const haToken = secrets.HA_TOKEN;
    serviceRoutes.push({
      prefix: '/ha',
      upstream: new URL(secrets.HA_URL),
      allowedPaths: ['/api/'],
      injectCredentials: (headers) => {
        delete headers['authorization'];
        headers['authorization'] = `Bearer ${haToken}`;
      },
    });
    logger.info({ upstream: secrets.HA_URL }, 'HA service route registered');
  }

  /** Build the headers forwarded to an upstream. Centralized so every route
   * (Anthropic and service routes) gets the same hop-by-hop scrub. */
  function prepareHeaders(
    req: import('http').IncomingMessage,
    targetHost: string,
    body: Buffer,
  ): Record<string, string | number | string[] | undefined> {
    const headers: Record<string, string | number | string[] | undefined> = {
      ...(req.headers as Record<string, string>),
      host: targetHost,
      'content-length': body.length,
    };
    stripHopByHop(headers);
    return headers;
  }

  /** Forward a prepared request to the chosen upstream and pipe the response
   * back. On error, emit a 502 once and strip the query string from the log. */
  function forwardRequest(
    targetUrl: URL,
    upstreamPath: string,
    method: string,
    headers: Record<string, string | number | string[] | undefined>,
    body: Buffer,
    res: import('http').ServerResponse,
    logContext: string,
  ): void {
    const targetIsHttps = targetUrl.protocol === 'https:';
    const doRequest = targetIsHttps ? httpsRequest : httpRequest;

    const upstream = doRequest(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetIsHttps ? 443 : 80),
        path: upstreamPath,
        method,
        headers,
      } as RequestOptions,
      (upRes) => {
        res.writeHead(upRes.statusCode!, upRes.headers);
        upRes.pipe(res);
      },
    );

    upstream.on('error', (err) => {
      // Strip query string from logged path — service routes (e.g. Wolfram)
      // inject secrets into the query string.
      const logPath = upstreamPath.split('?')[0];
      logger.error({ err, path: logPath }, `${logContext} upstream error`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    upstream.write(body);
    upstream.end();
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const rawUrl = req.url || '/';
        // Decode percent-encoded path chars before normalization to prevent
        // bypasses like %2e%2e encoding '..' (see decodePath doc).
        const normalizedPath = path.posix.normalize(decodePath(rawUrl));

        // Preserve query string after path normalization.
        const qIdx = rawUrl.indexOf('?');
        const queryString = qIdx >= 0 ? rawUrl.slice(qIdx) : '';
        const body = Buffer.concat(chunks);

        // --- Try service routes first (path-prefix based) ---
        const matchedRoute = serviceRoutes.find((r) =>
          normalizedPath.startsWith(r.prefix + '/'),
        );

        if (matchedRoute) {
          const strippedPath = normalizedPath.slice(matchedRoute.prefix.length);

          if (!matchesPrefix(strippedPath, matchedRoute.allowedPaths)) {
            logger.warn(
              { path: normalizedPath, service: matchedRoute.prefix },
              'Blocked request to disallowed service path',
            );
            res.writeHead(403);
            res.end('Forbidden');
            return;
          }

          const headers = prepareHeaders(req, matchedRoute.upstream.host, body);
          // Strip container-supplied auth-bearing headers before injecting
          // route credentials — prevents leaking Anthropic/Claude credentials
          // (or replayed tokens / cookies) into HA / Wolfram / other service
          // upstreams. `proxy-authorization` is already dropped by stripHopByHop.
          // TODO: migrate to a per-route allowlist if a future route needs to
          // forward caller-supplied custom headers.
          delete headers['authorization'];
          delete headers['x-api-key'];
          delete headers['cookie'];
          delete headers['x-auth-token'];
          matchedRoute.injectCredentials(headers);

          const strippedWithQuery = strippedPath + queryString;
          const upstreamPath = matchedRoute.transformPath
            ? matchedRoute.transformPath(strippedWithQuery)
            : strippedWithQuery;

          forwardRequest(
            matchedRoute.upstream,
            upstreamPath,
            req.method || 'GET',
            headers,
            body,
            res,
            `Service ${matchedRoute.prefix}`,
          );
          return;
        }

        // --- Default: Anthropic proxy ---
        if (!matchesPrefix(normalizedPath, ALLOWED_PATH_PREFIXES)) {
          logger.warn(
            { path: normalizedPath },
            'Blocked request to disallowed path',
          );
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        const upstreamPath = normalizedPath + queryString;
        const headers = prepareHeaders(req, upstreamUrl.host, body);

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request. Also drop any
          // container-supplied Authorization so upstream can't see a Bearer
          // token in addition to our x-api-key (dual-auth ambiguity).
          delete headers['x-api-key'];
          delete headers['authorization'];
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

        forwardRequest(
          upstreamUrl,
          upstreamPath,
          req.method || 'GET',
          headers,
          body,
          res,
          'Credential proxy',
        );
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

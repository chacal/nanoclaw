/**
 * API token identity binding — maps bearer tokens to sender identities
 * for the external HTTP API (voice-api.ts).
 *
 * Config file lives at ~/.config/nanoclaw/api-tokens.json, OUTSIDE the
 * project root and is NOT mounted into any container — tamper-proof from
 * agents. Same pattern as mount-allowlist.json and sender-allowlist.json.
 *
 * Each token entry declares:
 *   - sender:     stable sender ID (e.g. "api:jouni", "api:hass")
 *   - senderName: display name shown to the agent
 *   - isFromMe:   whether injected messages carry owner/admin trust
 *                 (true → passes session-command and remote-control gates;
 *                  false → goes through normal allowlist + trigger flow)
 *
 * Tokens with isFromMe=false are still fully usable: the message lands in
 * the target chat and routes through the sender-allowlist, so e.g. a
 * Home Assistant token can participate in a group via allowlist without
 * gaining admin privileges.
 */
import fs from 'fs';

import { logger } from './logger.js';

export interface ApiTokenIdentity {
  sender: string;
  senderName: string;
  isFromMe: boolean;
}

interface ApiTokenConfig {
  tokens: Array<{ token: string } & ApiTokenIdentity>;
}

export function loadApiTokens(filePath: string): Map<string, ApiTokenIdentity> {
  if (!fs.existsSync(filePath)) {
    logger.warn(
      { path: filePath },
      'api-tokens.json not found — HTTP API will not accept any requests',
    );
    return new Map();
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: ApiTokenConfig;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`api-tokens.json is not valid JSON: ${msg}`);
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tokens)) {
    throw new Error('api-tokens.json must be an object with a "tokens" array');
  }

  const map = new Map<string, ApiTokenIdentity>();
  for (const entry of parsed.tokens) {
    if (!entry || typeof entry.token !== 'string' || !entry.token) {
      throw new Error(
        'api-tokens.json: each entry must have a non-empty "token" string',
      );
    }
    const preview = `${entry.token.slice(0, 4)}…`;
    if (typeof entry.sender !== 'string' || !entry.sender) {
      throw new Error(
        `api-tokens.json: token ${preview} missing non-empty "sender"`,
      );
    }
    if (typeof entry.senderName !== 'string' || !entry.senderName) {
      throw new Error(
        `api-tokens.json: token ${preview} missing non-empty "senderName"`,
      );
    }
    if (typeof entry.isFromMe !== 'boolean') {
      throw new Error(
        `api-tokens.json: token ${preview} must have a boolean "isFromMe"`,
      );
    }
    if (map.has(entry.token)) {
      throw new Error(
        `api-tokens.json: duplicate token (sender: ${entry.sender})`,
      );
    }
    map.set(entry.token, {
      sender: entry.sender,
      senderName: entry.senderName,
      isFromMe: entry.isFromMe,
    });
  }

  logger.info(
    { count: map.size, path: filePath },
    'Loaded API token identities',
  );
  return map;
}

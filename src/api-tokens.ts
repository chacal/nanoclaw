/**
 * API token identity binding — maps bearer tokens to v2 user identities
 * for the external HTTP API (external-api.ts).
 *
 * Config file lives at ~/.config/nanoclaw/api-tokens.json, OUTSIDE the
 * project root and is NOT mounted into any container — tamper-proof from
 * agents. Same pattern as mount-allowlist.json and sender-allowlist.json.
 *
 * Each token entry declares:
 *   - userId:      v2 user id, namespaced (e.g. "phone:+358xxx", "api:hass").
 *                  Trust comes from this user's user_roles row, not the token.
 *                  An owner-trust token simply binds to the owner's existing
 *                  v2 user identity; an HA-style token binds to a synthetic
 *                  "api:hass" user that is added to agent_group_members for
 *                  exactly the agent groups it should reach.
 *   - platformId:  stable platform id used to route to a wired messaging
 *                  group (channel_type='api', platform_id=<this>). Pre-wire
 *                  via setup before tokens fire — first request otherwise
 *                  triggers the channel-request approval flow.
 *   - displayName: shown to the agent and recorded as users.display_name on
 *                  first sight (the senderResolver upserts).
 */
import fs from 'fs';

import type { DeliveryAddress } from './channels/adapter.js';
import { log } from './log.js';

export interface ApiTokenIdentity {
  userId: string;
  platformId: string;
  displayName: string;
  /**
   * Redirect the agent's reply to a different channel/platform than the api
   * channel itself (which has no return surface — see src/channels/api.ts).
   * Set this when the webhook source (e.g. Home Assistant) should trigger a
   * response that lands in the user's real chat (e.g. their Signal DM).
   *
   * Stamped onto the InboundEvent's `replyTo` so the router stamps the
   * outbound delivery address from this instead of the api inbound origin.
   */
  replyTo?: DeliveryAddress;
}

interface ApiTokenConfig {
  tokens: Array<{ token: string } & ApiTokenIdentity>;
}

export function loadApiTokens(filePath: string): Map<string, ApiTokenIdentity> {
  if (!fs.existsSync(filePath)) {
    log.warn('api-tokens.json not found — external HTTP API will not start', { path: filePath });
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
      throw new Error('api-tokens.json: each entry must have a non-empty "token" string');
    }
    const preview = `${entry.token.slice(0, 4)}…`;
    if (typeof entry.userId !== 'string' || !entry.userId) {
      throw new Error(`api-tokens.json: token ${preview} missing non-empty "userId"`);
    }
    if (typeof entry.platformId !== 'string' || !entry.platformId) {
      throw new Error(`api-tokens.json: token ${preview} missing non-empty "platformId"`);
    }
    if (typeof entry.displayName !== 'string' || !entry.displayName) {
      throw new Error(`api-tokens.json: token ${preview} missing non-empty "displayName"`);
    }
    const replyTo = parseReplyTo(entry.replyTo, preview);
    if (map.has(entry.token)) {
      throw new Error(`api-tokens.json: duplicate token (userId: ${entry.userId})`);
    }
    map.set(entry.token, {
      userId: entry.userId,
      platformId: entry.platformId,
      displayName: entry.displayName,
      ...(replyTo ? { replyTo } : {}),
    });
  }

  log.info('Loaded API token identities', { count: map.size, path: filePath });
  return map;
}

function parseReplyTo(raw: unknown, tokenPreview: string): DeliveryAddress | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`api-tokens.json: token ${tokenPreview} "replyTo" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.channelType !== 'string' || !obj.channelType) {
    throw new Error(`api-tokens.json: token ${tokenPreview} "replyTo.channelType" must be a non-empty string`);
  }
  if (typeof obj.platformId !== 'string' || !obj.platformId) {
    throw new Error(`api-tokens.json: token ${tokenPreview} "replyTo.platformId" must be a non-empty string`);
  }
  let threadId: string | null;
  if (obj.threadId === undefined || obj.threadId === null) {
    threadId = null;
  } else if (typeof obj.threadId === 'string') {
    threadId = obj.threadId;
  } else {
    throw new Error(`api-tokens.json: token ${tokenPreview} "replyTo.threadId" must be a string or null`);
  }
  return { channelType: obj.channelType, platformId: obj.platformId, threadId };
}

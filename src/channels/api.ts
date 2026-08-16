/**
 * External HTTP API channel — webhook input from external systems.
 *
 * Synthetic channel: no live platform, no remote conversations. Bridges
 * authenticated webhook POSTs into v2's router via `onInbound`. The request
 * handler lives in src/external-api.ts and is mounted as a raw route on the
 * shared webhook server (`/webhook/api`); this module is just the
 * channel-adapter shell so the API plugs into the standard lifecycle
 * (factory, setup, teardown) and identity/access pipeline.
 *
 * No deliver() return path: external systems (Home Assistant, scripts, iOS
 * shortcuts) fire webhooks without polling for replies. If an agent replies
 * to an api-channel message, the outbound row is persisted but no platform
 * delivery happens — log and drop. Use `replyTo` to redirect replies to a
 * real channel if a use case ever needs it.
 *
 * First request from a new token-platformId triggers v2's
 * channel-request-gate (owner-approval card) — same as a fresh real channel.
 */
import os from 'os';
import path from 'path';

import { loadApiTokens } from '../api-tokens.js';
import { API_WEBHOOK_ROUTE, createExternalApiHandler } from '../external-api.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const TOKENS_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'api-tokens.json');

/**
 * Webhook events: every authenticated POST is "for the agent" (pattern '.'),
 * senders are bound to v2 identities by bearer token — auto-created
 * messaging_groups stay 'strict' so an unknown token identity still needs
 * membership. Events arrive as DM-shaped messages with isMention=true, so
 * the mention signal is 'dm-only'. No threads.
 */
const API_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

function createAdapter(): ChannelAdapter | null {
  const identities = loadApiTokens(TOKENS_PATH);
  if (identities.size === 0) {
    // No tokens configured — skip the adapter entirely (matches the
    // "missing credentials" pattern other channels use).
    return null;
  }

  // The shared webhook server has no unregister API; teardown flips this
  // flag so the mounted route refuses requests instead of vanishing.
  let active = false;

  return {
    name: 'api',
    channelType: 'api',
    supportsThreads: false,
    defaults: API_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      const handler = createExternalApiHandler({
        identities,
        onInbound: config.onInbound,
        onInboundEvent: config.onInboundEvent,
      });
      registerWebhookHandler(API_WEBHOOK_ROUTE, async (req, res) => {
        if (!active) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'API channel not active' }));
          return;
        }
        await handler(req, res);
      });
      active = true;
    },

    async teardown(): Promise<void> {
      active = false;
    },

    isConnected(): boolean {
      return active;
    },

    async deliver(platformId, _threadId, _message: OutboundMessage): Promise<string | undefined> {
      log.warn('External API has no return channel — outbound message dropped', { platformId });
      return undefined;
    },
  };
}

registerChannelAdapter('api', { factory: createAdapter, defaults: API_DEFAULTS });

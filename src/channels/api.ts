/**
 * External HTTP API channel — webhook input from external systems.
 *
 * Synthetic channel: no live platform, no remote conversations. Bridges
 * authenticated webhook POSTs into v2's router via `onInbound`. The HTTP
 * server itself lives in src/external-api.ts; this module is just the
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
import http from 'http';
import os from 'os';
import path from 'path';

import { loadApiTokens } from '../api-tokens.js';
import { readEnvFile } from '../env.js';
import { startExternalApi } from '../external-api.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const TOKENS_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'api-tokens.json');

function defaultPort(): number {
  // Match the `readEnvFile` + `process.env` precedence used by channel
  // adapters elsewhere in the tree. The systemd unit doesn't load .env
  // automatically, so reading `process.env` alone would silently ignore
  // the EXTERNAL_API_PORT entry that .env.example documents.
  const fromDotenv = readEnvFile(['EXTERNAL_API_PORT']).EXTERNAL_API_PORT;
  return parseInt(fromDotenv || process.env.EXTERNAL_API_PORT || '3002', 10);
}

function defaultHost(): string {
  // Default loopback so bearer tokens don't travel cleartext on the LAN.
  // Installs that need an external service (e.g. Home Assistant on a
  // separate host) to POST webhooks set EXTERNAL_API_HOST=0.0.0.0 or a
  // specific LAN IP in .env. Same readEnvFile precedence as the port.
  const fromDotenv = readEnvFile(['EXTERNAL_API_HOST']).EXTERNAL_API_HOST;
  return fromDotenv || process.env.EXTERNAL_API_HOST || '127.0.0.1';
}

function createAdapter(): ChannelAdapter | null {
  const identities = loadApiTokens(TOKENS_PATH);
  if (identities.size === 0) {
    // No tokens configured — skip the adapter entirely (matches the
    // "missing credentials" pattern other channels use).
    return null;
  }

  let server: http.Server | null = null;

  return {
    name: 'api',
    channelType: 'api',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      // Await the bind so a port-in-use rejects setup, which lets
      // initChannelAdapters log + skip cleanly instead of crashing on an
      // unhandled async 'error' event later.
      server = await startExternalApi(defaultPort(), defaultHost(), {
        identities,
        onInbound: config.onInbound,
        onInboundEvent: config.onInboundEvent,
      });
    },

    async teardown(): Promise<void> {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null && server.listening;
    },

    async deliver(platformId, _threadId, _message: OutboundMessage): Promise<string | undefined> {
      log.warn('External API has no return channel — outbound message dropped', { platformId });
      return undefined;
    },
  };
}

registerChannelAdapter('api', { factory: createAdapter });

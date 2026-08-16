/**
 * Host-side integrations: Google Workspace CLI, Home Assistant, Wolfram Alpha.
 *
 * Each integration is opt-in. Nothing is contributed unless the host has the
 * relevant config files (e.g. `~/.config/gws/credentials.enc`) or `.env`
 * entries. The result is merged into the container spawn args alongside the
 * provider contribution and default mounts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

export interface HostIntegrationContribution {
  mounts: VolumeMount[];
  env: Record<string, string>;
}

/**
 * Resolve all host-side integrations into container mounts + env vars.
 * Returns an empty contribution when none of the integrations are
 * configured on the host.
 */
export function resolveHostIntegrations(): HostIntegrationContribution {
  const mounts: VolumeMount[] = [];
  const env: Record<string, string> = {};

  // Google Workspace CLI: mount the encrypted credential dir RW so gws can
  // refresh its access-token cache. Require BOTH the ciphertext and the AES
  // key — mounting just one side leaves the container able to write into a
  // dir gws can't decrypt, corrupting host-side state.
  const gwsDir = path.join(process.env.HOME || os.homedir(), '.config', 'gws');
  if (fs.existsSync(path.join(gwsDir, 'credentials.enc')) && fs.existsSync(path.join(gwsDir, '.encryption_key'))) {
    mounts.push({ hostPath: gwsDir, containerPath: '/workspace/gws-config', readonly: false });
    env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = '/workspace/gws-config';
    env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND = 'file';
  }

  // The HA shim needs its target URL from env; its authorization is injected
  // by OneCLI host-pattern matching. Wolfram deliberately appears nowhere
  // here: as of 2026-08-16 its appid is a query-param-injecting vault secret
  // (host pattern api.wolframalpha.com), so the shim needs no env at all and
  // is simply always present in the image. Do not reintroduce WOLFRAM_APP_ID —
  // that would put the credential back in clear text in the container env.
  const envFile = readEnvFile(['HA_BASE_URL']);
  if (envFile.HA_BASE_URL) env.HA_BASE_URL = envFile.HA_BASE_URL;

  return { mounts, env };
}

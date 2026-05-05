import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveHostIntegrations } from './host-integrations.js';

let tmpHome: string;
let tmpCwd: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-hi-home-'));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-hi-cwd-'));
  process.env.HOME = tmpHome;
  process.chdir(tmpCwd);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe('resolveHostIntegrations', () => {
  it('returns nothing when no host state is configured', () => {
    const result = resolveHostIntegrations();
    expect(result.mounts).toEqual([]);
    expect(result.env).toEqual({});
  });

  it('mounts gws config + sets env when both credential files exist', () => {
    const gwsDir = path.join(tmpHome, '.config', 'gws');
    fs.mkdirSync(gwsDir, { recursive: true });
    fs.writeFileSync(path.join(gwsDir, 'credentials.enc'), 'cipher');
    fs.writeFileSync(path.join(gwsDir, '.encryption_key'), 'key');

    const result = resolveHostIntegrations();

    expect(result.mounts).toEqual([{ hostPath: gwsDir, containerPath: '/workspace/gws-config', readonly: false }]);
    expect(result.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe('/workspace/gws-config');
    expect(result.env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND).toBe('file');
  });

  it('skips gws when only one of the credential files is present', () => {
    const gwsDir = path.join(tmpHome, '.config', 'gws');
    fs.mkdirSync(gwsDir, { recursive: true });
    fs.writeFileSync(path.join(gwsDir, 'credentials.enc'), 'cipher');
    // .encryption_key intentionally missing

    const result = resolveHostIntegrations();
    expect(result.mounts).toEqual([]);
    expect(result.env).toEqual({});
  });

  it('passes HA_BASE_URL and WOLFRAM_APP_ID through from .env', () => {
    fs.writeFileSync(
      path.join(tmpCwd, '.env'),
      ['HA_BASE_URL=http://ha.local:8123', 'WOLFRAM_APP_ID=ABCD-EF1234'].join('\n') + '\n',
    );

    const result = resolveHostIntegrations();
    expect(result.env.HA_BASE_URL).toBe('http://ha.local:8123');
    expect(result.env.WOLFRAM_APP_ID).toBe('ABCD-EF1234');
  });

  it('omits unset .env entries', () => {
    fs.writeFileSync(path.join(tmpCwd, '.env'), 'WOLFRAM_APP_ID=key\n');

    const result = resolveHostIntegrations();
    expect(result.env.WOLFRAM_APP_ID).toBe('key');
    expect(result.env.HA_BASE_URL).toBeUndefined();
  });
});

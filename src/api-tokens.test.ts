import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

import { loadApiTokens } from './api-tokens.js';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-api-tokens-'));
  configPath = path.join(tmpDir, 'api-tokens.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(obj: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(obj));
}

describe('loadApiTokens', () => {
  it('returns empty map when file is missing', () => {
    const map = loadApiTokens(path.join(tmpDir, 'does-not-exist.json'));
    expect(map.size).toBe(0);
  });

  it('loads valid config into a map keyed by token', () => {
    write({
      tokens: [
        {
          token: 'owner-secret',
          userId: 'phone:+358401112222',
          platformId: 'owner-main',
          displayName: 'External (Jouni)',
        },
        {
          token: 'hass-secret',
          userId: 'api:hass',
          platformId: 'hass-main',
          displayName: 'Home Assistant',
        },
      ],
    });
    const map = loadApiTokens(configPath);
    expect(map.size).toBe(2);
    expect(map.get('owner-secret')).toEqual({
      userId: 'phone:+358401112222',
      platformId: 'owner-main',
      displayName: 'External (Jouni)',
    });
    expect(map.get('hass-secret')).toEqual({
      userId: 'api:hass',
      platformId: 'hass-main',
      displayName: 'Home Assistant',
    });
  });

  it('throws on invalid JSON', () => {
    fs.writeFileSync(configPath, 'not json {{{');
    expect(() => loadApiTokens(configPath)).toThrow(/not valid JSON/);
  });

  it('throws when root is not an object with tokens array', () => {
    write({ foo: 'bar' });
    expect(() => loadApiTokens(configPath)).toThrow(/tokens.*array/);
  });

  it('throws when token field is missing or empty', () => {
    write({
      tokens: [{ userId: 'api:x', platformId: 'x', displayName: 'X' }],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/non-empty "token"/);
  });

  it('throws when userId is missing', () => {
    write({
      tokens: [{ token: 't', platformId: 'p', displayName: 'X' }],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/"userId"/);
  });

  it('throws when platformId is missing', () => {
    write({
      tokens: [{ token: 't', userId: 'api:x', displayName: 'X' }],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/"platformId"/);
  });

  it('throws when displayName is missing', () => {
    write({
      tokens: [{ token: 't', userId: 'api:x', platformId: 'p' }],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/"displayName"/);
  });

  it('parses optional replyTo when present', () => {
    write({
      tokens: [
        {
          token: 'hass-secret',
          userId: 'api:hass',
          platformId: 'hass-main',
          displayName: 'Home Assistant',
          replyTo: { channelType: 'signal', platformId: 'sig-uuid-1', threadId: null },
        },
      ],
    });
    const map = loadApiTokens(configPath);
    expect(map.get('hass-secret')?.replyTo).toEqual({
      channelType: 'signal',
      platformId: 'sig-uuid-1',
      threadId: null,
    });
  });

  it('omits replyTo from identity when not declared', () => {
    write({
      tokens: [{ token: 't', userId: 'api:x', platformId: 'p', displayName: 'X' }],
    });
    const id = loadApiTokens(configPath).get('t')!;
    expect(id.replyTo).toBeUndefined();
  });

  it('rejects replyTo with missing channelType', () => {
    write({
      tokens: [
        {
          token: 't',
          userId: 'api:x',
          platformId: 'p',
          displayName: 'X',
          replyTo: { platformId: 'sig-uuid-1' },
        },
      ],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/replyTo\.channelType/);
  });

  it('rejects replyTo with missing platformId', () => {
    write({
      tokens: [
        {
          token: 't',
          userId: 'api:x',
          platformId: 'p',
          displayName: 'X',
          replyTo: { channelType: 'signal' },
        },
      ],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/replyTo\.platformId/);
  });

  it('rejects replyTo with non-string threadId', () => {
    write({
      tokens: [
        {
          token: 't',
          userId: 'api:x',
          platformId: 'p',
          displayName: 'X',
          replyTo: { channelType: 'signal', platformId: 'sig', threadId: 123 },
        },
      ],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/replyTo\.threadId/);
  });

  it('throws on duplicate tokens', () => {
    write({
      tokens: [
        { token: 'dup', userId: 'api:a', platformId: 'a', displayName: 'A' },
        { token: 'dup', userId: 'api:b', platformId: 'b', displayName: 'B' },
      ],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/duplicate token/);
  });
});

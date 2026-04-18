import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

  it('loads valid config into a map', () => {
    write({
      tokens: [
        {
          token: 'jouni-secret',
          sender: 'api:jouni',
          senderName: 'Jouni',
          isFromMe: true,
        },
        {
          token: 'hass-secret',
          sender: 'api:hass',
          senderName: 'Home Assistant',
          isFromMe: false,
        },
      ],
    });
    const map = loadApiTokens(configPath);
    expect(map.size).toBe(2);
    expect(map.get('jouni-secret')).toEqual({
      sender: 'api:jouni',
      senderName: 'Jouni',
      isFromMe: true,
    });
    expect(map.get('hass-secret')).toEqual({
      sender: 'api:hass',
      senderName: 'Home Assistant',
      isFromMe: false,
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
      tokens: [{ sender: 'api:x', senderName: 'X', isFromMe: false }],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/non-empty "token"/);
  });

  it('throws when sender is missing', () => {
    write({
      tokens: [{ token: 't', senderName: 'X', isFromMe: false }],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/"sender"/);
  });

  it('throws when senderName is missing', () => {
    write({
      tokens: [{ token: 't', sender: 's', isFromMe: false }],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/"senderName"/);
  });

  it('throws when isFromMe is not boolean', () => {
    write({
      tokens: [
        { token: 't', sender: 's', senderName: 'S', isFromMe: 'yes' as any },
      ],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/boolean "isFromMe"/);
  });

  it('throws on duplicate tokens', () => {
    write({
      tokens: [
        { token: 'dup', sender: 'api:a', senderName: 'A', isFromMe: false },
        { token: 'dup', sender: 'api:b', senderName: 'B', isFromMe: true },
      ],
    });
    expect(() => loadApiTokens(configPath)).toThrow(/duplicate token/);
  });
});

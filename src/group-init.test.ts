import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContainerConfig } from './container-config.js';
import { composeClaudeSettings, regenerateClaudeSettings } from './group-init.js';

function baseConfig(extra: Partial<ContainerConfig> = {}): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    ...extra,
  };
}

describe('composeClaudeSettings', () => {
  it('emits only env defaults when no per-group overrides are set and no existing fields', () => {
    const settings = JSON.parse(composeClaudeSettings({}, baseConfig()));

    expect(settings.env).toEqual({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    });
    expect(settings.model).toBeUndefined();
    expect(settings.thinkingBudget).toBeUndefined();
    expect(settings.smallModelId).toBeUndefined();
  });

  it('writes container.json overrides on top of an existing file', () => {
    const settings = JSON.parse(
      composeClaudeSettings(
        {},
        baseConfig({
          model: 'claude-sonnet-4-6',
          thinkingBudget: 'high',
          smallModelId: 'claude-haiku-4-5',
        }),
      ),
    );

    expect(settings.model).toBe('claude-sonnet-4-6');
    expect(settings.thinkingBudget).toBe('high');
    expect(settings.smallModelId).toBe('claude-haiku-4-5');
  });

  it('preserves unrelated user-set top-level fields', () => {
    const existing = {
      permissions: { allow: ['Bash(ls:*)'] },
      plugins: { marketplace: 'foo' },
      'some-future-key': 42,
    };

    const settings = JSON.parse(composeClaudeSettings(existing, baseConfig()));

    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings.plugins).toEqual({ marketplace: 'foo' });
    expect(settings['some-future-key']).toBe(42);
  });

  it('lets user-set env vars win over host defaults', () => {
    const existing = { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', MY_VAR: 'x' } };

    const settings = JSON.parse(composeClaudeSettings(existing, baseConfig()));

    expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(settings.env.MY_VAR).toBe('x');
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  it('preserves an existing model when container.json has no override', () => {
    const existing = { model: 'claude-haiku-4-5', thinkingBudget: 'medium' };

    const settings = JSON.parse(composeClaudeSettings(existing, baseConfig()));

    expect(settings.model).toBe('claude-haiku-4-5');
    expect(settings.thinkingBudget).toBe('medium');
  });

  it('container.json model override wins over existing value', () => {
    const existing = { model: 'claude-haiku-4-5' };

    const settings = JSON.parse(composeClaudeSettings(existing, baseConfig({ model: 'claude-sonnet-4-6' })));

    expect(settings.model).toBe('claude-sonnet-4-6');
  });

  it('terminates with a trailing newline', () => {
    expect(composeClaudeSettings({}, baseConfig()).endsWith('\n')).toBe(true);
  });
});

describe('regenerateClaudeSettings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-settings-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes defaults when the file does not exist', () => {
    const filePath = path.join(tmpDir, 'settings.json');

    regenerateClaudeSettings(filePath, baseConfig());

    const settings = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  it('preserves user-set fields when overlaying overrides', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'] },
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        model: 'claude-haiku-4-5',
      }),
    );

    regenerateClaudeSettings(filePath, baseConfig({ thinkingBudget: 'high' }));

    const settings = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(settings.model).toBe('claude-haiku-4-5');
    expect(settings.thinkingBudget).toBe('high');
  });

  it('starts clean when the existing file is malformed JSON', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(filePath, '{not valid json');

    regenerateClaudeSettings(filePath, baseConfig({ model: 'claude-sonnet-4-6' }));

    const settings = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(settings.model).toBe('claude-sonnet-4-6');
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });
});

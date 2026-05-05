import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { composeGroupClaudeMd, migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { GROUPS_DIR } from './config.js';
import type { AgentGroup } from './types.js';

function fakeGroup(folder: string): AgentGroup {
  return {
    id: 'test-group-id',
    name: folder,
    folder,
    agent_provider: null,
    created_at: '2026-05-03T00:00:00Z',
  };
}

const GLOBAL_SOUL_PATH = path.resolve(GROUPS_DIR, 'global', 'SOUL.md');

// Tests in this file mutate `groups/global/SOUL.md` to exercise the shared
// persona slot. Snapshot the host's real value once before any test runs and
// restore it after, so a developer running the suite with their actual fork
// SOUL.md in place doesn't lose it.
let savedGlobalSoul: string | null = null;
beforeAll(() => {
  if (fs.existsSync(GLOBAL_SOUL_PATH)) {
    savedGlobalSoul = fs.readFileSync(GLOBAL_SOUL_PATH, 'utf-8');
  }
});
afterAll(() => {
  if (savedGlobalSoul === null) {
    if (fs.existsSync(GLOBAL_SOUL_PATH)) fs.unlinkSync(GLOBAL_SOUL_PATH);
  } else {
    fs.mkdirSync(path.dirname(GLOBAL_SOUL_PATH), { recursive: true });
    fs.writeFileSync(GLOBAL_SOUL_PATH, savedGlobalSoul);
  }
});

function clearGlobalSoul(): void {
  if (fs.existsSync(GLOBAL_SOUL_PATH)) fs.unlinkSync(GLOBAL_SOUL_PATH);
}

describe('composeGroupClaudeMd — group SOUL.md', () => {
  let folder: string;
  let groupDir: string;

  beforeEach(() => {
    folder = `test-soul-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });
    clearGlobalSoul();
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
    clearGlobalSoul();
  });

  it('emits a per-group persona fragment when group SOUL.md is present', () => {
    fs.writeFileSync(path.join(groupDir, 'SOUL.md'), 'I am terse and helpful.\n');

    composeGroupClaudeMd(fakeGroup(folder));

    const fragmentPath = path.join(groupDir, '.claude-fragments', 'zzz-group-soul.md');
    expect(fs.existsSync(fragmentPath)).toBe(true);

    const fragment = fs.readFileSync(fragmentPath, 'utf-8');
    expect(fragment).toContain('## Agent Persona (this group)');
    expect(fragment).toContain('I am terse and helpful.');

    const composed = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    expect(composed).toContain('@./.claude-fragments/zzz-group-soul.md');
  });

  it('omits the per-group persona fragment when group SOUL.md is absent', () => {
    composeGroupClaudeMd(fakeGroup(folder));

    const fragmentPath = path.join(groupDir, '.claude-fragments', 'zzz-group-soul.md');
    expect(fs.existsSync(fragmentPath)).toBe(false);

    const composed = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    expect(composed).not.toContain('zzz-group-soul.md');
  });

  it('drops the per-group persona fragment when SOUL.md is removed between spawns', () => {
    const soulPath = path.join(groupDir, 'SOUL.md');
    fs.writeFileSync(soulPath, 'persona v1');
    composeGroupClaudeMd(fakeGroup(folder));

    fs.unlinkSync(soulPath);
    composeGroupClaudeMd(fakeGroup(folder));

    expect(fs.existsSync(path.join(groupDir, '.claude-fragments', 'zzz-group-soul.md'))).toBe(false);
  });

  it('orders the per-group persona last in the import list', () => {
    fs.writeFileSync(path.join(groupDir, 'SOUL.md'), 'persona');
    composeGroupClaudeMd(fakeGroup(folder));

    const composed = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    const lines = composed.split('\n').filter((l) => l.startsWith('@./.claude-fragments/'));
    if (lines.length > 1) {
      expect(lines[lines.length - 1]).toContain('zzz-group-soul.md');
    }
  });
});

describe('composeGroupClaudeMd — global SOUL.md', () => {
  let folder: string;
  let groupDir: string;

  beforeEach(() => {
    folder = `test-global-soul-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });
    clearGlobalSoul();
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
    clearGlobalSoul();
  });

  it('emits a global persona fragment when groups/global/SOUL.md is present', () => {
    fs.mkdirSync(path.dirname(GLOBAL_SOUL_PATH), { recursive: true });
    fs.writeFileSync(GLOBAL_SOUL_PATH, 'I am Pentti, the family assistant.\n');

    composeGroupClaudeMd(fakeGroup(folder));

    const fragmentPath = path.join(groupDir, '.claude-fragments', 'zz-global-soul.md');
    expect(fs.existsSync(fragmentPath)).toBe(true);

    const fragment = fs.readFileSync(fragmentPath, 'utf-8');
    expect(fragment).toContain('## Agent Persona (shared)');
    expect(fragment).toContain('I am Pentti, the family assistant.');

    const composed = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    expect(composed).toContain('@./.claude-fragments/zz-global-soul.md');
  });

  it('omits the global persona fragment when groups/global/SOUL.md is absent', () => {
    composeGroupClaudeMd(fakeGroup(folder));

    const fragmentPath = path.join(groupDir, '.claude-fragments', 'zz-global-soul.md');
    expect(fs.existsSync(fragmentPath)).toBe(false);

    const composed = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    expect(composed).not.toContain('zz-global-soul.md');
  });

  it('does NOT include global SOUL when composing for the global group itself (no self-reference)', () => {
    fs.mkdirSync(path.dirname(GLOBAL_SOUL_PATH), { recursive: true });
    fs.writeFileSync(GLOBAL_SOUL_PATH, 'global persona\n');

    composeGroupClaudeMd(fakeGroup('global'));

    const fragmentPath = path.resolve(GROUPS_DIR, 'global', '.claude-fragments', 'zz-global-soul.md');
    expect(fs.existsSync(fragmentPath)).toBe(false);
  });

  it('orders global persona before group persona (zz- before zzz-)', () => {
    fs.mkdirSync(path.dirname(GLOBAL_SOUL_PATH), { recursive: true });
    fs.writeFileSync(GLOBAL_SOUL_PATH, 'global persona\n');
    fs.writeFileSync(path.join(groupDir, 'SOUL.md'), 'group persona\n');

    composeGroupClaudeMd(fakeGroup(folder));

    const composed = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    const fragmentLines = composed.split('\n').filter((l) => l.startsWith('@./.claude-fragments/'));
    const globalIdx = fragmentLines.findIndex((l) => l.includes('zz-global-soul.md'));
    const groupIdx = fragmentLines.findIndex((l) => l.includes('zzz-group-soul.md'));
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(groupIdx).toBeGreaterThanOrEqual(0);
    expect(globalIdx).toBeLessThan(groupIdx);
  });
});

describe('migrateGroupsToClaudeLocal — fork-local groups/global preservation', () => {
  // Use a throwaway temp dir for these tests — migrateGroupsToClaudeLocal
  // iterates the entire groupsDir and renames per-group CLAUDE.md files,
  // which would mutate live family data if pointed at the real GROUPS_DIR.
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-compose-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('preserves groups/global/ instead of deleting it (fork-local)', () => {
    const globalDir = path.join(tmp, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'SOUL.md'), 'install-wide persona\n');

    migrateGroupsToClaudeLocal(tmp);

    expect(fs.existsSync(globalDir)).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'SOUL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(globalDir, 'SOUL.md'), 'utf-8')).toContain('install-wide persona');
  });

  it('still renames per-group CLAUDE.md → CLAUDE.local.md for non-global groups', () => {
    const dir = path.join(tmp, 'some_group');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'v1 group memory\n');

    migrateGroupsToClaudeLocal(tmp);

    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'CLAUDE.local.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.local.md'), 'utf-8')).toContain('v1 group memory');
  });

  it('does not overwrite existing CLAUDE.local.md', () => {
    const dir = path.join(tmp, 'group_with_existing_local');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'v1 content\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), 'existing v2 memory\n');

    migrateGroupsToClaudeLocal(tmp);

    expect(fs.readFileSync(path.join(dir, 'CLAUDE.local.md'), 'utf-8')).toContain('existing v2 memory');
    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(true);
  });
});

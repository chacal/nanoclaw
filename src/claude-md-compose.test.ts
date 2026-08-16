import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-claude-md-compose-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-claude-md-compose-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { composeGroupClaudeMd } from './claude-md-compose.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function seed(ag: AgentGroup): void {
  createAgentGroup(ag);
  ensureContainerConfig(ag.id);
}

function writePersona(folder: string, text: string): void {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PERSONA_PREPEND_FILE), text);
}

function importsOf(folder: string): string[] {
  const md = fs.readFileSync(path.join(GROUPS_DIR, folder, 'CLAUDE.md'), 'utf-8');
  return md.split('\n').filter((line) => line.startsWith('@'));
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('composeGroupClaudeMd persona prepend', () => {
  it('imports the persona fragment FIRST, before the shared base', () => {
    const ag = group('ag-persona', 'persona-group');
    seed(ag);
    writePersona(ag.folder, 'You are an SDR agent.\n');

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-fragments/persona.md');
    expect(imports[1]).toBe('@./.claude-shared.md');
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'), 'utf-8')).toBe(
      'You are an SDR agent.',
    );
  });

  it('keeps the persona across a second compose (not pruned)', () => {
    const ag = group('ag-persona-2', 'persona-group-2');
    seed(ag);
    writePersona(ag.folder, 'persona body');

    composeGroupClaudeMd(ag);
    composeGroupClaudeMd(ag);

    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(true);
    expect(importsOf(ag.folder)[0]).toBe('@./.claude-fragments/persona.md');
  });

  it('is inert when no persona file is present (non-template groups)', () => {
    const ag = group('ag-no-persona', 'no-persona-group');
    seed(ag);

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-shared.md');
    expect(imports).not.toContain('@./.claude-fragments/persona.md');
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(false);
  });
});

describe('composeGroupClaudeMd SOUL layers (fork)', () => {
  function writeSoul(folder: string, text: string): void {
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SOUL.md'), text);
  }

  it('imports the global soul for a non-global group, after built-in fragments', () => {
    const ag = group('ag-soul-1', 'soul-group-1');
    seed(ag);
    writeSoul('global', 'Shared persona.');

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[imports.length - 1]).toBe('@./.claude-fragments/soul-global.md');
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'soul-global.md'), 'utf-8')).toBe(
      'Shared persona.',
    );
  });

  it('imports group soul last, after the global soul', () => {
    const ag = group('ag-soul-2', 'soul-group-2');
    seed(ag);
    writeSoul('global', 'Shared persona.');
    writeSoul(ag.folder, 'Group persona override.');

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[imports.length - 2]).toBe('@./.claude-fragments/soul-global.md');
    expect(imports[imports.length - 1]).toBe('@./.claude-fragments/soul-group.md');
    // Both come after the shared base and every built-in fragment.
    expect(imports.indexOf('@./.claude-shared.md')).toBeLessThan(
      imports.indexOf('@./.claude-fragments/soul-global.md'),
    );
  });

  it('does not apply the global soul to the global folder itself', () => {
    const ag = group('ag-soul-global', 'global');
    seed(ag);
    writeSoul('global', 'Shared persona.');

    composeGroupClaudeMd(ag);

    const imports = importsOf('global');
    expect(imports).not.toContain('@./.claude-fragments/soul-global.md');
    // The global folder's own SOUL.md still applies as its group soul.
    expect(imports[imports.length - 1]).toBe('@./.claude-fragments/soul-group.md');
  });

  it('is inert when no SOUL files exist', () => {
    const ag = group('ag-soul-none', 'soul-group-none');
    seed(ag);

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports.join('\n')).not.toContain('soul-');
  });

  it('keeps soul fragments across recompose and prunes them when the file is deleted', () => {
    const ag = group('ag-soul-prune', 'soul-group-prune');
    seed(ag);
    writeSoul(ag.folder, 'Persona v1.');

    composeGroupClaudeMd(ag);
    composeGroupClaudeMd(ag);
    const fragPath = path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'soul-group.md');
    expect(fs.existsSync(fragPath)).toBe(true);

    fs.unlinkSync(path.join(GROUPS_DIR, ag.folder, 'SOUL.md'));
    composeGroupClaudeMd(ag);
    expect(fs.existsSync(fragPath)).toBe(false);
    expect(importsOf(ag.folder).join('\n')).not.toContain('soul-');
  });

  it('layers souls together with a template persona: persona first, souls last', () => {
    const ag = group('ag-soul-persona', 'soul-persona-group');
    seed(ag);
    writePersona(ag.folder, 'Template persona.');
    writeSoul('global', 'Shared persona.');
    writeSoul(ag.folder, 'Group persona.');

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-fragments/persona.md');
    expect(imports[1]).toBe('@./.claude-shared.md');
    expect(imports[imports.length - 2]).toBe('@./.claude-fragments/soul-global.md');
    expect(imports[imports.length - 1]).toBe('@./.claude-fragments/soul-group.md');
  });
});

describe('composeGroupClaudeMd scheduling instructions (ncl tasks reach-in)', () => {
  // Red-on-delete guard for the `scheduling`/`cli` exclusion at the
  // module-fragment loop: the agent is taught `ncl tasks` iff it has ncl.
  it('imports module-scheduling.md at the default cli_scope', () => {
    const ag = group('ag-sched', 'sched-group');
    seed(ag);

    composeGroupClaudeMd(ag);

    expect(importsOf(ag.folder)).toContain('@./.claude-fragments/module-scheduling.md');
  });

  it('excludes module-scheduling.md (and module-cli.md) when cli_scope is disabled', () => {
    const ag = group('ag-sched-off', 'sched-group-off');
    seed(ag);
    updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports).not.toContain('@./.claude-fragments/module-scheduling.md');
    expect(imports).not.toContain('@./.claude-fragments/module-cli.md');
  });
});

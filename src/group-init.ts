import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { type ContainerConfig, initContainerConfig } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

/**
 * Default Claude Code settings — written at group init and re-written on
 * every spawn merged with per-group overrides from `container.json`. The
 * file lives at `data/v2-sessions/<id>/.claude-shared/settings.json` and is
 * mounted into the container at `/home/node/.claude/settings.json` (user
 * scope), so it's always re-read by Claude Code on each spawn.
 */
export const DEFAULT_CLAUDE_SETTINGS = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
};

/**
 * Compose the Claude Code settings.json for a group by overlaying
 * `container.json` overrides onto the existing on-disk settings (or an
 * empty object on first init). Returns the JSON-stringified body
 * (newline-terminated for clean diffs).
 *
 * Merge contract:
 *   - User-set top-level fields (permissions, plugin marketplace, manual
 *     overrides not in `container.json`) are preserved verbatim.
 *   - Host-managed env defaults are layered UNDER any existing env entries
 *     so a user-set env var (e.g. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`) wins.
 *   - `container.json` overrides for `model` / `thinkingBudget` /
 *     `smallModelId` win when set; when unset, the existing value (if any)
 *     is preserved — host config takes precedence but doesn't erase
 *     user-configured fallbacks.
 */
export function composeClaudeSettings(existing: Record<string, unknown>, config: ContainerConfig): string {
  const existingEnv =
    typeof existing.env === 'object' && existing.env !== null ? (existing.env as Record<string, string>) : {};
  const merged: Record<string, unknown> = {
    ...existing,
    env: { ...DEFAULT_CLAUDE_SETTINGS.env, ...existingEnv },
  };
  if (config.model) merged.model = config.model;
  if (config.thinkingBudget) merged.thinkingBudget = config.thinkingBudget;
  if (config.smallModelId) merged.smallModelId = config.smallModelId;
  return JSON.stringify(merged, null, 2) + '\n';
}

/**
 * Read the current settings.json (or `{}` if missing/malformed) and
 * regenerate it with `container.json` overrides merged in. Used by
 * `container-runner.ts` at every spawn.
 */
export function regenerateClaudeSettings(filePath: string, config: ContainerConfig): void {
  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    /* missing or malformed — start clean */
  }
  fs.writeFileSync(filePath, composeClaudeSettings(existing, config));
}

const EMPTY_CONFIG: ContainerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: 'all',
};

const DEFAULT_SETTINGS_JSON = composeClaudeSettings({}, EMPTY_CONFIG);

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path.
 *
 * Source code and skills are shared RO mounts — not copied per-group.
 * Skill symlinks are synced at spawn time by container-runner.ts.
 *
 * The composed `CLAUDE.md` is NOT written here — it's regenerated on every
 * spawn by `composeGroupClaudeMd()` (see `claude-md-compose.ts`). Initial
 * per-group instructions (if provided) seed `CLAUDE.local.md`.
 */
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const initialized: string[] = [];

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // groups/<folder>/CLAUDE.local.md — per-group agent memory, auto-loaded by
  // Claude Code. Seeded with caller-provided instructions on first creation.
  const claudeLocalFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(claudeLocalFile)) {
    const body = opts?.instructions ? opts.instructions + '\n' : '';
    fs.writeFileSync(claudeLocalFile, body);
    initialized.push('CLAUDE.local.md');
  }

  // groups/<folder>/container.json — empty container config, replaces the
  // former agent_groups.container_config DB column. Self-modification flows
  // read and write this file directly.
  if (initContainerConfig(group.folder)) {
    initialized.push('container.json');
  }

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    initialized.push('.claude-shared');
  }

  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
    initialized.push('settings.json');
  }

  // Skills directory — created empty here; symlinks are synced at spawn
  // time by container-runner.ts based on container.json skills selection.
  const skillsDst = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDst)) {
    fs.mkdirSync(skillsDst, { recursive: true });
    initialized.push('skills/');
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}

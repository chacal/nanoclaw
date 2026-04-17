import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock group-folder so resolveGroupFolderPath returns a tmpdir we control.
let groupDir = '';
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: () => groupDir,
  isValidGroupFolder: () => true,
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { resolveImagePath } from './ipc.js';

describe('resolveImagePath symlink containment', () => {
  let tmpRoot = '';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ipc-img-'));
    groupDir = path.join(tmpRoot, 'group');
    fs.mkdirSync(path.join(groupDir, 'images'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('accepts a regular file inside the group folder', () => {
    const real = path.join(groupDir, 'images', 'ok.png');
    fs.writeFileSync(real, 'img');
    expect(resolveImagePath('x', 'images/ok.png')).toBe(fs.realpathSync(real));
  });

  it('rejects lexical traversal (../)', () => {
    expect(resolveImagePath('x', '../escape.png')).toBeNull();
  });

  it('rejects a symlink inside the group folder that points outside', () => {
    // Put the target outside the group folder but inside the tmpRoot so we
    // can guarantee cleanup.
    const outside = path.join(tmpRoot, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    const symlink = path.join(groupDir, 'images', 'sneaky.png');
    fs.symlinkSync(outside, symlink);
    expect(resolveImagePath('x', 'images/sneaky.png')).toBeNull();
  });

  it('accepts a symlink that stays inside the group folder', () => {
    const target = path.join(groupDir, 'images', 'target.png');
    fs.writeFileSync(target, 'img');
    const symlink = path.join(groupDir, 'images', 'alias.png');
    fs.symlinkSync(target, symlink);
    expect(resolveImagePath('x', 'images/alias.png')).toBe(
      fs.realpathSync(target),
    );
  });

  it('returns null for a missing file', () => {
    expect(resolveImagePath('x', 'images/missing.png')).toBeNull();
  });
});

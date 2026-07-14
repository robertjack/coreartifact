import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAttribution } from '../../../src/core/attribution';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeMainRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'coreartifact-attr-unit-main-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  execFileSync('bash', ['-c', 'echo hello > file.txt'], { cwd: dir });
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial commit');
  return dir;
}

describe('attribution (unit)', () => {
  it('resolves the same repo root from a nested subdirectory of the main checkout, with no worktree path', async () => {
    const mainRepo = makeMainRepo();
    const subdir = join(mainRepo, 'nested', 'dir');
    mkdirSync(subdir, { recursive: true });

    const result = await resolveAttribution(subdir, '/tmp/fallback');
    expect(result.repoRoot).toBe(mainRepo);
    expect(result.worktreePath).toBeNull();
  });

  it('resolves the main repo root and worktree path from a nested subdirectory inside the worktree checkout', async () => {
    const mainRepo = makeMainRepo();
    const parentDir = realpathSync(mkdtempSync(join(tmpdir(), 'coreartifact-attr-unit-wt-')));
    const worktreePath = join(parentDir, 'wt-checkout');
    git(mainRepo, 'worktree', 'add', '-q', worktreePath, '-b', 'wt-branch-unit');
    const resolvedWorktreePath = realpathSync(worktreePath);

    const nestedInWorktree = join(resolvedWorktreePath, 'nested');
    mkdirSync(nestedInWorktree, { recursive: true });

    const result = await resolveAttribution(nestedInWorktree, '/tmp/fallback');
    expect(result.repoRoot).toBe(mainRepo);
    expect(result.worktreePath).toBe(resolvedWorktreePath);
  });
});

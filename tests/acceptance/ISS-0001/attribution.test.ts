import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE_PATH = '../../../src/core/attribution';

async function loadAttributionModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeMainRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'coreartifact-attr-main-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  execFileSync('bash', ['-c', 'echo hello > file.txt'], { cwd: dir });
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial commit');
  return dir;
}

describe('attribution', () => {
  it('resolveAttribution given a cwd inside a git worktree returns the main repo root as the repo root and the worktree checkout path as the worktree path; given a cwd inside a main checkout it returns that root with an absent worktree path; given a non-git cwd it returns the supplied init root fallback', async () => {
    const mod = await loadAttributionModule();
    if (!mod?.resolveAttribution) throw new Error('not implemented yet');
    const resolveAttribution = mod.resolveAttribution;

    const mainRepo = makeMainRepo();
    const parentDir = realpathSync(mkdtempSync(join(tmpdir(), 'coreartifact-attr-wt-')));
    const worktreePath = join(parentDir, 'wt-checkout');
    git(mainRepo, 'worktree', 'add', '-q', worktreePath, '-b', 'wt-branch');
    const resolvedWorktreePath = realpathSync(worktreePath);

    const fallbackRoot = '/tmp/init-root-fallback';

    const fromWorktree = await resolveAttribution(resolvedWorktreePath, fallbackRoot);
    expect(fromWorktree.repoRoot).toBe(mainRepo);
    expect(fromWorktree.worktreePath).toBe(resolvedWorktreePath);

    const fromMainCheckout = await resolveAttribution(mainRepo, fallbackRoot);
    expect(fromMainCheckout.repoRoot).toBe(mainRepo);
    expect(fromMainCheckout.worktreePath == null).toBe(true);

    const nonGitDir = realpathSync(mkdtempSync(join(tmpdir(), 'coreartifact-attr-nongit-')));
    const fromNonGit = await resolveAttribution(nonGitDir, fallbackRoot);
    expect(fromNonGit.repoRoot).toBe(fallbackRoot);
    expect(fromNonGit.worktreePath == null).toBe(true);
  });
});

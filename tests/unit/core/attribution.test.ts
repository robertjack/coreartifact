import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAttribution } from '../../../src/core/attribution.js';

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

    const result = await resolveAttribution({ cwd: subdir, initRoot: '/tmp/fallback' });
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

    const result = await resolveAttribution({ cwd: nestedInWorktree, initRoot: '/tmp/fallback' });
    expect(result.repoRoot).toBe(mainRepo);
    expect(result.worktreePath).toBe(resolvedWorktreePath);
  });

  it('treats a main checkout the same whether the caller passes the logical (symlinked) cwd or its realpath', async () => {
    const logicalDir = mkdtempSync(join(tmpdir(), 'coreartifact-attr-unit-logical-'));
    git(logicalDir, 'init', '-q');
    git(logicalDir, 'config', 'user.email', 'test@example.com');
    git(logicalDir, 'config', 'user.name', 'Test');
    execFileSync('bash', ['-c', 'echo hello > file.txt'], { cwd: logicalDir });
    git(logicalDir, 'add', '.');
    git(logicalDir, 'commit', '-q', '-m', 'initial commit');

    const realDir = realpathSync(logicalDir);

    const fromLogical = await resolveAttribution({ cwd: logicalDir, initRoot: '/tmp/fallback' });
    const fromReal = await resolveAttribution({ cwd: realDir, initRoot: '/tmp/fallback' });

    expect(fromLogical.worktreePath).toBeNull();
    expect(fromReal.worktreePath).toBeNull();
    expect(fromLogical.repoRoot).toBe(fromReal.repoRoot);
  });

  it('classifies a --separate-git-dir checkout as a main checkout, never a repo root inside the external git dir', async () => {
    const outer = mktempOuter();
    const externalGitDir = join(outer, 'external-git-storage');
    const checkoutDir = join(outer, 'checkout');
    mkdirSync(checkoutDir, { recursive: true });
    execFileSync('git', ['init', '-q', `--separate-git-dir=${externalGitDir}`, checkoutDir]);
    git(checkoutDir, 'config', 'user.email', 'test@example.com');
    git(checkoutDir, 'config', 'user.name', 'Test');
    execFileSync('bash', ['-c', 'echo hello > file.txt'], { cwd: checkoutDir });
    git(checkoutDir, 'add', '.');
    git(checkoutDir, 'commit', '-q', '-m', 'initial commit');
    const realCheckoutDir = realpathSync(checkoutDir);

    const result = await resolveAttribution({ cwd: checkoutDir, initRoot: checkoutDir });
    expect(result.repoRoot).toBe(realCheckoutDir);
    expect(result.worktreePath).toBeNull();
    expect(result.repoRoot.includes('external-git-storage')).toBe(false);
  });

  it('falls back to the supplied init root for a non-git cwd', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'coreartifact-attr-unit-nongit-'));
    const result = await resolveAttribution({ cwd: nonGitDir, initRoot: '/some/fallback/init-root' });
    expect(result.repoRoot).toBe('/some/fallback/init-root');
    expect(result.worktreePath).toBeNull();
  });
});

function mktempOuter() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'coreartifact-attr-unit-sepgit-')));
}

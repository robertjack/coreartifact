// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const HARNESS_MODULE_PATH = './support/harness';

async function loadHarness() {
  try {
    return await import(HARNESS_MODULE_PATH);
  } catch {
    return undefined;
  }
}

describe('worktree helper', () => {
  it('The harness worktree helper adds a real git worktree to a tmpdir repo and returns its checkout path; a self-test asserts the checkout exists and that its git common dir resolves to the main repo', async () => {
    const mod = await loadHarness();
    if (!mod) throw new Error(`not implemented yet: ${HARNESS_MODULE_PATH} does not export a harness module`);

    const { createTmpRepo, addWorktree } = mod;
    if (!createTmpRepo || !addWorktree) {
      throw new Error('not implemented yet: createTmpRepo/addWorktree export missing from harness module');
    }

    const repo = await createTmpRepo();
    try {
      const worktree = await addWorktree(repo, 'iss-0003-self-test');

      expect(existsSync(worktree.checkoutPath)).toBe(true);

      const worktreeCommonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: worktree.checkoutPath,
        encoding: 'utf8',
      }).trim();
      const resolvedWorktreeCommonDir = resolve(worktree.checkoutPath, worktreeCommonDirRaw);

      const mainCommonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: repo.root,
        encoding: 'utf8',
      }).trim();
      const resolvedMainCommonDir = resolve(repo.root, mainCommonDirRaw);

      expect(resolvedWorktreeCommonDir).toBe(resolvedMainCommonDir);
    } finally {
      await repo.cleanup();
    }
  });
});

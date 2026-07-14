// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HARNESS_MODULE_PATH = './support/harness';

async function loadHarness() {
  try {
    return await import(HARNESS_MODULE_PATH);
  } catch {
    return undefined;
  }
}

describe('tmpdir-repo factory', () => {
  it('The harness tmpdir-repo factory creates a real git repository in a fresh temporary directory with an initial commit, returns its root, its isolated HOME and its isolated registry path, and removes the whole directory on cleanup; a self-test asserts the repo root is a git work tree and that the directory no longer exists after cleanup', async () => {
    const mod = await loadHarness();
    if (!mod) throw new Error(`not implemented yet: ${HARNESS_MODULE_PATH} does not export a harness module`);

    const { createTmpRepo } = mod;
    if (!createTmpRepo) throw new Error('not implemented yet: createTmpRepo export missing from harness module');

    const repo = await createTmpRepo();

    // repo root exists and is a git work tree
    expect(existsSync(repo.root)).toBe(true);
    const isWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repo.root,
      encoding: 'utf8',
    }).trim();
    expect(isWorkTree).toBe('true');

    // an initial commit exists
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo.root, encoding: 'utf8' }).trim();
    expect(log.length).toBeGreaterThan(0);

    // isolated HOME: a real, usable directory distinct from the operator's real HOME
    expect(typeof repo.home).toBe('string');
    expect(repo.home.length).toBeGreaterThan(0);
    expect(existsSync(repo.home)).toBe(true);
    expect(repo.home).not.toBe(homedir());

    // isolated registry path: distinct from the operator's real global registry
    expect(typeof repo.registryPath).toBe('string');
    expect(repo.registryPath.length).toBeGreaterThan(0);
    const realRegistryPath = join(homedir(), '.coreartifact', 'registry.jsonl');
    expect(repo.registryPath).not.toBe(realRegistryPath);

    await repo.cleanup();

    // cleanup removes the whole directory
    expect(existsSync(repo.root)).toBe(false);
  });
});

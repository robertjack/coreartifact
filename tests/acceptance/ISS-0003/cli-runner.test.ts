// @vitest-environment node
import { describe, it, expect } from 'vitest';

const HARNESS_MODULE_PATH = './support/harness';

async function loadHarness() {
  try {
    return await import(HARNESS_MODULE_PATH);
  } catch {
    return undefined;
  }
}

describe('CLI runner', () => {
  it('The harness CLI runner builds the CLI once per test run and invokes it as a subprocess in a given cwd with an isolated HOME and registry, returning exit code, stdout and stderr; a self-test asserts that running it with no arguments in a tmpdir repo exits 0 and prints usage naming init, log and show, and that running an unknown command exits nonzero', async () => {
    const mod = await loadHarness();
    if (!mod) throw new Error(`not implemented yet: ${HARNESS_MODULE_PATH} does not export a harness module`);

    const { createTmpRepo, runCli } = mod;
    if (!createTmpRepo || !runCli) {
      throw new Error('not implemented yet: createTmpRepo/runCli export missing from harness module');
    }

    const repo = await createTmpRepo();
    try {
      const noArgsResult = await runCli([], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });

      expect(noArgsResult.exitCode).toBe(0);
      expect(noArgsResult.stdout).toContain('init');
      expect(noArgsResult.stdout).toContain('log');
      expect(noArgsResult.stdout).toContain('show');

      const unknownResult = await runCli(['this-command-does-not-exist'], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });

      expect(unknownResult.exitCode).not.toBe(0);
    } finally {
      await repo.cleanup();
    }
  });
});

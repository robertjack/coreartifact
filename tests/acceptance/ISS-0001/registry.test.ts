import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE_PATH = '../../../src/core/registry';

async function loadRegistryModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

function tmpRegistryPath() {
  const dir = mkdtempSync(join(tmpdir(), 'coreartifact-registry-'));
  return join(dir, 'registry');
}

describe('registry', () => {
  it('readRegistry on a missing registry file returns an empty ledger list rather than throwing; addLedger writes a v1 registry containing the repo root with an added-at timestamp, and calling addLedger again with the same repo root leaves exactly one entry for that root', async () => {
    const mod = await loadRegistryModule();
    if (!mod?.readRegistry || !mod?.addLedger) throw new Error('not implemented yet');
    const { readRegistry, addLedger } = mod;

    const registryPath = tmpRegistryPath();

    const missing = await readRegistry(registryPath);
    expect(missing.ledgers).toEqual([]);

    const repoRoot = '/tmp/some/repo/root';
    await addLedger(registryPath, repoRoot);

    const afterFirstAdd = await readRegistry(registryPath);
    expect(afterFirstAdd.v).toBe(1);
    expect(afterFirstAdd.ledgers).toHaveLength(1);
    expect(afterFirstAdd.ledgers[0].repo_root).toBe(repoRoot);
    expect(typeof afterFirstAdd.ledgers[0].added_at).toBe('string');
    expect(afterFirstAdd.ledgers[0].added_at.length).toBeGreaterThan(0);

    await addLedger(registryPath, repoRoot);

    const afterSecondAdd = await readRegistry(registryPath);
    const entriesForRoot = afterSecondAdd.ledgers.filter(
      (entry: { repo_root: string }) => entry.repo_root === repoRoot
    );
    expect(entriesForRoot).toHaveLength(1);
  });
});

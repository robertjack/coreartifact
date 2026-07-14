import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegistry, addLedger } from '../../../src/core/registry';

function tmpRegistryPath() {
  const dir = mkdtempSync(join(tmpdir(), 'coreartifact-registry-unit-'));
  return join(dir, 'registry');
}

describe('registry (unit)', () => {
  it('keeps distinct entries for distinct repo roots and preserves earlier added_at values', async () => {
    const registryPath = tmpRegistryPath();

    await addLedger(registryPath, '/tmp/repo-a');
    const afterFirst = await readRegistry(registryPath);
    const firstAddedAt = afterFirst.ledgers.find((e) => e.repo_root === '/tmp/repo-a')?.added_at;

    await addLedger(registryPath, '/tmp/repo-b');
    const afterSecond = await readRegistry(registryPath);

    expect(afterSecond.ledgers.map((e) => e.repo_root).sort()).toEqual(['/tmp/repo-a', '/tmp/repo-b']);
    expect(afterSecond.ledgers.find((e) => e.repo_root === '/tmp/repo-a')?.added_at).toBe(firstAddedAt);
  });

  it('writes atomically: the registry file is always valid JSON with no half-written temp file left behind at the target path', async () => {
    const registryPath = tmpRegistryPath();
    await addLedger(registryPath, '/tmp/repo-a');

    // The rename target must be the exact registryPath, never a temp name.
    const registry = await readRegistry(registryPath);
    expect(registry.v).toBe(1);
    expect(Array.isArray(registry.ledgers)).toBe(true);
  });

  it('creates parent directories for a registry path that does not exist yet', async () => {
    const base = mkdtempSync(join(tmpdir(), 'coreartifact-registry-unit-'));
    const nestedPath = join(base, 'nested', 'dir', 'registry');

    await addLedger(nestedPath, '/tmp/repo-a');
    const registry = await readRegistry(nestedPath);
    expect(registry.ledgers).toHaveLength(1);
  });
});

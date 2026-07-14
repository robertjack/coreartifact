import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegistry, addLedger } from '../../../src/core/registry.js';

function tmpRegistryPath() {
  const dir = mkdtempSync(join(tmpdir(), 'coreartifact-registry-unit-'));
  return join(dir, 'registry');
}

describe('registry (unit)', () => {
  it('keeps distinct entries for distinct repo roots and preserves earlier added_at values', async () => {
    const registryPath = tmpRegistryPath();

    await addLedger('/tmp/repo-a', registryPath);
    const afterFirst = await readRegistry(registryPath);
    const firstAddedAt = afterFirst.ledgers.find((e) => e.repo_root === '/tmp/repo-a')?.added_at;

    await addLedger('/tmp/repo-b', registryPath);
    const afterSecond = await readRegistry(registryPath);

    expect(afterSecond.ledgers.map((e) => e.repo_root).sort()).toEqual(['/tmp/repo-a', '/tmp/repo-b']);
    expect(afterSecond.ledgers.find((e) => e.repo_root === '/tmp/repo-a')?.added_at).toBe(firstAddedAt);
  });

  it('creates parent directories for a registry path that does not exist yet', async () => {
    const base = mkdtempSync(join(tmpdir(), 'coreartifact-registry-unit-'));
    const nestedPath = join(base, 'nested', 'dir', 'registry');

    await addLedger('/tmp/repo-a', nestedPath);
    const registry = await readRegistry(nestedPath);
    expect(registry.ledgers).toHaveLength(1);
  });

  it('serializes concurrent addLedger calls so no update is lost to a read-modify-write race', async () => {
    const registryPath = tmpRegistryPath();
    const roots = Array.from({ length: 10 }, (_, i) => `/tmp/concurrent-repo-${i}`);

    await Promise.all(roots.map((root) => addLedger(root, registryPath)));

    const registry = await readRegistry(registryPath);
    expect(registry.ledgers.map((e) => e.repo_root).sort()).toEqual([...roots].sort());
  });

  it('reaps a lock left behind by a dead holder pid instead of wedging permanently', async () => {
    const registryPath = tmpRegistryPath();
    await addLedger('/tmp/pre-existing', registryPath);

    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid as number;
    const lockPath = `${registryPath}.lock`;
    writeFileSync(lockPath, String(deadPid));

    await addLedger('/tmp/after-stale-lock', registryPath);
    const registry = await readRegistry(registryPath);
    expect(registry.ledgers.some((e) => e.repo_root === '/tmp/after-stale-lock')).toBe(true);
  });

  it('reaps a lock file with unparseable contents', async () => {
    const registryPath = tmpRegistryPath();
    const lockPath = `${registryPath}.lock`;
    writeFileSync(lockPath, 'not-a-pid');

    await addLedger('/tmp/after-corrupt-lock', registryPath);
    const registry = await readRegistry(registryPath);
    expect(registry.ledgers.some((e) => e.repo_root === '/tmp/after-corrupt-lock')).toBe(true);
  });
});

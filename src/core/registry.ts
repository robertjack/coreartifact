// The registry — the single global JSON list of ledger roots.
//
// Reading a missing registry returns an empty list, never an error. Writes
// are atomic (write-temp, rename) so a concurrent reader never sees a
// half-written file. Entries are unique by repo_root, which is what makes
// `init` idempotent.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RegistryEntry {
  repo_root: string;
  added_at: string;
}

export interface Registry {
  v: 1;
  ledgers: RegistryEntry[];
}

function emptyRegistry(): Registry {
  return { v: 1, ledgers: [] };
}

export async function readRegistry(registryPath: string): Promise<Registry> {
  let text: string;
  try {
    text = await readFile(registryPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRegistry();
    }
    throw err;
  }

  const parsed = JSON.parse(text) as Partial<Registry>;
  return {
    v: 1,
    ledgers: Array.isArray(parsed.ledgers) ? parsed.ledgers : [],
  };
}

async function writeRegistryAtomically(registryPath: string, registry: Registry): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmpPath, JSON.stringify(registry, null, 2));
  await rename(tmpPath, registryPath);
}

export async function addLedger(registryPath: string, repoRoot: string): Promise<void> {
  const registry = await readRegistry(registryPath);

  if (!registry.ledgers.some((entry) => entry.repo_root === repoRoot)) {
    registry.ledgers.push({ repo_root: repoRoot, added_at: new Date().toISOString() });
  }

  await writeRegistryAtomically(registryPath, registry);
}

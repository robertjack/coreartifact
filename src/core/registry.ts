// The registry — the single global JSON list of ledger roots.
//
// Reading a missing registry returns an empty list, never an error. Writes
// are atomic (write-temp, rename) so a concurrent reader never sees a
// half-written file. Entries are unique by repo_root, which is what makes
// `init` idempotent.

import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
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

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_MAX_WAIT_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// The atomic write-temp+rename in writeRegistryAtomically prevents a torn
// READ, but the read-modify-write in addLedger is still a lost-update race
// across concurrent callers (two parallel `cart init` runs). An O_EXCL
// lockfile serializes the critical section; the exclusive create itself is
// the atomic operation concurrent callers race on, so only one wins at a
// time and the rest retry.
async function acquireLock(lockPath: string, deadline: number): Promise<FileHandle> {
  for (;;) {
    try {
      return await open(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for registry lock at ${lockPath}`);
      }
      await delay(LOCK_RETRY_DELAY_MS);
    }
  }
}

async function withRegistryLock<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(registryPath), { recursive: true });
  const lockPath = `${registryPath}.lock`;
  const handle = await acquireLock(lockPath, Date.now() + LOCK_MAX_WAIT_MS);
  try {
    return await fn();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

export async function addLedger(registryPath: string, repoRoot: string): Promise<void> {
  await withRegistryLock(registryPath, async () => {
    const registry = await readRegistry(registryPath);

    if (!registry.ledgers.some((entry) => entry.repo_root === repoRoot)) {
      registry.ledgers.push({ repo_root: repoRoot, added_at: new Date().toISOString() });
    }

    await writeRegistryAtomically(registryPath, registry);
  });
}

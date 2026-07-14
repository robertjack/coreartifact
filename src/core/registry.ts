// The registry — the single global JSON list of ledger roots.
//
// Reading a missing registry returns an empty list, never an error. Writes
// are atomic (write-temp, rename) so a concurrent reader never sees a
// half-written file. Entries are unique by repo_root, which is what makes
// `init` idempotent.

import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { getRegistryPath } from './paths.js';

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

export async function readRegistry(registryPath: string = getRegistryPath()): Promise<Registry> {
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
// Defensive backstop against pid reuse: even a lock whose recorded holder
// happens to match a live process is stolen once it is this old.
const LOCK_STALE_TTL_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only probes whether the pid exists and is
    // reachable by this user.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else — still
    // alive, just not ours to signal. Any other error (ESRCH, etc.) means
    // no such process.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A lock is stale — safe to steal — when its recorded holder pid is no
// longer running, when its contents can't be read or parsed at all (a
// half-written or corrupted lock is as good as abandoned), or when it has
// simply sat past the bounded TTL regardless of pid liveness.
function isLockStale(lockPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch {
    return true;
  }

  const pid = Number.parseInt(text, 10);
  if (!Number.isFinite(pid) || !isPidAlive(pid)) {
    return true;
  }

  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    return age > LOCK_STALE_TTL_MS;
  } catch {
    return true;
  }
}

// Writes the pid to a uniquely-named temp file first, then `link()`s it
// into place: link (like O_EXCL open) atomically fails EEXIST if the lock
// already exists, but unlike open+write+close it never leaves a reader a
// window onto a zero-byte lock file mid-creation — the content is complete
// before the name is visible at all. A stale-check racing the writer of a
// brand-new lock would otherwise see an empty file, misread it as corrupt,
// and steal a lock that is very much held.
async function acquireLock(lockPath: string, deadline: number): Promise<void> {
  for (;;) {
    const tmpPath = `${lockPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmpPath, String(process.pid));
    try {
      await link(tmpPath, lockPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      if (isLockStale(lockPath)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for registry lock at ${lockPath}`);
      }
      await delay(LOCK_RETRY_DELAY_MS);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }
}

async function withRegistryLock<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(registryPath), { recursive: true });
  const lockPath = `${registryPath}.lock`;
  await acquireLock(lockPath, Date.now() + LOCK_MAX_WAIT_MS);

  // Complement to the pid-steal above, never the cure: SIGKILL and a hard
  // crash never run this, which is exactly why the steal logic above must
  // not depend on it.
  const cleanup = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already released */
    }
  };
  const onSignal = (signal: string) => {
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('exit', cleanup);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    return await fn();
  } finally {
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await unlink(lockPath).catch(() => {});
  }
}

export async function addLedger(repoRoot: string, registryPath: string = getRegistryPath()): Promise<void> {
  await withRegistryLock(registryPath, async () => {
    const registry = await readRegistry(registryPath);

    if (!registry.ledgers.some((entry) => entry.repo_root === repoRoot)) {
      registry.ledgers.push({ repo_root: repoRoot, added_at: new Date().toISOString() });
    }

    await writeRegistryAtomically(registryPath, registry);
  });
}

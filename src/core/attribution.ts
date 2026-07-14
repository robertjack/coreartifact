// Attribution (pure) — resolve a cwd to its ledger's repo root.
//
// Expressible without any package dependency: pure `git rev-parse`
// shell-out plus path logic, used by both the hook artifact and ingest.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface Attribution {
  repoRoot: string;
  worktreePath: string | null;
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// `--show-toplevel` returns the physical path (symlinks resolved). The
// common-dir is a path *relative to cwd*, so resolving it against a logical
// (non-realpath'd) cwd yields a logical path — a mismatch against toplevel's
// physical form on any symlinked cwd (macOS /var -> /private/var, $TMPDIR,
// symlinked home directories). Realpath both the cwd used to resolve it and
// the resolved common-dir itself so the comparison at the end is physical
// path to physical path, never physical to logical.
export async function resolveAttribution(cwd: string, initRootFallback: string): Promise<Attribution> {
  const realCwd = tryRealpath(cwd) ?? cwd;

  const toplevel = tryGit(realCwd, ['rev-parse', '--show-toplevel']);
  if (toplevel === null) {
    return { repoRoot: initRootFallback, worktreePath: null };
  }

  const commonDirRaw = tryGit(realCwd, ['rev-parse', '--git-common-dir']);
  if (commonDirRaw === null) {
    return { repoRoot: toplevel, worktreePath: null };
  }

  const commonDirResolved = resolve(realCwd, commonDirRaw);
  const commonDir = tryRealpath(commonDirResolved) ?? commonDirResolved;
  const mainRepoRoot = dirname(commonDir);

  if (mainRepoRoot === toplevel) {
    return { repoRoot: mainRepoRoot, worktreePath: null };
  }

  return { repoRoot: mainRepoRoot, worktreePath: toplevel };
}

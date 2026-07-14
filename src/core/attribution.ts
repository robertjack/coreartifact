// Attribution (pure) — resolve a cwd to its ledger's repo root.
//
// Expressible without any package dependency: pure `git rev-parse`
// shell-out plus path logic, used by both the hook artifact and ingest.

import { execFileSync } from 'node:child_process';
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

export async function resolveAttribution(cwd: string, initRootFallback: string): Promise<Attribution> {
  const toplevel = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (toplevel === null) {
    return { repoRoot: initRootFallback, worktreePath: null };
  }

  const commonDirRaw = tryGit(cwd, ['rev-parse', '--git-common-dir']);
  if (commonDirRaw === null) {
    return { repoRoot: toplevel, worktreePath: null };
  }

  const commonDir = resolve(cwd, commonDirRaw);
  const mainRepoRoot = dirname(commonDir);

  if (mainRepoRoot === toplevel) {
    return { repoRoot: mainRepoRoot, worktreePath: null };
  }

  return { repoRoot: mainRepoRoot, worktreePath: toplevel };
}

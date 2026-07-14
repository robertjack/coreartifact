// Attribution (pure) — resolve a cwd to its ledger's repo root.
//
// Expressible without any package dependency: pure `git rev-parse`
// shell-out plus path logic, used by both the hook artifact and ingest.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Attribution {
  repoRoot: string;
  worktreePath: string | null;
}

export interface ResolveAttributionInput {
  cwd: string;
  initRoot: string;
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

// `git worktree list --porcelain`'s first entry is always the main working
// tree (git's own invariant), so it is the correct source for the main
// root — never `dirname(gitCommonDir)`, which assumes the git dir lives at
// `<repo_root>/.git` and misclassifies a submodule or
// `git init --separate-git-dir` checkout as a worktree rooted inside `.git`.
function firstWorktreeRoot(porcelainOutput: string): string | null {
  const firstLine = porcelainOutput.split('\n', 1)[0] ?? '';
  const match = /^worktree (.+)$/.exec(firstLine);
  return match ? match[1] : null;
}

// A cwd inside a *linked* worktree has a `--git-dir` distinct from its
// `--git-common-dir` (the former is `<main>/.git/worktrees/<name>`, the
// latter the shared `<main>/.git`); a main checkout's two are equal no
// matter where the git dir physically lives (a plain `.git`, a submodule's
// gitfile-redirected dir, or a `--separate-git-dir` external dir). Realpath
// both sides before comparing: `--show-toplevel` returns a physical path
// while `--git-dir`/`--git-common-dir` are resolved relative to the
// caller's logical cwd, so an unrealpathed comparison on any symlinked path
// (macOS /var, $TMPDIR) would fabricate a worktree path for a main checkout
// and mint two repo_root identities for the same repo.
export async function resolveAttribution(input: ResolveAttributionInput): Promise<Attribution> {
  const { cwd, initRoot } = input;
  const realCwd = tryRealpath(cwd) ?? cwd;

  const toplevel = tryGit(realCwd, ['rev-parse', '--show-toplevel']);
  if (toplevel === null) {
    return { repoRoot: initRoot, worktreePath: null };
  }
  const realToplevel = tryRealpath(toplevel) ?? toplevel;

  const gitDirRaw = tryGit(realCwd, ['rev-parse', '--git-dir']);
  const commonDirRaw = tryGit(realCwd, ['rev-parse', '--git-common-dir']);
  if (gitDirRaw === null || commonDirRaw === null) {
    return { repoRoot: realToplevel, worktreePath: null };
  }

  const gitDirAbs = tryRealpath(resolve(realCwd, gitDirRaw)) ?? resolve(realCwd, gitDirRaw);
  const commonDirAbs = tryRealpath(resolve(realCwd, commonDirRaw)) ?? resolve(realCwd, commonDirRaw);

  if (gitDirAbs === commonDirAbs) {
    return { repoRoot: realToplevel, worktreePath: null };
  }

  const listOutput = tryGit(realCwd, ['worktree', 'list', '--porcelain']);
  const mainRootRaw = (listOutput && firstWorktreeRoot(listOutput)) ?? realToplevel;
  const mainRoot = tryRealpath(mainRootRaw) ?? mainRootRaw;

  return { repoRoot: mainRoot, worktreePath: realToplevel };
}

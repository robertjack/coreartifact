// Git shell-outs `init` needs: resolve the repo root, enumerate existing
// worktrees, and check whether a path is already tracked.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts). The node:child_process import below is
// `@ts-ignore`d at the import site and re-typed through a local interface
// describing only the surface this file calls.
//
// Same allowlist-not-denylist ruling as src/core/attribution.ts and
// src/hook/capture.ts (2026-07-14): a leaked GIT_DIR/GIT_WORK_TREE/
// GIT_COMMON_DIR in the ambient environment can silently redirect git at an
// unrelated repository. `scrubbedEnv` is imported rather than reinvented.

// @ts-ignore -- node:child_process has no ambient types available in this sandbox
import { execFileSync as execFileSyncFn } from "node:child_process";
import { scrubbedEnv } from "../core/attribution.js";

declare const process: { cwd(): string; env: Record<string, string | undefined> };

interface ExecFileSyncOptions {
  cwd?: string;
  encoding?: string;
  stdio?: [string, string, string];
  env?: Record<string, string | undefined>;
}

const execFileSync = execFileSyncFn as (file: string, args: string[], options?: ExecFileSyncOptions) => string;

function runGit(cwd: string, args: string[]): string {
  return String(
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: scrubbedEnv(process.env),
    }),
  );
}

// The canonical, physical repo root — `git rev-parse --show-toplevel`
// already resolves symlinks, so this is safe to compare against other
// git-reported paths (worktree list's main entry, etc.) without a separate
// realpath step. Throws if `cwd` is not inside a git work tree; `init`
// itself decides how to surface that.
export function resolveRepoRoot(cwd: string = process.cwd()): string {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

function firstColumnAfter(prefix: string, line: string): string | null {
  if (!line.startsWith(prefix)) return null;
  return line.slice(prefix.length);
}

// Every OTHER checkout `git worktree list --porcelain` reports for this
// repo, excluding the main checkout itself (its first entry, per git's own
// documented invariant, and defensively excluded again by value below).
export function listOtherWorktreePaths(repoRoot: string): string[] {
  const output = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    const worktreePath = firstColumnAfter("worktree ", line);
    if (worktreePath !== null) paths.push(worktreePath);
  }
  return paths.filter((path) => path !== repoRoot);
}

// Whether any file under `relativePath` (repo-relative) is already tracked
// by a prior commit. `git ls-files` never throws for zero matches — it just
// returns empty output — so a thrown error here means something else went
// wrong (e.g. not a git repo at all), which is treated as "cannot tell,
// assume untracked" rather than surfacing a second failure mode `init`
// hasn't already decided how to report.
export function isTrackedByGit(repoRoot: string, relativePath: string): boolean {
  try {
    return runGit(repoRoot, ["ls-files", "--", relativePath]).trim().length > 0;
  } catch {
    return false;
  }
}

// The worktree gap — names any worktree missing the per-repo settings file
// (docs/issues/ISS-0007.md "The worktree gap warning"): a checkout git
// knows about that Claude Code sessions would run in silently uncaptured,
// typically a hand-made `git worktree add` with no session and no `init`
// re-run ever touching it. Enumerate the repo's worktrees from git and
// check each checkout for the settings file — that is the entire
// diagnostic. This is not the doctor: no other checks ship this campaign.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:fs import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn } from "node:fs";
import { listOtherWorktreePaths } from "./install/gitRepo.js";

const existsSync = existsSyncFn as (path: string) => boolean;

// Hand-rolled join: same rationale as core/ledger.ts and core/registry.ts —
// this module owns no shared path-join module.
function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

export interface WorktreeGap {
  checkoutPath: string;
}

// Silent when propagation is complete: a worktree whose checkout carries
// `.claude/settings.local.json` (written either by `init`'s own
// propagation loop, ISS-0005, or by a session that ran there) is not a gap.
export function findWorktreeGaps(repoRoot: string): WorktreeGap[] {
  const gaps: WorktreeGap[] = [];
  for (const worktreePath of listOtherWorktreePaths(repoRoot)) {
    const settingsPath = joinPath(worktreePath, ".claude", "settings.local.json");
    if (!existsSync(settingsPath)) {
      gaps.push({ checkoutPath: worktreePath });
    }
  }
  return gaps;
}

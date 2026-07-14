// The worktree helper — primitive 4 of the acceptance harness (spec-v1.md
// "The acceptance harness", ISS-0003). `git worktree add` against a tmpdir
// repo, returning the new checkout path.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TmpRepo } from "./tmpRepo.js";
import { gitEnv } from "./gitEnv.js";

export interface Worktree {
  checkoutPath: string;
}

export async function addWorktree(repo: TmpRepo, branchName: string): Promise<Worktree> {
  const worktreesDir = join(repo.base, "worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  const checkoutPath = join(worktreesDir, branchName);

  const env = gitEnv(repo.home);
  execFileSync("git", ["worktree", "add", checkoutPath, "-b", branchName], { cwd: repo.root, env });

  return { checkoutPath };
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { resolveRepoRoot, listOtherWorktreePaths, isTrackedByGit } from "../../../src/install/gitRepo.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("install/gitRepo", () => {
  let base: string;
  let repoRoot: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "iss0005-gitrepo-unit-")));
    repoRoot = path.join(base, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, ["init", "-q"]);
    git(repoRoot, ["config", "user.email", "test@coreartifact.invalid"]);
    git(repoRoot, ["config", "user.name", "Coreartifact Test"]);
    fs.writeFileSync(path.join(repoRoot, ".gitkeep"), "");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "initial commit"]);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("resolveRepoRoot returns the physical toplevel of the repo at cwd", () => {
    expect(resolveRepoRoot(repoRoot)).toBe(repoRoot);
  });

  it("listOtherWorktreePaths is empty for a repo with no linked worktrees", () => {
    expect(listOtherWorktreePaths(repoRoot)).toEqual([]);
  });

  it("listOtherWorktreePaths excludes the main checkout and lists every linked worktree", () => {
    const worktreePath = path.join(base, "wt1");
    git(repoRoot, ["worktree", "add", worktreePath, "-b", "wt1-branch"]);

    const others = listOtherWorktreePaths(repoRoot);
    expect(others).toEqual([worktreePath]);
    expect(others).not.toContain(repoRoot);
  });

  it("isTrackedByGit is false for a path nothing has ever committed", () => {
    expect(isTrackedByGit(repoRoot, ".coreartifact")).toBe(false);
  });

  it("isTrackedByGit is true once a file under that path has been committed", () => {
    fs.mkdirSync(path.join(repoRoot, ".coreartifact"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".coreartifact", "spool.jsonl"), "{}\n");
    git(repoRoot, ["add", ".coreartifact"]);
    git(repoRoot, ["commit", "-q", "-m", "track spool"]);

    expect(isTrackedByGit(repoRoot, ".coreartifact")).toBe(true);
  });
});

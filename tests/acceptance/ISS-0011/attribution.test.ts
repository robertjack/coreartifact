import { describe, test, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const MODULE_PATH = "../../../src/core/attribution";

async function loadAttributionModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

function requireResolveAttribution(mod: any): (cwd: string, initRoot: string) => any {
  if (!mod) throw new Error("src/core/attribution module not implemented yet");
  const resolveAttribution = mod.resolveAttribution;
  if (typeof resolveAttribution !== "function") {
    throw new Error("src/core/attribution does not export resolveAttribution yet");
  }
  return resolveAttribution;
}

async function resolve(resolveAttribution: (cwd: string, initRoot: string) => any, cwd: string, initRoot: string) {
  return await resolveAttribution(cwd, initRoot);
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "file.txt"), "content");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);
}

const tmpRoots: string[] = [];
function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iss11-attr-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});

describe("ISS-0011 core contracts: attribution", () => {
  test(
    "resolveAttribution given a cwd inside a linked git worktree returns the main repo root as the repo root and the worktree checkout path as the worktree path; given a cwd inside a main checkout it returns that root with an absent worktree path; given a non-git cwd it returns the supplied init root fallback with an absent worktree path.",
    async () => {
      const mod = await loadAttributionModule();
      const resolveAttribution = requireResolveAttribution(mod);

      const root = makeTmpRoot();

      // worktree case
      const mainRepo = path.join(root, "main");
      initRepo(mainRepo);
      const worktreeDir = path.join(root, "wt");
      git(mainRepo, ["worktree", "add", worktreeDir, "-b", "iss11-wt"]);

      const expectedMainRoot = fs.realpathSync(mainRepo);
      const expectedWorktreePath = fs.realpathSync(worktreeDir);

      const worktreeResult = await resolve(resolveAttribution, worktreeDir, root);
      expect(worktreeResult?.repoRoot).toBe(expectedMainRoot);
      expect(worktreeResult?.worktreePath).toBe(expectedWorktreePath);

      // main checkout case
      const mainResult = await resolve(resolveAttribution, mainRepo, root);
      expect(mainResult?.repoRoot).toBe(expectedMainRoot);
      expect(mainResult?.worktreePath == null).toBe(true);

      // non-git case: cwd has no repository, so the supplied init-root
      // fallback (distinct from cwd) is returned verbatim.
      const nonGitDir = path.join(root, "plain");
      fs.mkdirSync(nonGitDir, { recursive: true });
      const fallbackDir = path.join(root, "fallback-init-root");
      fs.mkdirSync(fallbackDir, { recursive: true });
      const fallbackRoot = fs.realpathSync(fallbackDir);

      const nonGitResult = await resolve(resolveAttribution, nonGitDir, fallbackRoot);
      expect(nonGitResult?.repoRoot).toBe(fallbackRoot);
      expect(nonGitResult?.worktreePath == null).toBe(true);
    },
    30000,
  );

  test(
    "resolveAttribution classifies a main checkout correctly when the git dir is not at <repo_root>/.git: given a submodule checkout, and given a git init --separate-git-dir checkout, it returns that checkout as the repo root with an absent worktree path, and never returns a repo root inside a .git directory.",
    async () => {
      const mod = await loadAttributionModule();
      const resolveAttribution = requireResolveAttribution(mod);

      const root = makeTmpRoot();

      // submodule case: the git dir for the submodule checkout lives at
      // <super>/.git/modules/<name>, not <submodule checkout>/.git.
      const submoduleSource = path.join(root, "submodule-source");
      initRepo(submoduleSource);
      const superRepo = path.join(root, "super");
      initRepo(superRepo);
      git(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "sub"]);
      const submoduleCheckout = path.join(superRepo, "sub");
      const expectedSubmoduleRoot = fs.realpathSync(submoduleCheckout);

      const submoduleResult = await resolve(resolveAttribution, submoduleCheckout, root);
      expect(submoduleResult?.repoRoot).toBe(expectedSubmoduleRoot);
      expect(submoduleResult?.worktreePath == null).toBe(true);
      expect(String(submoduleResult?.repoRoot).split(/[\\/]/)).not.toContain(".git");

      // git init --separate-git-dir case: the git dir lives entirely
      // outside the checkout directory.
      const separateWorkDir = path.join(root, "separate-work");
      const separateGitDir = path.join(root, "separate-gitdir");
      fs.mkdirSync(separateWorkDir, { recursive: true });
      git(separateWorkDir, ["init", "-q", `--separate-git-dir=${separateGitDir}`]);
      git(separateWorkDir, ["config", "user.email", "test@example.com"]);
      git(separateWorkDir, ["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(separateWorkDir, "file.txt"), "content");
      git(separateWorkDir, ["add", "."]);
      git(separateWorkDir, ["commit", "-q", "-m", "initial commit"]);
      const expectedSeparateRoot = fs.realpathSync(separateWorkDir);

      const separateResult = await resolve(resolveAttribution, separateWorkDir, root);
      expect(separateResult?.repoRoot).toBe(expectedSeparateRoot);
      expect(separateResult?.worktreePath == null).toBe(true);
      expect(String(separateResult?.repoRoot).split(/[\\/]/)).not.toContain(".git");
    },
    30000,
  );

  test(
    "resolveAttribution is stable under symlinked paths: given a main checkout reached by a symlinked cwd it returns an absent worktree path and the same repo root string that the realpathed cwd yields - one repo never resolves to two repo_root identities.",
    async () => {
      const mod = await loadAttributionModule();
      const resolveAttribution = requireResolveAttribution(mod);

      const root = makeTmpRoot();
      const mainRepo = path.join(root, "main");
      initRepo(mainRepo);

      const symlinkPath = path.join(root, "main-symlink");
      fs.symlinkSync(mainRepo, symlinkPath, "dir");

      const realResult = await resolve(resolveAttribution, mainRepo, root);
      const symlinkResult = await resolve(resolveAttribution, symlinkPath, root);

      expect(realResult?.repoRoot).toBe(fs.realpathSync(mainRepo));
      expect(symlinkResult?.repoRoot).toBe(realResult?.repoRoot);
      expect(symlinkResult?.worktreePath == null).toBe(true);
      expect(realResult?.worktreePath == null).toBe(true);
    },
    30000,
  );

  test(
    "resolveAttribution ignores the ambient git environment: with GIT_DIR or GIT_WORK_TREE set in the environment to another repository, resolution still reflects the cwd's own repository, so a session's spool can never be redirected into an unrelated repo.",
    async () => {
      const mod = await loadAttributionModule();
      const resolveAttribution = requireResolveAttribution(mod);

      const root = makeTmpRoot();
      const ownRepo = path.join(root, "own");
      initRepo(ownRepo);
      const foreignRepo = path.join(root, "foreign");
      initRepo(foreignRepo);

      const expectedOwnRoot = fs.realpathSync(ownRepo);
      const foreignRoot = fs.realpathSync(foreignRepo);

      const savedGitDir = process.env.GIT_DIR;
      const savedWorkTree = process.env.GIT_WORK_TREE;
      process.env.GIT_DIR = path.join(foreignRepo, ".git");
      process.env.GIT_WORK_TREE = foreignRepo;
      try {
        const result = await resolve(resolveAttribution, ownRepo, root);
        expect(result?.repoRoot).toBe(expectedOwnRoot);
        expect(result?.repoRoot).not.toBe(foreignRoot);
        expect(result?.worktreePath == null).toBe(true);
      } finally {
        if (savedGitDir === undefined) {
          delete process.env.GIT_DIR;
        } else {
          process.env.GIT_DIR = savedGitDir;
        }
        if (savedWorkTree === undefined) {
          delete process.env.GIT_WORK_TREE;
        } else {
          process.env.GIT_WORK_TREE = savedWorkTree;
        }
      }
    },
    30000,
  );
});

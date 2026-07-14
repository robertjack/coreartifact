import { describe, test, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveAttribution, scrubbedEnv, validatedGitDirIdentity } from "../../../src/core/attribution.js";

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

// Every layout must resolve identically from a subdirectory of the
// checkout, not only its root: the hook artifact always calls this from
// wherever the user is working, essentially never the repo root itself
// (2026-07-14 finding A4). Create and return a nested subdirectory so every
// fixture below can be exercised both ways.
function subdirOf(dir: string): string {
  const sub = path.join(dir, "nested", "deeper");
  fs.mkdirSync(sub, { recursive: true });
  return sub;
}

const tmpRoots: string[] = [];
function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iss11-attr-unit-"));
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

describe("resolveAttribution", () => {
  test("main checkout: repo root is the toplevel, worktree path is absent (root and subdirectory cwd)", async () => {
    const root = makeTmpRoot();
    const mainRepo = path.join(root, "main");
    initRepo(mainRepo);
    const expected = fs.realpathSync(mainRepo);

    const rootResult = await resolveAttribution(mainRepo, root);
    expect(rootResult.repoRoot).toBe(expected);
    expect(rootResult.worktreePath).toBeNull();

    const subResult = await resolveAttribution(subdirOf(mainRepo), root);
    expect(subResult.repoRoot).toBe(expected);
    expect(subResult.worktreePath).toBeNull();
  });

  test("linked worktree: repo root is the main checkout, worktree path is the checkout itself (root and subdirectory cwd)", async () => {
    const root = makeTmpRoot();
    const mainRepo = path.join(root, "main");
    initRepo(mainRepo);
    const worktreeDir = path.join(root, "wt");
    git(mainRepo, ["worktree", "add", worktreeDir, "-b", "unit-wt"]);
    const expectedRoot = fs.realpathSync(mainRepo);
    const expectedWorktree = fs.realpathSync(worktreeDir);

    const rootResult = await resolveAttribution(worktreeDir, root);
    expect(rootResult.repoRoot).toBe(expectedRoot);
    expect(rootResult.worktreePath).toBe(expectedWorktree);

    const subResult = await resolveAttribution(subdirOf(worktreeDir), root);
    expect(subResult.repoRoot).toBe(expectedRoot);
    expect(subResult.worktreePath).toBe(expectedWorktree);
  });

  test("non-git cwd: returns the init-root fallback verbatim, worktree path absent (root and nested cwd)", async () => {
    const root = makeTmpRoot();
    const plainDir = path.join(root, "plain");
    fs.mkdirSync(plainDir, { recursive: true });
    const fallbackDir = path.join(root, "fallback");
    fs.mkdirSync(fallbackDir, { recursive: true });
    const fallbackRoot = fs.realpathSync(fallbackDir);

    const result = await resolveAttribution(plainDir, fallbackRoot);
    expect(result.repoRoot).toBe(fallbackRoot);
    expect(result.worktreePath).toBeNull();

    const nestedResult = await resolveAttribution(subdirOf(plainDir), fallbackRoot);
    expect(nestedResult.repoRoot).toBe(fallbackRoot);
    expect(nestedResult.worktreePath).toBeNull();
  });

  test("submodule checkout: repo root is the submodule's own toplevel, never a path inside .git (root and subdirectory cwd)", async () => {
    const root = makeTmpRoot();
    const submoduleSource = path.join(root, "submodule-source");
    initRepo(submoduleSource);
    const superRepo = path.join(root, "super");
    initRepo(superRepo);
    git(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "sub"]);
    const submoduleCheckout = path.join(superRepo, "sub");
    const expected = fs.realpathSync(submoduleCheckout);

    const rootResult = await resolveAttribution(submoduleCheckout, root);
    expect(rootResult.repoRoot).toBe(expected);
    expect(rootResult.worktreePath).toBeNull();
    expect(rootResult.repoRoot.split(/[\\/]/)).not.toContain(".git");

    const subResult = await resolveAttribution(subdirOf(submoduleCheckout), root);
    expect(subResult.repoRoot).toBe(expected);
    expect(subResult.worktreePath).toBeNull();
    expect(subResult.repoRoot.split(/[\\/]/)).not.toContain(".git");
  });

  test("git init --separate-git-dir checkout: repo root is the work dir, never the external git dir (root and subdirectory cwd)", async () => {
    const root = makeTmpRoot();
    const workDir = path.join(root, "separate-work");
    const gitDir = path.join(root, "separate-gitdir");
    fs.mkdirSync(workDir, { recursive: true });
    git(workDir, ["init", "-q", `--separate-git-dir=${gitDir}`]);
    git(workDir, ["config", "user.email", "test@example.com"]);
    git(workDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(workDir, "file.txt"), "content");
    git(workDir, ["add", "."]);
    git(workDir, ["commit", "-q", "-m", "initial commit"]);
    const expected = fs.realpathSync(workDir);

    const rootResult = await resolveAttribution(workDir, root);
    expect(rootResult.repoRoot).toBe(expected);
    expect(rootResult.worktreePath).toBeNull();
    expect(rootResult.repoRoot.split(/[\\/]/)).not.toContain(".git");

    const subResult = await resolveAttribution(subdirOf(workDir), root);
    expect(subResult.repoRoot).toBe(expected);
    expect(subResult.worktreePath).toBeNull();
    expect(subResult.repoRoot.split(/[\\/]/)).not.toContain(".git");
  });

  test("symlinked cwd resolves to the same repo root identity as the realpathed cwd (root and subdirectory-through-symlink cwd)", async () => {
    const root = makeTmpRoot();
    const mainRepo = path.join(root, "main");
    initRepo(mainRepo);
    const symlinkPath = path.join(root, "main-symlink");
    fs.symlinkSync(mainRepo, symlinkPath, "dir");

    const realResult = await resolveAttribution(mainRepo, root);
    const symlinkResult = await resolveAttribution(symlinkPath, root);
    expect(symlinkResult.repoRoot).toBe(realResult.repoRoot);
    expect(symlinkResult.worktreePath).toBeNull();

    const subSymlinkResult = await resolveAttribution(subdirOf(symlinkPath), root);
    expect(subSymlinkResult.repoRoot).toBe(realResult.repoRoot);
    expect(subSymlinkResult.worktreePath).toBeNull();
  });

  test("GIT_DIR and GIT_WORK_TREE in the ambient environment are ignored: resolution follows cwd only (root and subdirectory cwd)", async () => {
    const root = makeTmpRoot();
    const ownRepo = path.join(root, "own");
    initRepo(ownRepo);
    const foreignRepo = path.join(root, "foreign");
    initRepo(foreignRepo);

    const savedGitDir = process.env.GIT_DIR;
    const savedWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = path.join(foreignRepo, ".git");
    process.env.GIT_WORK_TREE = foreignRepo;
    try {
      const result = await resolveAttribution(ownRepo, root);
      expect(result.repoRoot).toBe(fs.realpathSync(ownRepo));
      expect(result.repoRoot).not.toBe(fs.realpathSync(foreignRepo));
      expect(result.worktreePath).toBeNull();

      const subResult = await resolveAttribution(subdirOf(ownRepo), root);
      expect(subResult.repoRoot).toBe(fs.realpathSync(ownRepo));
      expect(subResult.repoRoot).not.toBe(fs.realpathSync(foreignRepo));
      expect(subResult.worktreePath).toBeNull();
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedGitDir;
      if (savedWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = savedWorkTree;
    }
  });

  test("GIT_COMMON_DIR in the ambient environment is ignored: a clean main checkout is never misclassified as a worktree of a foreign repo (root and subdirectory cwd)", async () => {
    const root = makeTmpRoot();
    const ownRepo = path.join(root, "own");
    initRepo(ownRepo);
    const foreignRepo = path.join(root, "foreign");
    initRepo(foreignRepo);

    const savedCommonDir = process.env.GIT_COMMON_DIR;
    process.env.GIT_COMMON_DIR = path.join(foreignRepo, ".git");
    try {
      const result = await resolveAttribution(ownRepo, root);
      expect(result.repoRoot).toBe(fs.realpathSync(ownRepo));
      expect(result.repoRoot).not.toBe(fs.realpathSync(foreignRepo));
      expect(result.worktreePath).toBeNull();

      const subResult = await resolveAttribution(subdirOf(ownRepo), root);
      expect(subResult.repoRoot).toBe(fs.realpathSync(ownRepo));
      expect(subResult.repoRoot).not.toBe(fs.realpathSync(foreignRepo));
      expect(subResult.worktreePath).toBeNull();
    } finally {
      if (savedCommonDir === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = savedCommonDir;
    }
  });

  test("linked worktree created from inside a submodule resolves repo root to the submodule's own checkout, never a path inside .git (root and subdirectory cwd)", async () => {
    const root = makeTmpRoot();
    const submoduleSource = path.join(root, "submodule-source");
    initRepo(submoduleSource);
    const superRepo = path.join(root, "super");
    initRepo(superRepo);
    git(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "sub"]);
    const submoduleCheckout = path.join(superRepo, "sub");

    const worktreeDir = path.join(root, "subwt");
    git(submoduleCheckout, ["worktree", "add", worktreeDir, "-b", "unit-sub-wt"]);
    const expectedRoot = fs.realpathSync(submoduleCheckout);
    const expectedWorktree = fs.realpathSync(worktreeDir);

    const rootResult = await resolveAttribution(worktreeDir, root);
    expect(rootResult.repoRoot).toBe(expectedRoot);
    expect(rootResult.worktreePath).toBe(expectedWorktree);
    expect(rootResult.repoRoot.split(/[\\/]/)).not.toContain(".git");

    const subResult = await resolveAttribution(subdirOf(worktreeDir), root);
    expect(subResult.repoRoot).toBe(expectedRoot);
    expect(subResult.worktreePath).toBe(expectedWorktree);
    expect(subResult.repoRoot.split(/[\\/]/)).not.toContain(".git");
  });

  test("linked worktree of a BARE main repo: repo root is the realpathed bare gitdir (the repo's stable identity), never the worktree itself, and worktree path is recorded, not null (root and subdirectory cwd) (2026-07-14 ruling)", async () => {
    const root = makeTmpRoot();
    const bareMain = path.join(root, "bare-main");
    fs.mkdirSync(bareMain, { recursive: true });
    git(bareMain, ["init", "-q", "--bare"]);
    const worktreeDir = path.join(root, "bare-wt");
    // A bare repo has no commit to check out from yet, so this creates an
    // orphan branch worktree - the layout still exercises the exact
    // resolution path a real bare-main worktree would.
    git(bareMain, ["worktree", "add", worktreeDir, "-b", "unit-bare-wt", "--orphan", "-q"]);
    const worktreeReal = fs.realpathSync(worktreeDir);
    const bareMainReal = fs.realpathSync(bareMain);

    const rootResult = await resolveAttribution(worktreeDir, root);
    expect(rootResult.repoRoot).toBe(bareMainReal);
    expect(rootResult.repoRoot).not.toBe(worktreeReal);
    expect(rootResult.repoRoot).not.toBe(root);
    expect(rootResult.worktreePath).toBe(worktreeReal);
    // The destructive proof: repo_root is neither the worktree nor inside
    // it, so `git worktree remove` on this checkout could never destroy a
    // spool planted at repo_root.
    expect(rootResult.repoRoot.startsWith(`${worktreeReal}/`)).toBe(false);

    const subResult = await resolveAttribution(subdirOf(worktreeDir), root);
    expect(subResult.repoRoot).toBe(bareMainReal);
    expect(subResult.repoRoot).not.toBe(worktreeReal);
    expect(subResult.worktreePath).toBe(worktreeReal);
  });

  test("linked worktree of a git init --separate-git-dir main checkout: repo root is the realpathed external gitdir, never the worktree itself, and worktree path is recorded, not null (root and subdirectory cwd) (2026-07-14 ruling)", async () => {
    const root = makeTmpRoot();
    const workDir = path.join(root, "separate-work");
    const gitDir = path.join(root, "separate-gitdir");
    fs.mkdirSync(workDir, { recursive: true });
    git(workDir, ["init", "-q", `--separate-git-dir=${gitDir}`]);
    git(workDir, ["config", "user.email", "test@example.com"]);
    git(workDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(workDir, "file.txt"), "content");
    git(workDir, ["add", "."]);
    git(workDir, ["commit", "-q", "-m", "initial commit"]);
    const worktreeDir = path.join(root, "separate-wt");
    git(workDir, ["worktree", "add", worktreeDir, "-b", "unit-separate-wt"]);
    const worktreeReal = fs.realpathSync(worktreeDir);
    const gitDirReal = fs.realpathSync(gitDir);

    const rootResult = await resolveAttribution(worktreeDir, root);
    expect(rootResult.repoRoot).toBe(gitDirReal);
    expect(rootResult.repoRoot).not.toBe(worktreeReal);
    expect(rootResult.repoRoot).not.toBe(root);
    expect(rootResult.worktreePath).toBe(worktreeReal);
    expect(rootResult.repoRoot.startsWith(`${worktreeReal}/`)).toBe(false);

    const subResult = await resolveAttribution(subdirOf(worktreeDir), root);
    expect(subResult.repoRoot).toBe(gitDirReal);
    expect(subResult.repoRoot).not.toBe(worktreeReal);
    expect(subResult.worktreePath).toBe(worktreeReal);
  });

  test("two worktrees of the SAME bare repo resolve to the SAME repo_root; worktrees of DIFFERENT bare repos resolve to DIFFERENT repo_roots - no ledger collision (2026-07-14 ruling)", async () => {
    const root = makeTmpRoot();

    const bareA = path.join(root, "bare-a");
    fs.mkdirSync(bareA, { recursive: true });
    git(bareA, ["init", "-q", "--bare"]);
    const wtA1 = path.join(root, "bare-a-wt1");
    const wtA2 = path.join(root, "bare-a-wt2");
    git(bareA, ["worktree", "add", wtA1, "-b", "unit-a-wt1", "--orphan", "-q"]);
    git(bareA, ["worktree", "add", wtA2, "-b", "unit-a-wt2", "--orphan", "-q"]);

    const bareB = path.join(root, "bare-b");
    fs.mkdirSync(bareB, { recursive: true });
    git(bareB, ["init", "-q", "--bare"]);
    const wtB1 = path.join(root, "bare-b-wt1");
    git(bareB, ["worktree", "add", wtB1, "-b", "unit-b-wt1", "--orphan", "-q"]);

    const resultA1 = await resolveAttribution(wtA1, root);
    const resultA2 = await resolveAttribution(wtA2, root);
    const resultB1 = await resolveAttribution(wtB1, root);

    expect(resultA1.repoRoot).toBe(resultA2.repoRoot);
    expect(resultA1.repoRoot).toBe(fs.realpathSync(bareA));
    expect(resultB1.repoRoot).toBe(fs.realpathSync(bareB));
    expect(resultA1.repoRoot).not.toBe(resultB1.repoRoot);
  });

  test("bare gitdir literally named .git (git clone --bare url proj/.git + worktree add): repo root is the realpathed gitdir, worktree path is the checkout, never the worktree itself (root and subdirectory cwd) (2026-07-14 S1 fix)", async () => {
    const root = makeTmpRoot();
    const src = path.join(root, "src");
    initRepo(src);

    const proj = path.join(root, "myproject");
    fs.mkdirSync(proj, { recursive: true });
    const bareGitDir = path.join(proj, ".git");
    git(root, ["clone", "--bare", "-q", src, bareGitDir]);
    const worktreeDir = path.join(proj, "wt1");
    git(bareGitDir, ["worktree", "add", "-q", worktreeDir, "-b", "unit-bare-dot-git-wt"]);

    const bareGitDirReal = fs.realpathSync(bareGitDir);
    const worktreeReal = fs.realpathSync(worktreeDir);
    // Sanity: the gitdir really is literally named ".git" and is NOT the
    // worktree — this is precisely the layout `git worktree list
    // --porcelain` mangles by stripping the trailing "/.git".
    expect(path.basename(bareGitDirReal)).toBe(".git");
    expect(bareGitDirReal).not.toBe(worktreeReal);

    const rootResult = await resolveAttribution(worktreeDir, root);
    expect(rootResult.repoRoot).toBe(bareGitDirReal);
    expect(rootResult.repoRoot).not.toBe(worktreeReal);
    expect(rootResult.repoRoot).not.toBe(root);
    expect(rootResult.worktreePath).toBe(worktreeReal);
    expect(rootResult.repoRoot.startsWith(`${worktreeReal}/`)).toBe(false);

    const subResult = await resolveAttribution(subdirOf(worktreeDir), root);
    expect(subResult.repoRoot).toBe(bareGitDirReal);
    expect(subResult.repoRoot).not.toBe(worktreeReal);
    expect(subResult.worktreePath).toBe(worktreeReal);
  });

  test("bare-at-.git layout: a spool planted at repo_root survives `git worktree remove --force` on the checkout (destructive proof, 2026-07-14 S1 fix)", async () => {
    const root = makeTmpRoot();
    const src = path.join(root, "src");
    initRepo(src);

    const proj = path.join(root, "myproject");
    fs.mkdirSync(proj, { recursive: true });
    const bareGitDir = path.join(proj, ".git");
    git(root, ["clone", "--bare", "-q", src, bareGitDir]);
    const worktreeDir = path.join(proj, "wt1");
    git(bareGitDir, ["worktree", "add", "-q", worktreeDir, "-b", "unit-destructive-bare-dot-git-wt"]);

    // initRoot mirrors the real production call: it derives from cwd, and
    // in the bare-clone + worktree-per-branch workflow cwd IS the worktree
    // (2026-07-14 ruling). Passing anything else here would not exercise
    // the actual reported sink.
    const result = await resolveAttribution(worktreeDir, worktreeDir);
    const spoolDir = path.join(result.repoRoot, ".coreartifact");
    fs.mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, "spool.jsonl");
    fs.writeFileSync(spoolFile, `{"planted":true}\n`);

    git(bareGitDir, ["worktree", "remove", "--force", worktreeDir]);

    expect(fs.existsSync(spoolFile)).toBe(true);
    expect(fs.readFileSync(spoolFile, "utf8")).toBe(`{"planted":true}\n`);
  });

  test("plain bare and separate-git-dir layouts: a spool planted at repo_root survives `git worktree remove --force` on the checkout (destructive proof, 2026-07-14 S1 fix)", async () => {
    const root = makeTmpRoot();

    // Plain bare (not named .git).
    const bareMain = path.join(root, "bare-main");
    fs.mkdirSync(bareMain, { recursive: true });
    git(bareMain, ["init", "-q", "--bare"]);
    const bareWt = path.join(root, "bare-wt");
    git(bareMain, ["worktree", "add", bareWt, "-b", "unit-destructive-bare-wt", "--orphan", "-q"]);

    const bareResult = await resolveAttribution(bareWt, bareWt);
    const bareSpoolDir = path.join(bareResult.repoRoot, ".coreartifact");
    fs.mkdirSync(bareSpoolDir, { recursive: true });
    const bareSpoolFile = path.join(bareSpoolDir, "spool.jsonl");
    fs.writeFileSync(bareSpoolFile, `{"planted":"bare"}\n`);
    git(bareMain, ["worktree", "remove", "--force", bareWt]);
    expect(fs.existsSync(bareSpoolFile)).toBe(true);

    // separate-git-dir.
    const workDir = path.join(root, "separate-work");
    const gitDir = path.join(root, "separate-gitdir");
    fs.mkdirSync(workDir, { recursive: true });
    git(workDir, ["init", "-q", `--separate-git-dir=${gitDir}`]);
    git(workDir, ["config", "user.email", "test@example.com"]);
    git(workDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(workDir, "file.txt"), "content");
    git(workDir, ["add", "."]);
    git(workDir, ["commit", "-q", "-m", "initial commit"]);
    const sepWt = path.join(root, "separate-wt");
    git(workDir, ["worktree", "add", sepWt, "-b", "unit-destructive-separate-wt"]);

    const sepResult = await resolveAttribution(sepWt, sepWt);
    const sepSpoolDir = path.join(sepResult.repoRoot, ".coreartifact");
    fs.mkdirSync(sepSpoolDir, { recursive: true });
    const sepSpoolFile = path.join(sepSpoolDir, "spool.jsonl");
    fs.writeFileSync(sepSpoolFile, `{"planted":"separate"}\n`);
    git(workDir, ["worktree", "remove", "--force", sepWt]);
    expect(fs.existsSync(sepSpoolFile)).toBe(true);
  });

  test("submodule's <super>/.git/modules/<name> gitdir is still rejected as an identity by the new core.worktree discriminator (2026-07-14 S1 fix)", async () => {
    const root = makeTmpRoot();
    const submoduleSource = path.join(root, "submodule-source");
    initRepo(submoduleSource);
    const superRepo = path.join(root, "super");
    initRepo(superRepo);
    git(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "sub"]);
    const submoduleCheckout = path.join(superRepo, "sub");

    const worktreeDir = path.join(root, "subwt");
    git(submoduleCheckout, ["worktree", "add", worktreeDir, "-b", "unit-sub-wt-discriminator"]);

    // Sanity: the modules dir genuinely carries a core.worktree reverse
    // pointer (the forbidden signal) and is not bare.
    const modulesDir = path.join(superRepo, ".git", "modules", "sub");
    const coreWorktree = git(modulesDir, ["config", "--get", "core.worktree"]);
    expect(coreWorktree.length).toBeGreaterThan(0);

    // End-to-end: resolution self-corrects to the submodule's own checkout
    // via validatedMainRoot's reverse-pointer walk (a healthy submodule
    // never falls through to validatedGitDirIdentity in the first place —
    // see that function's own comment), never the modules/ subtree.
    const result = await resolveAttribution(worktreeDir, root);
    expect(result.repoRoot).toBe(fs.realpathSync(submoduleCheckout));
    expect(result.repoRoot.split(/[\\/]/)).not.toContain(".git");
    expect(result.repoRoot).not.toBe(fs.realpathSync(modulesDir));

    // Direct proof the new discriminator itself did not open the door: even
    // called head-on with the exact forbidden candidate (the modules dir,
    // genuinely a top-level gitdir of its own, `--is-inside-git-dir` true),
    // it must still be rejected because `core.worktree` is set. Contrast
    // with the ALLOWED bare-at-.git gitdir from the destructive-proof
    // fixture above, run through the identical function as a positive
    // control so this isn't a vacuously-always-null check.
    const { execFileSync: realExecFileSync } = await import("node:child_process");
    const { realpathSync: realRealpathSync } = await import("node:fs");
    const scrubbed = scrubbedEnv(process.env);

    const forbidden = validatedGitDirIdentity(realExecFileSync, realRealpathSync, modulesDir, scrubbed);
    expect(forbidden).toBeNull();

    const bareProj = path.join(root, "positive-control-bare");
    fs.mkdirSync(bareProj, { recursive: true });
    const bareGitDir = path.join(bareProj, ".git");
    git(root, ["clone", "--bare", "-q", submoduleSource, bareGitDir]);
    const allowed = validatedGitDirIdentity(realExecFileSync, realRealpathSync, bareGitDir, scrubbed);
    expect(allowed).toBe(fs.realpathSync(bareGitDir));
  });

  test("XDG_CONFIG_HOME is passed through to git via the real production allowlist (safe.directory grants set only via $XDG_CONFIG_HOME/git/config are honored, 2026-07-14 S2 fix)", async () => {
    const root = makeTmpRoot();
    const mainRepo = path.join(root, "main");
    initRepo(mainRepo);

    const xdgConfigHome = path.join(root, "xdg-config");
    fs.mkdirSync(path.join(xdgConfigHome, "git"), { recursive: true });
    const marker = "unit-test-xdg-config-home-marker";
    fs.writeFileSync(path.join(xdgConfigHome, "git", "config"), `[custom]\n\tprobe = ${marker}\n`);

    // Build the child env through the SAME `scrubbedEnv` function
    // `resolveAttribution` uses internally — this is a direct proof of the
    // allowlist's actual contents, not a hand-rolled proxy for it. Feed it
    // an ambient-shaped env carrying XDG_CONFIG_HOME plus a var it must
    // NOT forward (GIT_DIR), so a broken allowlist that leaks everything
    // wouldn't accidentally pass this test either.
    const ambient: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: xdgConfigHome,
      GIT_DIR: "/should/not/leak/through",
    };
    const childEnv = scrubbedEnv(ambient);

    expect(childEnv.XDG_CONFIG_HOME).toBe(xdgConfigHome);
    expect(childEnv.GIT_DIR).toBeUndefined();

    const seen = execFileSync("git", ["config", "--get", "custom.probe"], {
      cwd: mainRepo,
      encoding: "utf8",
      env: childEnv,
    }).trim();
    expect(seen).toBe(marker);

    // Confirm the PATH+HOME-only allowlist (the pre-fix state) does NOT see
    // the XDG-scoped config: the same marker lookup, with XDG_CONFIG_HOME
    // withheld from the ambient env fed to scrubbedEnv, must fail.
    const withoutXdg = scrubbedEnv({ PATH: process.env.PATH, HOME: process.env.HOME });
    expect(withoutXdg.XDG_CONFIG_HOME).toBeUndefined();
    expect(() =>
      execFileSync("git", ["config", "--get", "custom.probe"], {
        cwd: mainRepo,
        encoding: "utf8",
        env: withoutXdg,
      }),
    ).toThrow();

    // And confirm resolveAttribution still resolves correctly with
    // XDG_CONFIG_HOME present in the ambient environment (it must not
    // corrupt normal resolution).
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    try {
      const result = await resolveAttribution(mainRepo, root);
      expect(result.repoRoot).toBe(fs.realpathSync(mainRepo));
      expect(result.worktreePath).toBeNull();
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });
});

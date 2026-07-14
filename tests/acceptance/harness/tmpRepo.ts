// The tmpdir-repo factory — primitive 1 of the acceptance harness (spec-v1.md
// "The acceptance harness", ISS-0003). Creates a fresh temporary directory,
// git-inits it with a deterministic identity, and makes an initial commit.
//
// Isolation is the load-bearing part: the registry is a *global* file
// (~/.coreartifact/registry.jsonl in real life), so every test gets its own
// HOME and its own registry root under the same disposable tmpdir. A test
// that leaks into the operator's real home is a defect here, not in the test.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "./gitEnv.js";

export interface TmpRepo {
  /** The git work tree root. */
  root: string;
  /** An isolated HOME distinct from the operator's real one. */
  home: string;
  /** The tmpdir base this repo (and any worktrees added against it) live under. */
  base: string;
  /** The isolated registry root directory (COREARTIFACT_REGISTRY_ROOT value). */
  registryRoot: string;
  /** The isolated registry log path, distinct from the operator's real one. */
  registryPath: string;
  /** Removes the whole tmpdir base, including any worktrees. */
  cleanup(): Promise<void>;
}

export async function createTmpRepo(): Promise<TmpRepo> {
  // realpath immediately: on macOS $TMPDIR/os.tmpdir() commonly resolves
  // through a /tmp -> /private/tmp symlink, and git reports absolute paths
  // (e.g. the main repo's .git dir from a worktree's --git-common-dir)
  // already resolved through that symlink. Comparing a non-canonical path
  // against git's canonical output would spuriously mismatch.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "coreartifact-acceptance-")));
  const root = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });

  const registryRoot = join(home, ".coreartifact");
  const registryPath = join(registryRoot, "registry.jsonl");

  const env = gitEnv(home);
  execFileSync("git", ["init", "-q"], { cwd: root, env });
  execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: root, env });
  execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: root, env });
  writeFileSync(join(root, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: root, env });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: root, env });

  return {
    root,
    home,
    base,
    registryRoot,
    registryPath,
    cleanup: async () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

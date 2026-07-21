// Attribution (pure) — resolve a cwd to its ledger's repo root.
//
// Expressible without any package dependency: pure `git rev-parse`
// shell-outs plus path logic, used by both the hook artifact and ingest.
//
// @types/node is unreachable in this sandbox (no network, nothing cached).
// A `declare module "node:child_process"` block inside this .ts file is
// treated by tsc as an *augmentation* of an already-resolvable module, not
// a fresh ambient declaration (same finding as src/core/paths.ts), so it
// fails to compile; a real fix would need a .d.ts file, which this issue
// owns none of. `loadNode` sidesteps this with a genuine ESM dynamic
// `import()` whose specifier is cast to `any` purely to skip TS's static
// module resolution — the import itself is real Node at runtime, not a
// shim. node:path has the same typing problem, so path-joining below is
// hand-rolled instead of imported.
declare const process: { env: Record<string, string | undefined> };

async function loadNode(specifier: string): Promise<any> {
  return import(specifier as any);
}

export interface Attribution {
  repoRoot: string;
  worktreePath: string | null;
}

// Git's repository-discovery machinery reads more than GIT_DIR /
// GIT_WORK_TREE: GIT_COMMON_DIR alone is enough to redirect `git rev-parse`
// at another repository entirely (a leaked GIT_COMMON_DIR makes a clean
// main checkout's `--git-dir` and `--git-common-dir` diverge, so it gets
// misclassified as a worktree of whatever repo the leaked var points at —
// reviewer S2). A denylist of known variable names is one git release away
// from being wrong again — some future GIT_* discovery variable would leak
// straight through. Build the child environment as an ALLOWLIST instead:
// start from nothing and add back only what git genuinely needs to run.
// Every git invocation this module makes must depend on the cwd argument
// and nothing else in the ambient environment.
//
// - PATH: `execFileSync("git", ...)` resolves the executable by searching
//   PATH in the CHILD's env (Node replaces the child's environment
//   wholesale when `env` is passed, so this process's own PATH does not
//   leak through implicitly) — without it, spawning "git" itself fails.
// - HOME: git reads `~/.gitconfig` and (since 2.35.2) consults per-user
//   state for `safe.directory` trust checks; omitting it risks git
//   refusing to operate on repos it treats as having "dubious ownership"
//   in some environments.
// - XDG_CONFIG_HOME: git also reads `$XDG_CONFIG_HOME/git/config` (falling
//   back to `~/.config/git/config` when unset) as part of the same
//   dubious-ownership machinery, and that is commonly where a `safe.directory`
//   grant actually lives — verified empirically: with a non-default
//   XDG_CONFIG_HOME holding a `safe.directory` entry, a repo that trips
//   dubious-ownership (different uid — NFS, shared checkout, container
//   bind-mount) is trusted when XDG_CONFIG_HOME is passed through and
//   refused when it is scrubbed. Omitting it collapses into the same
//   unresolvable-repo path as every other tryGit failure in this module
//   (worktree-of-bare/separate-git-dir falls back to initRoot, which in that
//   workflow IS the worktree — see the 2026-07-14 ruling above). It cannot
//   redirect *which* repository is discovered the way the GIT_DIR/
//   GIT_WORK_TREE/GIT_COMMON_DIR family can, so it is safe to allow.
const ALLOWED_ENV_VARS = ["PATH", "HOME", "XDG_CONFIG_HOME"];

// Exported so tests can prove exactly what production `resolveAttribution`
// forwards to git, rather than reconstructing an equivalent env dict by
// hand (which would test the test, not the source).
export function scrubbedEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ALLOWED_ENV_VARS) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

// Not consolidated into src/core/paths.ts's exported `joinPath` (daily-lane
// finding 152): that helper is variadic and always concatenates every part,
// whereas this one takes exactly two arguments and treats an absolute
// `maybeRelative` as an override that discards `base` entirely — different
// semantics for an absolute second argument, e.g. join("/foo", "/bar") would
// be "/foo/bar" there but is "/bar" here. capture.ts's hook artifact re-states
// the identical two-argument semantics (and cannot import this module at
// all, per its own header law), so the two stay in lockstep as intentional
// duplicates rather than being unified with the unrelated variadic helper.
function joinPath(base: string, maybeRelative: string): string {
  if (maybeRelative.startsWith("/")) return maybeRelative;
  return `${base.replace(/\/+$/, "")}/${maybeRelative}`;
}

// `git worktree list --porcelain`'s first entry is documented as the main
// working tree (git's own invariant), so it is the starting candidate for
// the main root — never `dirname(gitCommonDir)`, which assumes the git dir
// lives at `<repo_root>/.git` and misclassifies a submodule or
// `git init --separate-git-dir` checkout as a worktree rooted inside `.git`.
// The candidate itself still needs validation (see validatedMainRoot):
// for a worktree created from inside a submodule, git reports that entry
// as the submodule's gitdir rather than its checkout path.
function firstWorktreeRoot(porcelainOutput: string): string | null {
  const firstLine = porcelainOutput.split("\n", 1)[0] ?? "";
  const match = /^worktree (.+)$/.exec(firstLine);
  return match ? match[1] : null;
}

function containsGitPathComponent(p: string): boolean {
  return p.split(/[\\/]/).includes(".git");
}

// For a linked worktree created from *inside a submodule*, git reports
// that submodule's own git dir (`<super>/.git/modules/<name>`) as the
// porcelain "worktree" entry rather than the submodule's checkout path.
// Verbatim use of that value resolves repo_root to a path INSIDE .git —
// the exact unrecoverable outcome this issue exists to prevent (reviewer
// S1). Validate the candidate by asking git to resolve it from its own
// location: `rev-parse --is-inside-work-tree --show-toplevel` succeeds and
// self-corrects a gitdir candidate back to its associated work tree ONLY
// when that gitdir carries a reverse work-tree pointer — which submodule
// tooling writes as `core.worktree = ../../../<path-to-checkout>` inside
// that module's own `config` file (there is no `gitdir` file involved;
// `gitdir` is the file *in the checkout* that points the other way, at the
// module's git dir). This is NOT a general git behavior: a `git init
// --separate-git-dir` gitdir has no such reverse pointer, and neither does
// a bare repo, so the identical call fails with "this operation must be run
// in a work tree" for both (verified against real git 2.55). Both failures
// are handled the same way here: reject and return null. The caller then
// decides between two different unresolvable outcomes — see the bare /
// separate-git-dir handling in resolveAttribution, which is NOT a fallback
// to init-root (2026-07-14 ruling: the gitdir itself is the safe, stable
// identity there). Whenever this call DOES succeed, still re-validate that
// the recovered path is itself a genuine work tree with no `.git` path
// component before trusting it.
function validatedMainRoot(
  execFileSync: any,
  realpathSync: any,
  candidateRaw: string,
  env: Record<string, string | undefined>,
): string | null {
  const output = tryGit(
    execFileSync,
    candidateRaw,
    ["rev-parse", "--is-inside-work-tree", "--show-toplevel"],
    env,
  );
  if (output === null) return null;

  const [isInsideWorkTreeRaw, toplevelRaw] = output.split("\n");
  if (!toplevelRaw) return null;

  const toplevel = tryRealpath(realpathSync, toplevelRaw) ?? toplevelRaw;
  if (containsGitPathComponent(toplevel)) return null;

  if (isInsideWorkTreeRaw?.trim() === "true") return toplevel;

  // The raw candidate was not itself a work tree (e.g. a submodule's
  // gitdir), but --show-toplevel resolved to one anyway. Re-validate that
  // resolved path stands on its own before trusting it.
  const recheck = tryGit(execFileSync, toplevel, ["rev-parse", "--is-inside-work-tree"], env);
  return recheck?.trim() === "true" ? toplevel : null;
}

// A linked worktree of a BARE repo, or of a `--separate-git-dir` repo, has
// no derivable main checkout: `validatedMainRoot` above legitimately
// returns null for both (neither carries a `core.worktree` reverse
// pointer). But the candidate is not garbage: the gitdir itself IS the
// repository's stable identity (2026-07-14 ruling). It survives `worktree
// add`/`remove`, it is unique per project, and unlike a path inside a
// non-bare repo's `.git/` it is never managed/deleted by git's own
// housekeeping (`gc`, `worktree prune`, etc. only touch `objects/`,
// `refs/`, `logs/`, `worktrees/` — never unknown top-level entries).
//
// The candidate fed in here MUST be `commonDirAbs` (the already-realpathed
// `--git-common-dir` computed in resolveAttribution), never the porcelain
// `worktree list --porcelain` main-entry path. That porcelain output STRIPS
// a trailing `/.git` from its main-entry line — for the
// `git clone --bare url proj/.git` + `git worktree add` workflow it reports
// the *parent* of the gitdir (`proj`, not `proj/.git`), which is not a
// gitdir at all. `--is-inside-git-dir` on that stripped candidate is false,
// this function used to bail, and control fell through to the initRoot
// fallback — which in that exact workflow is the worktree itself, the same
// data-destroying sink the 2026-07-14 ruling closed through a different
// entry point (reviewer S1, executed: a spool planted at that mis-resolved
// root was deleted by `git worktree remove --force`). `commonDirAbs` never
// has this problem: it comes from `rev-parse --git-common-dir`, not the
// porcelain listing, so it is never mangled.
//
// Validate the candidate is genuinely a gitdir's OWN top level (not some
// subdirectory of one) before trusting it as repo_root, then discriminate
// ALLOWED from FORBIDDEN by what git itself reports about the gitdir, not
// by a path-shape heuristic. The load-bearing signal, verified against real
// git 2.55 across all three reachable layouts, is `core.worktree`:
//   - ALLOWED, `core.worktree` UNSET:
//       * a bare gitdir, even one literally named `.git` (the
//         `git clone --bare url proj/.git` workflow) — `--is-bare-repository`
//         is true and there is no work tree to point back to at all.
//       * a `--separate-git-dir` external gitdir — `--is-bare-repository`
//         is FALSE there (its config explicitly carries `core.bare = false`)
//         but it still carries no `core.worktree` reverse pointer (verified:
//         [[git-worktree-reverse-pointer-gotcha]] — the reason
//         `validatedMainRoot` above cannot self-correct it back to a work
//         tree either). `--is-bare-repository` alone is therefore NOT a
//         sufficient ALLOWED test — it would wrongly reject this layout.
//   - FORBIDDEN, `core.worktree` SET: `<super>/.git/modules/<name>` — a
//     submodule's own gitdir subtree, into which `git submodule` writes a
//     `core.worktree = ../../../<path>` reverse pointer, and which git
//     deletes wholesale on submodule deinit. Verified:
//     `--is-bare-repository` is false there too, same as the
//     separate-git-dir case above — `core.worktree` is what actually tells
//     the two non-bare cases apart.
// The old discriminator (`containsGitPathComponent`, a blanket rejection of
// any candidate with a `.git` path component) is what caused the bug this
// fixes: it rejected the legitimate bare-named-`.git` case while never
// actually distinguishing it from the submodule-modules-dir case by
// anything git itself asserts.
// Exported so tests can prove the ALLOWED/FORBIDDEN discriminator directly
// against real gitdirs (bare-named-.git, separate-git-dir,
// `.git/modules/<name>`), including the submodule-modules-dir case that
// `resolveAttribution`'s own control flow never reaches with a healthy
// submodule (its reverse pointer lets `validatedMainRoot` resolve first —
// see that function's comment) but which must still be rejected here as
// defense in depth, matching what the reviewer executed.
export function validatedGitDirIdentity(
  execFileSync: any,
  realpathSync: any,
  candidateRaw: string,
  env: Record<string, string | undefined>,
): string | null {
  const output = tryGit(execFileSync, candidateRaw, ["rev-parse", "--is-inside-git-dir", "--git-dir"], env);
  if (output === null) return null;

  const [isInsideGitDirRaw, gitDirRaw] = output.split("\n");
  if (isInsideGitDirRaw?.trim() !== "true" || !gitDirRaw) return null;

  const realCandidate = tryRealpath(realpathSync, candidateRaw) ?? candidateRaw;
  const resolvedGitDir = tryRealpath(realpathSync, joinPath(candidateRaw, gitDirRaw)) ?? joinPath(candidateRaw, gitDirRaw);

  // The candidate must resolve to ITSELF as its own git-dir — i.e. it is
  // the top of a gitdir, not merely somewhere inside one (which would let
  // a stray subdirectory of a non-bare repo's `.git/` masquerade as an
  // identity).
  if (resolvedGitDir !== realCandidate) return null;

  // `core.worktree` unset -> bare gitdir or `--separate-git-dir` external
  // dir, both allowed. `core.worktree` set -> a submodule's own
  // `.git/modules/<name>` gitdir subtree, forbidden (see comment above).
  const coreWorktree = tryGit(execFileSync, candidateRaw, ["config", "--get", "core.worktree"], env);
  if (coreWorktree !== null && coreWorktree.trim() !== "") return null;

  return realCandidate;
}

function tryGit(
  execFileSync: any,
  cwd: string,
  args: string[],
  env: Record<string, string | undefined>,
): string | null {
  try {
    return String(
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env }),
    ).trim();
  } catch {
    return null;
  }
}

function tryRealpath(realpathSync: any, path: string): string | null {
  try {
    return String(realpathSync(path));
  } catch {
    return null;
  }
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
export async function resolveAttribution(cwd: string, initRoot: string): Promise<Attribution> {
  const { execFileSync } = await loadNode("node:child_process");
  const { realpathSync } = await loadNode("node:fs");
  const env = scrubbedEnv(process.env);

  const realCwd = tryRealpath(realpathSync, cwd) ?? cwd;

  const toplevel = tryGit(execFileSync, realCwd, ["rev-parse", "--show-toplevel"], env);
  if (toplevel === null) {
    return { repoRoot: initRoot, worktreePath: null };
  }
  const realToplevel = tryRealpath(realpathSync, toplevel) ?? toplevel;

  const gitDirRaw = tryGit(execFileSync, realCwd, ["rev-parse", "--git-dir"], env);
  const commonDirRaw = tryGit(execFileSync, realCwd, ["rev-parse", "--git-common-dir"], env);
  if (gitDirRaw === null || commonDirRaw === null) {
    return { repoRoot: realToplevel, worktreePath: null };
  }

  const gitDirAbs = tryRealpath(realpathSync, joinPath(realCwd, gitDirRaw)) ?? joinPath(realCwd, gitDirRaw);
  const commonDirAbs =
    tryRealpath(realpathSync, joinPath(realCwd, commonDirRaw)) ?? joinPath(realCwd, commonDirRaw);

  if (gitDirAbs === commonDirAbs) {
    return { repoRoot: realToplevel, worktreePath: null };
  }

  const listOutput = tryGit(execFileSync, realCwd, ["worktree", "list", "--porcelain"], env);
  const candidateRaw = listOutput ? firstWorktreeRoot(listOutput) : null;
  const mainRoot = candidateRaw ? validatedMainRoot(execFileSync, realpathSync, candidateRaw, env) : null;

  // A genuine linked worktree whose main repo is a submodule self-corrects
  // above (see validatedMainRoot). A linked worktree of a BARE repo or a
  // `--separate-git-dir` checkout does not: git has no reverse pointer from
  // that gitdir back to a real work tree (bare has none to point to;
  // --separate-git-dir never writes one), so validatedMainRoot legitimately
  // returns null.
  //
  // That does NOT mean fall back to init-root (2026-07-14 ruling, overrides
  // the previous "never the bare git directory itself" wording — reviewer
  // S1 executed the destructive consequence of the old fallback: initRoot
  // derives from cwd, and in the bare-clone + worktree-per-branch workflow
  // cwd IS the worktree, so the old fallback put the spool inside the
  // worktree and a routine `git worktree remove` deleted it). The
  // candidate itself — the bare dir or external gitdir — IS the
  // repository's stable identity here, and writing there is safe (verified
  // by execution: survives gc/repack/prune/reflog-expire/worktree-remove).
  // Use it as repo_root, and record the worktree checkout as worktree_path
  // rather than flattening it to null, so the caller can always tell
  // "non-git dir" (benign) from "a worktree I attributed" (meaningful).
  if (mainRoot !== null) {
    return { repoRoot: mainRoot, worktreePath: realToplevel };
  }

  // Feed `commonDirAbs` here, never `candidateRaw` (the porcelain main-entry
  // path): `git worktree list --porcelain` strips a trailing `/.git` from
  // its main-entry line, so for a bare repo whose gitdir is literally named
  // `.git` (`git clone --bare url proj/.git`) `candidateRaw` is `proj` — the
  // gitdir's *parent*, not a gitdir at all — and `validatedGitDirIdentity`
  // would legitimately reject it, falling through to the initRoot sink this
  // ruling exists to close (reviewer S1). `commonDirAbs` comes from
  // `rev-parse --git-common-dir`, which is never porcelain-mangled, and is
  // already the realpathed gitdir for every layout reachable here.
  const gitDirIdentity = validatedGitDirIdentity(execFileSync, realpathSync, commonDirAbs, env);
  if (gitDirIdentity !== null) {
    return { repoRoot: gitDirIdentity, worktreePath: realToplevel };
  }

  // Neither a genuine main checkout nor a bare/external gitdir identity
  // could be established. There is no safe candidate left to derive a root
  // from — the worktree's own cwd would be the worktree standing in for
  // its own main root (forbidden), and fabricating anything else is the
  // same unrecoverable class of mistake. Fall back to the supplied
  // init-root, exactly as every other unresolvable case in this module
  // does.
  return { repoRoot: initRoot, worktreePath: null };
}

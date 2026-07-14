---
name: review-defect-patterns
description: Recurring defect classes found while reviewing coreartifact issue branches, and why green gates do not prove acceptance
metadata:
  type: project
---

# coreartifact review — recurring defect classes

**Green gates (typecheck + `pnpm test` + build) do not prove an acceptance criterion is met.**

**Why:** the `tests/acceptance/ISS-xxxx/` files are written by a *test-author agent* before the
implementation exists (see commit `5412062 "test-author attempt 1"`). They restate the criterion
verbatim in the test name but exercise only the happy shape. On ISS-0001, the criterion
"serializeEnvelope emits exactly one line **for any payload**" was tested with an *object* payload
only; the implementation's `typeof input.event === "string"` raw-text passthrough branch emitted
multi-line and invalid-JSON records and the suite stayed 35/35 green.

**How to apply:** when reviewing any coreartifact branch, re-derive each acceptance criterion by
executing the built code (`dist/`) against adversarial inputs yourself. Specifically probe:
- functions with an **untagged union input** (`unknown` that means "value" *or* "pre-serialized
  text") — this is the repo's most productive break vector;
- the ABSENT law (CLAUDE.md): empty string / null / wrong-type must degrade to key-omitted, never
  fabricate. Check both the writer and the parser.
- module-local `declare const process` shims — these are *deliberate* here (`@types/node` is an
  empty dir in `node_modules/@types/node`, unfetchable offline). They are module-local, not
  `declare global`, and do NOT shadow real node types. Do not re-report them as the attempt-1
  `node-shim.d.ts` defect.

## Break vectors that have paid off (run these every time)

1. **Test the artifact `bin` points at, not the one the test spawns.** The ISS-0001 acceptance
   test spawns `dist/cli.js` (a wrapper that calls `main()` unconditionally) while `package.json`
   `bin` points at `dist/cli/index.js` (guarded by an entrypoint check). The guarded one silently
   exited 0 on an unknown command; the suite was green. **Always run the real bin target, through
   a symlink, and from a path containing `@`.**
2. **Hand-rolled `file://` URL derivation is always wrong.** The repo avoids `node:url` because
   `@types/node` is unfetchable, so implementers hand-roll `toFileUrl` with `encodeURIComponent`.
   It over-escapes `@ , & = + $ ; :` (Node's `pathToFileURL` leaves them raw) and it cannot see
   through symlinks (ESM `import.meta.url` is realpath'd; `process.argv[1]` is not). Both break
   `import.meta.url === toFileUrl(process.argv[1])`, and the failure is a **silent no-op exit 0**.
3. **"Total: never throws" comments are claims, not guarantees.** Check every unguarded
   `JSON.stringify` on an `unknown` — BigInt, circular refs, and a throwing `toJSON`/getter all
   throw `TypeError`. Guarding only `=== undefined` is the usual half-fix.
4. **Byte-scan the diff yourself with python, not `tr`/`grep`.** BSD `tr -dc '\0'` silently
   mis-handles octal escapes and will report clean. A fix commit claiming "escaped the NUL + scanned
   all files" instead *introduced* a raw `0x01` byte. `git diff --numstat` showing no `-`/`Bin` only
   proves git's NUL heuristic didn't trip, not that the bytes are clean.
5. **The catch block is part of the totality contract.** The usual fix for "JSON.stringify throws"
   is `try { ... } catch (err) { return { ok: false, reason: \`...: ${String(err)}\` } }` — but
   `String(err)` *itself* throws when the thrown value has a hostile `Symbol.toPrimitive` /
   `toString` / `message` getter, so the exception escapes the function that promises never to
   throw. A "never throws" wrapper must not stringify an attacker-controlled thrown value; use a
   fixed reason string, or `err instanceof Error ? err.name : "non-Error"`. Found on ISS-0001
   rescue-fix (V2, executed 2026-07-14). Low reachability (JSON-decoded payloads have no getters)
   but it is the literal wording of the criterion.
6. **U+2028/U+2029 is a red herring here** — `JSON.stringify` leaves them raw in the line, but the
   spool splits strictly on `\n`, so they are harmless. Verified; do not inflate it into a finding.
7. **Mutation-test any "this is a real concurrency test" claim by patching `dist/`, not `src/`.**
   Copy `dist/` twice into the scratchpad, hand-edit the mutant's built `.js` to reintroduce the bug
   (e.g. swap the `O_APPEND` for `readFileSync`+`writeFileSync`), then run the test's *own* spawn
   strategy against both. On ISS-0010 (2026-07-14) this proved the test genuine: the RMW mutant lost
   2-9 of 12 entries and 93 of 100; the real one lost zero. A test that cannot fail on the mutant is
   not a test — and this is the only way to know which you have.
8. **`node:sqlite` `DatabaseSync` sets no `busy_timeout`, so it is 0.** Any two processes that open
   the same ledger concurrently make one of them throw `Error: database is locked` out of
   `db.exec(DDL)`. Found on ISS-0010 (8/20 concurrent `openLedger` calls on one path died). Check
   every new SQLite open path for a `PRAGMA busy_timeout` — its absence is silent until two commands
   (ingest + dashboard read) coexist.
9. **Acceptance tests that override `HOME` instead of `COREARTIFACT_REGISTRY_ROOT` pollute the real
   registry.** `paths.ts` gives the env override precedence over `HOME`, so any suite that only sets
   `HOME` writes into the operator's real registry root whenever that var happens to be exported —
   and then fails. Grep new tests for `process.env.HOME =` and check they use `REGISTRY_ROOT_ENV_VAR`.

7. **Fallback laundering — the fallback value is never checked against the invariant the
   fallback exists to protect.** ISS-0011 (attribution, executed 2026-07-14): when the main
   root is underivable, the code returns the supplied `initRoot` (satisfying "never fabricate a
   path"). But `initRoot` defaults to `process.cwd()` (`getPaths`), so in a bare-repo +
   worktree workflow `initRoot` **IS the worktree** — the exact value the criterion said to
   never return. A7 was satisfied *by* violating A6. **Whenever a function falls back to a
   caller-supplied value, re-check that value against every "never return X" clause** — the
   fallback is an untyped hole through which forbidden values re-enter. The unit test could
   not catch it because it hardcoded an `initRoot` (tmp parent) that never equals the worktree.
8. **Env scrubbing: check for `new Set([...])` + `if (!SET.has(key))`.** That is a *denylist*
   even when it is long and even when its comment brags about not being a denylist. The spec
   asks for an allowlist (clean env built from scratch). Note: I could NOT exploit a var
   outside the list on git 2.55 (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0` with `core.worktree` /
   `core.bare` does not redirect `rev-parse`), so this rides S2 latent, not S1.

9. **A fix that special-cases the *value* git handed back, instead of the *derivation*, only moves
   the hole.** ISS-0011 eb52363 fixed the bare/separate-git-dir worktree fallback by validating the
   `git worktree list --porcelain` candidate — which works for every fixture the author built
   (`proj.git`, `.bare`, `separate-gitdir`) and fails for the one they didn't (`<proj>/.git`,
   where git strips the `/.git` from the porcelain path). **When a fix validates a string git
   printed, ask what git prints for the same layout under a different NAME** — path-shaped
   heuristics (`endsWith(".git")`, `includes(".git")`, dirname stripping) live on both sides of the
   boundary. Cross the layout axis with the *naming* axis.

10. **An allowlist env is spec-correct here but silently drops `XDG_CONFIG_HOME`.** git reads
   `$XDG_CONFIG_HOME/git/config` (where `safe.directory` often lives) and, with only PATH+HOME in
   the child env, cannot see it — a repo needing a `safe.directory` grant then fails discovery and
   the function falls back to init-root. Only bites when XDG_CONFIG_HOME is set to a NON-default
   path AND the repo trips dubious-ownership, so S2, not S1. Verified 2026-07-14.

## Real git facts established by execution (git 2.55, 2026-07-14) — do not re-derive

- `git worktree list --porcelain` from a linked worktree reports as its FIRST entry:
  - worktree-of-**submodule** → the submodule's **gitdir** (`<super>/.git/modules/<n>`), not its
    checkout. Feeding that back verbatim is the "repo_root inside `.git`" unrecoverable bug.
  - worktree-of-**bare** → the bare dir, plus a literal `bare` marker line.
  - worktree-of-**`--separate-git-dir`** → the **external gitdir**, not the main checkout.
- **BUT the porcelain path is MANGLED when the gitdir is named `.git`.** `git worktree list
  --porcelain` prints the main entry for a bare/`--separate-git-dir` repo with a trailing `/.git`
  **stripped**: a bare repo at `<proj>/.git` (the `git clone --bare url proj/.git` +
  `git worktree add` workflow) reports `worktree <proj>` — the *parent*, which is neither a gitdir
  nor a work tree. Any code that trusts the porcelain path as the repo identity silently loses that
  layout. `git -C <linked-worktree> rev-parse --git-common-dir` returns the **unmangled** gitdir for
  every one of these layouts and is the value to use. Executed 2026-07-14 (git 2.55).
- **`--is-bare-repository` is the discriminator a blanket `.git`-path-component blocklist is not.**
  At `<proj>/.git` (bare) it is `true` with `core.worktree` unset; at `<super>/.git/modules/<n>`
  (submodule gitdir — the genuinely forbidden target) it is `false` with
  `core.worktree = ../../../<n>`. Rejecting every candidate containing a `.git` path component
  conflates the two and re-opens the destructive init-root fallback.
- `git -C <gitdir> rev-parse --is-inside-work-tree --show-toplevel` self-corrects a gitdir back
  to its work tree **only** for a submodule, because the module config carries
  `core.worktree = ../../../<n>`. There is **no `gitdir` file** in `<super>/.git/modules/<n>` —
  code comments crediting one are wrong. Bare and `--separate-git-dir` gitdirs have no
  `core.worktree`, so the identical call fails `fatal: this operation must be run in a work tree`.
  Therefore **no git command yields a main checkout for a worktree of a bare or
  `--separate-git-dir` repo** — an implementer claiming that is telling the truth; verify the
  *consequence* of their fallback instead.

## ISS-0003 acceptance harness (executed 2026-07-14, commit 9764a0b) — copied VERBATIM into 7 downstream slices

- **Allowlist env fix is genuine.** `tests/acceptance/harness/env.ts` `baseHermeticEnv`
  reuses `attribution.ts`'s `scrubbedEnv` (PATH/HOME/XDG only) then pins HOME + XDG to the
  tmpdir. `gitEnv`/`cliRunner` build from it; `spawn`/`execFileSync` get an explicit `env` so
  the child env is REPLACED, not merged — no `{...process.env}` reaches any child. Full poison
  (GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_CONFIG_GLOBAL/XDG/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/
  GIT_NAMESPACE etc. all at once) does NOT reach a harness-made repo. Denylist-mutant of gitEnv
  → hermeticity self-test RED. Confirmed hermetic.
- **BUT the self-test's OWN verify calls are non-hermetic** (`harness.test.ts:35,41,150,156`):
  raw `execFileSync("git",...)` with NO `env`, so they inherit the parent's GIT_DIR family and
  give a FALSE RED under a GIT_DIR-poisoned parent (I reproduced 2 failures). The dedicated
  hermeticity test correctly uses `gitEnv` (queryEnv); the factory/worktree tests don't. S3:
  models a non-hermetic assertion pattern that copies 7x. Config-only poison (GIT_CONFIG_GLOBAL+
  XDG) does NOT break it — only the GIT_DIR family (rare in operator shells).
- **cliRunner resolves on `child.on("exit")` not `"close"`** (`cliRunner.ts:73`) — the known
  stdout-truncation footgun. Could NOT reproduce: 0/30 truncation at 3MB with a natural-exit
  child; the CLI's real usage output is ~200B. Advisory S3 only, since copied 7x and later
  slices capture larger CLI stdout. `process.exit(0)` in a child truncates BOTH exit and close
  (child-side), so don't use that to test the parent-side race.
- **Parallel replayer no-loss is a GENUINE test.** Stub uses `fs.appendFileSync` (O_APPEND,
  atomic append), one line per line, into one file; test does sorted-multiset compare. Drop
  mutant → RED (63 vs 66), duplicate mutant → RED (69 vs 66). Stress at 285 lines / 15 concurrent
  requests into one appendFileSync stub: zero loss across 4 runs. The O_APPEND stub does not
  itself lose lines. This is the primitive ISS-0004 leans on — it holds.
- **Build-once fix genuine:** moved to vitest `globalSetup` (root process, `execFileSync tsc`
  unconditional), `cliRunner.assertBuilt()` only `existsSync`-checks `dist/cli/bin.js` and throws.
  No tsc/build in any worker path. `rm -rf dist && pnpm test` builds via globalSetup and passes
  (111 tests). globalSetup is awaited before workers fork — no race window.
- Readers verified against real data: `openLedger`-built ledger → readLedger SQL
  (`SELECT * FROM events ORDER BY line_no`) returns ordered rows; `serializeEnvelope`→spool→
  `readSpool`/`parseEnvelope` round-trips ok:true. NOTE: serialize input REQUIRES `{v:1, ts}` —
  omitting ts emits literal `"ts":undefined` (invalid JSON), parse ok:false. That's caller error,
  not a reader bug.

Prior ladder history: ISS-0001 burned two attempt ladders; escalated branches
`escalated/ISS-0001-attempt-1` / `-attempt-2` hold prior implementations.

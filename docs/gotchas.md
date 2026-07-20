# Gotchas — bugs this campaign has already bled on

Every implementer starts fresh and rediscovers the same landmines. This file is
the shared memory. **Read it before writing any slice.** Each entry cost a real
review round (~$10) at least once; several cost two or three. The fixes are on
main — reuse them, do not re-derive them.

The standing rule that catches all of these: **"could this test fail if the bug
were present?"** If no, it is not a test. Prove it by mutation — revert the fix,
watch the test go red, restore.

## 1. Entry-point guards make an always-executed program a silent no-op (×3)

`fileURLToPath(import.meta.url) === process.argv[1]` fails on any symlinked
install path (Node realpaths the loader's module but not `argv[1]`), and
`import.meta.main` is **`undefined` on the `engines.node` floor (22.13)** — so
either one makes the program exit 0 having done nothing. It hit the CLI bin, then
the capture hook, twice more.

- **Never** guard a program that is only ever executed and never imported —
  `src/cli/bin.ts` has no guard; it just calls `main()`.
- If a single file must be both entry AND importable (the hook), the only correct
  guard is **realpath BOTH sides**: `realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url))`, defaulting to RUN on any error. Works on Node ≥12. See `src/hook/capture.ts`.
- **Never `import.meta.main`** — it is version-gated below our floor.
- Test it **through a symlink**, and verify on the **minimum supported Node**, by
  executing the real artifact — not on your local Node only.

## 2. Trailing-newline / control-char ordering drops real data (×2)

Running a control-char check (`/[\x00-\x1f]/`, which includes `\n`) against RAW
input **before trimming** rejects every ordinary newline-terminated payload.
`serializeEnvelope` (ISS-0001) needs the check BEFORE trim because its `eventText`
must be single-line; the hook (ISS-0004) needs it AFTER trim because stdin framing
is a legitimate trailing newline. **The rule depends on whether a trailing newline
is framing (strip) or corruption (reject) — decide per context, and test a
trailing-`\n` payload either way.** A silently-dropped payload is capture loss.

## 3. Denylist env scrubbing leaks the operator's machine (×2)

`{ ...process.env }` minus a couple of `GIT_*` names still leaks
`GIT_CONFIG_GLOBAL`, `GIT_COMMON_DIR`, `XDG_CONFIG_HOME`, etc. — poisoning a
"hermetic" test or redirecting a session's spool into another repo. **Build the
child env from scratch (ALLOWLIST): `PATH`, `HOME`, `XDG_CONFIG_HOME`, plus the
explicit `GIT_AUTHOR_*`/`GIT_COMMITTER_*` you set.** The pattern lives in
`src/core/attribution.ts` (`scrubbedEnv` / `ALLOWED_ENV_VARS`) — import it, do not
reinvent it. A denylist is one `git`/tool release from being wrong again.

## 4. A test that spawns the wrong artifact, or races itself, can't fail (×3)

- Tests spawned `dist/cli.js` (a wrapper) while `bin` pointed at a different file
  — the shipped artifact was never exercised.
- A concurrency test used `Promise.all` over a **synchronous** body → it ran
  serially → it could not detect the lost update it existed to catch. Spawn N
  **separate processes** for real concurrency.
- A "no-loss" test whose own stub writes concurrently without `O_APPEND` can lose
  lines itself and mask the bug. The stub must be durable.
- Build memoized in a module-level variable races under vitest's `forks` pool
  (one process per test file). Build once in `globalSetup`, before workers fork.

**Test the artifact that ships, exercise the real concurrency, and assert the
property end-to-end — not a proxy for it** (assert the spool survives
`git worktree remove`, don't assert "the path looks safe").

## 5. Degradation law: absent is never fabricated

`NULL`/absent means "source unavailable" and must stay distinguishable from
empty/zero/success. Do not default a missing `at` to `""`, a missing sha to a
plausible value, an unparseable timestamp to `open`, or an unknown `op` to `add`.
When unsure, fail toward "we don't know" (`closed-inferred`, ABSENT), never toward
a flattering claim. This is the product's one inviolable promise.

## 6. Verify on the floor, not your laptop; execute, don't assert

Platform facts (a Node API's availability, git's output shape, a hook payload's
fields) are **verified by execution on the actual target**, never asserted from
memory — memory has been wrong in both directions. `mise install node@<floor>`
and run the real thing. This is CLAUDE.md law and it is why the campaign's worst
bugs were caught before shipping.

## 7. Locked tests that over-pin extensible surfaces detonate one campaign later (×2)

An acceptance test that asserts an EXACT value where the criterion only
needs coverage becomes a landmine for the next campaign: PRD-0001's
ledger test pinned the literal `schema_version 1` (red the moment
PRD-0002's sanctioned v2 bump landed) and its fixtures test pinned
"exactly the five scenarios" via strict set equality (red the moment
PRD-0002's routed mandate added three streams). Both implementations
were correct; both issues escalated on locked-test collisions; both
fixes were operator test-only amendments. **When a locked test guards a
surface another campaign is EXPECTED to extend — version stamps,
manifest entries, table lists, scenario sets — assert containment of
what the criterion names, never exact equality with today's snapshot.**
Exclusivity is only worth pinning when the spec demands it by name.
Related: the test-author must treat module paths in the issue's
`[files] owns` block as CONTRACT — two other escalations came from
acceptance tests importing guessed filenames the footprint never
granted (`checkLine.js`, `state.js`).

## 8. Recorded fixtures carry live absolute paths — replay hermetically or the machine bleeds in (×3)

Recorded streams embed the recording machine's absolute `cwd` and
`transcript_path`. On this machine those leftovers still EXIST (live git
repos in old scratchpads; transcripts at the recorded paths), so a
verbatim replay silently attributes sessions into stale repos or
enriches a "transcript-absent" session with a real leftover transcript
(PRD-0003's only escalation: spend 0.0558… where the oracle said
0.555957). Three independent hits in one campaign (ISS-0025 fixture
authoring, ISS-0028 escalation, ISS-0029 re-confirmation). **When
seeding by fixture replay, pin `cwd` to the tmp repo and
`transcript_path` to a tmpdir-controlled value on every line — present
case via buildSubstitutedTranscript, absent case via a
guaranteed-nonexistent path INSIDE the tmpdir.** Prior art:
ISS-0028's `pinLineToRepo`, ISS-0029's `seedLines`. The durable fix —
fold the pin into the shared replay helper so hermeticity is by
construction — is this retro's process change; until it lands, HOME
overrides do NOT shield you (enrichment reads the payload's absolute
path directly).

// The hook artifact — capture and boundary git enrichment
// (docs/issues/ISS-0004.md).
//
// This file is the ENTIRE deployed artifact. `init` copies it verbatim into
// a target repo's `.coreartifact/hooks/capture.mjs` and a hook config
// invokes it by absolute path, in a repo that may have no `node_modules` at
// all. It therefore imports nothing but `node:` builtins — no `src/core`,
// no bundler, no sibling file in this directory. The envelope shape and the
// attribution logic (ISS-0011's `resolveAttribution`) are re-stated here
// rather than imported; that duplication is accepted by the spec and pinned
// by tests/unit/hook (a written line must still parse through
// src/core/envelope.ts's parser) and tests/unit/core/attribution.test.ts
// (the two must keep agreeing on repo-root resolution).
//
// @types/node is unreachable in this sandbox (see src/core/paths.ts,
// src/core/ledger.ts) — every node: import below is `@ts-ignore`d at the
// import site and re-typed through a local interface describing only the
// surface this file calls.
//
// NO PATH-COMPARISON ENTRYPOINT GUARD (2026-07-14, S0 — the campaign's
// worst-severity finding, and the SECOND time this exact bug appeared
// here). The previous attempt gated `main()` behind
// `fileURLToPath(import.meta.url) === process.argv[1]` — the identical bug
// that made the CLI bin a silent no-op (ISS-0001, see src/cli/bin.ts's
// header): Node does not realpath `process.argv[1]` but the ESM loader
// realpaths the main module, so on ANY symlinked install path (npx cache,
// node_modules/.bin, /tmp on macOS) the two differ, the guard reads false,
// and `main()` never runs — the hook captures NOTHING while exiting 0.
// `init` copies the artifact into `.coreartifact/`, which is reached
// through symlinks constantly. That specific construct is deleted below,
// permanently — if you feel the urge to write `fileURLToPath(import.meta.url)
// === process.argv[1]` (or reconstruct it via `realpathSync`), that is the
// bug.
//
// This file still cannot simply be "call main() unconditionally at module
// scope" the way src/cli/bin.ts is, though, because unlike the CLI bin this
// artifact must stay a SINGLE self-contained file (the spec's own
// zero-dependency contract: init copies exactly one file, never a sibling
// module) — there is no separate `index.ts` to hold the pure, side-effect-free
// exports the way cli/bin.ts delegates to cli/index.ts. tests/unit/hook
// imports THIS file's pure exports (isBoundaryEvent, validateEventText,
// buildSpoolLine, resolveRepoRoot, resolveBoundaryGit) directly, in-process,
// which means an unconditional top-level `main().finally(() =>
// process.exit(0))` would kill the vitest worker on every unit-test import —
// not a theoretical risk, an unconditional `process.exit(0)` at module scope
// executes the instant the module is evaluated, full stop.
//
// The check is a PORTABLE, symlink-safe path comparison — realpath BOTH sides.
// NOT `import.meta.main`: that property is `undefined` on Node 22.13.0 (this
// repo's `engines.node` floor), verified by execution on a mise-installed
// 22.13.0 — it was only backported partway through the 22.x line (present on
// 22.23.1). Using it would make the hook a PERMANENT silent no-op on every
// supported Node below ~22.18: strictly worse than the symlinked-install bug.
// NOT the old `fileURLToPath(import.meta.url) === argv[1]` either: Node does
// not realpath `argv[1]`, so a symlinked install path made the two differ.
// Realpathing BOTH sides resolves the symlink on each, so they match through
// npx cache / node_modules/.bin / macOS /tmp, and it works on every Node >= 12.
// On ANY ambiguity we default to RUNNING — a missed capture is the harm, and
// in production the artifact is only ever the process entry.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { mkdirSync as mkdirSyncFn, appendFileSync as appendFileSyncFn, realpathSync as realpathSyncFn } from "node:fs";
// @ts-ignore -- node:child_process has no ambient types available in this sandbox
import { execFileSync as execFileSyncFn } from "node:child_process";
// @ts-ignore -- node:url has no ambient types available in this sandbox
import { fileURLToPath as fileURLToPathFn } from "node:url";

interface ReadableStdin {
  setEncoding(encoding: string): void;
  on(event: "data", listener: (chunk: string) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  stdin: ReadableStdin;
};

interface ExecFileSyncOptions {
  cwd?: string;
  encoding?: string;
  stdio?: [string, string, string];
  env?: Record<string, string | undefined>;
  timeout?: number;
  killSignal?: string;
}

const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const appendFileSync = appendFileSyncFn as (path: string, data: string, options?: { flag?: string }) => void;
const realpathSync = realpathSyncFn as (path: string) => string;
const execFileSync = execFileSyncFn as (file: string, args: string[], options?: ExecFileSyncOptions) => string;
const fileURLToPath = fileURLToPathFn as (url: string) => string;

// A hung `git` call must never wedge the host session (ISS-0011
// verification note, docs/issues/ISS-0004.md). Every git invocation below
// is bounded by this timeout and killed outright (SIGKILL, not SIGTERM —
// a wedged process may ignore SIGTERM) if it runs long.
const GIT_TIMEOUT_MS = 2000;

// The init-root fallback contract this issue owns (spec "Test-harness
// contract"): a single positional argv argument. A hook config's "command"
// is one string, so `node <artifact> <initRoot>` is the only shape that
// bakes the fallback in without also wiring a separate env block. ISS-0005
// (init) wires the installed hook command to this exact shape.
export const INIT_ROOT_ARGV_INDEX = 2;

// Same allowlist-not-denylist ruling as src/core/attribution.ts
// (2026-07-14): a leaked GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR in the
// ambient environment can silently redirect git at an unrelated repository.
// Every git call this file makes depends only on its cwd argument and this
// scrubbed environment.
const ALLOWED_ENV_VARS = ["PATH", "HOME", "XDG_CONFIG_HOME"];

export function scrubbedEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ALLOWED_ENV_VARS) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

function tryGit(cwd: string, args: string[], env: Record<string, string | undefined>): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return String(out).trim();
  } catch {
    return null;
  }
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function joinPath(base: string, maybeRelative: string): string {
  if (maybeRelative.startsWith("/")) return maybeRelative;
  return `${base.replace(/\/+$/, "")}/${maybeRelative}`;
}

function containsGitPathComponent(p: string): boolean {
  return p.split(/[\\/]/).includes(".git");
}

// `git worktree list --porcelain`'s first entry is documented as the main
// working tree.
function firstWorktreeRoot(porcelainOutput: string): string | null {
  const firstLine = porcelainOutput.split("\n", 1)[0] ?? "";
  const match = /^worktree (.+)$/.exec(firstLine);
  return match?.[1] ?? null;
}

// Adapted from src/core/attribution.ts's `validatedMainRoot` (ISS-0011,
// verified against real git 2.55). Re-validates the porcelain worktree-list
// candidate rather than trusting it verbatim: for a worktree created from
// inside a submodule, git reports that submodule's own gitdir as the
// "worktree" entry, which resolves to a path inside `.git` — the exact
// unrecoverable outcome this check exists to reject.
function validatedMainRoot(candidateRaw: string, env: Record<string, string | undefined>): string | null {
  const output = tryGit(candidateRaw, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], env);
  if (output === null) return null;

  const [isInsideWorkTreeRaw, toplevelRaw] = output.split("\n");
  if (!toplevelRaw) return null;

  const toplevel = tryRealpath(toplevelRaw) ?? toplevelRaw;
  if (containsGitPathComponent(toplevel)) return null;

  if (isInsideWorkTreeRaw?.trim() === "true") return toplevel;

  const recheck = tryGit(toplevel, ["rev-parse", "--is-inside-work-tree"], env);
  return recheck?.trim() === "true" ? toplevel : null;
}

// Adapted from src/core/attribution.ts's `validatedGitDirIdentity` (ISS-0011,
// 2026-07-14 ruling). A linked worktree of a BARE repo or a
// `--separate-git-dir` checkout has no reverse pointer back to a work tree,
// so `validatedMainRoot` legitimately returns null for both — but the
// gitdir itself is still the repository's stable identity (survives gc,
// worktree remove, prune) and is safe to use as repo_root. Falling back to
// initRoot instead, in that workflow, put the spool inside the worktree
// itself and a routine `git worktree remove` deleted it (reviewer S1,
// executed) — this function exists to keep that regression from recurring.
function validatedGitDirIdentity(candidateRaw: string, env: Record<string, string | undefined>): string | null {
  const output = tryGit(candidateRaw, ["rev-parse", "--is-inside-git-dir", "--git-dir"], env);
  if (output === null) return null;

  const [isInsideGitDirRaw, gitDirRaw] = output.split("\n");
  if (isInsideGitDirRaw?.trim() !== "true" || !gitDirRaw) return null;

  const realCandidate = tryRealpath(candidateRaw) ?? candidateRaw;
  const resolvedGitDir = tryRealpath(joinPath(candidateRaw, gitDirRaw)) ?? joinPath(candidateRaw, gitDirRaw);
  if (resolvedGitDir !== realCandidate) return null;

  const coreWorktree = tryGit(candidateRaw, ["config", "--get", "core.worktree"], env);
  if (coreWorktree !== null && coreWorktree.trim() !== "") return null;

  return realCandidate;
}

// Resolves a hook payload's `cwd` to the repo root the spool line must land
// in: a session running in a git worktree attributes to the MAIN checkout,
// never the worktree itself (spec "Behavior 1 — the append"). Any
// unresolvable case — a non-git cwd, a repo with no commits, a git call
// that fails or times out — falls back to `initRoot`, exactly like every
// other degradation path in this file.
export function resolveRepoRoot(cwd: string, initRoot: string): string {
  try {
    const env = scrubbedEnv(process.env);
    const realCwd = tryRealpath(cwd) ?? cwd;

    const toplevel = tryGit(realCwd, ["rev-parse", "--show-toplevel"], env);
    if (toplevel === null) return initRoot;
    const realToplevel = tryRealpath(toplevel) ?? toplevel;

    const gitDirRaw = tryGit(realCwd, ["rev-parse", "--git-dir"], env);
    const commonDirRaw = tryGit(realCwd, ["rev-parse", "--git-common-dir"], env);
    if (gitDirRaw === null || commonDirRaw === null) return realToplevel;

    const gitDirAbs = tryRealpath(joinPath(realCwd, gitDirRaw)) ?? joinPath(realCwd, gitDirRaw);
    const commonDirAbs = tryRealpath(joinPath(realCwd, commonDirRaw)) ?? joinPath(realCwd, commonDirRaw);

    if (gitDirAbs === commonDirAbs) return realToplevel; // a main checkout

    const listOutput = tryGit(realCwd, ["worktree", "list", "--porcelain"], env);
    const candidateRaw = listOutput ? firstWorktreeRoot(listOutput) : null;
    const mainRoot = candidateRaw ? validatedMainRoot(candidateRaw, env) : null;
    if (mainRoot !== null) return mainRoot;

    const gitDirIdentity = validatedGitDirIdentity(commonDirAbs, env);
    if (gitDirIdentity !== null) return gitDirIdentity;

    return initRoot;
  } catch {
    return initRoot;
  }
}

export interface BoundaryGit {
  head?: string;
  dirty?: boolean;
}

// Boundary enrichment (spec "Behavior 2"): present with a genuine value, or
// ABSENT — never a fabricated empty string or `false` — when git resolution
// fails (a non-git cwd, or a repo with no commits).
export function resolveBoundaryGit(cwd: string): BoundaryGit {
  try {
    const env = scrubbedEnv(process.env);
    const realCwd = tryRealpath(cwd) ?? cwd;

    const head = tryGit(realCwd, ["rev-parse", "HEAD"], env);
    if (head === null || head.length === 0) return {};

    const result: BoundaryGit = { head };
    const status = tryGit(realCwd, ["status", "--porcelain"], env);
    if (status !== null) result.dirty = status.length > 0;
    return result;
  } catch {
    return {};
  }
}

const BOUNDARY_EVENT_NAMES = new Set(["SessionStart", "SessionEnd"]);

export function isBoundaryEvent(parsedEvent: unknown): boolean {
  if (typeof parsedEvent !== "object" || parsedEvent === null || Array.isArray(parsedEvent)) return false;
  const name = (parsedEvent as Record<string, unknown>).hook_event_name;
  return typeof name === "string" && BOUNDARY_EVENT_NAMES.has(name);
}

function extractCwd(parsedEvent: unknown, fallback: string): string {
  if (typeof parsedEvent === "object" && parsedEvent !== null && !Array.isArray(parsedEvent)) {
    const cwd = (parsedEvent as Record<string, unknown>).cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return fallback;
}

// Matches any raw control character (0x00-0x1F) — mirrors
// src/core/envelope.ts's CONTROL_CHAR_RE exactly, restated here rather than
// imported per the zero-dependency contract.
const CONTROL_CHAR_RE = /[\x00-\x1f]/;

export type ValidateEventTextResult = { ok: true; eventText: string; parsed: unknown } | { ok: false };

// The payload is byte-preserved: this validates the raw stdin text without
// ever re-serializing it (parse-then-stringify would drift key order and
// silently violate "payload stored verbatim, never rewritten"). Order
// matters here (2026-07-14, S1 — a real event lost with no error): a
// TRAILING newline (or surrounding whitespace) is stdin FRAMING, the
// ordinary shape Claude Code pipes a JSON payload in — trim it first. Only
// AFTER trimming does the control-character check run, so what it actually
// rejects is an INTERIOR control character (e.g. a newline in the middle of
// the trimmed text), which would make the appended spool record span two
// physical lines and desync every line_no. The previous attempt ran this
// check against the RAW, untrimmed stdin — so an ordinary trailing `\n`
// tripped the same rejection meant for interior corruption, and every
// normal payload was silently dropped. The bar for skipping a write is
// "genuinely unrecoverable" (empty, non-JSON, or an interior control
// character) — never "had a trailing newline".
export function validateEventText(raw: string): ValidateEventTextResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false };
  if (CONTROL_CHAR_RE.test(trimmed)) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false };
  }
  return { ok: true, eventText: trimmed, parsed };
}

function buildGitPart(git: BoundaryGit | undefined): string | undefined {
  if (!git) return undefined;
  const fields: string[] = [];
  if (typeof git.head === "string" && git.head.length > 0) fields.push(`"head":${JSON.stringify(git.head)}`);
  if (typeof git.dirty === "boolean") fields.push(`"dirty":${JSON.stringify(git.dirty)}`);
  return fields.length > 0 ? `{${fields.join(",")}}` : undefined;
}

// Builds one v1 spool line, byte-preserving `eventText` verbatim as the
// `event` member. Mirrors src/core/envelope.ts's `serializeEnvelope`
// output shape exactly — pinned by tests/unit/hook (a line built here must
// parse cleanly through that module's `parseEnvelope`).
export function buildSpoolLine(ts: string, eventText: string, git?: BoundaryGit): string {
  const parts = [`"v":1`, `"ts":${JSON.stringify(ts)}`, `"event":${eventText}`];
  const gitPart = buildGitPart(git);
  if (gitPart) parts.push(`"git":${gitPart}`);
  return `{${parts.join(",")}}\n`;
}

function appendSpoolLine(repoRoot: string, line: string): void {
  try {
    const dataDir = `${repoRoot.replace(/\/+$/, "")}/.coreartifact`;
    mkdirSync(dataDir, { recursive: true });
    const spoolPath = `${dataDir}/spool.jsonl`;
    // A single O_APPEND write of one line under the pipe-buffer size is
    // atomic on macOS and Linux (spec "Behavior 1") — the default `"a"`
    // flag opens with O_APPEND, and the whole line was built in memory
    // above, so there is nothing here to read-modify-write or lock.
    appendFileSync(spoolPath, line, { flag: "a" });
  } catch {
    // Capture is best-effort: an unwritable spool directory, a missing
    // parent, or any other filesystem failure must never break the host
    // session (spec "Always exits 0").
  }
}

// Reads stdin to completion via the stream's data/end events, never a
// synchronous `readFileSync(0, ...)`: when the parent is a `child_process`
// pipe (every real invocation — the test harness's spawn(), and Claude
// Code's own hook spawn), the fd is opened non-blocking, and a synchronous
// read against it can throw EAGAIN before any data has arrived — a libuv
// pipe quirk, not a real failure. The event-driven read waits for the
// event loop instead of racing the pipe's readiness.
function readStdinText(): Promise<string> {
  return new Promise((resolvePromise) => {
    let data = "";
    let settled = false;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        data += chunk;
      });
      process.stdin.on("end", () => finish(data));
      process.stdin.on("error", () => finish(data));
    } catch {
      finish(data);
    }
  });
}

// Every failure mode is swallowed here so the host session is never
// affected: unparseable stdin, an unresolvable cwd, an unwritable spool, a
// git call that fails or times out. Nothing below this function's own
// try/catch is allowed to escape it.
export async function main(): Promise<void> {
  try {
    const initRoot = process.argv[INIT_ROOT_ARGV_INDEX];
    if (typeof initRoot !== "string" || initRoot.length === 0) return;

    const validated = validateEventText(await readStdinText());
    if (!validated.ok) return;

    const cwd = extractCwd(validated.parsed, initRoot);
    const repoRoot = resolveRepoRoot(cwd, initRoot);

    let git: BoundaryGit | undefined;
    if (isBoundaryEvent(validated.parsed)) {
      git = resolveBoundaryGit(cwd);
    }

    const line = buildSpoolLine(new Date().toISOString(), validated.eventText, git);
    appendSpoolLine(repoRoot, line);
  } catch {
    // capture is best-effort; never throw out of main
  }
}

// Run when this file IS the process entry — portable, symlink-safe check
// (see file header). Realpath both sides so a symlinked argv[1] matches the
// loader's real import.meta.url; default to RUNNING on any ambiguity.
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false; // imported as a module (no process entry) — do not run
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Could not resolve one side (moved/unlinked). In production the artifact
    // is only ever the entry, and a missed capture is the harm — prefer to run.
    return true;
  }
}

if (isProcessEntry()) {
  main()
    .catch(() => {
      // main() already swallows every internal failure; this is defense in
      // depth only.
    })
    .finally(() => {
      process.exit(0);
    });
}

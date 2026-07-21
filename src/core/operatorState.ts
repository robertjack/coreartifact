// Operator state — global append-only JSONL log of the machine's install
// id, ping consent and last-ping time (spec "Global operator state").
// src/core/registry.ts is the normative prior art: this module mirrors its
// append/fold shape exactly (one atomic O_APPEND per write, a total fold
// that skips-and-counts hostile lines instead of throwing) rather than
// re-deriving the pattern. Consumers: the init-time consent question and
// the weekly ping (a later issue); doctor never reads it; per-repo
// uninstall never touches it — this file is machine-scoped, not repo-scoped.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see paths.ts), so the node:fs import below is `@ts-ignore`d at the import
// site and immediately re-typed through a local interface describing only
// the surface this file calls, the same pattern registry.ts uses.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { mkdirSync as mkdirSyncFn, appendFileSync as appendFileSyncFn, readFileSync as readFileSyncFn } from "node:fs";
import { getPaths } from "./paths.js";

const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const appendFileSync = appendFileSyncFn as (path: string, data: string) => void;
const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;

export type OperatorStateOp = "install" | "consent" | "ping";

// Compile-time proof that OperatorStateEntry's discriminated `op` union
// never drifts from the OperatorStateOp contract above (daily-lane finding
// 153): if a new entry variant's `op` literal is ever added below without a
// matching addition to OperatorStateOp, `Exclude<..., OperatorStateOp>`
// stops being `never` and this assignment fails to typecheck.
type AssertEntryOpsCoveredByOperatorStateOp = Exclude<OperatorStateEntry["op"], OperatorStateOp> extends never
  ? true
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _entryOpsCoveredByOperatorStateOp: AssertEntryOpsCoveredByOperatorStateOp = true;

export interface InstallEntry {
  v: 1;
  op: "install";
  install_id: string;
  at: string;
}

export interface ConsentEntry {
  v: 1;
  op: "consent";
  ping: boolean;
  at: string;
}

export interface PingEntry {
  v: 1;
  op: "ping";
  at: string;
}

export type OperatorStateEntry = InstallEntry | ConsentEntry | PingEntry;

// Hand-rolled dirname: same rationale as registry.ts — this file owns no
// shared path-join module.
function dirnameOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx <= 0 ? "/" : filePath.slice(0, idx);
}

function appendLine(statePath: string, entry: OperatorStateEntry): void {
  mkdirSync(dirnameOf(statePath), { recursive: true });
  appendFileSync(statePath, `${JSON.stringify(entry)}\n`);
}

// One atomic O_APPEND of one line, no read, no lock, no read-modify-write —
// the registry rewrite's ruling applies here verbatim (2026-07-14): a single
// appendFileSync call is one write() syscall for a line this size, which
// POSIX guarantees is atomic under O_APPEND.
export async function appendInstall(installId: string, statePath: string = getPaths().state): Promise<void> {
  appendLine(statePath, { v: 1, op: "install", install_id: installId, at: new Date().toISOString() });
}

export async function appendConsent(ping: boolean, statePath: string = getPaths().state): Promise<void> {
  appendLine(statePath, { v: 1, op: "consent", ping, at: new Date().toISOString() });
}

export async function appendPing(statePath: string = getPaths().state): Promise<void> {
  appendLine(statePath, { v: 1, op: "ping", at: new Date().toISOString() });
}

export interface FoldedOperatorState {
  install_id: string | null;
  consent: boolean;
  last_ping_at: string | null;
  skipped: number;
}

// Total: a missing file folds to the empty state; a corrupt, truncated, or
// shape-invalid line is skipped and counted, never thrown — a damaged state
// file must never take down a CLI command (packet "The fold").
//
// install_id is first-wins (the id is generated once and is the only value
// that ever leaves the machine in a ping, so it must never silently
// change); consent and last_ping_at are last-wins (mutable settings/facts).
// Default with no consent op ever recorded is `false` — the degradation
// law applied to consent: silence folds to "no", never to a flattering
// "yes" (gotchas entry 5).
export async function readState(statePath: string = getPaths().state): Promise<FoldedOperatorState> {
  const folded: FoldedOperatorState = {
    install_id: null,
    consent: false,
    last_ping_at: null,
    skipped: 0,
  };

  let text: string;
  try {
    text = readFileSync(statePath, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return folded; // missing file: empty state, not an error
    }
    // A damaged file (permissions, EISDIR, ...) must not take down every
    // command that reads operator state: fold to empty, warn, never rethrow.
    console.warn(
      `coreartifact: could not read operator state at ${statePath} (${code ?? "unknown error"}); treating it as empty.`
    );
    return folded;
  }

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    // Blank lines are STRUCTURAL (the log's trailing newline), not damaged
    // entries — deliberately not counted as skipped, same ruling as registry.ts.
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      folded.skipped++;
      continue; // corrupt or truncated line: skipped, counted, never thrown
    }

    // Valid JSON but not a plain object: null, true, 123, "str", [] are all
    // JSON.parse successes that must never be treated as an entry.
    // `typeof null === "object"` is the classic trap — excluded explicitly.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      folded.skipped++;
      continue;
    }

    // A hand-rolled "any shape any op might have" record, not an
    // intersection of the three entry interfaces — InstallEntry & ConsentEntry
    // & PingEntry would force `op` to the impossible intersection of three
    // disjoint string literals ("install" & "consent" & "ping" = never),
    // narrowing every field access below to `never` under strict mode.
    const candidate = parsed as {
      v?: unknown;
      op?: unknown;
      at?: unknown;
      install_id?: unknown;
      ping?: unknown;
    };

    if (candidate.v !== 1) {
      folded.skipped++;
      continue; // line-level version contract: never assumed, only honored
    }

    if (typeof candidate.at !== "string") {
      folded.skipped++;
      continue; // absent `at`: skip-and-count, never fabricate ""
    }

    if (candidate.op === "install") {
      if (typeof candidate.install_id !== "string" || candidate.install_id.length === 0) {
        folded.skipped++;
        continue; // shape-invalid install: skip-and-count, never fabricate an id
      }
      // First-wins: a second install op (crash race at first init) is
      // folded away, not an error, and never overwrites the first.
      if (folded.install_id === null) {
        folded.install_id = candidate.install_id;
      }
      continue;
    }

    if (candidate.op === "consent") {
      if (typeof candidate.ping !== "boolean") {
        folded.skipped++;
        continue; // shape-invalid consent: skip-and-count, never coerce a value
      }
      // Last-wins for a mutable setting: later lines override earlier ones.
      folded.consent = candidate.ping;
      continue;
    }

    if (candidate.op === "ping") {
      // Last-wins: the log is append-ordered, so the last valid ping line
      // processed is the latest one, never fabricated from an absent `at`.
      folded.last_ping_at = candidate.at;
      continue;
    }

    // Unrecognized op: skip-and-count, never fold as any recognized op.
    folded.skipped++;
  }

  return folded;
}

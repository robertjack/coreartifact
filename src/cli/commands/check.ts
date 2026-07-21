// `coreartifact check <name> -- <cmd>` — turn a wrapped command run into
// spool-borne evidence (docs/issues/ISS-0017.md). The spool is the only
// write path: this command appends exactly one check line (via the core
// serializer, atomic O_APPEND — same discipline as capture) and never
// writes the ledger directly.
//
// `check` is a READER for binding purposes: it triggers the same lazy
// ingest `log`/`show` do before resolving the open-session set, so a
// deleted ledger or spool lines newer than the last ingest still yield the
// true open set (spec "Binding").
//
// F124 (ISS-0017 round-4 review): this used to open a SECOND, readOnly
// connection after ingest to resolve the open-session set. busy_timeout
// only covers ordinary SQLITE_BUSY contention on an established ledger --
// it does nothing against the first-creation race (a brand-new repo, N
// concurrent first-ever `check` processes racing to create the ledger),
// which is a DIFFERENT connection hitting the SAME race window
// `ingest`'s own retry loop already exists to serialize (see
// src/ingest/index.ts's block comment). Reviewer repro: a fresh repo, no
// init, 10-24 concurrent first-ever `check` runs -> intermittent "attempt
// to write a readonly database" / "no such table: sessions", exit 1, the
// wrapped command never even started. The fix is to never open that second
// connection at all: `ingestAndResolveSessions` resolves the open-session
// set from the SAME connection ingest already opened (and already retries),
// so there is exactly one connection, one race window, already covered.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:fs import below is `@ts-ignore`d at the
// import site and re-typed through a local interface, same pattern as
// src/cli/commands/show.ts.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { mkdirSync as mkdirSyncFn, appendFileSync as appendFileSyncFn } from "node:fs";
import { getPaths, joinPath } from "../../core/paths.js";
import { resolveAttribution } from "../../core/attribution.js";
import { serializeCheckLine } from "../../core/envelope.js";
import { ingestAndResolveSessions } from "../../ingest/index.js";
import { parseCheckArgv } from "../../check/argv.js";
import { resolveBinding } from "../../check/binding.js";
import { capOutput } from "../../check/cap.js";
import { runCheckedCommand } from "../../check/run.js";

const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const appendFileSync = appendFileSyncFn as (path: string, data: string, options?: { flag?: string }) => void;

declare const process: {
  cwd(): string;
  stderr: { write(chunk: string): boolean };
};


export async function checkCommand(args: string[]): Promise<number> {
  const parsed = parseCheckArgv(args);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    return 1;
  }

  const cwd = process.cwd();
  const { repoRoot } = await resolveAttribution(cwd, cwd);
  const paths = getPaths(repoRoot);

  // Reader: lazy ingest before resolving the open-session set, exactly like
  // `log`/`show` (spec "Binding") — a deleted ledger or unseen spool tail
  // must still yield the true open set. The open-session identity set is
  // read from ingest's OWN connection (F124) — no second connection, no
  // second first-creation race window.
  const { sessions: rows } = await ingestAndResolveSessions(repoRoot);
  const knownSessionIds = new Set(rows.map((r) => r.session_id));
  const openSessionIds = rows.filter((r) => r.status === "open").map((r) => r.session_id);
  const binding = resolveBinding({
    explicitSessionId: parsed.session,
    openSessionIds,
    knownSessionIds,
  });

  if (!binding.ok) {
    process.stderr.write(`coreartifact check: unknown --session id: ${binding.unknownSessionId}\n`);
    return 1;
  }

  const runResult = await runCheckedCommand(parsed.command);
  const capped = capOutput(runResult.output);

  const serialized = serializeCheckLine({
    v: 1,
    ts: new Date().toISOString(),
    check: {
      name: parsed.name,
      argv: parsed.command,
      exit: runResult.exitCode,
      output: capped.output,
      truncated: capped.truncated,
      session_id: binding.sessionId,
      bound_by: binding.boundBy,
    },
  });

  if (!serialized.ok) {
    process.stderr.write(`coreartifact check: could not serialize the check line: ${serialized.reason}\n`);
    return 1;
  }

  const dataDir = joinPath(repoRoot, ".coreartifact");
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(paths.spool, serialized.line, { flag: "a" });

  return runResult.exitCode;
}

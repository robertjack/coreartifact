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
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:fs/node:sqlite imports below are
// `@ts-ignore`d at the import site and re-typed through a local interface,
// same pattern as src/cli/commands/show.ts.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { mkdirSync as mkdirSyncFn, appendFileSync as appendFileSyncFn } from "node:fs";
// @ts-ignore -- node:sqlite has no ambient types available in this sandbox
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";
import { getPaths } from "../../core/paths.js";
import { resolveAttribution } from "../../core/attribution.js";
import { serializeCheckLine } from "../../core/envelope.js";
import { ingest } from "../../ingest/index.js";
import { parseCheckArgv } from "../../check/argv.js";
import { resolveBinding } from "../../check/binding.js";
import { capOutput } from "../../check/cap.js";
import { runCheckedCommand } from "../../check/run.js";

const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const appendFileSync = appendFileSyncFn as (path: string, data: string, options?: { flag?: string }) => void;

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const DatabaseSync = DatabaseSyncCtor as unknown as new (
  path: string,
  options?: { readOnly?: boolean },
) => SqliteDatabase;

declare const process: {
  cwd(): string;
  stderr: { write(chunk: string): boolean };
};

interface SessionIdentityRow {
  session_id: string;
  status: string;
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

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
  // must still yield the true open set.
  await ingest(repoRoot);

  const db = new DatabaseSync(paths.ledger, { readOnly: true });
  let binding: ReturnType<typeof resolveBinding>;
  try {
    const rows = db.prepare("SELECT session_id, status FROM sessions").all() as SessionIdentityRow[];
    const knownSessionIds = new Set(rows.map((r) => r.session_id));
    const openSessionIds = rows.filter((r) => r.status === "open").map((r) => r.session_id);
    binding = resolveBinding({
      explicitSessionId: parsed.session,
      openSessionIds,
      knownSessionIds,
    });
  } finally {
    db.close();
  }

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

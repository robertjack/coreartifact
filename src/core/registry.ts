// The registry — global append-only JSONL log of ledger roots (schema.md
// Surface 3, rewritten 2026-07-14). The old registry was a JSON object
// holding an array, forcing addLedger into a read-modify-write; that was
// the system's only read-modify-write and its only source of concurrency
// bugs (lost update -> wedging O_EXCL lock -> TOCTOU stale-lock steal,
// three review rounds in a row). The fix deletes the read-modify-write
// rather than patching it again: addLedger only ever appends.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see paths.ts and ledger.ts), so the node:fs import below is `@ts-ignore`d
// at the import site and immediately re-typed through a local interface
// describing only the surface this file calls (see ledger.ts for the same
// pattern and why a `declare module` shim can't be used instead).

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { mkdirSync as mkdirSyncFn, appendFileSync as appendFileSyncFn, readFileSync as readFileSyncFn } from "node:fs";
import { getPaths } from "./paths.js";

const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const appendFileSync = appendFileSyncFn as (path: string, data: string) => void;
const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;

export type RegistryOp = "add" | "remove";

export interface RegistryEntry {
  v: 1;
  op: RegistryOp;
  repo_root: string;
  at: string;
}

// Hand-rolled dirname: same rationale as ledger.ts — this file owns no
// shared path-join module.
function dirnameOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx <= 0 ? "/" : filePath.slice(0, idx);
}

// One atomic O_APPEND of one line. Never reads the file first — that is
// the whole point. A single appendFileSync call is one write() syscall for
// a line this size, which POSIX guarantees is atomic under O_APPEND: two
// concurrent appenders can never interleave mid-line or lose one another's
// line, the same physics that makes the spool safe. No lock file, no
// reaping, no TTL, no pid check, no retry loop.
export async function addLedger(repoRoot: string, registryPath: string = getPaths().registry): Promise<void> {
  mkdirSync(dirnameOf(registryPath), { recursive: true });
  const entry: RegistryEntry = {
    v: 1,
    op: "add",
    repo_root: repoRoot,
    at: new Date().toISOString(),
  };
  appendFileSync(registryPath, `${JSON.stringify(entry)}\n`);
}

// A Map is still the return type (an acceptance-test contract: readers key
// off `instanceof Map`/`.keys()`), with the skipped-line count attached as a
// plain property on the instance rather than wrapping it — that keeps every
// existing Map read (`.size`, `.has`, `.keys()`) working unchanged while
// still surfacing the count the totality criterion requires.
export type FoldedRegistry = Map<string, RegistryEntry> & { skipped: number };

// Total: a missing file folds to the empty set; a corrupt or truncated
// line is skipped and counted (never thrown), so a damaged registry never
// takes down a command that reads it — the count is what makes "skipped"
// an observable fact instead of a silent zero. Dedupes by repo_root, last
// op for a root wins — remove tombstones (PRD-0002) fold out of the set.
//
// Every branch below skips-and-counts rather than throwing or fabricating
// (2026-07-14 findings, R1-R6): JSON.parse can succeed on a value that is
// not a plain object at all (`null`, `true`, `123`, `"str"`, `[]`) —
// `typeof null === "object"` is the classic trap, so `null` is excluded
// explicitly and arrays are excluded via `Array.isArray`. A line whose `v`
// is not `1`, or whose `op` is neither `add` nor `remove`, is skipped and
// counted rather than assumed/coerced — an unrecognized op must never fold
// as an add, or a future `remove` variant would silently register a repo.
// A line with no string `at` is skipped and counted rather than fabricating
// an empty-string timestamp (the degradation law: absent, never invented).
export async function readRegistry(
  registryPath: string = getPaths().registry
): Promise<FoldedRegistry> {
  const folded = new Map<string, RegistryEntry>() as FoldedRegistry;
  folded.skipped = 0;

  let text: string;
  try {
    text = readFileSync(registryPath, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return folded; // missing file: empty set, not an error
    }
    // A damaged file (permissions, EISDIR, ...) must not take down every
    // command that reads the registry: fold to empty, warn, never rethrow.
    console.warn(
      `coreartifact: could not read registry at ${registryPath} (${code ?? "unknown error"}); treating it as empty.`
    );
    return folded;
  }

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    // Blank lines are STRUCTURAL, not damaged entries: the log's trailing
    // newline would otherwise make every healthy file report skipped >= 1,
    // crying wolf on the one signal that must mean real damage. Deliberately
    // not counted as skipped.
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      folded.skipped++;
      continue;
    }

    const candidate = parsed as Partial<RegistryEntry>;

    if (candidate.v !== 1) {
      folded.skipped++;
      continue; // line-level version contract: never assumed, only honored
    }

    // An empty repo_root is a phantom entry: it folds to a real-looking row that
    // no cross-ledger read can ever resolve. Skip-and-count it like any other
    // malformed line rather than registering a root that does not exist.
    if (typeof candidate.repo_root !== "string" || candidate.repo_root.length === 0) {
      folded.skipped++;
      continue;
    }

    if (typeof candidate.at !== "string") {
      folded.skipped++;
      continue; // absent `at`: skip-and-count, never fabricate ""
    }

    if (candidate.op === "remove") {
      folded.delete(candidate.repo_root);
      continue;
    }

    if (candidate.op !== "add") {
      folded.skipped++;
      continue; // unrecognized op: skip-and-count, never fold as an add
    }

    folded.set(candidate.repo_root, {
      v: 1,
      op: "add",
      repo_root: candidate.repo_root,
      at: candidate.at,
    });
  }

  return folded;
}

// ISS-0017 acceptance tests — `coreartifact check <name> -- <cmd>` turns a
// wrapped command run into spool-borne evidence (docs/issues/ISS-0017.md).
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory with its isolated registry,
// CLI runner, fixture replayer). The check envelope variant (parseSpoolLine)
// and the ledger schema v2 (openLedger, CheckRow) are the check-variant
// contract issue's (ISS-0013) already-shipped, real exports from
// src/core/envelope.ts and src/core/ledger.ts — imported directly, never
// reinvented. ISS-0013's OWN acceptance test
// (tests/acceptance/ISS-0013/ledgerSchemaV2.test.ts) reads the `checks`
// table the same way: `openLedger(dbPath).db.prepare(...).all()` cast to the
// exported row type — that is "the check-variant contract's exported ledger
// row reader" this issue's spec points at; there is no separate wrapped
// reader function to import, and the acceptance harness's own readers.ts
// (frozen, outside this footprint) never grew one either.
//
// Module under test: `src/cli/commands/check.ts` / `src/check/**` (this
// issue's own, not-yet-existing footprint) plus the ingest routing this
// issue adds to `src/ingest/**`. Every test below drives the built CLI
// subprocess (runCli) and reads back through the ledger — never imports the
// not-yet-existing command module directly.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { createTmpRepo, runCli, replayFixtures, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { getPaths } from "../../../src/core/paths.js";
import { parseSpoolLine, type CheckFields } from "../../../src/core/envelope.js";
import { openLedger, type CheckRow } from "../../../src/core/ledger.js";

// The spec's own literal ("CHECK_OUTPUT_CAP_BYTES of 32768 bytes") — an
// independent oracle, never imported from the implementation the cap test
// exists to check.
const CAP_BYTES = 32768;

interface RawHookResult {
  exitCode: number;
}

// Mirrors tests/acceptance/ISS-0007/log.test.ts's own helper: a single raw
// invocation of the installed hook command with caller-supplied stdin bytes
// — needed to plant a SECOND no-SessionEnd (still-open) session under a
// distinct session_id, which no single named fixture scenario provides on
// its own.
function runRawHookInvocation(command: string[], stdinText: string): Promise<RawHookResult> {
  const [cmd, ...args] = command;
  if (!cmd) throw new Error("test setup invariant: empty hook command");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ exitCode: code ?? -1 });
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function sessionIdOf(fixtureLine: string): string {
  const parsed = JSON.parse(fixtureLine) as { session_id?: unknown };
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
    throw new Error("test setup invariant: fixture line has no session_id");
  }
  return parsed.session_id;
}

// Replays the SIGKILL scenario's lines under an OVERRIDDEN session_id — a
// second still-open (no SessionEnd) session distinct from whatever the
// scenario's own replay already created, per this issue's own "several
// open" test-harness guidance.
async function makeSecondOpenSession(hookCommand: string[], newSessionId: string): Promise<void> {
  const lines = loadFixtureStream("SIGKILL");
  for (const line of lines) {
    const payload = { ...JSON.parse(line), session_id: newSessionId };
    const result = await runRawHookInvocation(hookCommand, JSON.stringify(payload));
    if (result.exitCode !== 0) {
      throw new Error("test setup invariant: hook invocation for the second open session did not exit 0");
    }
  }
}

// Reads every check-variant line currently in the spool, via the real,
// already-shipped `parseSpoolLine` discriminator — never a hand-rolled
// re-parse of the raw JSON.
function readSpoolCheckLines(spoolPath: string): Array<{ ts: string; check: CheckFields }> {
  if (!existsSync(spoolPath)) return [];
  const text = readFileSync(spoolPath, "utf8");
  const out: Array<{ ts: string; check: CheckFields }> = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim().length === 0) continue;
    const parsed = parseSpoolLine(rawLine);
    if (parsed.kind === "check") out.push({ ts: parsed.ts, check: parsed.check });
  }
  return out;
}

// The check-variant contract's own read path (see header comment): open the
// ledger and query `checks` directly, cast to the exported row type.
function readCheckRows(dbPath: string): CheckRow[] {
  const handle = openLedger(dbPath);
  try {
    return handle.db.prepare("SELECT * FROM checks ORDER BY line_no").all() as CheckRow[];
  } finally {
    handle.close();
  }
}

describe("ISS-0017 check: evidence badges through the spool", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    "R1 Check runs and records. coreartifact check <name> -- <cmd> runs the command, appends exactly one check line to the spool (never a direct ledger write), and exits with the wrapped command's exit code. After ingest: a check row with name, command, pass/fail, and captured output (truncated at a named cap with a truncation flag when exceeded). A failing command records a failing check; the check itself still records (recording is not conditional on success).",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
      const init = await runCli(["init"], opts);
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);

      // --- Passing command. ---
      const passResult = await runCli(
        ["check", "unit-pass", "--", "node", "-e", "process.stdout.write('pass-output-marker')"],
        opts,
      );
      expect(
        passResult.exitCode,
        "check did not exit with the wrapped command's own exit code (passing case)",
      ).toBe(0);
      // Operator amendment 2026-07-16 (review S2 #121): the spec's "check
      // wraps, it does not swallow" clause had zero acceptance coverage —
      // a regression to capture-and-swallow kept every test green. The
      // wrapped command's output must reach the USER's stream, not just
      // the spool.
      expect(
        passResult.stdout,
        "the wrapped command's stdout must stream through to the user (check wraps, it does not swallow)",
      ).toContain("pass-output-marker");

      const spoolAfterPass = readSpoolCheckLines(paths.spool);
      expect(
        spoolAfterPass.length,
        "check did not append exactly one check line to the spool for the passing run",
      ).toBe(1);
      expect(spoolAfterPass[0]!.check.name).toBe("unit-pass");
      expect(spoolAfterPass[0]!.check.exit).toBe(0);
      expect(spoolAfterPass[0]!.check.output).toContain("pass-output-marker");

      expect(
        readCheckRows(paths.ledger).length,
        "a check row existed before any ingest ran -- check must never write the ledger directly, only the spool",
      ).toBe(0);

      const logAfterPass = await runCli(["log"], opts);
      expect(logAfterPass.exitCode, `log (ingest) did not exit 0; stderr: ${logAfterPass.stderr}`).toBe(0);

      const rowsAfterPass = readCheckRows(paths.ledger);
      const passRow = rowsAfterPass.find((r) => r.name === "unit-pass");
      if (!passRow) throw new Error("no check row found for the passing check after ingest");
      expect(passRow.exit_code, "the check row must record the wrapped command's exit code").toBe(0);
      expect(passRow.output, "the check row must record the captured output").toContain("pass-output-marker");
      expect(passRow.truncated, "output under the cap must not be flagged truncated").toBe(0);
      const passArgv = JSON.parse(passRow.argv) as string[];
      expect(passArgv, "the check row must record the wrapped command").toContain("node");

      // --- Failing command: recording is never conditional on success. ---
      const failResult = await runCli(
        ["check", "unit-fail", "--", "node", "-e", "process.stderr.write('fail-output-marker'); process.exit(3)"],
        opts,
      );
      expect(
        failResult.exitCode,
        "check did not exit with the wrapped command's own exit code (failing case)",
      ).toBe(3);

      const spoolAfterFail = readSpoolCheckLines(paths.spool);
      expect(
        spoolAfterFail.length,
        "check did not append exactly one check line for the failing run (spool should now hold 2 total)",
      ).toBe(2);
      const failLine = spoolAfterFail.find((l) => l.check.name === "unit-fail");
      if (!failLine) throw new Error("no spool check line found for the failing check");
      expect(failLine.check.exit).toBe(3);
      expect(failLine.check.output).toContain("fail-output-marker");

      const logAfterFail = await runCli(["log"], opts);
      expect(logAfterFail.exitCode, `log (ingest) did not exit 0; stderr: ${logAfterFail.stderr}`).toBe(0);

      const rowsAfterFail = readCheckRows(paths.ledger);
      expect(
        rowsAfterFail.length,
        "both the passing and the failing check must be recorded -- recording is not conditional on success",
      ).toBe(2);
      const failRow = rowsAfterFail.find((r) => r.name === "unit-fail");
      if (!failRow) throw new Error("no check row found for the failing check after ingest");
      expect(failRow.exit_code, "a failing command must still record its real exit code").toBe(3);
      expect(failRow.output, "a failing command's captured output must still be recorded").toContain(
        "fail-output-marker",
      );
    },
    60000,
  );

  it(
    "R2 Checks survive rebuild. Deleting the ledger and re-ingesting rebuilds check rows equivalent to the originals — checks are spool ground truth, the ledger stays a pure projection.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
      const init = await runCli(["init"], opts);
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);

      const passing = await runCli(["check", "r2-passing", "--", "node", "-e", "process.stdout.write('r2-out')"], opts);
      expect(passing.exitCode).toBe(0);
      const failing = await runCli(["check", "r2-failing", "--", "node", "-e", "process.exit(5)"], opts);
      expect(failing.exitCode).toBe(5);

      const logResult = await runCli(["log"], opts);
      expect(logResult.exitCode, `log (ingest) did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const before = readCheckRows(paths.ledger);
      expect(before.length, "test setup invariant: expected two check rows before rebuild").toBe(2);

      rmSync(paths.ledger);
      expect(existsSync(paths.ledger), "test setup invariant: the ledger file was not actually deleted").toBe(false);

      const logAfterDelete = await runCli(["log"], opts);
      expect(
        logAfterDelete.exitCode,
        `log (re-ingest after deleting the ledger) did not exit 0; stderr: ${logAfterDelete.stderr}`,
      ).toBe(0);

      const after = readCheckRows(paths.ledger);
      expect(
        after,
        "rebuilt check rows (same line_no, same fields) must be equivalent to the originals after deleting the ledger and re-ingesting",
      ).toEqual(before);
    },
    60000,
  );

  it(
    "R3 Check binding (single-open-session rule). At check time with exactly one open session in the repo's ledger, the check binds to it; with zero or several open, it records standalone (session NULL — never a guess); --session <id> always wins; an unknown --session id exits nonzero naming the id. The resolved binding and which rule produced it are recorded in the spool line itself.",
    async () => {
      // --- Phase A: zero open sessions -> standalone. ---
      const repoZero = await createTmpRepo();
      tmpRepos.push(repoZero);
      const optsZero = { cwd: repoZero.root, home: repoZero.home, registryPath: repoZero.registryPath };
      const initZero = await runCli(["init"], optsZero);
      expect(initZero.exitCode, `test setup invariant: init did not exit 0; stderr: ${initZero.stderr}`).toBe(0);
      const pathsZero = getPaths(repoZero.root);

      const zeroCheck = await runCli(["check", "bind-zero", "--", "node", "-e", "process.exit(0)"], optsZero);
      expect(zeroCheck.exitCode).toBe(0);
      const logZero = await runCli(["log"], optsZero);
      expect(logZero.exitCode, `log (ingest) did not exit 0; stderr: ${logZero.stderr}`).toBe(0);

      const zeroRow = readCheckRows(pathsZero.ledger).find((r) => r.name === "bind-zero");
      if (!zeroRow) throw new Error("no check row found for the zero-open-sessions case");
      expect(
        zeroRow.session_id,
        "zero open sessions must bind standalone (session_id null), never a guess",
      ).toBeNull();
      expect(zeroRow.bound_by, "zero open sessions must bind standalone (bound_by null)").toBeNull();

      // --- Phase B: exactly one open session -> single-open binding. ---
      const repoOne = await createTmpRepo();
      tmpRepos.push(repoOne);
      const optsOne = { cwd: repoOne.root, home: repoOne.home, registryPath: repoOne.registryPath };
      const initOne = await runCli(["init"], optsOne);
      expect(initOne.exitCode, `test setup invariant: init did not exit 0; stderr: ${initOne.stderr}`).toBe(0);
      const pathsOne = getPaths(repoOne.root);
      const sigkillLines = loadFixtureStream("SIGKILL");
      await replayFixtures("SIGKILL", repoOne.root);
      const openSessionId = sessionIdOf(sigkillLines[0]!);

      const oneCheck = await runCli(["check", "bind-one", "--", "node", "-e", "process.exit(0)"], optsOne);
      expect(oneCheck.exitCode).toBe(0);
      const logOne = await runCli(["log"], optsOne);
      expect(logOne.exitCode, `log (ingest) did not exit 0; stderr: ${logOne.stderr}`).toBe(0);

      const oneRow = readCheckRows(pathsOne.ledger).find((r) => r.name === "bind-one");
      if (!oneRow) throw new Error("no check row found for the single-open-session case");
      expect(oneRow.session_id, "exactly one open session must bind to it").toBe(openSessionId);
      expect(oneRow.bound_by, "the single-open rule must be recorded as the binding reason").toBe("single-open");

      // --- Phase C: several open sessions -> standalone (never guessed). ---
      const repoSeveral = await createTmpRepo();
      tmpRepos.push(repoSeveral);
      const optsSeveral = { cwd: repoSeveral.root, home: repoSeveral.home, registryPath: repoSeveral.registryPath };
      const initSeveral = await runCli(["init"], optsSeveral);
      expect(initSeveral.exitCode, `test setup invariant: init did not exit 0; stderr: ${initSeveral.stderr}`).toBe(0);
      const pathsSeveral = getPaths(repoSeveral.root);
      await replayFixtures("SIGKILL", repoSeveral.root);
      const secondOpenId = "iss17-r3-second-open-session";
      // makeSecondOpenSession is a raw hook invocation (never through the
      // harness's replay primitives), so it still needs a literal command.
      const hookCommandSeveral = ["node", pathsSeveral.hookArtifact, repoSeveral.root];
      await makeSecondOpenSession(hookCommandSeveral, secondOpenId);

      const severalCheck = await runCli(["check", "bind-several", "--", "node", "-e", "process.exit(0)"], optsSeveral);
      expect(severalCheck.exitCode).toBe(0);
      const logSeveral = await runCli(["log"], optsSeveral);
      expect(logSeveral.exitCode, `log (ingest) did not exit 0; stderr: ${logSeveral.stderr}`).toBe(0);

      const severalRow = readCheckRows(pathsSeveral.ledger).find((r) => r.name === "bind-several");
      if (!severalRow) throw new Error("no check row found for the several-open-sessions case");
      expect(
        severalRow.session_id,
        "several open sessions must bind standalone (session_id null), never a guess",
      ).toBeNull();
      expect(severalRow.bound_by, "several open sessions must bind standalone (bound_by null)").toBeNull();

      // --- Phase D: --session always wins, even over the several-open state above. ---
      const explicitCheck = await runCli(
        ["check", "bind-explicit", "--session", secondOpenId, "--", "node", "-e", "process.exit(0)"],
        optsSeveral,
      );
      expect(explicitCheck.exitCode).toBe(0);
      const logExplicit = await runCli(["log"], optsSeveral);
      expect(logExplicit.exitCode, `log (ingest) did not exit 0; stderr: ${logExplicit.stderr}`).toBe(0);

      const explicitRow = readCheckRows(pathsSeveral.ledger).find((r) => r.name === "bind-explicit");
      if (!explicitRow) throw new Error("no check row found for the explicit-session case");
      expect(
        explicitRow.session_id,
        "--session must win even when the standalone (several-open) rule would otherwise apply",
      ).toBe(secondOpenId);
      expect(explicitRow.bound_by, "an explicit --session must record bound_by explicit").toBe("explicit");

      // --- Phase E: an unknown --session id exits nonzero, names the id, writes nothing. ---
      const spoolBefore = readFileSync(pathsSeveral.spool, "utf8");
      const unknownId = "iss17-r3-unknown-session-id-does-not-exist";
      const unknownCheck = await runCli(
        ["check", "bind-unknown", "--session", unknownId, "--", "node", "-e", "process.exit(0)"],
        optsSeveral,
      );
      expect(unknownCheck.exitCode, "an unknown --session id must exit nonzero").not.toBe(0);
      const unknownOutput = `${unknownCheck.stdout}\n${unknownCheck.stderr}`;
      expect(unknownOutput, "the unknown --session error must name the offending id").toContain(unknownId);
      const spoolAfter = readFileSync(pathsSeveral.spool, "utf8");
      expect(spoolAfter, "an unknown --session id must write no check line at all -- no line written").toBe(
        spoolBefore,
      );
    },
    60000,
  );

  it(
    "The check output cap is the named constant CHECK_OUTPUT_CAP_BYTES of 32768 bytes: combined output at or under the cap is stored whole with truncated false; output over the cap stores exactly the first 32768 bytes truncated on a UTF-8 codepoint boundary with truncated true — truncation is always flagged, never silent.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
      const init = await runCli(["init"], opts);
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);
      const paths = getPaths(repo.root);

      // --- Under the cap: byte-identical, truncated false. ---
      const smallOutput = "under-cap-output-ok";
      const underResult = await runCli(
        ["check", "cap-under", "--", "node", "-e", `process.stdout.write(${JSON.stringify(smallOutput)})`],
        opts,
      );
      expect(underResult.exitCode).toBe(0);
      const logUnder = await runCli(["log"], opts);
      expect(logUnder.exitCode, `log (ingest) did not exit 0; stderr: ${logUnder.stderr}`).toBe(0);

      const underRow = readCheckRows(paths.ledger).find((r) => r.name === "cap-under");
      if (!underRow) throw new Error("no check row found for the under-cap case");
      expect(underRow.output, "output at/under the cap must be stored byte-identically").toBe(smallOutput);
      expect(underRow.truncated, "output under the cap must not be flagged truncated").toBe(0);

      // --- Over the cap, straddling a multi-byte character: 'x' + 'é' * 16384
      // is 1 + 2*16384 = 32769 bytes. Byte index 32767 (the last byte a
      // 32768-byte cap would include) is the FIRST byte of the 16384th 'é'
      // (a 2-byte UTF-8 character) -- truncating at exactly 32768 bytes
      // would split it. The correct behavior backs off to the last whole
      // codepoint boundary: 'x' + 'é' * 16383, exactly 32767 bytes. Computed
      // independently of the implementation under test, from the spec's own
      // literal cap value. ---
      const REPEAT = 16384;
      const overScript = `process.stdout.write('x' + 'é'.repeat(${REPEAT}))`;
      const overResult = await runCli(["check", "cap-over", "--", "node", "-e", overScript], opts);
      expect(overResult.exitCode).toBe(0);
      const logOver = await runCli(["log"], opts);
      expect(logOver.exitCode, `log (ingest) did not exit 0; stderr: ${logOver.stderr}`).toBe(0);

      const overRow = readCheckRows(paths.ledger).find((r) => r.name === "cap-over");
      if (!overRow) throw new Error("no check row found for the over-cap case");

      const expectedPrefix = "x" + "é".repeat(REPEAT - 1);
      expect(
        Buffer.byteLength(expectedPrefix, "utf8"),
        "test setup invariant: the expected prefix must be exactly 32767 bytes (cap - 1, backed off one whole codepoint)",
      ).toBe(CAP_BYTES - 1);
      expect(
        overRow.output,
        "truncation must land on a codepoint boundary, never splitting the multi-byte character straddling byte 32768",
      ).toBe(expectedPrefix);
      expect(
        Buffer.byteLength(overRow.output, "utf8"),
        "stored output must never exceed the 32768-byte cap",
      ).toBeLessThanOrEqual(CAP_BYTES);
      expect(overRow.truncated, "output exceeding the cap must be flagged truncated, never silently").toBe(1);
    },
    60000,
  );

  it(
    "Binding reflects spool truth at check time: with a captured open session whose ledger has been deleted, check still binds to it by the single-open rule — check ingests before resolving, like every reader.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
      const init = await runCli(["init"], opts);
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);
      const paths = getPaths(repo.root);
      const sigkillLines = loadFixtureStream("SIGKILL");
      await replayFixtures("SIGKILL", repo.root);
      const openSessionId = sessionIdOf(sigkillLines[0]!);

      // Prime a ledger that already knows about the open session, then
      // delete it outright -- the check that follows must still see the
      // true open set by ingesting the spool itself, never by trusting a
      // stale or missing ledger.
      const primeLog = await runCli(["log"], opts);
      expect(primeLog.exitCode, `test setup invariant: log (ingest) did not exit 0; stderr: ${primeLog.stderr}`).toBe(
        0,
      );
      expect(
        readCheckRows(paths.ledger).length,
        "test setup invariant: no check rows should exist yet",
      ).toBe(0);

      rmSync(paths.ledger);
      expect(existsSync(paths.ledger), "test setup invariant: the ledger file was not actually deleted").toBe(false);

      const checkResult = await runCli(
        ["check", "bind-after-delete", "--", "node", "-e", "process.exit(0)"],
        opts,
      );
      expect(checkResult.exitCode).toBe(0);

      const logAfter = await runCli(["log"], opts);
      expect(logAfter.exitCode, `log (ingest) did not exit 0; stderr: ${logAfter.stderr}`).toBe(0);

      const row = readCheckRows(paths.ledger).find((r) => r.name === "bind-after-delete");
      if (!row) throw new Error("no check row found after re-ingest");
      expect(
        row.session_id,
        "check must still bind to the open session by the single-open rule even though the ledger was deleted at check time",
      ).toBe(openSessionId);
      expect(row.bound_by, "the single-open rule must be recorded as the binding reason").toBe("single-open");
    },
    30000,
  );
});

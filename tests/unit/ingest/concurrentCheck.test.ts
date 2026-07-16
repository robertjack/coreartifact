// F119 (ISS-0017 round-2 review): concurrent `coreartifact check` runs
// against ONE repo must never die "database is locked" and zero evidence.
// Root cause (reviewer's executed repro, isolated on a scratch copy):
// src/ingest/index.ts opened its write transaction as plain `BEGIN`
// (DEFERRED) -- each concurrent ingest starts as a reader and upgrades to
// writer mid-transaction, and SQLite returns SQLITE_BUSY on THAT upgrade
// WITHOUT invoking the busy handler, so openLedger's busy_timeout never
// applies. `BEGIN IMMEDIATE` takes the write lock at transaction start,
// where busy_timeout DOES apply, so concurrent ingests serialize instead of
// erroring.
//
// This spawns >=10 SEPARATE `check` processes concurrently (docs/gotchas.md
// #4: real processes, not Promise.all over a synchronous body) against one
// repo -- the fleet workload the spec names ("Fleets use --session"). Every
// process must exit 0, and every one of the N check lines must land in the
// ledger with the exit code that process's own wrapped command produced.
import { describe, it, expect, afterAll } from "vitest";
import { createTmpRepo, runCli, type TmpRepo } from "../../acceptance/harness/index.js";
import { getPaths } from "../../../src/core/paths.js";
import { openLedger, type CheckRow } from "../../../src/core/ledger.js";
import { ingest } from "../../../src/ingest/index.js";

const CONCURRENCY = 10;

describe("concurrent check runs do not die 'database is locked'", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    `${CONCURRENCY} concurrent 'coreartifact check' processes against one repo all exit 0 and all record`,
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
      const init = await runCli(["init"], opts);
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          runCli(["check", `conc-${i}`, "--", "node", "-e", "process.exit(0)"], opts),
        ),
      );

      for (const [i, result] of results.entries()) {
        expect(
          result.exitCode,
          `check conc-${i} did not exit 0 (stderr: ${result.stderr})`,
        ).toBe(0);
        expect(
          result.stderr,
          `check conc-${i} must not surface a "database is locked" error`,
        ).not.toMatch(/database is locked/i);
      }

      const logResult = await runCli(["log"], opts);
      expect(logResult.exitCode, `log (ingest) did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const handle = openLedger(paths.ledger);
      let rows: CheckRow[];
      try {
        rows = handle.db.prepare("SELECT * FROM checks ORDER BY line_no").all() as CheckRow[];
      } finally {
        handle.close();
      }

      const names = new Set(rows.map((r) => r.name));
      for (let i = 0; i < CONCURRENCY; i++) {
        expect(names.has(`conc-${i}`), `no check row landed for conc-${i}`).toBe(true);
      }
      expect(rows.length, "every concurrent check must land exactly once").toBe(CONCURRENCY);
    },
    60000,
  );

  // F124 (ISS-0017 round-4 review): the variant above pre-creates the ledger
  // via `init` before the concurrent fleet runs, which never exercises the
  // first-creation race at all -- every process there opens an
  // already-created, already-schema'd ledger. The real reviewer repro is a
  // brand-new repo with NO init: N concurrent FIRST-EVER `check` processes,
  // each racing to be the one that creates the ledger from scratch. Before
  // the fix, `check`'s own second readOnly connection (opened AFTER ingest,
  // outside ingest's retry loop) could observe the ledger mid-creation by a
  // sibling process and die "attempt to write a readonly database" / "no
  // such table: sessions" -- exit 1, with the wrapped command never having
  // run at all, so the spool line count falls short of N.
  it(
    `${CONCURRENCY} concurrent FIRST-EVER 'coreartifact check' processes against a brand-new repo (no init) all pass through the wrapped command's exit code and all record`,
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };

      // Deliberately NO `init` here -- every one of these `check` invocations
      // is racing to be the first to ever create the ledger.
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          runCli(["check", `first-${i}`, "--", "node", "-e", "process.exit(0)"], opts),
        ),
      );

      for (const [i, result] of results.entries()) {
        expect(
          result.exitCode,
          `check first-${i} did not pass through the wrapped command's exit code 0 (stderr: ${result.stderr})`,
        ).toBe(0);
      }

      // `log` is a GLOBAL, registry-driven command (docs/issues/ISS-0007.md
      // amendment) -- it unions every REGISTERED repo, never the cwd
      // directly. This variant deliberately never runs `init`, so the repo
      // is never registered and `runCli(["log"])` would be a silent no-op
      // against it (proven while diagnosing this test: `log` exited 0 having
      // touched nothing here). The in-process `ingest` this issue's own
      // ingest module exports is the correct final-state read for an
      // unregistered repo -- the same lazy-ingest-by-cwd mechanism `check`
      // itself uses, just invoked directly instead of through another CLI
      // command that assumes registration.
      const paths = getPaths(repo.root);
      const ingestReport = await ingest(repo.root);
      expect(
        ingestReport.skipped,
        `final ingest must not skip any spool line: ${JSON.stringify(ingestReport.skipped)}`,
      ).toEqual([]);

      const handle = openLedger(paths.ledger);
      let rows: CheckRow[];
      try {
        rows = handle.db.prepare("SELECT * FROM checks ORDER BY line_no").all() as CheckRow[];
      } finally {
        handle.close();
      }

      const names = new Set(rows.map((r) => r.name));
      for (let i = 0; i < CONCURRENCY; i++) {
        expect(names.has(`first-${i}`), `no check row landed for first-${i}`).toBe(true);
      }
      expect(rows.length, "every concurrent first-ever check must land exactly once").toBe(CONCURRENCY);
    },
    60000,
  );
});

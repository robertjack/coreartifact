---
name: iss0017-check-concurrency-gaps
description: ISS-0017 check — the three-layer concurrency fix leaves the readOnly binding connection unprotected; capture is unbounded and crashes >512MB
metadata:
  type: project
---

# ISS-0017 `coreartifact check` — round-3 remediation gaps (executed 2026-07-16, HEAD 4c07a1e)

The three-layer F119 fix (BEGIN IMMEDIATE + probe/main busy_timeout + `openLedgerWithRetry`)
covers ingest's write path but **misses the check command's own readOnly binding connection**
(`src/cli/commands/check.ts:88`, `new DatabaseSync(paths.ledger, { readOnly: true })`).

- **The readOnly reader is the unprotected third actor.** busy_timeout there only handles
  SQLITE_BUSY; it does NOT cover the first-creation/rebuild race. Under N concurrent FIRST-EVER
  checks in a brand-new repo (no ledger yet), the reader intermittently throws
  `no such table: sessions` or `attempt to write a readonly database`. This connection runs
  BEFORE `runCheckedCommand`, so on failure the wrapped command **never runs**, exit is 1 (not the
  wrapped exit), and **no spool line is written**. Reproduced through the product bin: ~2-3 failing
  batches out of ~80 (10-24 procs each). Timing-sensitive — 0/30 on a quiet machine, several under
  load. The `openLedgerWithRetry` retry only wraps ingest, not this reader.
- **The unit test `tests/unit/ingest/concurrentCheck.test.ts` runs `runCli(["init"])` FIRST**
  (line 39-40), pre-creating the ledger with all tables — so it never exercises the first-creation
  race the third retry layer supposedly exists for. Init-first repro: 0/40 fails; no-init repro:
  fails. The "20/20 clean" operator-amendment claim was measured with the ledger pre-created.
  Break vector: run the concurrent fleet against a bare git repo with NO `coreartifact init`.

- **Capture is unbounded (`src/check/run.ts`).** `chunks.push(chunk)` accumulates the entire child
  output; the 32KB cap is applied only post-hoc via `capOutput(runResult.output)`. A 512MB emitter
  → 1.64GB peak RSS. `>512MB` combined output → `Buffer.concat(chunks).toString("utf8")` throws
  `RangeError: Cannot create a string longer than 0x1fffffe8 characters`; check exits 1 while the
  wrapped command exited 0, and NO spool line is written (R1 violated). The escalation amendment
  claims "unbounded capture" was fixed in-ladder — it is not; the round-1 UTF-8 fix (2d3ed43)
  switched to accumulate-all-raw-buffers, which is what created the >512MB crash. Bound the
  accumulation at cap + a small margin.

## Round-4 remediation VERIFIED CLEAN (executed 2026-07-16, HEAD b5f5a86)
- **F124 fix genuine.** check's 2nd readOnly connection dropped; `ingestAndResolveSessions`
  resolves sessions from ingest's own connection; retry widened to whole open-then-run
  (`withLedgerRetry`). Mutation proof: reverted the two files to parent 4c07a1e, rebuilt,
  ran 24-way no-init fleet under load avg ~30 → 2/90 batches failed "attempt to write a
  readonly database" spoolLines 23/24 (the documented bug). Fixed HEAD: 0/90 under same load,
  10/10 vitest no-init green. Idempotency of widened retry PROVEN by dist-injection: one-shot
  throw AFTER commit → retry re-runs, sees advanced cursor (1210B/7lines), inserts 0, final
  rows == baseline (4 events/3 checks/2 sessions). Throw BEFORE commit → ROLLBACK, retry clean,
  same final state. HWM cursor + `ON CONFLICT(line_no) DO NOTHING` = double protection, no
  double-ingest either path. Bounding: path-is-directory fails fast 0ms; persistent EACCES
  (unwritable parent) bounded 1079ms (40×25ms); sustained 7s EXCLUSIVE lock recovers at 6038ms
  (busy_timeout absorbs the wait within one attempt, NOT 40×5s spin).
  - Minor (not a finding): on a post-commit-then-retry, `report.eventsInserted` reads 0 (real
    count lost). Only `ingestAndResolveSessions` has a post-commit op and check.ts ignores the
    report; `ingest` (log) has no post-commit op so its report stays accurate. Benign.
- **F125 fix genuine.** Passthrough unbounded/byte-exact (5MB in → 5242880 bytes through);
  retention capped independently. Production DEFAULT cap (32772 = 32768+4margin): capOutput
  re-trims at 32768, strictly before the retention-boundary split, so any tail U+FFFD from the
  retention cut is discarded — 5MB multi-byte 'é' with odd offset → capped clean (no U+FFFD,
  == 'x'+é*16383). Seam defaults correctly: check.ts:88 `runCheckedCommand(parsed.command)` no
  option; grep confirms no other production caller passes retentionCapBytes.
  - S3 seam trap (test-only, NOT production-reachable): injecting `retentionCapBytes` BELOW
    CHECK_OUTPUT_CAP_BYTES (e.g. 1024) with multi-byte data mid-char → retained output carries a
    U+FFFD that capOutput does NOT strip (1003 < 32768 so no re-trim). The margin guarantee only
    holds for injected caps >= 32768. Author avoided it: their small-cap test uses ASCII, their
    multibyte test uses the default cap. A future author injecting a small cap + asserting
    multibyte cleanliness would get a false failure / real U+FFFD. Spool never sees it (prod default > cap).

## What HELD (verified by execution, don't re-litigate)
- F120 strict argv: valueless `--session`, unknown tokens, typos, missing `--` all exit 1 with
  usage; spool byte-identical (sha unchanged); unknown `--session <id>` exits 1 naming the id.
- F121: BOTH the run.test.ts unit test AND the R1 acceptance passthrough assertion go RED on a
  capture-and-swallow mutant (mutated + rebuilt in scratchpad, confirmed).
- Reporter hygiene: `vitest run --reporter=json` stdout parses (361/361).
- Multi-byte chunk-split capture: exact, no U+FFFD, clean codepoint-boundary truncation.
- 1(a) persistent failure: directory path fails fast (LedgerPathIsDirectoryError, 0ms in retry);
  persistent EACCES bounded ~1.08s (40×25ms) with original error surfaced — no infinite spin.
- 1(c) stale v1 ledger rebuilds to v2 in 4ms, no retry loop (openLedger succeeds post-rmSync).

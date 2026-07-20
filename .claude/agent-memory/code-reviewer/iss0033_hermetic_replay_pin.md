---
name: iss0033-hermetic-replay-pin
description: ISS-0033 rescue (ee11e03) — harness-centralized cwd/transcript_path pin. Locked test genuinely binds; two S3 residuals (dropped seeding exitCode guard, EISDIR-as-nonexistent).
metadata:
  type: reference
---

ISS-0033 folds the cwd/transcript_path pin into the shared replay harness (`fixtureReplayer.ts` gains required `pinTarget`; `harness/index.ts` gains `ingest`/`getSession`). By-hand rescue, commit ee11e03. Reviewed clean → MERGE.

**Locked test is genuinely mutation-resistant** (proven, not read):
- Skip cwd assignment → red. Sentinel outside pinTarget → red. Sentinel = existing readable enrichable file → red (ingest+getSession catches enrichment).
- Migrated Gotcha-2 oracles NOT vacuous: mutating a non-pinned payload field (session_id) in `pinPayloadLine` turns BOTH ISS-0004 R4 byte-preserve and harness.test parallel none-lost/none-duplicated red. The strip/normalize-cwd-only comparison genuinely still byte-checks all other fields.

**Two S3 residuals worth remembering:**
- Sentinel-nonexistence guard `readFile(payload.transcript_path).rejects.toThrow()` (locked test line 156) accepts a DIRECTORY (EISDIR) as "nonexistent" — mutation returning `pinTarget` itself stayed green. Not a real defect (impl returns a real nonexistent file; a dir can't enrich), but the assertion is looser than its prose.
- ISS-0018 + ISS-0024 dropped the per-line seeding `expect(invocation.exitCode).toBe(0)` guard when deleting `replayLinesThroughHook` for harness `replayLines` (which returns exitCode but asserts nothing). ISS-0004 kept it. S3 only because ISS-0004 R4 still guards capture's exit-0 globally across all scenarios — fully redundant.

**Sanctioned residual (not a finding):** ISS-0008 R8 keeps a local `replayRawUnpinned` that re-expresses the machine-leftover hazard (unpinned recorded cwd), relying on the recorded `/Users/...` cwd being dead on the test machine. Operator-sanctioned (Gotcha 2). Fragile only on a machine where that exact path exists as a git repo.

**Two same-named `replaySubstitutedTranscript`** (harness `(lines, content, pinTarget)` vs fixtures `(scenario, workDir, command)`) — import routing verified correct; `transcriptReplay.ts` references harness `replayLines` only in comments, no import (Ruling B honored, ISS-0016 byte-identity intact). `getSession`'s NULL→"ABSENT" mapping consumed ONLY by the locked test; product never stores literal "ABSENT" in the model column.

**Port-flake determination:** ISS-0028/0029/0032 ran 3x in the operator worktree, all green, ZERO orphaned node procs between runs. No leak introduced by migration; the 2278 collision is environmental (only when a real dashboard runs on 2278). Full worktree gates: typecheck clean, 89 files/598 tests green, build ok.

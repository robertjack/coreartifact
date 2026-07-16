---
name: iss0022-uninstall-backup-gaps
description: ISS-0022 uninstall — two residual F103-class holes after the round-3 fix (re-init pollutes the backup baseline; hasUsableInstallBackup's typeof-object trap)
metadata:
  type: project
---

# ISS-0022 `coreartifact uninstall` — residual F103-class holes (executed 2026-07-16, HEAD 592cc1c)

The four round-3 remediations F102/F104/F105 are genuinely clean by execution; F103's
manifest gate is clean for the plain missing/unparseable case but has two demonstrated
completeness gaps, both re-opening the exact "fabricated success + live hook config left
behind" defect F103 exists to prevent.

1. **Re-init after manifest loss pollutes the backup baseline.** `captureInstallBackup`
   ("first capture wins", keyed on `targetPath in backup.entries`) records the CURRENT
   settings.local.json as the pre-init snapshot. After init → lose `.coreartifact/`
   (targeted `rm -rf`, or a best-effort capture failure that init's try/catch swallowed)
   → re-init, the captured "pre-init" content already contains coreartifact's own 9-event
   hook config. Uninstall then hits the `currentContent === expectedInitOutput`
   "untouched since init" branch and restores that polluted baseline VERBATIM (removeHookConfig
   never runs) → exit 0, `.coreartifact/` deleted (incl. the hook artifact), registry
   tombstoned, but all 9 live hook subscriptions remain in settings.local.json, now dangling
   at a deleted artifact. The F103 refusal message actively recommends re-init as the recovery,
   so this is reachable via the fix's own advice. Fix direction: capture must not treat a
   settings file that already `referencesHookArtifact` as a clean pre-init baseline (or the
   verbatim-restore branch must still strip coreartifact entries when the captured baseline
   itself references the artifact). NOTE: `git clean -fdX` removes BOTH `.coreartifact/` and
   `.claude/settings.local.json` (init gitignores both), so the classic F103 trigger doesn't
   actually leave settings behind — the reachable trigger is a `.coreartifact`-only deletion.

2. **`hasUsableInstallBackup` typeof-object array/null trap.** The gate accepts
   `{"v":1,"entries":[]}` and `{"v":1,"entries":null}` as usable (`typeof x === "object"` is
   true for arrays and null). `entries:[]` → every `entries[path]` string-index returns
   undefined → all live config left untouched while `.coreartifact/` is deleted + registry
   tombstoned (F103 defect, exit 0). `entries:null` → uncaught `TypeError: Cannot read
   properties of null` mid-uninstall (nonzero, ugly, but pre-rmSync so non-destructive).
   Same trap in `readBackupFile` (installBackup.ts). Low reachability (needs that specific
   valid-JSON corruption), fix trivial: reject `Array.isArray(entries) || entries === null`.

Break vectors that PAID OFF here: mutation-testing src in a scratchpad rsync copy (symlink
node_modules) — but a naive early-return mutant narrows the param to `never` and fails tsc;
use a non-narrowing guard like `if (root.length >= 0) return;`. The dir-capturing snapshotTree
amendment (f1878ae) is load-bearing: neutering removeClaudeDirIfInitCreatedAndEmpty reddens
both the F104 unit test and R9 acceptance.

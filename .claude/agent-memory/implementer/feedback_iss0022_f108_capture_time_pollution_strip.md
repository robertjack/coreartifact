---
name: iss0022-f108-capture-time-pollution-strip
description: ISS-0022 F108 — install-backup capture must strip a settings file's own prior coreartifact hook entries BEFORE recording it as the pre-init baseline, or F103's own recovery advice reopens F103.
metadata:
  type: feedback
---

When a "capture the pre-existing state as a restore baseline" function
(`captureInstallBackup`/`captureOne` in `src/install/installBackup.ts`) can
be re-run after the tool's own artifacts were destroyed and reinstalled
(here: `init -> rm -rf .coreartifact -> init`, exactly the F103 refusal
message's own advice), the file it captures on the SECOND run may already
carry the tool's own prior output mixed into it. Recording that as-found
content as "pre-init truth" and later restoring it verbatim on uninstall
reopens the very defect (F103: live hooks left behind) the manifest exists
to prevent.

**Fix at capture time, not restore time, when the strip logic already
exists and is shared elsewhere** (here: `referencesHookArtifact` +
`removeHookConfig` from `src/install/hookConfig.ts`, already used by
uninstall's edited-since-init path). Capture-time stripping means the
baseline is simply correct from the start and no downstream consumer needs
a new "was this baseline itself polluted" branch.

Exporting a previously-unexported helper (`referencesHookArtifact`) from a
module that already imports FROM the module you're editing
(`installBackup.ts` imports `captureInstallBackup` — wait, reversed:
`hookConfig.ts` imports `captureInstallBackup` from `installBackup.ts`)
creates a two-file import cycle. This is safe in ESM as long as both
cross-module imports are only referenced inside function bodies invoked
after both modules finish evaluating — never at top-level/module-eval time.
Verified working on this repo's tsc + vitest setup.

Related: [[typeof-object-trap-jsonl-folds]] — same review round's F109 was
the sibling defect: `typeof entries === "object"` accepting `[]`/`null`
for a manifest's entries map. Both were in `installBackup.ts` and fixed
together; the fix pattern (exclude `Array.isArray` and `=== null`
explicitly) matches this repo's existing registry/state fold discipline —
see docs/gotchas.md #3 for the denylist-vs-allowlist cousin issue.

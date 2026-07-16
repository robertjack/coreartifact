---
name: uninstall-manifest-absent-vs-per-path-uncaptured
description: ISS-0022 review round 3 — "the whole backup manifest is missing" and "this one path was never captured" look identical in readInstallBackup's fold but demand opposite-scoped responses.
metadata:
  type: feedback
---

`readInstallBackup` (and any manifest reader that degrades-not-aborts per
docs/gotchas.md #5) folds three distinct situations to the SAME
`{ entries: {} }` shape: the manifest file never existed, it's damaged/
unparseable, and it's a real valid manifest that's simply empty. That fold
is correct for **per-path** decisions inside uninstall (an uncaptured path is
never guessed at — leave it alone), but it is the wrong signal for the
**top-level** question "do we have a reliable inventory of this repo's
install at all?" Conflating the two lets a wiped `.coreartifact/` (e.g.
`git clean -fdX`) silently degrade to "nothing looked captured, so leave
everything untouched" while the command *still* deletes the artifact dir and
tombstones the registry — a fabricated success with live hook config left
behind.

**Why:** reviewer finding F103 (ISS-0022) proved this by execution: an
existing unit test already covered the per-path-uncaptured case correctly
(leaves files alone) and stayed green throughout, masking that the
whole-repo-scoped refusal was never implemented. Both behaviors are needed
simultaneously and live at different call sites — per-path tolerance inside
`computePlan`/`performUninstall` (called directly by existing unit tests,
must keep proceeding), whole-manifest refusal at the CLI command's entry
point (before `computePlan` is ever reached).

**How to apply:** when a spec says "if X is missing, refuse the whole
operation" but the module already has graceful per-item degradation for
"item X was never captured," add a **separate, narrower presence/validity
check** gating entry to the command, rather than trying to make the existing
fold distinguish the cases retroactively — the fold's callers (and their
tests) depend on it staying permissive.

Related: [[reference_sandbox_no_network_types_node]] (this repo's node:fs
`@ts-ignore` pattern), and the acceptance-suite operator amendment pattern in
`feedback_snapshot_directories_are_part_of_the_tree` (F104, same round) —
a locked test's own primitive (snapshotTree) was amended mid-campaign to
close a byte-identical loophole (empty leftover directories), which is the
kind of change that makes a previously-green acceptance test go red for a
correct reason on the NEXT attempt, not a regression.

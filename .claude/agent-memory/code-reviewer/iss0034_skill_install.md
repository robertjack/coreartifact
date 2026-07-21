---
name: iss0034-skill-install
description: ISS-0034 skill-install rescue (be21f13) — rulings A-G verified by execution; Ruling G directory-inversion is protected only by ISS-0022, NOT by ISS-0034's own acceptance test
metadata:
  type: project
---

# ISS-0034 `init` installs coreartifact SKILL.md — rescue be21f13 (reviewed 2026-07-21)

Real product behavior CLEAN across all 5 acceptance criteria, proven by real-CLI
subprocess probes (dist bin, git tmpdir, COREARTIFACT_REGISTRY_ROOT=home):
- Task1: real init→uninstall --yes → dir-aware tree byte-identical (ADDED [], REMOVED []).
  `.claude/skills/coreartifact/` + empty parents `.claude/skills` + `.claude` all removed.
- Ruling F (init.ts:74-81): pre-existing NON-canonical file → skip+warn, unrecorded,
  doctor silent, survives uninstall. Pre-existing BYTE-IDENTICAL file → recorded
  existed:true, uninstall RESTORES/leaves it (ISS-0022 law: survives).
- Ruling C (report.ts:119 `if (backup.entries[skillPath]===undefined) return`): no-backup
  drift → silent; backup+drift → named finding. Both executed.
- Ruling D (doctor.ts:118 cwd:repoRoot): real CLI doctor from subdir → exit 1 names root skill.
- Ruling E (gitignore.ts:137 `.claude/skills/coreartifact/`): pinned by unit init.test.ts.
- Probe 5: standalone uninstall() removes only manifest FILE + empty-.coreartifact rmdir;
  a spool under .coreartifact SURVIVES.

## The green-suite gap (S2, finding-1 this review)
Ruling G says "the acceptance tree comparison must compare DIRECTORY existence too."
ISS-0034's OWN acceptance test (init-skill.test.ts:72-87) `snapshotTree` is FILES-ONLY,
and its only tree case pre-seeds `.claude/skills/my-other-skill` so `.claude/skills`
pre-exists and `removeSkillsDirIfInitCreatedAndEmpty` NEVER fires. Proven: neutering
that fn (`if(root.length>=0)return;`) leaves ISS-0034's suite GREEN (5 passed) while
ISS-0022/uninstall.test.ts R9 goes RED (its snapshotTree.ts:26 records `${path}/`→`<dir>`
sentinels AND runs the real CLI which now installs the skill). So the directory-inversion
invariant is protected ONLY by ISS-0022, not the issue's own tests — fragile mis-attribution
(remove skill from ISS-0022's flow and coverage silently vanishes). Also: the TEST-ONLY
standalone `init()` seam leaks an empty `.claude` in a fresh repo (installSkill captures
`.claude/skills` but NOT `.claude`; real CLI captures `.claude` via the settings step, so
real CLI is clean). Criterion #3's "including the skills directory" is met by test
construction, not by the seam.

S3: formatInventory (uninstall.ts:108-121) does NOT list the skill file/dir among the
deletion disclosure, though uninstall deletes them.

Task6: rescue be21f13 made ZERO edits to the locked acceptance test; only sanctioned
amendment is c378273 (Ruling B mockRestore-before-read). Gates: 95 files, 642 pass, 1 skip.
Verdict: MERGE (no S0/S1 live defect).

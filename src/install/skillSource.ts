// The canonical, byte-identical text of the coreartifact conventions skill
// (docs/issues/ISS-0034.md). Static, no templating, no per-repo
// interpolation — that is what makes doctor's drift check (src/doctor/
// report.ts) a trivial byte comparison between this and whatever `init`
// last wrote to a repo's .claude/skills/coreartifact/SKILL.md.
//
// Lives in its own module (rather than inlined at the `init` call site) the
// same way src/install/hookArtifactSource.ts isolates the hook artifact's
// location: one place both `init` (writes it) and `doctor` (compares
// against it) resolve the SAME canonical value from, so the two can never
// drift from each other even if this text changes across a version bump.

const SKILL_TEXT = `---
name: coreartifact
description: Use when running tests, builds, lint, typecheck, or any other verifiable command in a repo with coreartifact installed — wraps the command so its run is bound as evidence to this session instead of left unverified.
---

# coreartifact: self-verifying delegation

Run every verifiable command (tests, builds, lint, typecheck) through:

    cart check <name> -- <cmd>

Exit codes pass straight through — nothing else about the command changes.

## Headless / delegated sessions: self-bind

In a headless or delegated session, bind the check to your OWN session so
it shows as VERIFIED (not unverified) in the dashboard. Read the session id
from the spool's last SessionStart line:

    grep '"hook_event_name":"SessionStart"' .coreartifact/spool.jsonl | tail -1 | jq -r '.event.session_id'

then pass it:

    cart check <name> --session <session_id> -- <cmd>

Never guess or fabricate a session id — binding is validated and will
refuse one that doesn't match a real session.

## Don'ts

- Never edit \`.coreartifact/**\` — it is the raw, verbatim evidence spool.
- Never parse the spool or ledger directly — use \`cart log\` / \`cart show\`.
- Never fabricate a session id.

## Reading the output

\`ABSENT\` (‹absent›) means a fact is unverifiable from evidence — not
missing, not zero. Never "fix" it by inventing a value.
`;

export function skillSource(): string {
  return SKILL_TEXT;
}

export default skillSource;

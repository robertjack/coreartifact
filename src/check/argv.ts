// Pure argv parsing for `coreartifact check <name> [--session <id>] -- <cmd>
// [args...]` (docs/issues/ISS-0017.md "Command behavior"). No I/O — the
// seam tests/unit/check/argv.test.ts exercises directly.

export type ParseCheckArgvResult =
  | { ok: true; name: string; session?: string; command: string[] }
  | { ok: false; message: string };

const USAGE =
  "coreartifact check: usage: coreartifact check <name> [--session <id>] -- <cmd> [args...]";

// Everything after the FIRST `--` is the wrapped command, verbatim
// (spec: "Everything after -- is the wrapped command"). Missing `<name>`,
// missing `--`, or an empty wrapped command is a usage error.
export function parseCheckArgv(args: string[]): ParseCheckArgvResult {
  const dashIndex = args.indexOf("--");
  if (dashIndex === -1) {
    return { ok: false, message: USAGE };
  }

  const command = args.slice(dashIndex + 1);
  if (command.length === 0) {
    return { ok: false, message: USAGE };
  }

  const before = args.slice(0, dashIndex);
  const name = before[0];
  if (!name || name.length === 0) {
    return { ok: false, message: USAGE };
  }

  // Strict parsing (F120, ISS-0017 round-2 review): a malformed flag before
  // `--` used to be silently swallowed -- `--session` with no value dropped
  // silently, and an unrecognized token (e.g. a typo'd `--sesion`) dropped
  // BOTH itself and whatever followed it, with no error at all. A wrong or
  // missing binding written to the spool is frozen there forever (the spool
  // is ground truth, never re-resolved), so every token here must be either
  // a recognized `--session <id>` pair or a usage error -- never silently
  // ignored.
  let session: string | undefined;
  for (let i = 1; i < before.length; i++) {
    if (before[i] === "--session") {
      const value = before[i + 1];
      if (value === undefined) {
        return { ok: false, message: USAGE };
      }
      session = value;
      i++;
      continue;
    }
    return { ok: false, message: USAGE };
  }

  return session !== undefined ? { ok: true, name, session, command } : { ok: true, name, command };
}

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

  let session: string | undefined;
  for (let i = 1; i < before.length; i++) {
    if (before[i] === "--session") {
      session = before[i + 1];
      i++;
    }
  }

  return session !== undefined ? { ok: true, name, session, command } : { ok: true, name, command };
}

// The CLI argv dispatcher — exposes init, log and show as registered
// commands. Each command's real implementation lands in its own later
// issue; this module ships the dispatcher, usage output, exit codes and
// stub handlers that exit nonzero with "not implemented".
//
// This module is a shared surface: later issues register their command by
// adding a one-line entry to COMMANDS below, so amendments never conflict.
//
// This module is PURE: it exports `main` and the command table and never
// invokes anything at module scope, so importing it is always safe (tests
// and later issues import both). The process entry point lives in
// `src/cli/bin.ts`, which is the only file that ever calls `main` — see its
// header for why an import.meta.url entrypoint guard was tried and rejected
// here (F1 / V1, 2026-07-14): ESM realpaths `import.meta.url` but not
// `process.argv[1]`, so a symlinked bin (exactly how node_modules/.bin
// installs it) reads as "not the entry" and silently no-ops; and a
// hand-rolled `encodeURIComponent`-based file URL escapes `@`, which Node's
// own `pathToFileURL` does not, breaking on pnpm's `name@version` store
// paths. Splitting the module from the entry removes the question entirely
// instead of trying to answer it more precisely.
//
// @types/node is unreachable in this sandbox (no network, nothing cached).
// The `declare const process` below is a module-local shadow, not a global
// augmentation: it shapes `process` only within this file and cannot merge
// or conflict with the real `NodeJS.Process` global if @types/node is later
// installed, unlike a `declare global` shim would.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};

import { initCommand } from "./commands/init.js";
import { logCommand } from "./commands/log.js";
import { showCommand } from "./commands/show.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { sendCliPing } from "../ping/index.js";

export type CommandHandler = (args: string[]) => number | Promise<number>;

interface CommandSpec {
  name: string;
  summary: string;
  handler: CommandHandler;
}

function notImplemented(name: string): CommandHandler {
  return () => {
    process.stderr.write(`coreartifact ${name}: not implemented\n`);
    return 1;
  };
}

// Exported: a public surface later issues amend (registering `init`, `log`
// and `show`'s real handlers) and later tests import directly.
export const COMMANDS: CommandSpec[] = [
  { name: "init", summary: "Register this repo and start capturing sessions", handler: () => initCommand() },
  { name: "log", summary: "List sessions across registered ledgers", handler: () => logCommand() },
  { name: "show", summary: "Show a single session in detail", handler: (args) => showCommand(args) },
  {
    name: "uninstall",
    summary: "Remove coreartifact from this repo (destructive; requires --yes or a TTY confirmation)",
    handler: (args) => uninstallCommand(args),
  },
];

function usage(): string {
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(8)} ${c.summary}`);
  return `Usage: coreartifact <command> [args]\n\nCommands:\n${lines.join("\n")}\n`;
}

export async function main(argv: string[]): Promise<void> {
  const [commandName, ...rest] = argv;

  if (!commandName) {
    process.stdout.write(usage());
    process.exit(0);
  }

  const command = COMMANDS.find((c) => c.name === commandName);
  if (!command) {
    process.stderr.write(`coreartifact: unknown command '${commandName}'\n\n${usage()}`);
    process.exit(1);
  }

  const code = await command.handler(rest);

  // The weekly ping rides the dispatcher path, once per invocation, for
  // ANY command (docs/issues/ISS-0023.md "The ping (R11)") — never wired
  // per-command, and never in the hook artifact. Fire-and-forget: nothing
  // about this call may change the exit code or either stream above, so
  // any unexpected failure here (not just a transport error, which
  // sendCliPing already swallows internally) is caught and silently
  // dropped rather than surfaced.
  try {
    await sendCliPing({ env: process.env });
  } catch {
    // never let ping plumbing change a command's outcome
  }

  process.exit(code);
}

// The CLI argv dispatcher — exposes init, log and show as registered
// commands. Each command's real implementation lands in its own later
// issue; this module ships the dispatcher, usage output, exit codes and
// stub handlers.
//
// This module is a shared surface: later issues register their command by
// adding a one-line entry to COMMANDS below, so amendments never conflict.

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

const COMMANDS: CommandSpec[] = [
  { name: 'init', summary: 'Register this repo and start capturing sessions', handler: notImplemented('init') },
  { name: 'log', summary: 'List sessions across registered ledgers', handler: notImplemented('log') },
  { name: 'show', summary: 'Show a single session in detail', handler: notImplemented('show') },
];

function usage(): string {
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(8)} ${c.summary}`);
  return `Usage: coreartifact <command> [args]\n\nCommands:\n${lines.join('\n')}\n`;
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
  process.exit(code);
}

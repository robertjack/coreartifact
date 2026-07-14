import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const CLI_ENTRY = join(repoRoot, 'dist', 'cli.js');

function runCli(args: string[]) {
  return spawnSync('node', [CLI_ENTRY, ...args], { encoding: 'utf8' });
}

describe('cli', () => {
  it('Running the built CLI entry with no arguments exits 0 and prints usage naming the commands init, log and show; running it with an unknown command exits nonzero and names the unknown command', () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`not implemented yet: built CLI entry does not exist at ${CLI_ENTRY}`);
    }

    const noArgs = runCli([]);
    expect(noArgs.status).toBe(0);
    expect(noArgs.stdout).toMatch(/\binit\b/);
    expect(noArgs.stdout).toMatch(/\blog\b/);
    expect(noArgs.stdout).toMatch(/\bshow\b/);

    const unknownCommand = 'bogus-command-xyz';
    const unknown = runCli([unknownCommand]);
    expect(unknown.status).not.toBe(0);
    const combinedOutput = `${unknown.stdout ?? ''}${unknown.stderr ?? ''}`;
    expect(combinedOutput).toMatch(new RegExp(unknownCommand));
  });
});

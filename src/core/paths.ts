// Paths — where the spool, ledger and registry live.
//
// The registry path is overridable via an environment variable so the
// acceptance harness can point a subprocess at a tmpdir registry instead of
// the operator's real home; every later acceptance test depends on this
// variable's name.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const REGISTRY_PATH_ENV_VAR = 'COREARTIFACT_REGISTRY_PATH';

export const DEFAULT_REGISTRY_PATH = join(homedir(), '.coreartifact', 'registry');

export function getRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[REGISTRY_PATH_ENV_VAR] || DEFAULT_REGISTRY_PATH;
}

export function getRepoDataDir(repoRoot: string): string {
  return join(repoRoot, '.coreartifact');
}

export function getSpoolPath(repoRoot: string): string {
  return join(getRepoDataDir(repoRoot), 'spool.jsonl');
}

export function getLedgerPath(repoRoot: string): string {
  return join(getRepoDataDir(repoRoot), 'ledger.db');
}

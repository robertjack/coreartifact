import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  REGISTRY_PATH_ENV_VAR,
  getRegistryPath,
  getRepoDataDir,
  getSpoolPath,
  getLedgerPath,
} from '../../../src/core/paths.js';

describe('paths (unit)', () => {
  it('getRegistryPath honors the env var override and falls back to the default otherwise', () => {
    const overridden = getRegistryPath({ [REGISTRY_PATH_ENV_VAR]: '/tmp/custom/registry' });
    expect(overridden).toBe('/tmp/custom/registry');

    const fallback = getRegistryPath({});
    expect(fallback.endsWith(join('.coreartifact', 'registry'))).toBe(true);
  });

  it('derives the spool and ledger paths under <repo_root>/.coreartifact', () => {
    const repoRoot = '/abs/path/to/repo';
    expect(getRepoDataDir(repoRoot)).toBe(join(repoRoot, '.coreartifact'));
    expect(getSpoolPath(repoRoot)).toBe(join(repoRoot, '.coreartifact', 'spool.jsonl'));
    expect(getLedgerPath(repoRoot)).toBe(join(repoRoot, '.coreartifact', 'ledger.db'));
  });
});

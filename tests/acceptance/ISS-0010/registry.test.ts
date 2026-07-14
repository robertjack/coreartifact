import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as url from 'node:url';
import { spawn } from 'node:child_process';
import { tryImport, extractRoots } from './helpers.js';

// Spawn against the BUILT module (pnpm test runs `pnpm build` first), the same
// way tests/unit/core/registry.test.ts does — one separate OS process per
// append, which is the only honest way to exercise O_APPEND interleaving.
const acceptanceDir = path.dirname(url.fileURLToPath(import.meta.url));
const distRegistryUrl = url.pathToFileURL(
  path.join(path.resolve(acceptanceDir, '../../..'), 'dist', 'core', 'registry.js')
).href;

function spawnAppend(root: string): Promise<void> {
  const script = [
    `import { addLedger } from ${JSON.stringify(distRegistryUrl)};`,
    `await addLedger(process.env.CART_TEST_ROOT);`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CART_TEST_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`child append for ${root} exited ${code}: ${stderr}`))
    );
  });
}

// Guessed at the conventional location for the persistence module; the
// module does not exist yet. If this path is wrong, loadRegistryModule()
// throws "not implemented yet" below, which is still a red assertion
// failure (never a collection error).
const REGISTRY_MODULE_PATH = '../../../src/core/registry.js';

async function loadRegistryModule(): Promise<any> {
  const mod = await tryImport(REGISTRY_MODULE_PATH);
  if (!mod || typeof mod.addLedger !== 'function' || typeof mod.readRegistry !== 'function') {
    throw new Error(`not implemented yet: ${REGISTRY_MODULE_PATH}#addLedger/readRegistry`);
  }
  return mod;
}

// The spec's test-harness contract: never touch a real ~/.coreartifact — use
// "the registry-root environment override that ISS-0001's paths module exposes".
//
// Overriding HOME alone is NOT sufficient and is actively dangerous: paths.ts
// gives COREARTIFACT_REGISTRY_ROOT *precedence* over HOME, so on any machine
// where that variable is exported (which is its intended use) this suite would
// write into the operator's REAL registry. Set the override itself.
const REGISTRY_ROOT_ENV_VAR = 'COREARTIFACT_REGISTRY_ROOT';

function registryFilePath(registryRoot: string): string {
  return path.join(registryRoot, 'registry.jsonl');
}

describe('ISS-0010 registry', () => {
  let tmpHome: string;
  let tmpRegistryRoot: string;
  let originalHome: string | undefined;
  let originalRegistryRoot: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'iss0010-registry-'));
    tmpRegistryRoot = path.join(tmpHome, '.coreartifact');
    originalHome = process.env.HOME;
    originalRegistryRoot = process.env[REGISTRY_ROOT_ENV_VAR];
    process.env.HOME = tmpHome;
    process.env[REGISTRY_ROOT_ENV_VAR] = tmpRegistryRoot;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRegistryRoot === undefined) {
      delete process.env[REGISTRY_ROOT_ENV_VAR];
    } else {
      process.env[REGISTRY_ROOT_ENV_VAR] = originalRegistryRoot;
    }
  });

  it('addLedger appends exactly one line to the registry log and never reads it first: N genuinely concurrent addLedger calls from N SEPARATE PROCESSES with distinct repo roots yield a registry log whose fold contains all N roots, with no lock file created anywhere and no entry lost.', async () => {
    const mod = await loadRegistryModule();
    const N = 20;
    const roots = Array.from({ length: N }, (_, i) => path.join(tmpHome, 'repos', `repo-${i}`));

    // N SEPARATE OS PROCESSES, not Promise.all. A Promise.all over an
    // in-process synchronous body runs SERIALLY — it cannot interleave, so it
    // cannot fail on the lost update it exists to catch. It is not a test.
    // Separate processes are also the real scenario: parallel `init` runs
    // across worktrees. (2026-07-14 finding.)
    await Promise.all(roots.map((root) => spawnAppend(root)));

    const regFile = registryFilePath(tmpRegistryRoot);
    expect(fs.existsSync(regFile)).toBe(true);

    const lines = fs
      .readFileSync(regFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(N);

    const parsed = lines.map((l) => JSON.parse(l));
    for (const entry of parsed) {
      expect(entry.op).toBe('add');
      expect(typeof entry.repo_root).toBe('string');
    }
    const loggedRoots = new Set(parsed.map((e) => e.repo_root));
    for (const root of roots) {
      expect(loggedRoots.has(root)).toBe(true);
    }

    const registryDir = path.dirname(regFile);
    const filesInDir = fs.readdirSync(registryDir);
    const lockLike = filesInDir.filter((f) => /lock/i.test(f));
    expect(lockLike).toEqual([]);

    const folded = await mod.readRegistry();
    const foldedRoots = extractRoots(folded);
    for (const root of roots) {
      expect(foldedRoots).toContain(root);
    }
  });

  it('readRegistry is total: a missing registry file folds to an empty set rather than throwing, and a registry log containing a corrupt or truncated line skips that line, counts it, and still returns every valid entry - a damaged registry never takes down a command that reads it.', async () => {
    const mod = await loadRegistryModule();

    const regFile = registryFilePath(tmpRegistryRoot);
    expect(fs.existsSync(regFile)).toBe(false);

    const missingResult = await mod.readRegistry();
    expect(extractRoots(missingResult)).toEqual([]);

    fs.mkdirSync(path.dirname(regFile), { recursive: true });
    const validRootA = path.join(tmpHome, 'repos', 'valid-a');
    const validRootB = path.join(tmpHome, 'repos', 'valid-b');
    const lines = [
      JSON.stringify({ v: 1, op: 'add', repo_root: validRootA, at: new Date(0).toISOString() }),
      '{ this line is not valid json and is truncated',
      JSON.stringify({ v: 1, op: 'add', repo_root: validRootB, at: new Date(0).toISOString() }),
    ];
    fs.writeFileSync(regFile, lines.join('\n') + '\n', 'utf8');

    const result = await mod.readRegistry();
    const roots = extractRoots(result);
    expect(roots).toContain(validRootA);
    expect(roots).toContain(validRootB);
    expect(roots).toHaveLength(2);
  });

  it('The registry fold dedupes by repo_root: running init twice for one repo appends two add lines and the fold still yields exactly one entry for that root.', async () => {
    const mod = await loadRegistryModule();
    const repoRoot = path.join(tmpHome, 'repos', 'dup-repo');

    await mod.addLedger(repoRoot);
    await mod.addLedger(repoRoot);

    const regFile = registryFilePath(tmpRegistryRoot);
    const lines = fs
      .readFileSync(regFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry.repo_root).toBe(repoRoot);
    }

    const folded = await mod.readRegistry();
    const roots = extractRoots(folded);
    const matches = roots.filter((r) => r === repoRoot);
    expect(matches).toHaveLength(1);
  });
});

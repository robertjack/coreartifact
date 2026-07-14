// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HARNESS_MODULE_PATH = './support/harness';

async function loadHarness() {
  try {
    return await import(HARNESS_MODULE_PATH);
  } catch {
    return undefined;
  }
}

// Records each invocation's raw stdin to a results file, independent of
// whatever the harness itself reports it sent.
const STUB_SCRIPT = `
const fs = require('node:fs');
const resultsFile = process.argv[2];
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const payload = Buffer.concat(chunks);
  fs.appendFileSync(resultsFile, JSON.stringify({ base64: payload.toString('base64') }) + '\\n');
  process.exit(0);
});
`;

describe('fixture replayer', () => {
  let workDir: string | undefined;

  afterEach(() => {
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
    workDir = undefined;
  });

  it('The harness fixture replayer loads a fixture stream by scenario name and pipes each payload line into a given hook command on stdin, one invocation per line, in order, returning each invocation\'s exit code; a self-test replays the headless stream into a stub command that records its stdin and asserts one invocation per fixture line with the payload bytes delivered unchanged', async () => {
    const mod = await loadHarness();
    if (!mod) throw new Error(`not implemented yet: ${HARNESS_MODULE_PATH} does not export a harness module`);

    const { replayFixtures } = mod;
    if (!replayFixtures) throw new Error('not implemented yet: replayFixtures export missing from harness module');

    workDir = mkdtempSync(join(tmpdir(), 'coreartifact-replay-'));
    const stubPath = join(workDir, 'stub.cjs');
    const resultsFile = join(workDir, 'results.ndjson');
    writeFileSync(stubPath, STUB_SCRIPT);
    writeFileSync(resultsFile, '');

    const result = await replayFixtures('headless', ['node', stubPath, resultsFile]);

    expect(Array.isArray(result.invocations)).toBe(true);
    expect(result.invocations.length).toBeGreaterThan(0);

    // independent oracle: what the stub process itself recorded on disk,
    // not what the replayer's own bookkeeping claims
    const recordedLines = readFileSync(resultsFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    const stubRecords = recordedLines.map((line) => JSON.parse(line));

    expect(stubRecords.length).toBe(result.invocations.length);

    // distinct payloads confirm distinct fixture lines were actually piped,
    // not the same line replayed repeatedly
    const payloads = stubRecords.map((record) => record.base64);
    expect(new Set(payloads).size).toBe(payloads.length);

    for (let i = 0; i < stubRecords.length; i += 1) {
      const stubBytes = Buffer.from(stubRecords[i].base64, 'base64');
      const reportedBytes = Buffer.from(result.invocations[i].stdinBytes);
      expect(stubBytes.equals(reportedBytes)).toBe(true);
      expect(typeof result.invocations[i].exitCode).toBe('number');
    }
  });
});

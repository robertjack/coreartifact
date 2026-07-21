import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_MODULE = '../harness/index';
const FIXTURES_MODULE = '../../fixtures/transcriptReplay';

async function loadHarness(): Promise<any> {
  try {
    return await import(HARNESS_MODULE);
  } catch {
    return undefined;
  }
}

async function loadFixtures(): Promise<any> {
  try {
    return await import(FIXTURES_MODULE);
  } catch {
    return undefined;
  }
}

function firstScenarioName(fixturesMod: any): string | undefined {
  if (!fixturesMod) return undefined;
  if (fixturesMod.SCENARIOS && typeof fixturesMod.SCENARIOS === 'object') {
    const keys = Object.keys(fixturesMod.SCENARIOS);
    if (keys.length) return keys[0];
  }
  if (typeof fixturesMod.listScenarios === 'function') {
    const list = fixturesMod.listScenarios();
    if (Array.isArray(list) && list.length) {
      const s = list[0];
      return typeof s === 'string' ? s : s?.name;
    }
  }
  if (Array.isArray(fixturesMod.scenarios) && fixturesMod.scenarios.length) {
    const s = fixturesMod.scenarios[0];
    return typeof s === 'string' ? s : s?.name;
  }
  return undefined;
}

function makeLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: 'iss-0033-session',
    cwd: '/Users/original-recorder/leftover-repo',
    transcript_path:
      '/Users/original-recorder/.claude/projects/leftover/transcript.jsonl',
    source: 'startup',
    ...overrides,
  });
}

function stdinText(invocation: any): string {
  const bytes = invocation?.stdinBytes;
  return Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
}

describe('ISS-0033 hermetic replay by construction', () => {
  it('Replaying a committed fixture stream through the shared replay primitives with a tmp-repo pin delivers every parseable payload line with cwd equal to the pinned tmp-repo root and transcript_path inside the test tmpdir — asserted on the delivered stdin bytes of each hook invocation (parse ReplayInvocation.stdinBytes), for BOTH the by-scenario path (replayFixtures) and the explicit-lines path (replayLines); no delivered line retains the committed stream\'s recorded absolute cwd or transcript_path.', async () => {
    const harness = await loadHarness();
    if (!harness) throw new Error('tests/acceptance/harness/index.ts is not implemented yet');
    const h = harness as any;
    if (typeof h.replayLines !== 'function') {
      throw new Error('harness.replayLines is not implemented yet');
    }

    const originalCwd = '/Users/original-recorder/leftover-repo';
    const originalTranscript =
      '/Users/original-recorder/.claude/projects/leftover/transcript.jsonl';

    const pinRoot = await mkdtemp(join(tmpdir(), 'iss-0033-pin-lines-'));
    const lines = [
      makeLine({ hook_event_name: 'SessionStart', cwd: originalCwd, transcript_path: originalTranscript }),
      makeLine({ hook_event_name: 'PostToolUse', cwd: originalCwd, transcript_path: originalTranscript }),
    ];

    const invocations = await h.replayLines(lines, pinRoot);
    expect(Array.isArray(invocations)).toBe(true);
    expect(invocations.length).toBe(2);

    for (const inv of invocations) {
      const payload = JSON.parse(stdinText(inv));
      expect(payload.cwd).toBe(pinRoot);
      expect(payload.cwd).not.toBe(originalCwd);
      expect(payload.transcript_path).not.toBe(originalTranscript);
      expect(String(payload.transcript_path).startsWith(pinRoot)).toBe(true);
    }

    if (typeof h.replayFixtures !== 'function') {
      throw new Error('harness.replayFixtures is not implemented yet');
    }
    const fixturesMod = await loadFixtures();
    const scenarioName = firstScenarioName(fixturesMod);
    if (!scenarioName) {
      throw new Error(
        'no fixture scenario discoverable from tests/fixtures/transcriptReplay.ts yet',
      );
    }

    const pinRoot2 = await mkdtemp(join(tmpdir(), 'iss-0033-pin-scenario-'));
    const scenarioInvocations = await h.replayFixtures(scenarioName, pinRoot2);
    expect(Array.isArray(scenarioInvocations)).toBe(true);
    expect(scenarioInvocations.length).toBeGreaterThan(0);

    let sawParseableLine = false;
    for (const inv of scenarioInvocations) {
      let payload: any;
      try {
        payload = JSON.parse(stdinText(inv));
      } catch {
        continue;
      }
      sawParseableLine = true;
      expect(payload.cwd).toBe(pinRoot2);
      expect(String(payload.transcript_path).startsWith(pinRoot2)).toBe(true);
    }
    expect(sawParseableLine).toBe(true);
  });

  it('When the caller does not substitute a transcript, the pinned transcript_path is a guaranteed-nonexistent path INSIDE the test tmpdir: a stream line whose recorded transcript_path points at a live file the test itself creates OUTSIDE the pin target replays with transcript_path rewritten to the tmpdir sentinel, and the ingested session\'s transcript-derived facets read ABSENT — enrichment from a machine leftover (the ISS-0028 escalation class) is unexpressible through the harness.', async () => {
    const harness = await loadHarness();
    if (!harness) throw new Error('tests/acceptance/harness/index.ts is not implemented yet');
    const h = harness as any;
    if (typeof h.replayLines !== 'function') {
      throw new Error('harness.replayLines is not implemented yet');
    }

    const leftoverDir = await mkdtemp(join(tmpdir(), 'iss-0033-leftover-'));
    const leftoverTranscriptPath = join(leftoverDir, 'transcript.jsonl');
    await writeFile(
      leftoverTranscriptPath,
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5' } }) + '\n',
    );

    const pinRoot = await mkdtemp(join(tmpdir(), 'iss-0033-pin-noscript-'));
    const sessionId = 'iss-0033-no-substitute-session';
    const lines = [
      makeLine({
        hook_event_name: 'SessionStart',
        session_id: sessionId,
        transcript_path: leftoverTranscriptPath,
      }),
    ];

    const invocations = await h.replayLines(lines, pinRoot);
    expect(invocations.length).toBe(1);
    const payload = JSON.parse(stdinText(invocations[0]));

    expect(payload.transcript_path).not.toBe(leftoverTranscriptPath);
    expect(String(payload.transcript_path).startsWith(pinRoot)).toBe(true);
    await expect(readFile(payload.transcript_path)).rejects.toThrow();
    expect(
      existsSync(payload.transcript_path),
      'the pinned sentinel path must not exist at all (a directory would pass the rejects.toThrow check via EISDIR without being a genuinely absent path)',
    ).toBe(false);

    if (typeof h.ingest !== 'function') {
      throw new Error('harness.ingest is not implemented yet');
    }
    await h.ingest(pinRoot);

    if (typeof h.getSession !== 'function') {
      throw new Error('harness.getSession is not implemented yet');
    }
    const session = await h.getSession(pinRoot, sessionId);
    expect(session).toBeDefined();
    const transcriptFacet =
      session?.model ?? session?.transcriptModel ?? session?.facets?.model;
    expect(transcriptFacet).toBe('ABSENT');
  });

  it('The sanctioned substitution survives: replaySubstitutedTranscript still delivers transcript_path pointing at the tmpdir copy of the paired transcript (present case), and an explicit caller-supplied transcript_path override (the missing-transcript ABSENT scenario, ISS-0024 precedent) reaches the hook exactly as supplied — both proven at the delivered-bytes seam, not only via ingest output.', async () => {
    const harness = await loadHarness();
    if (!harness) throw new Error('tests/acceptance/harness/index.ts is not implemented yet');
    const h = harness as any;

    if (typeof h.replaySubstitutedTranscript !== 'function') {
      throw new Error('harness.replaySubstitutedTranscript is not implemented yet');
    }
    const pinRoot = await mkdtemp(join(tmpdir(), 'iss-0033-pin-substituted-'));
    const transcriptContent =
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5' } }) + '\n';
    const sessionId = 'iss-0033-substituted-session';
    const lines = [
      makeLine({ hook_event_name: 'SessionStart', session_id: sessionId }),
    ];

    const invocations = await h.replaySubstitutedTranscript(lines, transcriptContent, pinRoot);
    expect(Array.isArray(invocations)).toBe(true);
    expect(invocations.length).toBeGreaterThan(0);
    const payload = JSON.parse(stdinText(invocations[0]));
    expect(String(payload.transcript_path).startsWith(pinRoot)).toBe(true);
    const copiedContent = await readFile(payload.transcript_path, 'utf8');
    expect(copiedContent).toBe(transcriptContent);

    if (typeof h.replayLines !== 'function') {
      throw new Error('harness.replayLines is not implemented yet');
    }
    const pinRoot2 = await mkdtemp(join(tmpdir(), 'iss-0033-pin-override-'));
    const overridePath = join(pinRoot2, 'deliberately-missing-transcript.jsonl');
    const overrideLines = [
      makeLine({ hook_event_name: 'SessionStart', session_id: 'iss-0033-override-session' }),
    ];

    const overrideInvocations = await h.replayLines(overrideLines, pinRoot2, {
      transcriptPathOverride: overridePath,
    });
    expect(overrideInvocations.length).toBeGreaterThan(0);
    const overridePayload = JSON.parse(stdinText(overrideInvocations[0]));
    expect(overridePayload.transcript_path).toBe(overridePath);
  });

  it('A fixture line that does not parse as JSON (the corrupt-line capture-robustness corpus) is delivered verbatim: the pin never drops it, never edits it, never throws on it, and the line still reaches the hook as its own invocation in order.', async () => {
    const harness = await loadHarness();
    if (!harness) throw new Error('tests/acceptance/harness/index.ts is not implemented yet');
    const h = harness as any;
    if (typeof h.replayLines !== 'function') {
      throw new Error('harness.replayLines is not implemented yet');
    }

    const pinRoot = await mkdtemp(join(tmpdir(), 'iss-0033-pin-corrupt-'));
    const corruptLine = '{not-valid-json:::';
    const before = makeLine({ hook_event_name: 'SessionStart', session_id: 'iss-0033-corrupt-before' });
    const after = makeLine({ hook_event_name: 'Stop', session_id: 'iss-0033-corrupt-after' });
    const lines = [before, corruptLine, after];

    const invocations = await h.replayLines(lines, pinRoot);
    expect(invocations.length).toBe(3);

    expect(stdinText(invocations[1]).trim()).toBe(corruptLine);
    let threwOnParse = false;
    try {
      JSON.parse(stdinText(invocations[1]));
    } catch {
      threwOnParse = true;
    }
    expect(threwOnParse).toBe(true);

    const firstPayload = JSON.parse(stdinText(invocations[0]));
    const thirdPayload = JSON.parse(stdinText(invocations[2]));
    expect(firstPayload.session_id).toBe('iss-0033-corrupt-before');
    expect(thirdPayload.session_id).toBe('iss-0033-corrupt-after');
  });

  it('No per-file pin remains: outside tests/acceptance/harness/ and tests/fixtures/, no test file assigns payload cwd or transcript_path by hand — the four transformLines cwd-pin copies (ISS-0019, ISS-0021, ISS-0024, ISS-0025), ISS-0008\'s rebase helper\'s cwd duty, ISS-0028\'s pinLineToRepo, and ISS-0029\'s seedLines pin duty are deleted or absorbed; scenario-legitimate overrides are expressed through the harness API; the full suite passes with prior issues\' assertions and oracles unchanged.', async () => {
    const acceptanceRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

    const bannedPatterns: RegExp[] = [
      /transformLines\s*\(/,
      /pinLineToRepo/,
      /seedLines\s*\(/,
      /\.cwd\s*=\s*['"`]/,
      /\.transcript_path\s*=\s*['"`]/,
      /\bcwd\s*:\s*repoRoot/,
      /\btranscript_path\s*:\s*['"`]\/dev\/null/,
    ];

    async function walk(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full.endsWith('/harness')) continue;
          files.push(...(await walk(full)));
        } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
          if (full.endsWith('/harness.test.ts')) continue;
          files.push(full);
        }
      }
      return files;
    }

    const files = await walk(acceptanceRoot);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(acceptanceRoot, file);
      if (rel === `ISS-0033${sep}hermetic-replay.test.ts`) continue;
      const content = await readFile(file, 'utf8');
      for (const pattern of bannedPatterns) {
        if (pattern.test(content)) {
          offenders.push(`${file}: matched ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

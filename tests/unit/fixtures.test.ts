import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, loadFixtureStream } from '../fixtures/loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const SCENARIOS = ['interactive', 'headless', 'worktree', 'SIGTERM', 'SIGKILL'];
const REQUIRED_PAYLOAD_FIELDS = ['session_id', 'hook_event_name', 'cwd', 'transcript_path'];

function readJsonLines(file: string) {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

describe('recording-pass fixture manifest', () => {
  it('lists exactly the five scenarios: interactive, headless, worktree, SIGTERM, SIGKILL', () => {
    const manifest = loadManifest();
    expect(Object.keys(manifest.streams).sort()).toEqual([...SCENARIOS].sort());
  });

  it('every recorded stream is version-stamped and exists on disk; pending streams are named as pending, never fabricated', () => {
    const manifest = loadManifest();
    for (const scenario of SCENARIOS) {
      const entry = manifest.streams[scenario as keyof typeof manifest.streams];
      expect(entry, `manifest entry for "${scenario}"`).toBeTruthy();

      if (entry.status === 'pending') {
        // Explicitly not fabricated: no version, no file claimed on disk.
        expect(entry.claudeCodeVersion, `pending scenario "${scenario}" must not claim a version`).toBeFalsy();
        continue;
      }

      expect(entry.claudeCodeVersion, `Claude Code version stamp for "${scenario}"`).toBeTruthy();
      expect(entry.hookEvents.length, `ordered hook events for "${scenario}"`).toBeGreaterThan(0);

      const filePath = path.join(FIXTURES_DIR, entry.file);
      expect(fs.existsSync(filePath), `stream file for "${scenario}" exists at ${filePath}`).toBe(true);
    }
  });

  it('every line of every recorded stream is a JSON object carrying session_id, hook_event_name, cwd and transcript_path', () => {
    const manifest = loadManifest();
    const problems: string[] = [];

    for (const scenario of SCENARIOS) {
      const entry = manifest.streams[scenario as keyof typeof manifest.streams];
      if (entry.status === 'pending') continue;

      const lines = readJsonLines(path.join(FIXTURES_DIR, entry.file));
      lines.forEach((line, idx) => {
        let payload: unknown;
        try {
          payload = JSON.parse(line);
        } catch {
          problems.push(`${scenario} line ${idx + 1}: not valid JSON`);
          return;
        }
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          problems.push(`${scenario} line ${idx + 1}: not a JSON object`);
          return;
        }
        for (const field of REQUIRED_PAYLOAD_FIELDS) {
          if (!(field in (payload as Record<string, unknown>))) {
            problems.push(`${scenario} line ${idx + 1}: missing "${field}"`);
          }
        }
      });
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('the worktree stream records a WorktreeCreate payload', () => {
    const lines = loadFixtureStream('worktree');
    const worktreeCreate = lines.find((line) => JSON.parse(line).hook_event_name === 'WorktreeCreate');
    expect(worktreeCreate, 'a WorktreeCreate payload in the worktree stream').toBeTruthy();
  });

  it('loadFixtureStream throws a clear error for a pending scenario rather than returning fabricated lines', () => {
    const manifest = loadManifest();
    const pending = Object.entries(manifest.streams).find(([, entry]) => entry.status === 'pending');
    expect(pending, 'at least one pending scenario to exercise this path').toBeTruthy();
    const [scenario] = pending as [string, unknown];
    expect(() => loadFixtureStream(scenario as never)).toThrow(/pending/);
  });

  it('the corrupt-line fixture has an invalid middle line flanked by valid envelope-bearing payloads', () => {
    const file = path.join(FIXTURES_DIR, 'corrupt.jsonl');
    expect(fs.existsSync(file), 'corrupt.jsonl exists').toBe(true);

    const lines = readJsonLines(file);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const parsed = lines.map((line) => {
      try {
        return { ok: true as const, value: JSON.parse(line) };
      } catch {
        return { ok: false as const, value: undefined };
      }
    });

    const corruptIndices = parsed.map((r, idx) => (r.ok ? -1 : idx)).filter((idx) => idx !== -1);
    expect(corruptIndices.length).toBe(1);

    const corruptIdx = corruptIndices[0];
    expect(corruptIdx).toBeGreaterThan(0);
    expect(corruptIdx).toBeLessThan(lines.length - 1);

    for (const field of REQUIRED_PAYLOAD_FIELDS) {
      expect(parsed[corruptIdx - 1].value).toHaveProperty(field);
      expect(parsed[corruptIdx + 1].value).toHaveProperty(field);
    }
  });
});

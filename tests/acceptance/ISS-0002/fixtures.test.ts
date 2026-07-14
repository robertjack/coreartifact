import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This suite predates the fixture manifest and loader described in ISS-0002:
// "the operator runs the recording pass and commits the streams; the
// implementer builds the manifest, the loader and the validation test around
// them." No exact manifest path is named by the spec, so rather than lock the
// implementer to a single guessed filename, these tests discover a
// `manifest.json` anywhere under the repo (excluding vendor/build dirs) whose
// contents reference the five recording-pass scenarios. That keeps today's
// red state meaningful (the manifest genuinely does not exist yet) without
// pinning an implementation detail the spec never named.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../');
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo']);
const SCENARIOS = ['interactive', 'headless', 'worktree', 'SIGTERM', 'SIGKILL'];
const REQUIRED_PAYLOAD_FIELDS = ['session_id', 'hook_event_name', 'cwd', 'transcript_path'];

function walk(dir, visit, depth = 0, maxDepth = 8) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      visit(full);
    } else if (entry.isDirectory()) {
      walk(full, visit, depth + 1, maxDepth);
    }
  }
}

function findManifest() {
  let found = null;
  walk(REPO_ROOT, (file) => {
    if (found) return;
    if (path.basename(file) !== 'manifest.json') return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return;
    }
    const text = JSON.stringify(parsed).toLowerCase();
    if (text.includes('interactive') && text.includes('headless') && text.includes('worktree')) {
      found = { path: file, data: parsed };
    }
  });
  return found;
}

function findCorruptFixture() {
  let found = null;
  walk(REPO_ROOT, (file) => {
    if (found) return;
    if (/corrupt/i.test(path.basename(file))) {
      found = file;
    }
  });
  return found;
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function getStreamEntries(manifest) {
  const raw = pick(manifest.data, ['streams', 'fixtures', 'scenarios', 'entries']);
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([scenario, value]) => ({ scenario, ...(value || {}) }));
  }
  return [];
}

function resolveStreamFile(manifest, entry) {
  const file = pick(entry, ['file', 'path', 'filename']);
  if (!file) return undefined;
  if (path.isAbsolute(file) && fs.existsSync(file)) return file;
  const candidates = [
    path.resolve(path.dirname(manifest.path), file),
    path.resolve(REPO_ROOT, file),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function readJsonLines(file) {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

describe('ISS-0002: recording pass fixtures', () => {
  it('R14 Fixtures (recording pass). Committed fixture streams cover: interactive, headless, worktree, SIGTERM, SIGKILL; each stamped with the Claude Code version it was recorded on; the WorktreeCreate payload shape is recorded.', () => {
    const manifest = findManifest();
    if (!manifest) {
      throw new Error(
        'no fixture manifest found under the repo (expected a manifest.json referencing the interactive/headless/worktree/SIGTERM/SIGKILL streams)'
      );
    }

    const entries = getStreamEntries(manifest);
    const byScenario = new Map(entries.map((entry) => [String(pick(entry, ['scenario', 'name'])), entry]));

    for (const scenario of SCENARIOS) {
      const entry = byScenario.get(scenario);
      expect(entry, `manifest entry for scenario "${scenario}"`).toBeTruthy();

      const version = pick(entry, ['claudeCodeVersion', 'version', 'ccVersion', 'recordedVersion']);
      expect(version, `Claude Code version stamp for "${scenario}"`).toBeTruthy();

      const resolved = resolveStreamFile(manifest, entry);
      expect(resolved, `stream file on disk for "${scenario}"`).toBeTruthy();
    }

    const worktreeEntry = byScenario.get('worktree');
    expect(worktreeEntry, 'manifest entry for "worktree"').toBeTruthy();
    const worktreeFile = resolveStreamFile(manifest, worktreeEntry);
    expect(worktreeFile, 'worktree stream file on disk').toBeTruthy();

    const worktreeCreateLine = readJsonLines(worktreeFile).find((line) => {
      try {
        return JSON.parse(line).hook_event_name === 'WorktreeCreate';
      } catch {
        return false;
      }
    });
    expect(worktreeCreateLine, 'a WorktreeCreate payload recorded in the worktree stream').toBeTruthy();
  });

  it('Every committed fixture stream is a sequence of hook payloads, one JSON object per line, each carrying session_id, hook_event_name, cwd and transcript_path; a fixture manifest test parses every stream and fails naming any line that is not a JSON object or that lacks one of those four fields.', () => {
    const manifest = findManifest();
    if (!manifest) {
      throw new Error('no fixture manifest found — cannot validate committed streams');
    }

    const entries = getStreamEntries(manifest);
    expect(entries.length, 'manifest lists at least one stream').toBeGreaterThan(0);

    const problems = [];

    for (const entry of entries) {
      const scenario = pick(entry, ['scenario', 'name']);
      const resolved = resolveStreamFile(manifest, entry);

      if (!resolved) {
        problems.push(`${scenario}: stream file not found on disk`);
        continue;
      }

      readJsonLines(resolved).forEach((line, idx) => {
        let payload;
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
          if (!(field in payload)) {
            problems.push(`${scenario} line ${idx + 1}: missing "${field}"`);
          }
        }
      });
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('The fixture manifest records, per stream, the recorded Claude Code version, the scenario name and the hook event names in order; a test asserts the manifest lists exactly the five scenarios interactive, headless, worktree, SIGTERM and SIGKILL, and that every stream file named by the manifest exists.', () => {
    const manifest = findManifest();
    if (!manifest) {
      throw new Error('no fixture manifest found');
    }

    const entries = getStreamEntries(manifest);
    const scenarioNames = entries.map((entry) => String(pick(entry, ['scenario', 'name']))).sort();
    expect(scenarioNames).toEqual([...SCENARIOS].sort());

    for (const entry of entries) {
      const scenario = pick(entry, ['scenario', 'name']);

      const version = pick(entry, ['claudeCodeVersion', 'version', 'ccVersion', 'recordedVersion']);
      expect(version, `Claude Code version for "${scenario}"`).toBeTruthy();

      const hookEvents = pick(entry, ['hookEvents', 'events', 'hookEventNames']);
      expect(
        Array.isArray(hookEvents) && hookEvents.length > 0,
        `ordered hook event names for "${scenario}"`
      ).toBe(true);

      const resolved = resolveStreamFile(manifest, entry);
      expect(resolved, `stream file for "${scenario}" exists on disk`).toBeTruthy();
    }
  });

  it('A corrupt-line fixture exists whose middle line is not valid JSON while the lines before and after it are valid envelope-bearing payloads, so downstream ingest tests can assert skip-and-continue against a real file.', () => {
    const file = findCorruptFixture();
    expect(file, 'a fixture file with "corrupt" in its name').toBeTruthy();

    const lines = readJsonLines(file);
    expect(lines.length, 'at least 3 lines (valid, corrupt, valid)').toBeGreaterThanOrEqual(3);

    const parsedResults = lines.map((line) => {
      try {
        return { ok: true, value: JSON.parse(line) };
      } catch {
        return { ok: false, value: undefined };
      }
    });

    const corruptIndices = parsedResults
      .map((result, idx) => (result.ok ? -1 : idx))
      .filter((idx) => idx !== -1);

    expect(corruptIndices.length, 'exactly one invalid JSON line').toBe(1);

    const corruptIdx = corruptIndices[0];
    expect(corruptIdx, 'the corrupt line is not the first line').toBeGreaterThan(0);
    expect(corruptIdx, 'the corrupt line is not the last line').toBeLessThan(lines.length - 1);

    const before = parsedResults[corruptIdx - 1];
    const after = parsedResults[corruptIdx + 1];
    expect(before.ok, 'line before the corrupt line is valid JSON').toBe(true);
    expect(after.ok, 'line after the corrupt line is valid JSON').toBe(true);

    for (const field of REQUIRED_PAYLOAD_FIELDS) {
      expect(before.value, `field "${field}" on the line before the corrupt line`).toHaveProperty(field);
      expect(after.value, `field "${field}" on the line after the corrupt line`).toHaveProperty(field);
    }
  });
});

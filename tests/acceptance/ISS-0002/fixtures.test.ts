import fs from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DOCS_RECORDING_PASS,
  findFiles,
  findManifestFile,
  loadManifest,
  readJsonLines,
  REQUIRED_ENVELOPE_FIELDS,
  REQUIRED_SCENARIOS,
  resolveStreamPath,
} from "./helpers";

describe("ISS-0002 recording pass fixtures", () => {
  test("R14 Fixtures (recording pass). Committed fixture streams cover: interactive, headless, worktree, SIGTERM, SIGKILL; each stamped with the Claude Code version it was recorded on; the WorktreeCreate payload shape is recorded.", () => {
    const manifestPath = findManifestFile();
    expect(
      manifestPath,
      `expected a fixture manifest (manifest.json or manifest.jsonl under a "fixtures"/"hook-stream" directory) to be committed under the repo; found none`,
    ).not.toBeNull();
    if (!manifestPath) return;

    const entries = loadManifest(manifestPath);
    const scenarios = entries.map((e) => e.scenario);

    for (const scenario of REQUIRED_SCENARIOS) {
      expect(
        scenarios,
        `manifest at ${manifestPath} must list a stream for scenario "${scenario}"`,
      ).toContain(scenario);
    }

    for (const entry of entries) {
      expect(
        entry.claudeCodeVersion,
        `manifest entry for scenario "${entry.scenario}" (${manifestPath}) must be stamped with the recorded Claude Code version`,
      ).toBeTruthy();
    }

    const docsExists = fs.existsSync(DOCS_RECORDING_PASS);
    expect(
      docsExists,
      `expected docs/recording-pass.md to exist and record the observed WorktreeCreate payload shape`,
    ).toBe(true);
    const docsContent = docsExists ? fs.readFileSync(DOCS_RECORDING_PASS, "utf8") : "";
    expect(
      docsContent,
      `docs/recording-pass.md must describe the observed WorktreeCreate payload shape (whether it carries the new worktree's path)`,
    ).toMatch(/WorktreeCreate/);
  });

  test("Every committed fixture stream is a sequence of hook payloads, one JSON object per line, each carrying session_id, hook_event_name, cwd and transcript_path; a fixture manifest test parses every stream and fails naming any line that is not a JSON object or that lacks one of those four fields.", () => {
    const manifestPath = findManifestFile();
    expect(
      manifestPath,
      `expected a fixture manifest to be committed so its streams can be validated; found none`,
    ).not.toBeNull();
    if (!manifestPath) return;

    const entries = loadManifest(manifestPath);
    expect(
      entries.length,
      `manifest at ${manifestPath} must list at least one stream`,
    ).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(
        entry.file,
        `manifest entry for scenario "${entry.scenario}" must name its stream file`,
      ).toBeTruthy();
      if (!entry.file) continue;

      const streamPath = resolveStreamPath(manifestPath, entry.file);
      expect(
        fs.existsSync(streamPath),
        `stream file "${entry.file}" named by manifest entry "${entry.scenario}" must exist on disk (resolved to ${streamPath})`,
      ).toBe(true);
      if (!fs.existsSync(streamPath)) continue;

      const lines = readJsonLines(streamPath);
      expect(
        lines.length,
        `stream "${entry.scenario}" (${streamPath}) must contain at least one hook payload line`,
      ).toBeGreaterThan(0);

      lines.forEach((line, index) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          throw new Error(
            `stream "${entry.scenario}" (${streamPath}) line ${index + 1} is not valid JSON: ${(err as Error).message}`,
          );
        }
        expect(
          typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
          `stream "${entry.scenario}" (${streamPath}) line ${index + 1} must be a JSON object`,
        ).toBe(true);

        const obj = parsed as Record<string, unknown>;
        for (const field of REQUIRED_ENVELOPE_FIELDS) {
          expect(
            Object.prototype.hasOwnProperty.call(obj, field),
            `stream "${entry.scenario}" (${streamPath}) line ${index + 1} is missing required field "${field}"`,
          ).toBe(true);
        }
      });
    }
  });

  test("The fixture manifest records, per stream, the recorded Claude Code version, the scenario name and the hook event names in order; a test asserts the manifest lists exactly the five scenarios interactive, headless, worktree, SIGTERM and SIGKILL, and that every stream file named by the manifest exists.", () => {
    const manifestPath = findManifestFile();
    expect(
      manifestPath,
      `expected a fixture manifest to be committed; found none`,
    ).not.toBeNull();
    if (!manifestPath) return;

    const entries = loadManifest(manifestPath);

    for (const entry of entries) {
      expect(
        entry.scenario,
        `every manifest entry (${manifestPath}) must record a scenario name`,
      ).toBeTruthy();
      expect(
        entry.claudeCodeVersion,
        `manifest entry for scenario "${entry.scenario}" must record the Claude Code version it was recorded on`,
      ).toBeTruthy();
      expect(
        entry.events && entry.events.length > 0,
        `manifest entry for scenario "${entry.scenario}" must record the hook event names in order`,
      ).toBe(true);
    }

    const scenarios = entries.map((e) => e.scenario).filter(Boolean).sort();
    const expected = [...REQUIRED_SCENARIOS].sort();
    expect(
      scenarios,
      `manifest at ${manifestPath} must list exactly the five scenarios ${expected.join(", ")}, got: ${scenarios.join(", ") || "(none)"}`,
    ).toEqual(expected);

    for (const entry of entries) {
      if (!entry.file) continue;
      const streamPath = resolveStreamPath(manifestPath, entry.file);
      expect(
        fs.existsSync(streamPath),
        `stream file "${entry.file}" named by manifest entry "${entry.scenario}" must exist on disk`,
      ).toBe(true);
    }
  });

  test("A corrupt-line fixture exists whose middle line is not valid JSON while the lines before and after it are valid envelope-bearing payloads, so downstream ingest tests can assert skip-and-continue against a real file.", () => {
    const candidates = findFiles((basename, fullPath) => {
      const lower = fullPath.toLowerCase();
      return /\.jsonl?$/i.test(basename) && lower.includes("corrupt");
    });

    expect(
      candidates.length,
      `expected a hand-authored corrupt-line fixture (a *.jsonl file with "corrupt" in its path) to be committed under the repo; found none`,
    ).toBeGreaterThan(0);
    if (candidates.length === 0) return;

    const corruptFile = candidates[0];
    const lines = readJsonLines(corruptFile);
    expect(
      lines.length,
      `corrupt-line fixture ${corruptFile} must have at least 3 lines (valid, corrupt, valid)`,
    ).toBeGreaterThanOrEqual(3);

    const parsedResults = lines.map((line) => {
      try {
        return { ok: true as const, value: JSON.parse(line) };
      } catch {
        return { ok: false as const, value: undefined };
      }
    });

    const corruptIndices = parsedResults
      .map((r, i) => (r.ok ? -1 : i))
      .filter((i) => i !== -1);

    expect(
      corruptIndices.length,
      `corrupt-line fixture ${corruptFile} must contain exactly one line that fails JSON.parse, found ${corruptIndices.length}`,
    ).toBe(1);
    if (corruptIndices.length !== 1) return;

    const corruptIndex = corruptIndices[0];
    expect(
      corruptIndex,
      `the corrupt line in ${corruptFile} must sit in the middle of the file, not be the first line`,
    ).toBeGreaterThan(0);
    expect(
      corruptIndex,
      `the corrupt line in ${corruptFile} must sit in the middle of the file, not be the last line`,
    ).toBeLessThan(lines.length - 1);

    const before = parsedResults[corruptIndex - 1];
    const after = parsedResults[corruptIndex + 1];

    for (const [label, result] of [
      ["before", before],
      ["after", after],
    ] as const) {
      expect(
        result.ok,
        `the line immediately ${label} the corrupt line in ${corruptFile} must be valid JSON`,
      ).toBe(true);
      if (!result.ok) continue;
      const obj = result.value as Record<string, unknown>;
      for (const field of REQUIRED_ENVELOPE_FIELDS) {
        expect(
          Object.prototype.hasOwnProperty.call(obj, field),
          `the line immediately ${label} the corrupt line in ${corruptFile} must be an envelope-bearing payload with field "${field}"`,
        ).toBe(true);
      }
    }
  });
});

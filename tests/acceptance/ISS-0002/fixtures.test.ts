import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Plain fs-based checks only (no acceptance harness, no implementation
// imports) — this issue predates the acceptance harness and the manifest
// loader it will eventually ship does not exist yet.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");

// Fixed path per spec: "resolve tests/fixtures/manifest.json as a constant
// path relative to the repo root ... No globbing, no walking, no
// candidates[0], no fallbacks."
const MANIFEST_PATH = path.join(REPO_ROOT, "tests/fixtures/manifest.json");

// The corrupt-line fixture is hand-authored and deliberately excluded from
// the manifest's five scenarios, so it is resolved at its own fixed,
// conventional path alongside the manifest rather than discovered.
const CORRUPT_LINE_PATH = path.join(REPO_ROOT, "tests/fixtures/corrupt-line.jsonl");

const REQUIRED_SCENARIOS = ["interactive", "headless", "worktree", "SIGTERM", "SIGKILL"];
const REQUIRED_PAYLOAD_FIELDS = ["session_id", "hook_event_name", "cwd", "transcript_path"];

function readManifest(): any {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`fixture manifest not found at fixed path ${MANIFEST_PATH}`);
  }
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  return JSON.parse(raw);
}

function getStreamEntries(manifest: any): any[] {
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest?.streams)) return manifest.streams;
  if (Array.isArray(manifest?.fixtures)) return manifest.fixtures;
  throw new Error(
    'manifest does not contain a recognizable list of streams (expected an array, or a "streams"/"fixtures" array field)',
  );
}

function scenarioOf(entry: any): string | undefined {
  return entry?.scenario ?? entry?.name;
}

function versionOf(entry: any): string | undefined {
  return entry?.claudeCodeVersion ?? entry?.version ?? entry?.cliVersion ?? entry?.recordedVersion;
}

function fileOf(entry: any): string | undefined {
  return entry?.file ?? entry?.path ?? entry?.stream ?? entry?.streamFile;
}

function eventsOf(entry: any): any {
  return entry?.events ?? entry?.hookEvents ?? entry?.eventNames;
}

function resolveStreamPath(file: string): string {
  return path.isAbsolute(file) ? file : path.join(REPO_ROOT, file);
}

function readNonEmptyLines(filePath: string): string[] {
  const raw = readFileSync(filePath, "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

function findScenario(entries: any[], scenario: string): any {
  const entry = entries.find((e) => scenarioOf(e) === scenario);
  if (!entry) {
    throw new Error(`manifest is missing scenario "${scenario}"`);
  }
  return entry;
}

describe("ISS-0002 R14 fixtures (recording pass)", () => {
  it("R14 Fixtures (recording pass). Committed fixture streams cover: interactive, headless, worktree, SIGTERM, SIGKILL; each stamped with the Claude Code version it was recorded on; the WorktreeCreate payload shape is recorded.", () => {
    const manifest = readManifest();
    const entries = getStreamEntries(manifest);

    for (const scenario of REQUIRED_SCENARIOS) {
      const entry = findScenario(entries, scenario);
      const version = versionOf(entry);
      expect(version, `stream "${scenario}" is not stamped with a Claude Code version`).toBeTruthy();
      expect(typeof version).toBe("string");
    }

    const worktreeEntry = findScenario(entries, "worktree");
    const worktreeFile = fileOf(worktreeEntry);
    if (!worktreeFile) {
      throw new Error('manifest entry for scenario "worktree" does not name a stream file');
    }
    const worktreeFilePath = resolveStreamPath(worktreeFile);
    expect(existsSync(worktreeFilePath), `worktree stream file ${worktreeFilePath} does not exist`).toBe(true);

    const lines = readNonEmptyLines(worktreeFilePath).map((line) => JSON.parse(line));
    const hasWorktreeCreate = lines.some((payload) => payload.hook_event_name === "WorktreeCreate");
    expect(
      hasWorktreeCreate,
      "worktree stream does not record a WorktreeCreate payload, so its shape is not captured",
    ).toBe(true);
  });

  it("Every committed fixture stream is a sequence of hook payloads, one JSON object per line, each carrying session_id, hook_event_name, cwd and transcript_path; a fixture manifest test parses every stream and fails naming any line that is not a JSON object or that lacks one of those four fields.", () => {
    const manifest = readManifest();
    const entries = getStreamEntries(manifest);
    expect(entries.length, "manifest lists no streams to validate").toBeGreaterThan(0);

    for (const entry of entries) {
      const scenario = scenarioOf(entry) ?? "(unnamed scenario)";
      const file = fileOf(entry);
      if (!file) {
        throw new Error(`entry for scenario "${scenario}" does not name a file`);
      }
      const filePath = resolveStreamPath(file);
      expect(existsSync(filePath), `stream file ${filePath} for scenario "${scenario}" does not exist`).toBe(true);

      const rawLines = readNonEmptyLines(filePath);
      expect(rawLines.length, `stream file ${filePath} has no payload lines`).toBeGreaterThan(0);

      rawLines.forEach((line, index) => {
        let payload: any;
        try {
          payload = JSON.parse(line);
        } catch {
          throw new Error(`${filePath}:${index + 1} is not valid JSON`);
        }
        expect(
          payload !== null && typeof payload === "object" && !Array.isArray(payload),
          `${filePath}:${index + 1} is not a JSON object`,
        ).toBe(true);
        for (const field of REQUIRED_PAYLOAD_FIELDS) {
          expect(payload[field], `${filePath}:${index + 1} is missing required field "${field}"`).toBeDefined();
        }
      });
    }
  });

  it("The fixture manifest records, per stream, the recorded Claude Code version, the scenario name and the hook event names in order; a test asserts the manifest lists exactly the five scenarios interactive, headless, worktree, SIGTERM and SIGKILL, and that every stream file named by the manifest exists.", () => {
    const manifest = readManifest();
    const entries = getStreamEntries(manifest);

    const scenarios = entries.map((e) => scenarioOf(e) ?? "");
    expect(new Set(scenarios).size, "manifest has duplicate or unnamed scenario entries").toBe(scenarios.length);
    expect(
      [...scenarios].sort(),
      "manifest does not list exactly the five required scenarios: interactive, headless, worktree, SIGTERM, SIGKILL",
    ).toEqual([...REQUIRED_SCENARIOS].sort());

    for (const entry of entries) {
      const scenario = scenarioOf(entry) ?? "(unnamed scenario)";

      expect(versionOf(entry), `entry "${scenario}" is missing its recorded Claude Code version`).toBeTruthy();

      const events = eventsOf(entry);
      expect(Array.isArray(events), `entry "${scenario}" does not record hook event names in order`).toBe(true);
      expect((events as any[]).length, `entry "${scenario}" records an empty hook event list`).toBeGreaterThan(0);
      for (const ev of events as any[]) {
        expect(typeof ev, `entry "${scenario}" has a non-string hook event name`).toBe("string");
      }

      const file = fileOf(entry);
      if (!file) {
        throw new Error(`entry "${scenario}" does not name a stream file`);
      }
      const filePath = resolveStreamPath(file);
      expect(
        existsSync(filePath),
        `stream file ${filePath} named by manifest entry "${scenario}" does not exist`,
      ).toBe(true);
    }
  });

  it("A corrupt-line fixture exists whose middle line is not valid JSON while the lines before and after it are valid envelope-bearing payloads, so downstream ingest tests can assert skip-and-continue against a real file.", () => {
    expect(
      existsSync(CORRUPT_LINE_PATH),
      `corrupt-line fixture not found at fixed path ${CORRUPT_LINE_PATH}`,
    ).toBe(true);

    const rawLines = readNonEmptyLines(CORRUPT_LINE_PATH);
    expect(
      rawLines.length,
      "corrupt-line fixture must have at least 3 lines: a valid line, the corrupt line, and a valid line",
    ).toBeGreaterThanOrEqual(3);

    const parsed = rawLines.map((line) => {
      try {
        return { ok: true as const, value: JSON.parse(line) };
      } catch {
        return { ok: false as const, value: undefined };
      }
    });

    const corruptIndices = parsed.map((p, i) => (p.ok ? -1 : i)).filter((i) => i >= 0);
    expect(corruptIndices.length, "corrupt-line fixture must have exactly one invalid JSON line").toBe(1);

    const corruptIndex = corruptIndices[0];
    if (corruptIndex === undefined) {
      throw new Error("corrupt-line fixture has no invalid JSON line");
    }
    expect(corruptIndex, "the corrupt line must not be the first line").toBeGreaterThan(0);
    expect(corruptIndex, "the corrupt line must not be the last line").toBeLessThan(rawLines.length - 1);

    const before = parsed[corruptIndex - 1];
    const after = parsed[corruptIndex + 1];
    if (!before || !after) {
      throw new Error("corrupt-line fixture is missing a neighboring line");
    }
    expect(before.ok, "the line before the corrupt line must be valid JSON").toBe(true);
    expect(after.ok, "the line after the corrupt line must be valid JSON").toBe(true);

    for (const neighbor of [before, after]) {
      const payload = neighbor.value;
      for (const field of REQUIRED_PAYLOAD_FIELDS) {
        expect(payload[field], `neighboring valid line is missing required envelope field "${field}"`).toBeDefined();
      }
    }
  });
});

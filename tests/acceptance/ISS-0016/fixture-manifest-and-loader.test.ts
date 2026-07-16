// ISS-0016 acceptance tests — R13 "Fixtures wired for the loop".
//
// These tests exercise the typed fixture manifest/loader (tests/fixtures/manifest.json,
// tests/fixtures/loader.ts) once it is extended to carry the three recording-pass
// streams (cost-headless, vitest, background) and the typed transcript-pair reader
// over tests/fixtures/transcripts/manifest.json. None of that extension exists yet,
// so these tests are red today.
//
// loadManifest/loadFixtureStream already exist on tests/fixtures/loader.ts today, so
// they are imported statically. The transcript-pair reader does not exist yet, so it
// is loaded through a dynamic import behind a non-literal specifier (MODULE_PATH) —
// a literal specifier would let tsc try to resolve missing named exports and fail
// the whole file at collection instead of producing a red assertion.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, loadFixtureStream, type ScenarioName } from "../../fixtures/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const LOADER_MODULE_PATH = "../../fixtures/loader.js";
const TRANSCRIPTS_MANIFEST_PATH = path.join(REPO_ROOT, "tests/fixtures/transcripts/manifest.json");

const EIGHT_SCENARIOS = [
  "interactive",
  "headless",
  "worktree",
  "SIGTERM",
  "SIGKILL",
  "cost-headless",
  "vitest",
  "background",
];

const REQUIRED_PAYLOAD_FIELDS = ["session_id", "hook_event_name", "cwd", "transcript_path"];

async function importLoaderModule(): Promise<any> {
  try {
    return await import(LOADER_MODULE_PATH);
  } catch {
    return undefined;
  }
}

function readTranscriptsManifest(): any {
  const raw = fs.readFileSync(TRANSCRIPTS_MANIFEST_PATH, "utf-8");
  return JSON.parse(raw);
}

describe("ISS-0016 R13 fixtures wired for the loop", () => {
  it("R13 Fixtures wired for the loop. The typed fixture manifest and loader expose the three recording-pass PRD-0002 streams (cost-headless, vitest, background) alongside the five v1 scenarios, each stamped with its Claude Code version, and expose the committed transcript pairs with their envelope oracle values (total cost and token counts) for cost-headless, vitest and background plus the recovered headless and interactive transcripts; the fixtures layer supplies the one sanctioned substitution — a transcript-substituting replay wrapper that rewrites transcript_path in delivered payloads to a tmpdir copy of the paired transcript fixture — while every committed fixture file stays byte-verbatim.", async () => {
    // Part 1: the typed stream manifest lists all eight scenarios, each version-stamped.
    const manifest = loadManifest();
    const scenarios = manifest.streams.map((s) => s.scenario).sort();
    expect(scenarios, "manifest streams must list all eight scenarios").toEqual([...EIGHT_SCENARIOS].sort());

    for (const scenario of EIGHT_SCENARIOS) {
      const entry = manifest.streams.find((s) => s.scenario === (scenario as ScenarioName));
      expect(entry, `manifest entry for "${scenario}"`).toBeTruthy();
      if (!entry) continue;
      expect(entry.claudeCodeVersion, `Claude Code version stamp for "${scenario}"`).toMatch(/^\d+\.\d+\.\d+$/);
    }

    // Part 2: the loader exposes the transcript pairs (typed reader), not just the raw manifest.
    const mod = await importLoaderModule();
    if (!mod || typeof mod.loadTranscriptPair !== "function") {
      throw new Error(
        "tests/fixtures/loader.ts does not yet export a loadTranscriptPair transcript-pair reader — not implemented",
      );
    }

    const rawTranscriptsManifest = readTranscriptsManifest();
    for (const pairEntry of rawTranscriptsManifest.pairs as any[]) {
      const typedPair = mod.loadTranscriptPair(pairEntry.scenario);
      expect(typedPair, `typed transcript pair for "${pairEntry.scenario}"`).toBeTruthy();
      if (pairEntry.oracle === null) {
        expect(typedPair.oracle, `"${pairEntry.scenario}" pair oracle must be null (recovered transcript)`).toBeNull();
      } else {
        expect(typedPair.oracle, `"${pairEntry.scenario}" pair must expose a non-null oracle`).toBeTruthy();
        expect(typedPair.oracle.total_cost_usd, `"${pairEntry.scenario}" oracle total_cost_usd`).toBe(
          pairEntry.oracle.total_cost_usd,
        );
      }
    }

    // Part 3: every committed fixture file involved stays byte-verbatim (no rewrite in place).
    for (const scenario of ["cost-headless", "vitest", "background"]) {
      const entry = manifest.streams.find((s) => s.scenario === (scenario as ScenarioName));
      if (!entry) continue;
      const filePath = path.join(REPO_ROOT, entry.file);
      const before = fs.readFileSync(filePath);
      // loading must not mutate the committed fixture on disk
      loadFixtureStream(scenario as ScenarioName);
      const after = fs.readFileSync(filePath);
      expect(before.equals(after), `${entry.file} must stay byte-verbatim after being loaded`).toBe(true);
    }
  });
});

describe("ISS-0016 loading the eight scenarios by name", () => {
  it("Loading any of the eight scenarios by name through the typed loader returns the stream's lines; the manifest test parses every listed stream and fails naming any line that is not a JSON object or that lacks session_id, hook_event_name, cwd or transcript_path.", () => {
    const problems: string[] = [];

    for (const scenario of EIGHT_SCENARIOS) {
      let lines: string[];
      try {
        lines = loadFixtureStream(scenario as ScenarioName);
      } catch (err) {
        problems.push(`${scenario}: loadFixtureStream threw "${(err as Error).message}"`);
        continue;
      }

      if (lines.length === 0) {
        problems.push(`${scenario}: loadFixtureStream returned no lines`);
        continue;
      }

      lines.forEach((line, idx) => {
        let payload: unknown;
        try {
          payload = JSON.parse(line);
        } catch {
          problems.push(`${scenario} line ${idx + 1}: not valid JSON`);
          return;
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
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

    expect(problems, problems.join("\n")).toEqual([]);
  });
});

describe("ISS-0016 typed transcript-pair access", () => {
  it("The typed transcript-pair access exposes, for cost-headless, vitest and background, the paired stream, transcript and envelope oracle with total_cost_usd and the four token counts, and for the recovered headless and interactive pairs the transcript with a null oracle; a test asserts every referenced file exists.", async () => {
    const mod = await importLoaderModule();
    if (!mod || typeof mod.loadTranscriptPair !== "function") {
      throw new Error(
        "tests/fixtures/loader.ts does not yet export a loadTranscriptPair transcript-pair reader — not implemented",
      );
    }

    const rawManifest = readTranscriptsManifest();
    const rawPairs: any[] = rawManifest.pairs;

    for (const scenario of ["cost-headless", "vitest", "background"]) {
      const rawPair = rawPairs.find((p) => p.scenario === scenario);
      expect(rawPair, `raw transcripts manifest carries a "${scenario}" pair`).toBeTruthy();

      const typedPair = mod.loadTranscriptPair(scenario);
      expect(typedPair, `typed transcript pair for "${scenario}"`).toBeTruthy();

      expect(typedPair.stream, `"${scenario}" pair names a stream file`).toBeTruthy();
      expect(typedPair.transcript, `"${scenario}" pair names a transcript file`).toBeTruthy();

      const streamPath = path.join(REPO_ROOT, typedPair.stream);
      const transcriptPath = path.join(REPO_ROOT, typedPair.transcript);
      expect(fs.existsSync(streamPath), `"${scenario}" stream file exists at ${streamPath}`).toBe(true);
      expect(fs.existsSync(transcriptPath), `"${scenario}" transcript file exists at ${transcriptPath}`).toBe(true);

      expect(typedPair.oracle, `"${scenario}" pair exposes a non-null oracle`).toBeTruthy();
      expect(typedPair.oracle.total_cost_usd, `"${scenario}" oracle total_cost_usd`).toBe(
        rawPair.oracle.total_cost_usd,
      );
      expect(typedPair.oracle.usage?.input_tokens, `"${scenario}" oracle input token count`).toBe(
        rawPair.oracle.usage.input_tokens,
      );
      expect(typedPair.oracle.usage?.output_tokens, `"${scenario}" oracle output token count`).toBe(
        rawPair.oracle.usage.output_tokens,
      );
      expect(typedPair.oracle.usage?.cache_read_input_tokens, `"${scenario}" oracle cache-read token count`).toBe(
        rawPair.oracle.usage.cache_read_input_tokens,
      );
      expect(
        typedPair.oracle.usage?.cache_creation_input_tokens,
        `"${scenario}" oracle cache-creation token count`,
      ).toBe(rawPair.oracle.usage.cache_creation_input_tokens);

      if (rawPair.oracle.distinct_requests !== undefined) {
        expect(typedPair.oracle.distinct_requests, `"${scenario}" oracle distinct_requests`).toBe(
          rawPair.oracle.distinct_requests,
        );
      }
    }

    for (const scenario of ["headless", "interactive"]) {
      const rawPair = rawPairs.find((p) => p.scenario === scenario && p.oracle === null);
      expect(rawPair, `raw transcripts manifest carries a recovered "${scenario}" pair with a null oracle`).toBeTruthy();

      const typedPair = mod.loadTranscriptPair(scenario);
      expect(typedPair, `typed transcript pair for recovered "${scenario}"`).toBeTruthy();

      expect(typedPair.transcript, `recovered "${scenario}" pair names a transcript file`).toBeTruthy();
      const transcriptPath = path.join(REPO_ROOT, typedPair.transcript);
      expect(fs.existsSync(transcriptPath), `recovered "${scenario}" transcript file exists at ${transcriptPath}`).toBe(
        true,
      );

      expect(typedPair.oracle, `recovered "${scenario}" pair oracle must be null`).toBeNull();
    }
  });
});

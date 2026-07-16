// Typed loader for the recording-pass fixture manifest.
// Resolves tests/fixtures/manifest.json at a fixed path — no search, no
// globbing, no candidates[0] (spec-v1.md, ISS-0002 "Test-harness contract").
// Later acceptance tests should import from here rather than hard-coding a
// raw fixture path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "tests/fixtures/manifest.json");
const TRANSCRIPTS_MANIFEST_PATH = path.join(REPO_ROOT, "tests/fixtures/transcripts/manifest.json");

export type ScenarioName =
  | "interactive"
  | "headless"
  | "worktree"
  | "SIGTERM"
  | "SIGKILL"
  | "cost-headless"
  | "vitest"
  | "background";

export interface FixtureStreamEntry {
  scenario: ScenarioName;
  /** Path to the stream file, relative to the repo root. */
  file: string;
  claudeCodeVersion: string;
  events: string[];
}

export interface FixtureManifest {
  streams: FixtureStreamEntry[];
}

function readManifest(): FixtureManifest {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`fixture manifest not found at fixed path ${MANIFEST_PATH}`);
  }
  const raw = fs.readFileSync(MANIFEST_PATH, "utf-8");
  return JSON.parse(raw) as FixtureManifest;
}

export function loadManifest(): FixtureManifest {
  return readManifest();
}

function findEntry(manifest: FixtureManifest, scenario: ScenarioName): FixtureStreamEntry {
  const entry = manifest.streams.find((s) => s.scenario === scenario);
  if (!entry) {
    throw new Error(`no manifest entry for scenario "${scenario}"`);
  }
  return entry;
}

/** Load a fixture stream by scenario name, returning its lines (raw JSON text, one hook payload per line). */
export function loadFixtureStream(scenario: ScenarioName): string[] {
  const manifest = readManifest();
  const entry = findEntry(manifest, scenario);
  const filePath = path.join(REPO_ROOT, entry.file);
  const raw = fs.readFileSync(filePath, "utf-8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

export interface TranscriptPairOracleUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface TranscriptPairOracle {
  total_cost_usd: number;
  usage: TranscriptPairOracleUsage;
  distinct_requests?: number;
}

export interface TranscriptPair {
  scenario: string;
  /** Path to the paired stream file, relative to the repo root. */
  stream: string;
  /** Path to the paired transcript file, relative to the repo root. */
  transcript: string;
  claudeCodeVersion: string;
  model: string | null;
  /** null for the two recovered pairs (headless, interactive) that carry no envelope. */
  oracle: TranscriptPairOracle | null;
}

interface RawTranscriptsManifest {
  claudeVersionOutput: string;
  pairs: Array<{
    scenario: string;
    stream: string;
    transcript: string;
    claudeCodeVersion: string;
    model: string | null;
    oracle: {
      total_cost_usd: number;
      usage: TranscriptPairOracleUsage;
      distinct_requests?: number;
    } | null;
  }>;
}

function readTranscriptsManifest(): RawTranscriptsManifest {
  if (!fs.existsSync(TRANSCRIPTS_MANIFEST_PATH)) {
    throw new Error(`transcripts manifest not found at fixed path ${TRANSCRIPTS_MANIFEST_PATH}`);
  }
  const raw = fs.readFileSync(TRANSCRIPTS_MANIFEST_PATH, "utf-8");
  return JSON.parse(raw) as RawTranscriptsManifest;
}

/** Load a typed transcript pair (stream + transcript + envelope oracle) by scenario name. */
export function loadTranscriptPair(scenario: string): TranscriptPair {
  const manifest = readTranscriptsManifest();
  const pair = manifest.pairs.find((p) => p.scenario === scenario);
  if (!pair) {
    throw new Error(`no transcript pair for scenario "${scenario}"`);
  }
  return {
    scenario: pair.scenario,
    stream: pair.stream,
    transcript: pair.transcript,
    claudeCodeVersion: pair.claudeCodeVersion,
    model: pair.model,
    oracle: pair.oracle
      ? {
          total_cost_usd: pair.oracle.total_cost_usd,
          usage: pair.oracle.usage,
          distinct_requests: pair.oracle.distinct_requests,
        }
      : null,
  };
}

/** The recorded `claude --version` output shape (e.g. "2.1.211 (Claude Code)") — the doctor issue's shim uses it. */
export function loadClaudeVersionOutputShape(): string {
  const manifest = readTranscriptsManifest();
  return manifest.claudeVersionOutput;
}

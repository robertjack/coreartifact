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

export type ScenarioName = "interactive" | "headless" | "worktree" | "SIGTERM" | "SIGKILL";

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

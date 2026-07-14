// Typed loader for the recording-pass fixture manifest (tests/fixtures/manifest.json).
// Later acceptance tests should import from here rather than hard-coding a raw
// fixture path — see spec-v1.md, ISS-0002 "The manifest".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(__dirname, "manifest.json");

export type ScenarioName = "interactive" | "headless" | "worktree" | "SIGTERM" | "SIGKILL";

export interface FixtureStreamEntry {
  scenario: ScenarioName;
  file: string;
  claudeCodeVersion: string;
  events: string[];
}

export interface FixtureManifest {
  streams: FixtureStreamEntry[];
}

function readManifest(): FixtureManifest {
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
  const filePath = path.join(__dirname, entry.file);
  const raw = fs.readFileSync(filePath, "utf-8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

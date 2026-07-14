// Typed loader for the recording-pass fixture manifest (tests/fixtures/manifest.json).
// Later acceptance tests should import from here rather than hard-coding a raw
// fixture path — see docs/issues/ISS-0002.md, "The manifest".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');

export type ScenarioName = 'interactive' | 'headless' | 'worktree' | 'SIGTERM' | 'SIGKILL';

export interface FixtureStreamEntry {
  file: string;
  status: 'recorded' | 'pending';
  claudeCodeVersion: string | null;
  hookEvents: string[];
  note?: string;
}

export interface FixtureManifest {
  streams: Record<ScenarioName, FixtureStreamEntry>;
}

function readManifest(): FixtureManifest {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  return JSON.parse(raw) as FixtureManifest;
}

export function loadManifest(): FixtureManifest {
  return readManifest();
}

export function loadFixtureStream(scenario: ScenarioName): string[] {
  const manifest = readManifest();
  const entry = manifest.streams[scenario];
  if (!entry) {
    throw new Error(`no manifest entry for scenario "${scenario}"`);
  }
  if (entry.status === 'pending') {
    throw new Error(
      `scenario "${scenario}" is pending the operator recording pass and has no stream file yet (see docs/recording-pass.md)`
    );
  }
  const filePath = path.join(__dirname, entry.file);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

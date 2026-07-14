import fs from "node:fs";
import path from "node:path";

// tests/acceptance/ISS-0002/helpers.ts -> repo root is three levels up.
export const REPO_ROOT = path.resolve(__dirname, "../../..");

export const DOCS_RECORDING_PASS = path.join(REPO_ROOT, "docs/recording-pass.md");

export const REQUIRED_SCENARIOS = ["interactive", "headless", "worktree", "SIGTERM", "SIGKILL"] as const;

export const REQUIRED_ENVELOPE_FIELDS = ["session_id", "hook_event_name", "cwd", "transcript_path"] as const;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  ".aeh",
]);

/**
 * Walk the repo (skipping dependency/build/vcs directories) and return every
 * file path whose basename matches `nameFilter`. Used to locate fixture
 * artifacts without hard-coding a single guessed location, since the issue
 * packet does not name an explicit path for the manifest or stream files.
 */
export function findFiles(nameFilter: (basename: string, fullPath: string) => boolean, root = REPO_ROOT): string[] {
  const matches: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        if (nameFilter(entry.name, fullPath)) {
          matches.push(fullPath);
        }
      }
    }
  }

  return matches.sort();
}

/**
 * Locate a candidate fixture manifest: a JSON or JSONL file named
 * "manifest.*" that lives under a directory whose path mentions
 * "fixture" or "hook-stream" (the vocabulary the issue spec uses).
 */
export function findManifestFile(): string | null {
  const candidates = findFiles((basename, fullPath) => {
    if (!/^manifest\.(json|jsonl)$/i.test(basename)) return false;
    const lower = fullPath.toLowerCase();
    return lower.includes("fixture") || lower.includes("hook-stream") || lower.includes("hookstream");
  });
  return candidates[0] ?? null;
}

export type ManifestStreamEntry = {
  scenario: string | undefined;
  claudeCodeVersion: string | undefined;
  file: string | undefined;
  events: string[] | undefined;
  raw: Record<string, unknown>;
};

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickStringArray(obj: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value as string[];
    }
  }
  return undefined;
}

function normalizeEntry(raw: Record<string, unknown>): ManifestStreamEntry {
  return {
    scenario: pickString(raw, ["scenario", "name", "scenarioName", "kind"]),
    claudeCodeVersion: pickString(raw, [
      "claudeCodeVersion",
      "version",
      "ccVersion",
      "recordedVersion",
      "cc_version",
      "claude_code_version",
    ]),
    file: pickString(raw, ["file", "path", "stream", "streamFile", "filename"]),
    events: pickStringArray(raw, ["events", "hookEvents", "eventOrder", "hookEventNames", "hook_events"]),
    raw,
  };
}

function extractEntryList(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  }
  if (parsed && typeof parsed === "object") {
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null)) {
        return value as Record<string, unknown>[];
      }
    }
  }
  return [];
}

/**
 * Load and normalize a manifest file (JSON or JSONL), tolerating unknown
 * field naming since the issue spec does not pin an exact schema - only the
 * facts each stream record must carry (scenario, version, hook event order).
 */
export function loadManifest(manifestPath: string): ManifestStreamEntry[] {
  const content = fs.readFileSync(manifestPath, "utf8");

  if (manifestPath.toLowerCase().endsWith(".jsonl")) {
    const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    return lines.map((line) => normalizeEntry(JSON.parse(line)));
  }

  const parsed = JSON.parse(content);
  return extractEntryList(parsed).map(normalizeEntry);
}

/** Resolve a manifest-referenced stream file path against the manifest's own directory, then repo root. */
export function resolveStreamPath(manifestPath: string, referenced: string): string {
  const nearManifest = path.resolve(path.dirname(manifestPath), referenced);
  if (fs.existsSync(nearManifest)) return nearManifest;
  return path.resolve(REPO_ROOT, referenced);
}

export function readJsonLines(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8");
  return content.split("\n").filter((line) => line.trim().length > 0);
}

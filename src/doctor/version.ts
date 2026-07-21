// The running Claude Code version — obtained by executing `claude
// --version` (resolved through PATH, allowlist-scrubbed env) and parsing
// the FIRST whitespace-separated token of its single output line (the
// recorded shape is `2.1.211 (Claude Code)`, docs/issues/ISS-0021.md).
// Anything else — multi-line output, a non-semver first token, a missing
// binary, a nonzero exit, a hang — renders ABSENT (null here; the CLI
// layer renders the shared marker). Never guess, never scrape deeper.
//
// @types/node is unreachable in this sandbox (no network, nothing cached
// — see src/core/paths.ts). `node:child_process` is loaded via a genuine
// dynamic `import()` cast to `any`, same pattern as
// src/core/attribution.ts's `loadNode` (a real ESM import at runtime, only
// its specifier is cast to skip TS's static module resolution).
declare const process: { env: Record<string, string | undefined> };

import { scrubbedEnv } from "../core/attribution.js";

// The tested version range — the README's stamp (README.md now ships the
// stamp; this constant is the source of truth it's stamped from). Bump on
// the next recording pass; one constant, one place.
export const TESTED_CLAUDE_CODE_RANGE = {
  min: "2.1.208",
  max: "2.1.215",
} as const;

const SEMVER_TOKEN_RE = /^\d+\.\d+\.\d+$/;

// Pure parsing — the only logic in this file worth unit-testing directly.
// A "single output line" means exactly one non-empty line once a trailing
// newline (ordinary process-output framing, not corruption) is discounted.
export function parseClaudeVersionOutput(output: string): string | null {
  const nonEmptyLines = output.split("\n").filter((line) => line.length > 0);
  if (nonEmptyLines.length !== 1) return null;
  const token = nonEmptyLines[0]!.split(/\s+/)[0];
  if (!token || !SEMVER_TOKEN_RE.test(token)) return null;
  return token;
}

const VERSION_TIMEOUT_MS = 3000;

async function loadNode(specifier: string): Promise<any> {
  return import(specifier as any);
}

// Spawns `claude --version` with a bounded timeout and the same
// allowlist-scrubbed env every other subprocess call in this codebase
// uses (gotchas.md entry 3) — never `{ ...process.env }`. Any failure
// mode (missing binary, nonzero exit, timeout/hang) resolves to null;
// this function never throws.
export async function getRunningClaudeVersion(): Promise<string | null> {
  const { execFile } = await loadNode("node:child_process");
  const env = scrubbedEnv(process.env);
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["--version"],
      { env, timeout: VERSION_TIMEOUT_MS },
      (err: unknown, stdout: string) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(parseClaudeVersionOutput(stdout));
      },
    );
  });
}

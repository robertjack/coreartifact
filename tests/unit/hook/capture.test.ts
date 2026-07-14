// Below-the-seam unit tests for the hook artifact's pure parts (spec
// "Test-harness contract": boundary detection, envelope framing, and the
// pinning cross-check that a line this module writes parses through
// src/core/envelope.ts's parser). Process-level behavior (exit codes,
// spool bytes across fixture replays) is covered by
// tests/acceptance/ISS-0004/hook.test.ts — this file never spawns the
// compiled artifact.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isBoundaryEvent,
  validateEventText,
  buildSpoolLine,
  resolveRepoRoot,
  resolveBoundaryGit,
  scrubbedEnv,
} from "../../../src/hook/capture.js";
import { parseEnvelope } from "../../../src/core/envelope.js";

const tmpRoots: string[] = [];

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "iss4-capture-unit-"));
  tmpRoots.push(dir);
  return dir;
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: dir };
  execFileSync("git", ["init", "-q"], { cwd: dir, env });
  execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: dir, env });
  execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: dir, env });
  writeFileSync(join(dir, "file.txt"), "content");
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: dir, env });
}

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});

describe("isBoundaryEvent", () => {
  it("is true for SessionStart and SessionEnd", () => {
    expect(isBoundaryEvent({ hook_event_name: "SessionStart" })).toBe(true);
    expect(isBoundaryEvent({ hook_event_name: "SessionEnd" })).toBe(true);
  });

  it("is false for every other event name, and for non-object payloads", () => {
    expect(isBoundaryEvent({ hook_event_name: "PreToolUse" })).toBe(false);
    expect(isBoundaryEvent({ hook_event_name: "WorktreeCreate" })).toBe(false);
    expect(isBoundaryEvent(null)).toBe(false);
    expect(isBoundaryEvent("SessionStart")).toBe(false);
    expect(isBoundaryEvent([1, 2, 3])).toBe(false);
  });
});

describe("validateEventText", () => {
  it("byte-preserves valid JSON, trimming only surrounding whitespace", () => {
    const result = validateEventText('  {"hook_event_name":"Stop"}  ');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eventText).toBe('{"hook_event_name":"Stop"}');
    }
  });

  it("rejects a raw control character (e.g. an embedded newline) before trimming", () => {
    const result = validateEventText('{"a":1}\n{"b":2}');
    expect(result.ok).toBe(false);
  });

  it("rejects text that does not parse as JSON", () => {
    expect(validateEventText("not valid json {{{").ok).toBe(false);
  });

  it("rejects empty stdin", () => {
    expect(validateEventText("").ok).toBe(false);
    expect(validateEventText("   ").ok).toBe(false);
  });
});

describe("buildSpoolLine — pinned against the core envelope parser", () => {
  it("produces a line that parses cleanly through parseEnvelope, byte-preserving eventText", () => {
    const eventText = '{"hook_event_name":"PreToolUse","session_id":"abc"}';
    const line = buildSpoolLine("2026-07-14T10:00:00.000Z", eventText);
    const parsed = parseEnvelope(line.trimEnd());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.ts).toBe("2026-07-14T10:00:00.000Z");
      expect(parsed.eventText).toBe(eventText);
      expect(parsed.git).toBeUndefined();
    }
  });

  it("carries a git facet through parseEnvelope when both head and dirty are present", () => {
    const eventText = '{"hook_event_name":"SessionStart"}';
    const line = buildSpoolLine("2026-07-14T10:00:00.000Z", eventText, { head: "abc123", dirty: true });
    const parsed = parseEnvelope(line.trimEnd());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.git?.head).toBe("abc123");
      expect(parsed.git?.dirty).toBe(true);
    }
  });

  it("omits the git member entirely when neither field is present", () => {
    const line = buildSpoolLine("2026-07-14T10:00:00.000Z", "{}", {});
    const parsed = parseEnvelope(line.trimEnd());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.git).toBeUndefined();
    }
  });
});

describe("resolveRepoRoot", () => {
  it("resolves a main checkout cwd to its own realpathed toplevel", () => {
    const root = makeTmpRoot();
    const repo = join(root, "repo");
    initRepo(repo);
    const expected = realpathSync(repo);

    expect(resolveRepoRoot(repo, "/init-root-should-not-be-used")).toBe(expected);
  });

  it("falls back to initRoot for a cwd with no git resolution at all", () => {
    const root = makeTmpRoot();
    const nonGitDir = join(root, "not-a-repo");
    mkdirSync(nonGitDir, { recursive: true });

    expect(resolveRepoRoot(nonGitDir, root)).toBe(root);
  });

  it("falls back to initRoot for a cwd that does not exist on disk", () => {
    const root = makeTmpRoot();
    expect(resolveRepoRoot(join(root, "does-not-exist"), root)).toBe(root);
  });
});

describe("resolveBoundaryGit", () => {
  it("returns head and dirty for a resolvable repo with a commit", () => {
    const root = makeTmpRoot();
    const repo = join(root, "repo");
    initRepo(repo);

    const result = resolveBoundaryGit(repo);
    expect(typeof result.head).toBe("string");
    expect(result.head).toHaveLength(40);
    expect(typeof result.dirty).toBe("boolean");
    expect(result.dirty).toBe(false);
  });

  it("reports dirty=true when the working tree has uncommitted changes", () => {
    const root = makeTmpRoot();
    const repo = join(root, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "file.txt"), "changed content");

    const result = resolveBoundaryGit(repo);
    expect(result.dirty).toBe(true);
  });

  it("returns an object with both keys absent — never a fabricated empty string or false — for an unresolvable cwd", () => {
    const root = makeTmpRoot();
    const nonGitDir = join(root, "not-a-repo");
    mkdirSync(nonGitDir, { recursive: true });

    const result = resolveBoundaryGit(nonGitDir);
    expect(result.head).toBeUndefined();
    expect(result.dirty).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe("scrubbedEnv", () => {
  it("passes through only the allowlisted variables", () => {
    const out = scrubbedEnv({ PATH: "/bin", HOME: "/home/x", XDG_CONFIG_HOME: "/xdg", GIT_DIR: "/evil" });
    expect(out).toEqual({ PATH: "/bin", HOME: "/home/x", XDG_CONFIG_HOME: "/xdg" });
  });

  it("omits a key entirely when it is absent from the input, rather than setting it to undefined", () => {
    const out = scrubbedEnv({ PATH: "/bin" });
    expect(Object.keys(out)).toEqual(["PATH"]);
  });
});

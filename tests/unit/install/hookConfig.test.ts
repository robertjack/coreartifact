import { describe, it, expect } from "vitest";
import { NINE_EVENTS, buildHookCommand, mergeHookConfig } from "../../../src/install/hookConfig.js";

describe("install/hookConfig", () => {
  it("buildHookCommand shell-quotes both paths so a space or embedded single quote survives a shell round trip", () => {
    const command = buildHookCommand("/tmp/it's a dir/capture.mjs", "/repo root/with space");
    expect(command).toBe("node '/tmp/it'\\''s a dir/capture.mjs' '/repo root/with space'");
  });

  it("mergeHookConfig subscribes exactly the nine events on a fresh (empty) settings object", () => {
    const merged = mergeHookConfig({}, "/repo/.coreartifact/hooks/capture.mjs", "/repo");
    const hooks = merged.hooks as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual([...NINE_EVENTS].sort());
    expect(hooks).not.toHaveProperty("WorktreeCreate");
    expect(hooks).not.toHaveProperty("WorktreeRemove");
  });

  it("mergeHookConfig preserves unrelated top-level keys and unrelated hook event keys untouched", () => {
    const existing = {
      customUserKey: "keep-me",
      hooks: {
        Notification: [{ matcher: "*", hooks: [{ type: "command", command: "some-other-tool" }] }],
      },
    };
    const merged = mergeHookConfig(existing, "/repo/.coreartifact/hooks/capture.mjs", "/repo");
    expect(merged.customUserKey).toBe("keep-me");
    const hooks = merged.hooks as Record<string, unknown>;
    expect(hooks.Notification).toEqual(existing.hooks.Notification);
  });

  it("mergeHookConfig replaces a prior coreartifact entry rather than appending a second one, even at a different absolute path", () => {
    const firstInstallPath = "/old/location/.coreartifact/hooks/capture.mjs";
    const afterFirstInstall = mergeHookConfig({}, firstInstallPath, "/repo");

    // Simulate the repo having moved: re-running init with a new absolute path.
    const secondInstallPath = "/new/location/.coreartifact/hooks/capture.mjs";
    const afterSecondInstall = mergeHookConfig(afterFirstInstall, secondInstallPath, "/repo");

    const hooks = afterSecondInstall.hooks as Record<string, unknown[]>;
    for (const event of NINE_EVENTS) {
      expect(hooks[event]).toHaveLength(1);
      expect(JSON.stringify(hooks[event])).toContain(secondInstallPath);
      expect(JSON.stringify(hooks[event])).not.toContain(firstInstallPath);
    }
  });

  it("mergeHookConfig run twice with identical inputs is idempotent (no duplicate entries)", () => {
    const once = mergeHookConfig({}, "/repo/.coreartifact/hooks/capture.mjs", "/repo");
    const twice = mergeHookConfig(once, "/repo/.coreartifact/hooks/capture.mjs", "/repo");
    const hooks = twice.hooks as Record<string, unknown[]>;
    for (const event of NINE_EVENTS) {
      expect(hooks[event]).toHaveLength(1);
    }
  });

  it("mergeHookConfig leaves a non-coreartifact entry on one of the nine events alongside the coreartifact one", () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "some-unrelated-linter" }] }],
      },
    };
    const merged = mergeHookConfig(existing, "/repo/.coreartifact/hooks/capture.mjs", "/repo");
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(JSON.stringify(hooks.PreToolUse)).toContain("some-unrelated-linter");
    expect(JSON.stringify(hooks.PreToolUse)).toContain("capture.mjs");
  });
});

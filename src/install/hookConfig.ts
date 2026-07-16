// The hook config `init` merges into `.claude/settings.local.json` — the
// exact nine-event subscription list (docs/issues/ISS-0005.md, 2026-07-14
// amendment) and the merge-not-clobber logic that makes re-running `init`
// idempotent and safe over a pre-existing settings file.
//
// Deliberately does NOT subscribe WorktreeCreate or WorktreeRemove: a
// passive subscription to WorktreeCreate breaks every worktree-isolated
// agent spawn in the repo (docs/recording-pass.md FINDING 1, observed on
// Claude Code 2.1.209) because that event is a delegation hook, not a
// notification.
import { captureInstallBackup } from "./installBackup.js";

export const NINE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
] as const;

// A hook config's "command" is a single shell string (the invocation
// contract src/hook/capture.ts's INIT_ROOT_ARGV_INDEX owns: `node <artifact>
// <initRoot>`, a single positional argv argument) — quote both paths so a
// tmpdir path containing a space or a single quote still round-trips
// through the shell Claude Code spawns the command with.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildHookCommand(hookArtifactPath: string, repoRoot: string): string {
  return `node ${shellQuote(hookArtifactPath)} ${shellQuote(repoRoot)}`;
}

// Recursively hunts a hooks-config subtree for a string referencing the
// installed hook artifact's known filename, exactly the way the acceptance
// test's own `countCoreartifactHookOccurrences` walks it — used here to
// find and replace a coreartifact entry from a prior `init` run without
// assuming a specific nesting for Claude Code's hooks schema.
export function referencesHookArtifact(node: unknown): boolean {
  if (node === undefined || node === null) return false;
  if (typeof node === "string") return node.includes("capture.mjs");
  if (Array.isArray(node)) return node.some(referencesHookArtifact);
  if (typeof node === "object") return Object.values(node as Record<string, unknown>).some(referencesHookArtifact);
  return false;
}

// Re-running `init` must add no duplicate hook entry: strip any existing
// entry that already references the coreartifact artifact (a prior
// install, possibly at a different absolute path if the repo moved) before
// appending the current one — never append a second time.
function mergeEventEntries(existingEntries: unknown, hookCommand: string): unknown[] {
  const entries = Array.isArray(existingEntries) ? existingEntries.filter((entry) => !referencesHookArtifact(entry)) : [];
  entries.push({ matcher: "*", hooks: [{ type: "command", command: hookCommand }] });
  return entries;
}

// Merge, never clobber: every key in `existingSettings` other than `hooks`
// passes through untouched, and within `hooks` every event key other than
// the nine this issue owns passes through untouched too. Only the nine
// event arrays are rewritten (coreartifact entry replaced-or-added).
//
// Exported separately from mergeHookConfig (below) as the PURE half of the
// merge, with no install-backup capture side effect -- uninstall (ISS-0022)
// calls this directly to recompute exactly what init would have written from
// the pre-init snapshot, to tell "untouched since init" (safe to
// byte-restore the snapshot verbatim) apart from "edited since init" (must
// surgically strip only coreartifact's own entries via removeHookConfig
// below, preserving the edit).
export function applyHookConfig(
  existingSettings: Record<string, unknown>,
  hookArtifactPath: string,
  repoRoot: string,
): Record<string, unknown> {
  const hookCommand = buildHookCommand(hookArtifactPath, repoRoot);
  const existingHooksRaw = existingSettings.hooks;
  const existingHooks: Record<string, unknown> =
    existingHooksRaw && typeof existingHooksRaw === "object" && !Array.isArray(existingHooksRaw)
      ? (existingHooksRaw as Record<string, unknown>)
      : {};

  const hooks: Record<string, unknown> = { ...existingHooks };
  for (const event of NINE_EVENTS) {
    hooks[event] = mergeEventEntries(existingHooks[event], hookCommand);
  }

  return { ...existingSettings, hooks };
}

export function mergeHookConfig(
  existingSettings: Record<string, unknown>,
  hookArtifactPath: string,
  repoRoot: string,
): Record<string, unknown> {
  // ISS-0022 (uninstall): capture the pre-write originals of every
  // settings.local.json/.gitignore init is about to touch for repoRoot,
  // before this call's caller (init.ts) writes anything. See
  // installBackup.ts's header for why this is the only legal hook point.
  // No-ops (existsSync guard inside) for the fabricated, nonexistent repo
  // roots this function's own unit tests pass.
  captureInstallBackup(repoRoot);
  return applyHookConfig(existingSettings, hookArtifactPath, repoRoot);
}

// Inverse of applyHookConfig (ISS-0022 uninstall): removes exactly the
// coreartifact hook entries applyHookConfig would have added to
// `currentSettings`, leaving every unrelated top-level key, event key, and
// sibling entry on a shared event untouched -- including entries added to
// `currentSettings` AFTER init ran (e.g. a live session granting itself
// permissions), since this strips against CURRENT bytes, never the pre-init
// snapshot. `preInitSettings` (the repo's settings before init ever touched
// it, `{}` if the file did not exist) decides whether an event key that ends
// up with zero entries is dropped entirely (it did not exist pre-init) or
// kept as `[]` (it existed pre-init, empty or not).
export function removeHookConfig(
  currentSettings: Record<string, unknown>,
  preInitSettings: Record<string, unknown>,
): Record<string, unknown> {
  const currentHooksRaw = currentSettings.hooks;
  if (!currentHooksRaw || typeof currentHooksRaw !== "object" || Array.isArray(currentHooksRaw)) {
    return currentSettings; // no hooks object -- nothing of ours could be here
  }
  const currentHooks = currentHooksRaw as Record<string, unknown>;
  const preInitHooksRaw = preInitSettings.hooks;
  const preInitHooks: Record<string, unknown> =
    preInitHooksRaw && typeof preInitHooksRaw === "object" && !Array.isArray(preInitHooksRaw)
      ? (preInitHooksRaw as Record<string, unknown>)
      : {};

  const hooks: Record<string, unknown> = { ...currentHooks };
  for (const event of NINE_EVENTS) {
    if (!(event in currentHooks)) continue;
    const entries = currentHooks[event];
    if (!Array.isArray(entries)) continue; // not a shape we ever wrote -- leave it alone
    const filtered = entries.filter((entry) => !referencesHookArtifact(entry));
    if (filtered.length === 0 && !(event in preInitHooks)) {
      delete hooks[event];
    } else {
      hooks[event] = filtered;
    }
  }

  const result: Record<string, unknown> = { ...currentSettings };
  if (Object.keys(hooks).length === 0 && !("hooks" in preInitSettings)) {
    delete result.hooks;
  } else {
    result.hooks = hooks;
  }
  return result;
}

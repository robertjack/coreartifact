// Paths — where the spool, ledger, hook artifact and registry live.
//
// The registry root is overridable via a named environment variable so the
// acceptance harness can point a subprocess at a tmpdir registry instead of
// the operator's real home; every later acceptance test depends on this
// variable's name, so it is exported rather than inlined.
//
// @types/node is unreachable in this sandbox (no network, nothing cached).
// A `declare module "node:path"` shim would have to live in a .d.ts file to
// be accepted as a fresh ambient module rather than an augmentation of an
// already-resolvable one — and this issue owns no .d.ts file. So this module
// sidesteps node:os/node:path entirely and hand-rolls the handful of join
// semantics it needs; only `process` (env, cwd) is shadowed, and only as a
// module-local `declare const`, which shapes `process` inside this file
// alone and cannot merge or conflict with the real `NodeJS.Process` global
// if @types/node is later installed.
declare const process: { env: Record<string, string | undefined>; cwd(): string };

export const REGISTRY_ROOT_ENV_VAR = "COREARTIFACT_REGISTRY_ROOT";

export interface Paths {
  spool: string;
  ledger: string;
  hookArtifact: string;
  // The directory the registry lives under. Overridable via
  // REGISTRY_ROOT_ENV_VAR so the acceptance harness can point a
  // subprocess at a tmpdir instead of the operator's real home.
  registryRoot: string;
  // The registry itself: an append-only JSONL log, per schema.md Surface 3
  // and CONTEXT.md. `registryRoot` is a directory, not the log — this field
  // names the log file explicitly so later issues (e.g. ISS-0010) never
  // have to guess the filename.
  registry: string;
  // The operator-state log (ISS-0015): install id, ping consent, last-ping
  // time. It lives under the SAME overridable global root as the registry
  // (registryRoot) — one env override isolates a test subprocess's entire
  // global surface, so this is a sibling file, not a second root.
  state: string;
}

function join(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

function homedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "/";
}

export function getPaths(repoRoot: string = process.cwd()): Paths {
  const dataDir = join(repoRoot, ".coreartifact");
  const override = process.env[REGISTRY_ROOT_ENV_VAR];
  // The registry root is a directory (`~/.coreartifact`), not the log
  // itself — schema.md Surface 3 / CONTEXT.md name the log explicitly as
  // `~/.coreartifact/registry.jsonl`. The env override still controls the
  // root, so a test subprocess pointed at a tmpdir gets both a distinct
  // root and a distinct log path.
  const registryRoot = override && override.length > 0 ? override : join(homedir(), ".coreartifact");

  return {
    spool: join(dataDir, "spool.jsonl"),
    ledger: join(dataDir, "ledger.db"),
    hookArtifact: join(dataDir, "hooks", "capture.mjs"),
    registryRoot,
    registry: join(registryRoot, "registry.jsonl"),
    state: join(registryRoot, "state.jsonl"),
  };
}

import { describe, it, expect, afterEach } from "vitest";
import { getPaths, REGISTRY_ROOT_ENV_VAR } from "../../../src/core/paths.js";

describe("getPaths", () => {
  const previous = process.env[REGISTRY_ROOT_ENV_VAR];

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[REGISTRY_ROOT_ENV_VAR];
    } else {
      process.env[REGISTRY_ROOT_ENV_VAR] = previous;
    }
  });

  it("derives spool, ledger and hook-artifact paths under the given repo root", () => {
    delete process.env[REGISTRY_ROOT_ENV_VAR];
    const paths = getPaths("/tmp/some-repo");
    expect(paths.spool).toBe("/tmp/some-repo/.coreartifact/spool.jsonl");
    expect(paths.ledger).toBe("/tmp/some-repo/.coreartifact/ledger.db");
    expect(paths.hookArtifact).toBe("/tmp/some-repo/.coreartifact/hooks/capture.mjs");
  });

  it("falls back to a default registry root when the env var is unset", () => {
    delete process.env[REGISTRY_ROOT_ENV_VAR];
    const paths = getPaths("/tmp/some-repo");
    expect(paths.registryRoot.length).toBeGreaterThan(0);
  });

  // F3 regression: the registry root previously defaulted to
  // `~/.coreartifact/registry`, which is neither the directory nor the log.
  // schema.md Surface 3 / CONTEXT.md are normative: the registry is an
  // append-only JSONL log at `~/.coreartifact/registry.jsonl`.
  it("defaults the registry root to ~/.coreartifact (not .../registry) and exposes the log path explicitly", () => {
    delete process.env[REGISTRY_ROOT_ENV_VAR];
    const paths = getPaths("/tmp/some-repo");
    expect(paths.registryRoot.endsWith("/.coreartifact")).toBe(true);
    expect(paths.registryRoot.endsWith("/registry")).toBe(false);
    expect(paths.registry).toBe(`${paths.registryRoot}/registry.jsonl`);
  });

  it("uses the env var override verbatim when set, ignoring the repo root", () => {
    process.env[REGISTRY_ROOT_ENV_VAR] = "/tmp/fixture-registry";
    const paths = getPaths("/tmp/some-repo");
    expect(paths.registryRoot).toBe("/tmp/fixture-registry");
  });

  it("derives the registry log path from an overridden registry root too", () => {
    process.env[REGISTRY_ROOT_ENV_VAR] = "/tmp/fixture-registry";
    const paths = getPaths("/tmp/some-repo");
    expect(paths.registry).toBe("/tmp/fixture-registry/registry.jsonl");
  });

  it("derives the state-log path under the same registry root as the registry itself (ISS-0015)", () => {
    delete process.env[REGISTRY_ROOT_ENV_VAR];
    const defaultPaths = getPaths("/tmp/some-repo");
    expect(defaultPaths.state).toBe(`${defaultPaths.registryRoot}/state.jsonl`);

    process.env[REGISTRY_ROOT_ENV_VAR] = "/tmp/fixture-registry";
    const overridden = getPaths("/tmp/some-repo");
    expect(overridden.state).toBe("/tmp/fixture-registry/state.jsonl");
  });

  it("ignores an empty-string override and falls back to the default", () => {
    process.env[REGISTRY_ROOT_ENV_VAR] = "";
    const withEmpty = getPaths("/tmp/some-repo");
    delete process.env[REGISTRY_ROOT_ENV_VAR];
    const withUnset = getPaths("/tmp/some-repo");
    expect(withEmpty.registryRoot).toBe(withUnset.registryRoot);
  });
});

import { describe, test, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODULE_PATH = "../../../src/core/paths";

async function loadPathsModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

describe("ISS-0001 core contracts: paths", () => {
  test("The paths module exposes the spool, ledger, hook-artifact and registry locations, and the registry root is overridable by a named environment variable so a test subprocess never touches the operator's real home.", async () => {
    const mod = await loadPathsModule();
    if (!mod) throw new Error("src/core/paths module not implemented yet");

    const getPaths = mod.getPaths ?? mod.paths ?? mod.default;
    if (typeof getPaths !== "function") {
      throw new Error("src/core/paths does not export a paths accessor (getPaths) yet");
    }

    const before = getPaths();
    expect(typeof before?.spool).toBe("string");
    expect(typeof before?.ledger).toBe("string");
    expect(typeof before?.hookArtifact).toBe("string");
    expect(typeof before?.registryRoot).toBe("string");

    const envVarName: unknown = mod.REGISTRY_ROOT_ENV_VAR ?? mod.REGISTRY_ROOT_ENV;
    if (typeof envVarName !== "string" || envVarName.length === 0) {
      throw new Error(
        "src/core/paths does not name its registry-root override environment variable as an export yet",
      );
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cart-registry-"));
    const previous = process.env[envVarName];
    process.env[envVarName] = tmpRoot;
    try {
      const after = getPaths();
      expect(after?.registryRoot).toBe(tmpRoot);
      expect(after?.registryRoot).not.toBe(os.homedir());
      expect(after?.registryRoot?.startsWith(os.homedir())).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env[envVarName];
      } else {
        process.env[envVarName] = previous;
      }
    }
  });
});

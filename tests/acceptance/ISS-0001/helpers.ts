import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// tests/acceptance/ISS-0001/helpers.ts -> repo root is three levels up.
export const REPO_ROOT = path.resolve(__dirname, "../../..");
export const SRC_CORE = path.join(REPO_ROOT, "src", "core");

export function mkTmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// Dynamic-import a module that may not exist yet. Never throws; callers
// narrow the `undefined` case themselves so a missing module reads as an
// ordinary failing assertion, not a collection-time crash.
export async function tryImport(modulePath: string): Promise<any> {
  try {
    return await import(modulePath);
  } catch {
    return undefined;
  }
}

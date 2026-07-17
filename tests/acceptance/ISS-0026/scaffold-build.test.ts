import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// tests/acceptance/ISS-0026/scaffold-build.test.ts -> repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DIST_WEB = path.join(REPO_ROOT, "dist", "web");
const ASSETS_DIR = path.join(DIST_WEB, "assets");

beforeAll(() => {
  // Run the real build pipeline under test. Until the SPA scaffold and its
  // vite build step exist, this either fails or simply never produces
  // dist/web/ — either way the assertions below observe the true state.
  try {
    execSync("pnpm run build", { cwd: REPO_ROOT, stdio: "pipe" });
  } catch {
    // Swallow: a failing/incomplete build is exactly the red state these
    // criteria are meant to catch — let the file-existence assertions report it.
  }
}, 180_000);

describe("SPA scaffold + build wiring into dist (ISS-0026)", () => {
  it("After pnpm run build, dist/web/index.html exists and is a non-empty HTML document that loads a content-hashed script asset from dist/web/assets/.", () => {
    const indexPath = path.join(DIST_WEB, "index.html");
    expect(existsSync(indexPath)).toBe(true);

    const html = readFileSync(indexPath, "utf-8");
    expect(html.trim().length).toBeGreaterThan(0);
    expect(html).toMatch(/<html[\s>]/i);

    // A content-hashed script asset served from dist/web/assets/, referenced
    // by a relative or absolute path (not asserting the exact hashed name).
    expect(html).toMatch(/<script[^>]+src=["'](?:\.\/)?\/?assets\/[^"']+\.[cm]?js["']/i);
  });

  it("After pnpm run build, at least one content-hashed asset file exists under dist/web/assets/ and the index.html shell references it by its hashed path.", () => {
    expect(existsSync(ASSETS_DIR)).toBe(true);

    const files = readdirSync(ASSETS_DIR);
    // A hashed filename: name-<hash>.ext, where the hash segment is not a
    // fixed literal — never assert today's exact snapshot.
    const hashedAssets = files.filter((f) => /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/i.test(f));
    expect(hashedAssets.length).toBeGreaterThan(0);

    const indexPath = path.join(DIST_WEB, "index.html");
    expect(existsSync(indexPath)).toBe(true);
    const html = readFileSync(indexPath, "utf-8");

    const referencedByShell = hashedAssets.some((f) => html.includes(f));
    expect(referencedByShell).toBe(true);
  });

  it("Every SPA toolchain package including vite, react, and react-dom is declared under devDependencies and none of them under dependencies.", () => {
    const pkgPath = path.join(REPO_ROOT, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const devDependencies = pkg.devDependencies ?? {};
    const dependencies = pkg.dependencies ?? {};

    const spaToolchainPackages = ["vite", "react", "react-dom"];
    for (const name of spaToolchainPackages) {
      expect(devDependencies, `expected devDependencies to declare "${name}"`).toHaveProperty(name);
      expect(dependencies, `expected dependencies to NOT declare "${name}"`).not.toHaveProperty(name);
    }
  });
});

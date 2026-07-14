import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

// Placeholder proving the vitest gate wires src -> tests; PRD-0001 replaces it
// with real acceptance tests.
describe("scaffold", () => {
  it("exposes the package version", () => {
    expect(VERSION).toBe("0.0.0");
  });
});

// Pure unit tests for src/ingest/footprint.ts (docs/issues/ISS-0006.md
// "Below-the-seam unit tests ... footprint set derivation from a list of
// tool events").
import { describe, it, expect } from "vitest";
import { deriveFootprintPaths, extractFootprintPath } from "../../../src/ingest/footprint.js";

describe("extractFootprintPath", () => {
  it("returns the file path for a Write tool event", () => {
    expect(extractFootprintPath({ tool_name: "Write", tool_input: { file_path: "/repo/a.txt" } })).toBe(
      "/repo/a.txt",
    );
  });

  it("returns the file path for Edit, MultiEdit and NotebookEdit (the 'and kin' set)", () => {
    for (const toolName of ["Edit", "MultiEdit", "NotebookEdit"]) {
      expect(extractFootprintPath({ tool_name: toolName, tool_input: { file_path: "/repo/b.txt" } })).toBe(
        "/repo/b.txt",
      );
    }
  });

  it("returns null for a Bash tool event, even one whose command textually writes a file", () => {
    expect(
      extractFootprintPath({ tool_name: "Bash", tool_input: { command: "echo hi > /repo/c.txt" } }),
    ).toBeNull();
  });

  it("returns null for a Read tool event (not a file-editing tool)", () => {
    expect(extractFootprintPath({ tool_name: "Read", tool_input: { file_path: "/repo/d.txt" } })).toBeNull();
  });

  it("returns null when tool_input has no string file_path", () => {
    expect(extractFootprintPath({ tool_name: "Write", tool_input: {} })).toBeNull();
    expect(extractFootprintPath({ tool_name: "Write", tool_input: { file_path: 42 } })).toBeNull();
    expect(extractFootprintPath({ tool_name: "Write" })).toBeNull();
  });

  it("returns null when tool_name is missing or not a string", () => {
    expect(extractFootprintPath({ tool_input: { file_path: "/repo/e.txt" } })).toBeNull();
  });
});

describe("deriveFootprintPaths", () => {
  it("dedupes a path touched by more than one file-editing event into a single row", () => {
    const events = [
      { tool_name: "Write", tool_input: { file_path: "/repo/note.txt" } },
      { tool_name: "Edit", tool_input: { file_path: "/repo/note.txt" } },
    ];
    expect(deriveFootprintPaths(events)).toEqual(["/repo/note.txt"]);
  });

  it("holds distinct rows for distinct paths, and drops Bash-only side effects", () => {
    const events = [
      { tool_name: "Write", tool_input: { file_path: "/repo/a.txt" } },
      { tool_name: "Bash", tool_input: { command: "echo hi > /repo/b.txt" } },
      { tool_name: "Edit", tool_input: { file_path: "/repo/c.txt" } },
    ];
    expect(deriveFootprintPaths(events).sort()).toEqual(["/repo/a.txt", "/repo/c.txt"]);
  });

  it("returns an empty list for no file-editing events", () => {
    expect(deriveFootprintPaths([{ tool_name: "Bash", tool_input: { command: "pwd" } }])).toEqual([]);
    expect(deriveFootprintPaths([])).toEqual([]);
  });
});

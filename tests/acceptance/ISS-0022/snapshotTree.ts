// A full recursive tree capture (relative path -> file bytes), the one
// mechanism ISS-0022's acceptance bar rests on: "byte-identical to its
// pre-init snapshot" (docs/issues/ISS-0022.md). `.git` is excluded wherever
// it appears (a directory in a main checkout, a gitlink FILE in a linked
// worktree) — git manages its own internals independently of coreartifact.
// Everything else, including dotfiles, is captured and compared
// byte-for-byte, never by name or existence alone.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export type TreeSnapshot = Map<string, Buffer>;

export function snapshotTree(root: string): TreeSnapshot {
  const snapshot: TreeSnapshot = new Map();

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        snapshot.set(relative(root, full), readFileSync(full));
      }
    }
  }

  walk(root);
  return snapshot;
}

// Every difference between two snapshots of the same tree, named for
// assertion-failure messages — never just a boolean, so a failing test says
// exactly which path regressed (added, removed, or byte-changed).
export function diffTreeSnapshots(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const diffs: string[] = [];
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  for (const path of allPaths) {
    const beforeBytes = before.get(path);
    const afterBytes = after.get(path);
    if (beforeBytes === undefined && afterBytes !== undefined) {
      diffs.push(`added, absent from the pre-init snapshot: ${path}`);
    } else if (beforeBytes !== undefined && afterBytes === undefined) {
      diffs.push(`missing, present in the pre-init snapshot: ${path}`);
    } else if (beforeBytes && afterBytes && !beforeBytes.equals(afterBytes)) {
      diffs.push(`bytes differ from the pre-init snapshot: ${path}`);
    }
  }
  return diffs;
}

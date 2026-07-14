// ISS-0003's own local copy-point for the acceptance harness, per this
// issue's Test-harness contract: every later issue's tests/acceptance/<ISS>/
// support/harness.ts is a verbatim copy of tests/acceptance/harness/**.
// ISS-0003 is the one issue that can't copy something that doesn't exist yet
// — it's what creates the canonical harness — so this file re-exports it
// in place, from the same source every later copy will contain.
export * from "../../harness/index.js";

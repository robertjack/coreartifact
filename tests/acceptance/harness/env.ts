// The hermetic base environment shared by every subprocess the harness
// spawns — git invocations AND the CLI subprocess (S1a/S2, 2026-07-14
// escalation findings). Built from an ALLOWLIST, never a denylist: the
// first attempt did `{ ...process.env }` then deleted GIT_DIR/GIT_WORK_TREE,
// which still leaks the operator's XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL,
// GIT_COMMON_DIR, GIT_CEILING_DIRECTORIES etc. into every "hermetic" tmpdir
// repo — the exact hazard ISS-0011 already ruled on for src/core/attribution.ts.
// Reuse that ruling's mechanism (scrubbedEnv / ALLOWED_ENV_VARS) rather than
// inventing a second allowlist.
import { scrubbedEnv } from "../../../src/core/attribution.js";

// scrubbedEnv only selects PATH/HOME/XDG_CONFIG_HOME out of whatever is
// passed in — it does not know this caller wants HOME and XDG_CONFIG_HOME
// to point at an ISOLATED tmpdir rather than whatever (possibly hostile)
// values the operator's shell happens to export. Overriding both here after
// scrubbing is what actually severs the harness from the operator's git
// config: a hostile XDG_CONFIG_HOME/HOME in the parent process must never
// reach a child process this function builds an env for.
export function baseHermeticEnv(home: string): NodeJS.ProcessEnv {
  const allowed = scrubbedEnv(process.env as Record<string, string | undefined>);
  return {
    ...allowed,
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
  } as NodeJS.ProcessEnv;
}

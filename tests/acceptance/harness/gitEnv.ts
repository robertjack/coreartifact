// A deterministic, hermetic git environment for the harness's subprocess
// git calls — built from scratch via baseHermeticEnv's allowlist (S1a fix,
// 2026-07-14 escalation), never the operator's real git config, name,
// email, or ambient GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR (which would
// redirect commands into an unrelated repo).
import { baseHermeticEnv } from "./env.js";

export function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...baseHermeticEnv(home),
    GIT_AUTHOR_NAME: "Coreartifact Test",
    GIT_AUTHOR_EMAIL: "test@coreartifact.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Coreartifact Test",
    GIT_COMMITTER_EMAIL: "test@coreartifact.invalid",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    // Belt-and-suspenders: baseHermeticEnv already excludes GIT_DIR/
    // GIT_WORK_TREE/GIT_COMMON_DIR by never copying them in the first
    // place (allowlist, not denylist), and GIT_CONFIG_NOSYSTEM keeps the
    // machine-wide /etc/gitconfig out of the picture too.
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

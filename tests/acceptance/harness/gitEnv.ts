// A deterministic git environment for the harness's subprocess git calls —
// never the operator's real git config, name, email, or ambient GIT_DIR/
// GIT_WORK_TREE (which would redirect commands into an unrelated repo).
export function gitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HOME = home;
  env.GIT_AUTHOR_NAME = "Coreartifact Test";
  env.GIT_AUTHOR_EMAIL = "test@coreartifact.invalid";
  env.GIT_COMMITTER_NAME = "Coreartifact Test";
  env.GIT_COMMITTER_EMAIL = "test@coreartifact.invalid";
  env.GIT_CONFIG_NOSYSTEM = "1";
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

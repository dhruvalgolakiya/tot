/**
 * The environment for git that TOT's server runs on this Mac itself (module 09: merging into the user's
 * folder, keeping copied files out of a worktree's commits). TOT's own environment may carry GIT_*
 * variables from whatever started it (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_*…), which would
 * point git at another repo, index or config than the folder it runs in: they're left out.
 */
export function hostGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return { ...env, ...extra };
}

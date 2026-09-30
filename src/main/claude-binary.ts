import fs from 'node:fs';
import path from 'node:path';

/** Find the `claude` executable on an env's PATH (the shim dir a session env prepends holds only the `orchestra`
 *  CLI, so this lands on the user's real install). Returns null when absent — session callers fall back to the
 *  SDK's bundled default, which only works outside the packaged asar. ONE lookup: the session spawn
 *  (agent-sdk.ts) and the CLI-version watcher (cli-budget-rerun.ts, #211) must agree on which `claude` is "installed". */
export function resolveClaudeBinary(env: Record<string, string | undefined>): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

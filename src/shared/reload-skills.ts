/** Pure logic behind `orchestra reload-skills` — the CLI's flag parsing, the
 *  plugin-reload result classification, and the fan-out summary line.
 *
 *  Lives in `shared/` (Electron-free) for the usual reason: the interesting
 *  decisions here are the ones a live SDK session can't cheaply demonstrate.
 *  Driving a real reload needs the desktop app, an authenticated account and a
 *  running session, so the parts that WOULD silently do the wrong thing — a
 *  misparsed flag, a fan-out that skips sessions, an empty plugin list read as
 *  a failure — are isolated here where `node --test` can pin them.
 */

/** What one workspace's reload attempt did. `skipped` is not a failure: it
 *  means the workspace had no live SDK session to reload, which is the normal
 *  state for most of a 20-workspace sidebar and must not colour the exit code. */
export type ReloadOutcome = 'reloaded' | 'skipped' | 'failed';

/** Per-workspace result of a reload, reported back so the user can see WHICH
 *  sessions picked the new skill up rather than trusting a bare "ok". */
export interface ReloadResult {
  /** Workspace id. */
  id: string;
  /** Branch/name, for a human-readable report line. */
  label: string;
  outcome: ReloadOutcome;
  /** Number of skills the session reported after reloading (`skills.length`).
   *  Absent when the workspace was skipped or the call failed. */
  skills?: number;
  /** Number of plugins reported, when `--plugins` asked for a plugin reload.
   *  ZERO IS A LEGITIMATE VALUE — see {@link isPluginReloadFailure}. */
  plugins?: number;
  /** Failure text, present only when `outcome === 'failed'`. */
  error?: string;
}

/** Parsed form of `orchestra reload-skills [<id>|--all] [--plugins]`. */
export interface ReloadSkillsArgs {
  /** Explicit workspace id, when the caller named one. */
  id?: string;
  /** Fan out to every live session rather than a single workspace. */
  all: boolean;
  /** Also call `reloadPlugins()`, not just `reloadSkills()`. */
  plugins: boolean;
  /** Set when the argv is unusable; the CLI prints this and exits non-zero. */
  error?: string;
}

/** Parse the verb's argv.
 *
 *  Design notes, both learned from the surrounding CLI:
 *  - `--all` and an explicit id are MUTUALLY EXCLUSIVE rather than
 *    "--all wins". Silently ignoring one of two contradictory selectors is how
 *    a user ends up reloading 22 sessions when they meant one (or vice versa),
 *    and neither mistake announces itself.
 *  - An unknown `--flag` is an ERROR, not an ignored token. A typo'd
 *    `--plugin` that parsed as "no plugin reload" would report a clean success
 *    for a reload that never touched plugins — the silent-wrong-thing shape
 *    this repo keeps getting bitten by.
 */
export function parseReloadSkillsArgs(argv: string[]): ReloadSkillsArgs {
  let id: string | undefined;
  let all = false;
  let plugins = false;
  for (const arg of argv) {
    if (arg === '--all') {
      all = true;
    } else if (arg === '--plugins') {
      plugins = true;
    } else if (arg.startsWith('-')) {
      return { all, plugins, error: `unknown flag: ${arg}` };
    } else if (id !== undefined) {
      return { all, plugins, error: `unexpected argument: ${arg}` };
    } else {
      id = arg;
    }
  }
  if (all && id !== undefined) {
    return { id, all, plugins, error: 'pass either <id> or --all, not both' };
  }
  return { id, all, plugins };
}

/** Does a `reloadPlugins()` response indicate a real failure?
 *
 *  NO — an empty `plugins` array is EXPECTED and must never be surfaced as an
 *  error. Measured behaviour: immediately after an out-of-band plugin install,
 *  the first `reloadPlugins()` comes back with `plugins: []` because the
 *  settings file carrying `enabledPlugins` sits behind a ~2s cache in the CLI.
 *  A call issued after that window succeeds; two back-to-back immediate calls
 *  both come back empty. So "no plugins" means either "the cache hadn't
 *  turned over yet" or "this account genuinely enables no plugins" — and
 *  neither is something to shout about. Only a THROWN error is a failure, and
 *  that is handled at the call site.
 *
 *  Exists as a named predicate rather than an inline `false` so the reasoning
 *  has somewhere to live and a test can pin the behaviour against a future
 *  refactor that "helpfully" starts treating empty as broken. */
export function isPluginReloadFailure(_response: { plugins?: unknown[] }): boolean {
  return false;
}

/** Summarize a fan-out into the one line the CLI prints last.
 *
 *  Counts every outcome explicitly — including `skipped` — because a run that
 *  reloaded 0 of 22 workspaces and a run that reloaded 22 must not print the
 *  same thing, and a summary that mentions only successes reads as a clean
 *  pass when nothing happened at all. */
export function summarizeReload(results: ReloadResult[]): string {
  const reloaded = results.filter((r) => r.outcome === 'reloaded').length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  const parts = [`${reloaded} reloaded`];
  if (skipped) parts.push(`${skipped} without a live session`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(', ');
}

/** Exit-code decision for the CLI: only a genuine failure is non-zero.
 *  A fan-out that found nothing to reload is a legitimate outcome (nobody had
 *  a live session), not an error — failing there would make `--all` unusable
 *  in a script that runs whether or not agents happen to be up. */
export function reloadExitCode(results: ReloadResult[]): number {
  return results.some((r) => r.outcome === 'failed') ? 1 : 0;
}

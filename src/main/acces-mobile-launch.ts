// Accès mobile (#375/#376): launch a workspace from the phone. Electron-free (the spawn path is injected), so node --test drives the
// REAL guards. Served only on the private fd-3 channel (acces-mobile-routes.ts) — never the hooks socket: a launch is a human act that
// starts an agent in bypassPermissions.
//   · the repo must be REGISTERED (exact path) — nothing is created for anything else;
//   · the prompt is required;
//   · a repeat of a request id inside MOBILE_LAUNCH_REPEAT_WINDOW_MS is the SAME launch: one workspace, the same answer (#376 — the
//     entry is recorded in the tick of the lookup, so a double tap whose first request is still creating shares its promise).

import { MOBILE_LAUNCH_REPEAT_WINDOW_MS, parseMobileLaunch } from '../shared/acces-mobile-launch.ts';

/** What the human-click spawn path (dispatchSpawnRequest) tells back — the fields this module reads. */
export interface MobileSpawnResult {
  ok: boolean;
  id?: string;
  branch?: string;
  error?: string;
  note?: string;
  startError?: string;
}

export interface MobileLauncherDeps {
  repos: () => readonly { path: string }[];
  /** Create the workspace + deliver `task` as the agent's first message. THE desktop-click path: human defaults, top-level. */
  spawn: (input: { repoPath: string; task: string }) => Promise<MobileSpawnResult>;
  now?: () => number;
  info?: (line: string) => void;
}

/** `code` is what the phone words in French; `error` is the raw detail (logs, tests). `id` on a failure = the workspace was KEPT. */
export type MobileLaunchOutcome =
  | { ok: true; id: string; branch?: string; note?: string }
  | { ok: false; code: 'bad-request' | 'unknown-repo' | 'request-reused' | 'create-failed' | 'start-failed'; error: string; id?: string; branch?: string };

/** Hard bound on the repeat table (the server's 10/min cap keeps it far below this; main does not rely on that). */
const MAX_REMEMBERED = 256;

export function createMobileLauncher(deps: MobileLauncherDeps): { launch(raw: unknown): Promise<MobileLaunchOutcome> } {
  const now = deps.now ?? Date.now;
  const seen = new Map<string, { fingerprint: string; at: number; settled: boolean; outcome: Promise<MobileLaunchOutcome> }>();

  function prune(t: number): void {
    for (const [k, e] of seen) if (t - e.at >= MOBILE_LAUNCH_REPEAT_WINDOW_MS) seen.delete(k);
    while (seen.size >= MAX_REMEMBERED) {
      const oldestSettled = [...seen].find(([, e]) => e.settled)?.[0];
      if (oldestSettled === undefined) break;
      seen.delete(oldestSettled);
    }
  }

  async function create(repoPath: string, prompt: string): Promise<MobileLaunchOutcome> {
    let res: MobileSpawnResult;
    try {
      res = await deps.spawn({ repoPath, task: prompt });
    } catch (e) {
      return { ok: false, code: 'create-failed', error: e instanceof Error ? e.message : String(e) };
    }
    if (res.id && res.ok) {
      deps.info?.(`mobile launch: workspace ${res.id} created in ${repoPath.split('/').pop()} (${prompt.length} chars)`);
      return { ok: true, id: res.id, ...(res.branch ? { branch: res.branch } : {}), ...(res.note ? { note: res.note } : {}) };
    }
    if (res.id) return { ok: false, code: 'start-failed', id: res.id, ...(res.branch ? { branch: res.branch } : {}), error: res.startError ?? res.error ?? 'the agent failed to start' };
    return { ok: false, code: 'create-failed', error: res.error ?? 'could not create the workspace' };
  }

  return {
    launch(raw) {
      const parsed = parseMobileLaunch(raw);
      if (!parsed.ok) return Promise.resolve({ ok: false, code: 'bad-request', error: parsed.error });
      const { repoPath, prompt, requestId } = parsed.launch;
      const t = now();
      prune(t);
      const fingerprint = `${repoPath}\0${prompt}`;
      const prior = seen.get(requestId);
      if (prior) {
        // The same launch again ⇒ the same answer. The same id carrying ANOTHER launch is a client bug: never answer with a workspace that is not its own.
        if (prior.fingerprint === fingerprint) return prior.outcome;
        return Promise.resolve({ ok: false, code: 'request-reused', error: 'this request id already carried another launch' });
      }
      if (!deps.repos().some((r) => r.path === repoPath)) return Promise.resolve({ ok: false, code: 'unknown-repo', error: 'unknown repo' });
      const entry = { fingerprint, at: t, settled: false, outcome: create(repoPath, prompt) };
      seen.set(requestId, entry);
      // A launch that created NOTHING is retryable under the same id; one that created (or kept) a workspace stays answered with it.
      void entry.outcome.then((o) => {
        entry.settled = true;
        if (!o.ok && !o.id && seen.get(requestId) === entry) seen.delete(requestId);
      });
      return entry.outcome;
    },
  };
}

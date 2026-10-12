// Accès mobile (#375): launch a workspace from the phone. Electron-free (the spawn path is injected), so node --test drives the
// REAL guards. Served only on the private fd-3 channel (acces-mobile-routes.ts) — never the hooks socket: a launch is a human act that
// starts an agent in bypassPermissions.
//   · the repo must be REGISTERED (exact path) — nothing is created for anything else;
//   · the prompt is required.

import { parseMobileLaunch } from '../shared/acces-mobile-launch.ts';

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
  info?: (line: string) => void;
}

/** `code` is what the phone words in French; `error` is the raw detail (logs, tests). `id` on a failure = the workspace was KEPT. */
export type MobileLaunchOutcome =
  | { ok: true; id: string; branch?: string; note?: string }
  | { ok: false; code: 'bad-request' | 'unknown-repo' | 'create-failed' | 'start-failed'; error: string; id?: string; branch?: string };

export function createMobileLauncher(deps: MobileLauncherDeps): { launch(raw: unknown): Promise<MobileLaunchOutcome> } {
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
      const { repoPath, prompt } = parsed.launch;
      if (!deps.repos().some((r) => r.path === repoPath)) return Promise.resolve({ ok: false, code: 'unknown-repo', error: 'unknown repo' });
      return create(repoPath, prompt);
    },
  };
}

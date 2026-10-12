// Accès mobile (#375): launching a workspace from the phone — the repo list and the request's shape.
// Pure (no fs / Electron): the phone server (the network-facing process), main and node --test share ONE definition.

import { resolveWorkspaceAccountId, type Account } from './accounts.ts';
import type { RepoEntry } from './types.ts';

/** The first prompt typed on the phone: 1–this many characters (the same bound as a message, MOBILE_SEND_MAX_CHARS). */
export const MOBILE_LAUNCH_MAX_PROMPT = 32_000;
/** A registered repo's absolute path is far below this; anything longer is not one. */
export const MOBILE_LAUNCH_MAX_PATH = 4096;
/** Creating the worktree + the agent's first turn can take ~25 s: the server waits this long on main. */
export const MOBILE_LAUNCH_TIMEOUT_MS = 60_000;

export interface MobileRepoRow {
  path: string;
  name: string;
  /** Compte label, or "default" (same rule as a workspace row). */
  account: string;
}

/** The repos the phone may launch in: every registered repo, every Compte, sorted by name. The Compte is the repo's own. */
export function projectMobileRepos(repos: readonly RepoEntry[], accounts: readonly Account[]): MobileRepoRow[] {
  const known = new Set(accounts.map((a) => a.id));
  const labelOf = new Map(accounts.map((a) => [a.id, a.label]));
  return repos
    .map((r): MobileRepoRow => {
      const id = resolveWorkspaceAccountId(r.accountId, known);
      return { path: r.path, name: r.name, account: id ? (labelOf.get(id) ?? id) : 'default' };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export interface MobileLaunchRequest {
  repoPath: string;
  /** Trimmed, 1..MOBILE_LAUNCH_MAX_PROMPT characters. */
  prompt: string;
}

/** The phone's launch body. Run by the server (shape) AND by main (before anything is created). A prompt is REQUIRED: a tap must
 *  never create an idle workspace (#371 story 5). Extra keys (a model, a branch, a Compte) are ignored — D1: none of them is a choice. */
export function parseMobileLaunch(raw: unknown): { ok: true; launch: MobileLaunchRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'launch must be an object' };
  const b = raw as Record<string, unknown>;
  const repoPath = b.repoPath;
  if (typeof repoPath !== 'string' || !repoPath || repoPath.length > MOBILE_LAUNCH_MAX_PATH || repoPath.includes('\0')) return { ok: false, error: 'repoPath is required' };
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt || prompt.length > MOBILE_LAUNCH_MAX_PROMPT) return { ok: false, error: `prompt must be 1–${MOBILE_LAUNCH_MAX_PROMPT} characters` };
  return { ok: true, launch: { repoPath, prompt } };
}

/** What the launch form says — in French — for whatever came back: `status` is the HTTP status (null = the request itself failed: no
 *  network), `body` the parsed JSON (or null). `open` = the id of a workspace that EXISTS although the agent did not start (offer it);
 *  `repair` = the token is refused (offer pairing). ONE self-contained function: launch.ts injects `mobileLaunchFailure.toString()`
 *  into the phone script — nothing outside its own body may be referenced. Only a refusal main decided says « aucun workspace »:
 *  a lost reply may hide a launch that happened, and says so. */
export function mobileLaunchFailure(status: number | null, body: unknown): { text: string; open?: string; repair?: boolean } {
  const lost = 'Vérifie la liste avant de réessayer.';
  if (status === null) return { text: 'Réseau coupé : le workspace est peut-être créé. ' + lost };
  if (status === 401) return { text: 'Jeton refusé : re-scanne le QR code.', repair: true };
  if (status === 429) return { text: 'Trop de lancements en cours : réessaie dans un instant. Aucun workspace n’a été créé.' };
  if (status >= 500) return { text: 'Orchestra injoignable : le workspace est peut-être créé. ' + lost };
  if (status !== 200) return { text: 'Refusé (' + status + '). Aucun workspace n’a été créé.' };
  const b = (body && typeof body === 'object' ? body : {}) as { code?: unknown; error?: unknown; id?: unknown };
  const detail = typeof b.error === 'string' ? (b.error.length > 200 ? b.error.slice(0, 200) + '…' : b.error) : '';
  if (b.code === 'unknown-repo') return { text: 'Dépôt inconnu : aucun workspace n’a été créé.' };
  if (b.code === 'create-failed') return { text: 'Création impossible' + (detail ? ' : ' + detail : '') + '. Aucun workspace n’a été créé.' };
  if (b.code === 'start-failed') {
    const text = 'L’agent n’a pas démarré' + (detail ? ' : ' + detail : '') + '. Le workspace existe sur le bureau, sa tâche l’attend (Restart l’y relance).';
    return typeof b.id === 'string' && b.id ? { text, open: b.id } : { text };
  }
  return { text: 'Échec du lancement' + (detail ? ' : ' + detail : '') + '.' };
}

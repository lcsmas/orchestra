// Accès mobile (#333/#334, ADR 0006): the settings, the phone's workspace-list projection, and the one-time `tailscale serve`
// command. Pure — no fs/Electron — so node --test drives it and the renderer, main and the server process share one definition.

import { resolveWorkspaceAccountId, type Account } from './accounts.ts';
import type { RepoEntry, Workspace, WorkspaceStatus } from './types.ts';

export interface AccesMobileSettings {
  /** Off by default: nothing listens for the phone unless the human turned it on. */
  enabled: boolean;
  /** HTTPS port `tailscale serve` exposes on the tailnet (only used to print the command and the pairing URL). */
  servePort: number;
  /** The ONLY Tailscale login allowed in (`Tailscale-User-Login`). Empty ⇒ every request is refused (fail closed). */
  allowedLogin: string;
}

export const DEFAULT_ACCES_MOBILE_SETTINGS: AccesMobileSettings = {
  enabled: false,
  servePort: 8445,
  allowedLogin: '',
};

function validPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535;
}

/** Store value → settings; anything malformed falls back to the default (and so to OFF). */
export function normalizeAccesMobileSettings(raw: Partial<AccesMobileSettings> | undefined | null): AccesMobileSettings {
  const d = DEFAULT_ACCES_MOBILE_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  return {
    enabled: raw.enabled === true,
    servePort: validPort(raw.servePort) ? raw.servePort : d.servePort,
    allowedLogin: typeof raw.allowedLogin === 'string' ? raw.allowedLogin.trim() : d.allowedLogin,
  };
}

export type AccesMobilePatchResult = { ok: true; settings: AccesMobileSettings } | { ok: false; error: string };

/** Validate a Settings patch. An invalid patch writes nothing. Enabling without a login is refused (it would refuse everything). */
export function patchAccesMobileSettings(current: AccesMobileSettings, patch: Partial<AccesMobileSettings>): AccesMobilePatchResult {
  const next: AccesMobileSettings = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  if (patch.servePort !== undefined) {
    if (!validPort(patch.servePort)) return { ok: false, error: 'tailnet port must be an integer between 1024 and 65535' };
    next.servePort = patch.servePort;
  }
  if (patch.allowedLogin !== undefined) {
    const login = String(patch.allowedLogin).trim();
    if (login !== '' && !/^[^\s@]+@[^\s@]*$/.test(login)) return { ok: false, error: 'Tailscale login looks like name@domain (see `tailscale whoami`)' };
    next.allowedLogin = login;
  }
  if (next.enabled && next.allowedLogin === '') return { ok: false, error: 'set your Tailscale login before turning Accès mobile on' };
  return { ok: true, settings: next };
}

/** Server process health as main sees it. `listening` only after the process printed its bound port. */
export type AccesMobileHealth =
  | { state: 'off' }
  | { state: 'starting'; pid?: number }
  | { state: 'listening'; pid: number; socketPath: string }
  | { state: 'failed'; error: string; retryInMs: number | null };

export interface AccesMobileView {
  settings: AccesMobileSettings;
  health: AccesMobileHealth;
  serveCommand: string;
  /** The Unix socket the server listens on (0600) — the `tailscale serve` target. */
  socketPath: string;
  /** `#t=<token>` — appended to the tailnet URL to pair the phone. null when no token exists yet (never enabled). */
  pairingFragment: string | null;
}

export type AccesMobileSetResult = { ok: true; view: AccesMobileView } | { ok: false; error: string; view: AccesMobileView };

/** The command the human runs ONCE by hand — Orchestra never runs `tailscale` itself (ADR 0006). The target is the server's
 *  0600 Unix socket, never a TCP port: any local process can take a free loopback port and harvest the phone's token (#334 review). */
export function tailscaleServeCommand(socketPath: string, servePort: number): string {
  // `sudo`: tailscaled refuses a Unix-socket target from a mere operator (« must be root … to serve a path or Unix socket », 1.98.9).
  return `sudo tailscale serve --bg --https=${servePort} unix:${socketPath}`;
}

/** Where the server listens: a stable path (the serve config outlives restarts), keyed on ORCHESTRA_HOME like the hooks socket, in
 *  the per-user 0700 runtime dir. `homeHash` = first 12 hex of sha256(ORCHESTRA_HOME). */
export function accesMobileSocketPath(runtimeDir: string, homeHash: string): string {
  return `${runtimeDir.replace(/\/+$/, '')}/orchestra-acces-mobile-${homeHash}.sock`;
}

/** Login comparison: Tailscale logins are e-mail-like; case never distinguishes two people. */
export function sameLogin(a: string | undefined | null, b: string): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---------- the phone's workspace list ----------

export interface MobileWorkspaceRow {
  id: string;
  name: string;
  branch: string;
  /** Sidebar-style group: the repo's name, else "Orchestrators". */
  group: string;
  /** Account label, or "default" for the default login. */
  account: string;
  status: WorkspaceStatus;
  /** Non lu: the turn finished while the human was not looking (the bell). */
  unread: boolean;
  statusText?: string;
}

export interface MobileWorkspaceList {
  ok: true;
  workspaces: MobileWorkspaceRow[];
}

/** Rank inside the list: en attente (blocked on the human) first, then non lu, then the rest. */
export function attentionRank(row: Pick<MobileWorkspaceRow, 'status' | 'unread'>): number {
  if (row.status === 'waiting') return 0;
  if (row.unread) return 1;
  return 2;
}

const ORCHESTRATORS_GROUP = 'Orchestrators';

/** Every non-archived workspace, every account. Sorted by attention, then group, then name — stable for the phone to render. */
export function projectMobileWorkspaces(
  workspaces: readonly Workspace[],
  repos: readonly RepoEntry[],
  accounts: readonly Account[],
): MobileWorkspaceRow[] {
  const repoByPath = new Map(repos.map((r) => [r.path, r]));
  const known = new Set(accounts.map((a) => a.id));
  const labelOf = new Map(accounts.map((a) => [a.id, a.label]));
  const rows: MobileWorkspaceRow[] = [];
  for (const ws of workspaces) {
    if (ws.archived) continue;
    const repo = repoByPath.get(ws.repoPath) ?? (ws.repoAssociation ? repoByPath.get(ws.repoAssociation) : undefined);
    const accountId = resolveWorkspaceAccountId(ws.accountId ?? repoByPath.get(ws.repoPath)?.accountId, known);
    const row: MobileWorkspaceRow = {
      id: ws.id,
      name: ws.name,
      branch: ws.branch,
      group: repo?.name ?? ORCHESTRATORS_GROUP,
      account: accountId ? (labelOf.get(accountId) ?? accountId) : 'default',
      status: ws.status,
      unread: ws.autoUnread === true,
    };
    if (ws.statusText) row.statusText = ws.statusText;
    rows.push(row);
  }
  return rows.sort(
    (a, b) => attentionRank(a) - attentionRank(b) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

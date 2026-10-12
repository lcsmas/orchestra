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
  /** This machine's MagicDNS name on the tailnet (`tailscale status --json` → `Self.DNSName`), typed ONCE by the human — Orchestra
   *  never runs `tailscale` to find it (ADR 0006). Empty ⇒ no pairing URL, no QR code. */
  tailnetHost: string;
}

export const DEFAULT_ACCES_MOBILE_SETTINGS: AccesMobileSettings = {
  enabled: false,
  servePort: 8445,
  allowedLogin: '',
  tailnetHost: '',
};

function validPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A MagicDNS host as the human pastes it (`Self.DNSName` ends with a dot): lower-cased, trailing dot dropped. null when it cannot be a
 *  tailnet HTTPS name: no scheme/port/path/space, ≥ 2 labels, numeric TLD refused (an IP has no certificate). */
export function normalizeTailnetHost(raw: string): string | null {
  const h = raw.trim().replace(/\.$/, '').toLowerCase();
  if (h.length === 0 || h.length > 253) return null;
  const labels = h.split('.');
  if (labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;
  return h;
}

/** The token shape the phone page reads from `#t=` (page.ts) and the server accepts in `Authorization` (server.ts). */
const PAIRING_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/** The one URL the phone opens: the token rides in the FRAGMENT only — a fragment is never sent in a request line, so no server,
 *  proxy or log ever sees it. null until a host and a well-formed token exist. */
export function pairingUrl(host: string, servePort: number, token: string | null | undefined): string | null {
  if (!host || !token || !PAIRING_TOKEN.test(token)) return null;
  return `https://${host}:${servePort}/#t=${token}`;
}

/** Store value → settings; anything malformed falls back to the default (and so to OFF). */
export function normalizeAccesMobileSettings(raw: Partial<AccesMobileSettings> | undefined | null): AccesMobileSettings {
  const d = DEFAULT_ACCES_MOBILE_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  return {
    enabled: raw.enabled === true,
    servePort: validPort(raw.servePort) ? raw.servePort : d.servePort,
    allowedLogin: typeof raw.allowedLogin === 'string' ? raw.allowedLogin.trim() : d.allowedLogin,
    tailnetHost: typeof raw.tailnetHost === 'string' ? (normalizeTailnetHost(raw.tailnetHost) ?? d.tailnetHost) : d.tailnetHost,
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
  if (patch.tailnetHost !== undefined) {
    const raw = String(patch.tailnetHost).trim();
    const host = raw === '' ? '' : normalizeTailnetHost(raw);
    if (host === null) return { ok: false, error: 'tailnet host looks like my-machine.tailnet-name.ts.net (`tailscale status --json` → Self.DNSName)' };
    next.tailnetHost = host;
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
  /** `https://<tailnetHost>:<servePort>/#t=<token>` — what the QR code encodes. null without a host or a token. */
  pairingUrl: string | null;
}

export type AccesMobileSetResult = { ok: true; view: AccesMobileView } | { ok: false; error: string; view: AccesMobileView };

/** The command the human runs ONCE by hand — Orchestra never runs `tailscale` itself (ADR 0006). The target is the server's
 *  0600 Unix socket, never a TCP port: any local process can take a free loopback port and harvest the phone's token (#334 review). */
export function tailscaleServeCommand(socketPath: string, servePort: number): string {
  // `sudo`: tailscaled refuses a Unix-socket target from a mere operator (« must be root … to serve a path or Unix socket », 1.98.9).
  return `sudo tailscale serve --bg --https=${servePort} unix:${socketPath}`;
}

/** Linux: exec the server through `bash -c` after closing every inherited fd above stderr. Electron/Chromium leaves some of its
 *  own sockets without CLOEXEC — the e2e rig caught the server holding main's DevTools LISTEN socket — and the network-facing
 *  process must hold nothing of main's — except fd 3, the private channel main hands it on purpose (#338 review M1).
 *  Usage: bash -c CLOSE_INHERITED_FDS <label> <runtime> <script>. */
export const CLOSE_INHERITED_FDS = 'shopt -s nullglob; for f in /proc/$$/fd/*; do n=${f##*/}; if [ "$n" -gt 3 ]; then eval "exec $n>&-"; fi; done; exec "$@"';

/** The directory for the socket: $XDG_RUNTIME_DIR only when it is a directory OURS and closed to others (0700), else `fallback`
 *  (our own 0700 dir). A runtime dir we do not own could let its owner swap the socket. */
export function pickSocketDir(
  runtimeDir: string | undefined,
  stat: (p: string) => { isDirectory(): boolean; uid: number; mode: number },
  uid: number,
  fallback: string,
): string {
  if (!runtimeDir || !runtimeDir.startsWith('/')) return fallback;
  try {
    const st = stat(runtimeDir);
    if (st.isDirectory() && st.uid === uid && (st.mode & 0o077) === 0) return runtimeDir;
  } catch {
    /* missing ⇒ fallback */
  }
  return fallback;
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
  /** The desktop name, unchanged (`<repo> · <branch>`). */
  name: string;
  /** #372: what the phone shows as the title — `name` without its `<repo basename> · ` / `scratch · ` / `orchestrator · ` prefix. */
  displayName: string;
  branch: string;
  /** Sidebar-style group: the repo's name, else "Orchestrators". */
  group: string;
  /** Account label, or "default" for the default login. */
  account: string;
  status: WorkspaceStatus;
  /** Non lu: the turn finished while the human was not looking (the bell). */
  unread: boolean;
  statusText?: string;
  /** Last activity (ms): the latest of turn start / stop / status note / creation. */
  at: number;
  /** The coordinator this workspace runs under (a fleet worker): its nearest LISTED ancestor — archived / unlisted parents are walked
   *  through (#373) — so the phone can fold the whole tree, at any depth (Lucas, 2026-10-12). Absent ⇒ a root. */
  parentId?: string;
  /** #340 (design V1): one line under the row — the question it is blocked on, else the agent's status note. */
  preview?: { kind: 'question' | 'desktop' | 'status'; text: string };
}

export type PreviewOf = (ws: Workspace) => MobileWorkspaceRow['preview'] | undefined;

export interface MobileWorkspaceList {
  ok: true;
  workspaces: MobileWorkspaceRow[];
  /** A newer Orchestra is installed on the computer (the running one keeps the old code until relaunched) — the phone says so. */
  appUpdate?: { version: string | null };
}

/** Rank inside the list: en attente (blocked on the human) first, then non lu, then the rest. */
export function attentionRank(row: Pick<MobileWorkspaceRow, 'status' | 'unread'>): number {
  if (row.status === 'waiting') return 0;
  if (row.unread) return 1;
  return 2;
}

const ORCHESTRATORS_GROUP = 'Orchestrators';

/** #372: the phone row's title. The desktop name is `<repo basename> · <branch>`, `scratch · <label>` or `orchestrator · <label>`
 *  (`workspace-name.ts`); the row already sits under its repo's section, so the prefix is noise on a phone. One LEADING prefix is
 *  cut — the repo's FIRST, so a repo whose name contains « · » loses all of it. A name without the prefix (renamed by hand), or
 *  one the cut would leave empty, is shown whole. */
export function mobileDisplayName(ws: Pick<Workspace, 'name' | 'repoPath'>): string {
  const base = ws.repoPath ? ws.repoPath.replace(/\/+$/, '').split('/').pop() : '';
  for (const prefix of [...(base ? [`${base} · `] : []), 'scratch · ', 'orchestrator · ']) {
    if (ws.name.startsWith(prefix) && ws.name.length > prefix.length) return ws.name.slice(prefix.length);
  }
  return ws.name;
}

/** Every non-archived workspace, every account. Sorted by attention, then group, then the title the phone shows (displayName) — stable for the phone to render. */
export function projectMobileWorkspaces(
  workspaces: readonly Workspace[],
  repos: readonly RepoEntry[],
  accounts: readonly Account[],
  previewOf?: PreviewOf,
): MobileWorkspaceRow[] {
  const repoByPath = new Map(repos.map((r) => [r.path, r]));
  const known = new Set(accounts.map((a) => a.id));
  const labelOf = new Map(accounts.map((a) => [a.id, a.label]));
  const rows: MobileWorkspaceRow[] = [];
  const listed = new Set(workspaces.filter((w) => !w.archived).map((w) => w.id));
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const resolved = new Map<string, string | undefined>(); // unlisted id ⇒ the first listed row at or above it (memoised: O(rows) overall)
  /** The first LISTED row on the parent chain starting AT `start`; undefined when the chain ends or loops among unlisted rows. */
  const firstListed = (start: string | undefined): string | undefined => {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur = start;
    let answer: string | undefined;
    for (;;) {
      if (!cur) break;
      if (listed.has(cur)) { answer = cur; break; }
      if (resolved.has(cur)) { answer = resolved.get(cur); break; }
      if (onPath.has(cur)) break;
      onPath.add(cur);
      path.push(cur);
      cur = byId.get(cur)?.parentId;
    }
    for (const id of path) resolved.set(id, answer);
    return answer;
  };
  /** #373: a row's parent is its nearest LISTED ancestor — the walk goes up through archived / unlisted parents; none listed ⇒ a root.
   *  A chain that comes back to the row itself is no ancestor (the page's tree module breaks any cycle of LISTED rows). */
  const listedAncestor = (ws: Workspace): string | undefined => {
    const a = firstListed(ws.parentId);
    return a === ws.id ? undefined : a;
  };
  for (const ws of workspaces) {
    if (ws.archived) continue;
    const repo = repoByPath.get(ws.repoPath) ?? (ws.repoAssociation ? repoByPath.get(ws.repoAssociation) : undefined);
    const accountId = resolveWorkspaceAccountId(ws.accountId ?? repoByPath.get(ws.repoPath)?.accountId, known);
    const row: MobileWorkspaceRow = {
      id: ws.id,
      name: ws.name,
      displayName: mobileDisplayName(ws),
      branch: ws.branch,
      group: repo?.name ?? ORCHESTRATORS_GROUP,
      account: accountId ? (labelOf.get(accountId) ?? accountId) : 'default',
      status: ws.status,
      unread: ws.autoUnread === true,
      at: Math.max(ws.createdAt ?? 0, ws.lastTurnStartAt ?? 0, ws.lastStopReasonAt ?? 0, ws.statusTextAt ?? 0),
    };
    if (ws.statusText) row.statusText = ws.statusText;
    const parentId = listedAncestor(ws);
    if (parentId) row.parentId = parentId;
    const pv = previewOf?.(ws) ?? (ws.statusText ? { kind: 'status' as const, text: ws.statusText } : undefined);
    if (pv) row.preview = { kind: pv.kind, text: pv.text.length > 300 ? pv.text.slice(0, 300) + '…' : pv.text };
    rows.push(row);
  }
  return rows.sort(
    (a, b) =>
      attentionRank(a) - attentionRank(b) || a.group.localeCompare(b.group) || a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/** The pairing token in what the phone scanned or pasted: a pairing URL (`…#t=<token>`) or the bare token; null otherwise.
 *  ONE self-contained function: page.ts injects `pairingTokenFrom.toString()` into the phone script. */
export function pairingTokenFrom(text: string): string | null {
  const s = String(text == null ? '' : text).trim();
  const m = /[#&]t=([A-Za-z0-9_-]{16,256})(?:&|$)/.exec(s) || /^([A-Za-z0-9_-]{16,256})$/.exec(s);
  return m ? m[1] : null;
}

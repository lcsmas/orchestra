// Browser Reliquats — the bridge until the member scope is ON (#331, wave H ledger #329 track H10; parent #319). PURE: no fs, no signals — the decisions
// src/main/browser-reliquats.ts applies from the 60 s resource-monitor pass and from every Pause dure.
//
// On 2026-10-08 56 headless Chromium (~15 GB) left by a rig's browser launcher survived for hours: reparented to init, so no tree walk reached them. A process is a
// BROWSER RELIQUAT when ALL of these hold:
//   - it is a Chromium/Chrome browser MAIN process (no `--type=`);
//   - it is headless or remote-controlled (`--headless`, `--remote-debugging-port`, `--remote-debugging-pipe`);
//   - its launcher is dead (parent is init, or the user manager that adopts orphans);
//   - its `--user-data-dir` lies under `<agent-tmp>/<ws-id>/` of a workspace we know — that attributes it to that member.
// Stopped: in PIPE mode at once (the pipe died with its parent: nobody can ever drive it again); in PORT mode (or headless with no controller at all) after
// {@link BROWSER_IDLE_WINDOW_MS} with no client connected to its debugging port. A browser whose client state cannot be read is NEVER stopped (UNKNOWN is not NONE).

import path from 'node:path';

/** N: a port-mode orphan must have shown no client for this long before it is stopped. */
export const BROWSER_IDLE_WINDOW_MS = 10 * 60_000;

/** Executable base names of a Chromium-family browser (the kernel `comm` is the first 15 chars of the same name). */
const BROWSER_EXE = /^(chromium(-browser)?|chrome|google-chrome(-stable)?|chrome-headless-shell|headless_shell)$/;
const BROWSER_COMM = /^(chromium(-browser)?|chrome|google-chrome(-sta)?|chrome-headless|headless_shell)/;

/** Cheap pre-filter on the process table's `comm` (no /proc/<pid>/cmdline read for the other 99 % of processes). */
export function isBrowserComm(comm: string): boolean {
  return BROWSER_COMM.test(comm);
}

export type BrowserMode = 'pipe' | 'port' | 'headless';

export interface BrowserArgv {
  mode: BrowserMode;
  /** The `--remote-debugging-port` value (0 = the browser picks one); null when the flag is absent. */
  port: number | null;
  userDataDir: string | null;
}

/**
 * A Chromium MAIN process started from an ordinary session environment (DBUS_SESSION_BUS_ADDRESS set — the environment of every uncapped member, the very target of this bridge) rewrites its own
 * title: `/proc/<pid>/cmdline` is then ONE NUL-free string, `"/usr/bin/chromium-browser --headless=new --remote-debugging-port=0 --user-data-dir=/p about:blank"`. Recover the tokens by splitting on a
 * space that begins a flag; a value that contains a space keeps it unless the next word starts with `--`; the two-word spelling `--flag value` is folded to `--flag=value` for the two flags we read.
 */
export function normalizeArgv(argv: readonly string[]): string[] {
  if (argv.length !== 1 || !argv[0].includes(' --')) return [...argv];
  const toks = argv[0].split(/ (?=--)/).map((t) => t.replace(/^(--(?:remote-debugging-port|user-data-dir)) (.+)$/, '$1=$2'));
  // trailing positional URLs (`about:blank`, `https://…`) follow the last flag after a plain space: peel them off so they do not become part of its value
  const tail: string[] = [];
  for (let m = /^(.*\S) ([a-z][a-z0-9+.-]*:\S*)$/.exec(toks[toks.length - 1]); m; m = /^(.*\S) ([a-z][a-z0-9+.-]*:\S*)$/.exec(toks[toks.length - 1])) {
    toks[toks.length - 1] = m[1];
    tail.unshift(m[2]);
  }
  return [...toks, ...tail];
}

/**
 * Parse a browser's argv. null = NOT a browser main process we handle: another executable, a child (`--type=renderer|gpu|zygote|utility|crashpad-handler`…),
 * or a browser that is neither headless nor remote-controlled (the human's own window).
 */
export function parseBrowserArgv(rawArgv: readonly string[], procExe?: string | null): BrowserArgv | null {
  const argv = normalizeArgv(rawArgv);
  if (argv.length === 0) return null;
  // the executable is what /proc/<pid>/exe says when it can be read (a title-rewritten or `exec -a` argv[0] is not evidence); otherwise argv[0]
  const exe = path.posix.basename(procExe ? procExe.replace(/ \(deleted\)$/, '') : argv[0]);
  if (!BROWSER_EXE.test(exe)) return null;
  let headless = false;
  let pipe = false;
  let port: number | null = null;
  let userDataDir: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--type=')) return null; // a child process (renderer, gpu, zygote, utility, crashpad): never the main browser
    if (a === '--headless' || a.startsWith('--headless=')) headless = true;
    else if (a === '--remote-debugging-pipe' || a.startsWith('--remote-debugging-pipe=')) pipe = true;
    else if (a.startsWith('--remote-debugging-port=')) {
      const n = Number(a.slice('--remote-debugging-port='.length));
      port = Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;
      if (port === null) return null; // a malformed flag: not something we can reason about
    } else if (a === '--remote-debugging-port') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) return null;
      port = n;
      i++;
    } else if (a.startsWith('--user-data-dir=')) userDataDir = a.slice('--user-data-dir='.length);
    else if (a === '--user-data-dir') {
      userDataDir = argv[i + 1] ?? null;
      i++;
    }
  }
  if (!headless && !pipe && port === null) return null;
  // a browser with BOTH flags can still be driven through its port: it is a port-mode browser (a live client protects it) — pipe mode means "nobody can ever drive it again"
  return { mode: port !== null ? 'port' : pipe ? 'pipe' : 'headless', port, userDataDir };
}

const WS_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * The workspace a profile directory is attributed to: `<agentTmpRoot>/<ws-id>/…` after lexical normalisation (a `..` that climbs out, a relative path, a profile
 * outside the root, or the root itself → null). The root is the caller's (`~/.orchestra/agent-tmp` in production, a scratch dir in a rig).
 */
export function profileOwner(userDataDir: string | null, agentTmpRoot: string): { wsId: string; prefix: string } | null {
  if (!userDataDir || !path.posix.isAbsolute(userDataDir) || !path.posix.isAbsolute(agentTmpRoot)) return null;
  const root = path.posix.normalize(agentTmpRoot).replace(/\/+$/, '');
  const dir = path.posix.normalize(userDataDir).replace(/\/+$/, '');
  if (root === '' || !dir.startsWith(`${root}/`)) return null;
  const seg = dir.slice(root.length + 1).split('/')[0];
  if (!seg || seg === '.' || seg === '..' || !WS_ID_RE.test(seg)) return null;
  return { wsId: seg, prefix: `${root}/${seg}/` };
}

/** Is the browser's launcher gone? Parent init, or the user manager (`systemd --user`: the subreaper orphans of a user session reparent to). Any other parent is a live launcher. */
export function launcherDead(ppid: number, parent: { comm: string; ppid: number } | null): boolean {
  if (ppid <= 1) return true;
  return parent !== null && parent.comm === 'systemd' && parent.ppid <= 1;
}

export type ClientState = 'yes' | 'no' | 'unknown';

export type { BrowserCounter, BrowserReliquatView, BrowserChip } from './browser-chip.ts';
export { browserChipOf } from './browser-chip.ts';
import type { BrowserCounter } from './browser-chip.ts';

export interface BrowserTrack {
  /** When this monitor first saw the browser as an orphan. */
  firstOrphanAt: number;
  /** The last time a client was seen connected (null = never). */
  lastClientAt: number | null;
}

/** Roll the per-browser track forward one observation. A client we could not read counts as a sighting: time spent UNKNOWN is not time without a client (UNKNOWN is not NONE). */
export function nextTrack(prev: BrowserTrack | undefined, now: number, client: ClientState): BrowserTrack {
  return { firstOrphanAt: prev?.firstOrphanAt ?? now, lastClientAt: client !== 'no' ? now : (prev?.lastClientAt ?? null) };
}

export interface BrowserFacts {
  parsed: BrowserArgv;
  owner: { wsId: string; prefix: string } | null;
  /** The owning workspace is one this store knows. */
  ownerKnown: boolean;
  launcherDead: boolean;
  client: ClientState;
}

export type BrowserVerdict =
  | { stop: true; why: string }
  | { stop: false; why: 'not-attributable' | 'unknown-workspace' | 'launcher-alive' | 'client-connected' | 'client-unknown' | 'idle-window'; waitMs?: number };

/**
 * THE decision. `track` is already rolled forward for THIS observation ({@link nextTrack}); `windowMs` = N. `ignoreWindow` = a Pause dure: the member is frozen and nobody
 * will drive its browser, so the idle window does not apply — a live client still protects it. Order matters: every "keep" is checked before anything may stop.
 */
export function decideBrowserReliquat(f: BrowserFacts, track: BrowserTrack, now: number, windowMs: number, ignoreWindow = false): BrowserVerdict {
  if (!f.owner) return { stop: false, why: 'not-attributable' };
  if (!f.ownerKnown) return { stop: false, why: 'unknown-workspace' };
  if (!f.launcherDead) return { stop: false, why: 'launcher-alive' };
  if (f.parsed.mode === 'pipe') return { stop: true, why: 'pipe mode: the pipe died with its launcher — nobody can ever drive this browser again' };
  if (f.client === 'yes') return { stop: false, why: 'client-connected' };
  if (f.client === 'unknown') return { stop: false, why: 'client-unknown' };
  if (ignoreWindow) return { stop: true, why: `${f.parsed.mode} mode: launcher dead, no client connected (Pause dure: the member is frozen)` };
  const idleSince = Math.max(track.firstOrphanAt, track.lastClientAt ?? 0);
  const idle = now - idleSince;
  if (idle >= windowMs) return { stop: true, why: `${f.parsed.mode} mode: launcher dead and no client connected for ${Math.round(idle / 60_000)} min (window ${Math.round(windowMs / 60_000)} min)` };
  return { stop: false, why: 'idle-window', waitMs: windowMs - idle };
}

// ─── /proc/net/tcp — is a client connected to the browser's debugging port? ────────────────────────────────────────────────────────

export interface TcpRow {
  localPort: number;
  remotePort: number;
  /** Hex socket state: `0A` LISTEN, `01` ESTABLISHED. */
  state: string;
  inode: number;
}

/** Parse /proc/net/tcp or /proc/net/tcp6. Malformed lines are skipped; an empty/garbled file yields []. */
export function parseProcNetTcp(text: string): TcpRow[] {
  const out: TcpRow[] = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const lp = /:([0-9A-Fa-f]{4})$/.exec(f[1]);
    const rp = /:([0-9A-Fa-f]{4})$/.exec(f[2]);
    const inode = Number(f[9]);
    if (!lp || !rp || !Number.isFinite(inode)) continue;
    out.push({ localPort: parseInt(lp[1], 16), remotePort: parseInt(rp[1], 16), state: f[3].toUpperCase(), inode });
  }
  return out;
}

/** The ports this process LISTENS on: LISTEN rows whose inode is one of its sockets. */
export function listeningPortsOf(rows: readonly TcpRow[], socketInodes: ReadonlySet<number>): number[] {
  return [...new Set(rows.filter((r) => r.state === '0A' && socketInodes.has(r.inode)).map((r) => r.localPort))];
}

/** A client is connected iff some ESTABLISHED socket has one of the browser's listening ports as its LOCAL port (the accepted, server side of a connection). */
export function clientConnected(rows: readonly TcpRow[], ports: readonly number[]): boolean {
  return rows.some((r) => r.state === '01' && ports.includes(r.localPort));
}

/** Process tree of `rootPid` (itself first, then descendants breadth-first) from a flat table — what a browser's renderers / gpu / zygote hang from. */
export function descendantsOf<T extends { pid: number; ppid: number }>(table: readonly T[], rootPid: number): T[] {
  const kids = new Map<number, T[]>();
  for (const p of table) {
    const l = kids.get(p.ppid);
    if (l) l.push(p);
    else kids.set(p.ppid, [p]);
  }
  const root = table.find((p) => p.pid === rootPid);
  if (!root) return [];
  const out: T[] = [];
  const seen = new Set<number>();
  const queue: T[] = [root];
  while (queue.length) {
    const p = queue.shift() as T;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    for (const k of kids.get(p.pid) ?? []) queue.push(k);
  }
  return out;
}

/** The longest common directory prefix of absolute profile paths, never shorter than their `<agentTmp>/<ws>/` root — what the bus status names. */
export function commonProfilePrefix(profiles: readonly string[], fallback: string): string {
  if (profiles.length === 0) return fallback;
  const split = profiles.map((p) => path.posix.normalize(p).split('/'));
  let n = split[0].length;
  for (const s of split) { let i = 0; while (i < n && i < s.length && s[i] === split[0][i]) i++; n = i; }
  const common = split[0].slice(0, n).join('/');
  return common.length >= fallback.length - 1 && common.startsWith(fallback.replace(/\/$/, '')) ? `${common.replace(/\/$/, '')}/` : fallback;
}

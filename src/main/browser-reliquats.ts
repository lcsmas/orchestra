// Browser Reliquats — I/O half (#331, wave H ledger #329 track H10). Electron-free, dependency-injected: the 60 s resource-monitor pass and every Pause dure call
// `browserPass`; a rig drives it over the REAL /proc with real headless Chromium. Decisions: src/shared/browser-reliquats.ts.
//
// DESTRUCTIVE, so: a process is signalled only when its identity (pid + /proc start-time) was RE-READ right before the signal, its argv is still the browser we
// classified, its launcher is still dead and (port mode) no client has connected since; the profile directory is never touched; anything unreadable is "keep".

import fs from 'node:fs';
import type { ProcSample } from '../shared/resources.ts';
import {
  BROWSER_IDLE_WINDOW_MS,
  clientConnected,
  commonProfilePrefix,
  decideBrowserReliquat,
  descendantsOf,
  isBrowserComm,
  launcherDead,
  listeningPortsOf,
  nextTrack,
  parseBrowserArgv,
  parseProcNetTcp,
  profileOwner,
  type BrowserArgv,
  type BrowserCounter,
  type BrowserReliquatView,
  type BrowserTrack,
  type ClientState,
} from '../shared/browser-reliquats.ts';
import { emptyReliquatReport, type ReliquatKilled, type ReliquatLeft, type ReliquatReport } from '../shared/pause-reliquats.ts';

export const BROWSER_GRACE_MS = 3_000;
const CMD_CHARS = 400;

export interface BrowserPassDeps {
  now(): number;
  /** `~/.orchestra/agent-tmp` in production; a scratch dir in a rig. */
  agentTmpRoot(): string;
  /** The workspace is one the store knows (live or archived): a profile under an unknown id is not attributable. */
  workspaceKnown(wsId: string): boolean;
  /** Fresh single-pid /proc/<pid>/stat; null = gone / unreadable / non-Linux. */
  readProcStat(pid: number): ProcSample | null;
  /** /proc/<pid>/cmdline argv; null = gone / unreadable. */
  readCmdline(pid: number): string[] | null;
  /** The ports `pid` LISTENS on and whether a client is connected to one; 'unknown' when /proc cannot say (then the browser is never stopped). */
  clientState(pid: number): { ports: number[]; client: ClientState } | 'unknown';
  /** Epoch ms a process with this /proc start-time began. */
  startMs(startTicks: number): number;
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean;
  sleep(ms: number): Promise<void>;
  warn(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  idleWindowMs?: number;
  graceMs?: number;
}

/** The monitor's memory across passes: when each orphan was first seen / last had a client, and the per-workspace counters. */
export class BrowserTracker {
  readonly tracks = new Map<string, BrowserTrack>();
  readonly counters = new Map<string, BrowserCounter>();
  view(): BrowserReliquatView {
    let total = 0;
    const byWorkspace: Record<string, BrowserCounter> = {};
    for (const [ws, c] of this.counters) {
      total += c.stopped;
      byWorkspace[ws] = { ...c };
    }
    return { total, byWorkspace };
  }
}

export interface BrowserStopped {
  wsId: string;
  pid: number;
  startTicks: number;
  mode: string;
  prefix: string;
  profile: string;
  groupSize: number;
}

export interface BrowserPassOpts {
  /** Only this workspace's browsers (a Pause dure of ONE member); the other workspaces' tracks are left alone. */
  onlyWs?: string;
  /** A Pause dure: the idle window does not apply (a live client still protects). */
  ignoreWindow?: boolean;
  /** Re-checked before every signal round: false ⇒ stop at once (the pause was lifted). */
  stillWanted?: () => boolean;
  /** Called with the report so far after the SIGTERM batch (the trap persists it: a stopped browser must be in the Bilan even if the app dies next). */
  onProgress?: (report: ReliquatReport) => void;
}

export interface BrowserPassResult {
  stopped: BrowserStopped[];
  /** Orphans attributable to a member that were deliberately KEPT, with the reason (client connected / unknown). */
  spared: ReliquatLeft[];
  /** The Bilan-shaped report of the stops (killed + spared); null when this pass found nothing worth recording. */
  report: ReliquatReport | null;
  aborted?: 'lifted';
  errors: string[];
}

interface Target {
  main: ProcSample;
  argv: string[];
  parsed: BrowserArgv;
  wsId: string;
  prefix: string;
  why: string;
  members: ProcSample[];
}

const sameArgv = (a: readonly string[] | null, b: readonly string[]): boolean => a !== null && a.length === b.length && a.every((x, i) => x === b[i]);
const trunc = (s: string): string => (s.length > CMD_CHARS ? `${s.slice(0, CMD_CHARS)}…` : s);

/**
 * One pass over a FRESH process table: classify every browser main process, roll the per-browser tracks forward, stop the ones the decision says stop.
 * Never throws for a process that vanished mid-pass; a dependency that throws is recorded in `errors` and nothing is signalled for that browser.
 */
export async function browserPass(d: BrowserPassDeps, tracker: BrowserTracker, table: readonly ProcSample[], opts: BrowserPassOpts = {}): Promise<BrowserPassResult> {
  const now = d.now();
  const windowMs = d.idleWindowMs ?? BROWSER_IDLE_WINDOW_MS;
  const root = d.agentTmpRoot();
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const errors: string[] = [];
  const spared: ReliquatLeft[] = [];
  const targets: Target[] = [];
  const seenKeys = new Set<string>();

  for (const p of table) {
    if (p.startTicks === undefined || !isBrowserComm(p.comm)) continue; // no start-time ⇒ no identity ⇒ never signalled (non-Linux `ps` path)
    let argv: string[] | null;
    try {
      argv = d.readCmdline(p.pid);
    } catch (e) {
      errors.push(`cmdline ${p.pid}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!argv) continue;
    const parsed = parseBrowserArgv(argv);
    if (!parsed) continue;
    const owner = profileOwner(parsed.userDataDir, root);
    if (!owner) continue; // the human's browser, a default profile, anything outside agent-tmp/: not ours — not even tracked
    if (opts.onlyWs !== undefined && owner.wsId !== opts.onlyWs) continue;
    const parent = byPid.get(p.ppid);
    const dead = launcherDead(p.ppid, parent ? { comm: parent.comm, ppid: parent.ppid } : null);
    const key = `${p.pid}:${p.startTicks}`;
    if (!dead) continue; // launcher alive: it owns this browser
    let client: ClientState = 'no';
    if (parsed.mode !== 'pipe') {
      try {
        const cs = d.clientState(p.pid);
        client = cs === 'unknown' ? 'unknown' : cs.client;
      } catch (e) {
        client = 'unknown';
        errors.push(`client state ${p.pid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const track = nextTrack(tracker.tracks.get(key), now, client);
    tracker.tracks.set(key, track);
    seenKeys.add(key);
    const verdict = decideBrowserReliquat({ parsed, owner, ownerKnown: d.workspaceKnown(owner.wsId), launcherDead: dead, client }, track, now, windowMs, opts.ignoreWindow === true);
    if (!verdict.stop) {
      if (verdict.why === 'client-connected' || verdict.why === 'client-unknown') spared.push({ pid: p.pid, startTicks: p.startTicks, comm: p.comm, cmd: trunc(argv.join(' ')), reason: `browser Reliquat kept: ${verdict.why === 'client-connected' ? 'a client is connected to its debugging port' : 'its debugging-port clients could not be read'}` });
      continue;
    }
    targets.push({ main: p, argv, parsed, wsId: owner.wsId, prefix: owner.prefix, why: verdict.why, members: descendantsOf(table, p.pid) });
  }
  if (opts.onlyWs === undefined) for (const k of [...tracker.tracks.keys()]) if (!seenKeys.has(k)) tracker.tracks.delete(k); // gone, or no longer an orphan

  const killed: ReliquatKilled[] = [];
  const stopped: BrowserStopped[] = [];
  let aborted: 'lifted' | undefined;
  const wanted = (): boolean => {
    if (opts.stillWanted && !opts.stillWanted()) { aborted = 'lifted'; return false; }
    return true;
  };
  const armed: Array<{ t: Target; sent: ProcSample[]; entry: ReliquatKilled }> = [];
  for (const t of targets) {
    if (!wanted()) break;
    // ── identity + state RE-READ right before the signal: same pid + start-time, same argv, launcher still dead, no client since ──
    const fresh = d.readProcStat(t.main.pid);
    if (!fresh || fresh.startTicks !== t.main.startTicks) { d.warn(`resources: browser reliquat pid ${t.main.pid} withheld — identity changed or gone`); continue; }
    if (!sameArgv(d.readCmdline(t.main.pid), t.argv)) { d.warn(`resources: browser reliquat pid ${t.main.pid} withheld — argv changed`); continue; }
    const parent = d.readProcStat(fresh.ppid);
    if (!launcherDead(fresh.ppid, parent ? { comm: parent.comm, ppid: parent.ppid } : null)) { d.warn(`resources: browser reliquat pid ${t.main.pid} withheld — it has a live launcher now (ppid ${fresh.ppid})`); continue; }
    if (t.parsed.mode !== 'pipe') {
      const cs = d.clientState(t.main.pid);
      if (cs === 'unknown' || cs.client !== 'no') { d.warn(`resources: browser reliquat pid ${t.main.pid} withheld — a client appeared / could not be read`); continue; }
    }
    // the group: the browser + its descendants, each re-verified (same start-time, parent a verified member), children first, the main process last
    const verified = new Map<number, ProcSample>([[t.main.pid, fresh]]);
    const order: ProcSample[] = [];
    for (const m of t.members) {
      if (m.pid === t.main.pid) continue;
      const f = d.readProcStat(m.pid);
      if (!f || f.startTicks !== m.startTicks || !verified.has(f.ppid)) continue; // not provably still this browser's child: left alone
      verified.set(m.pid, f);
      order.push(f);
    }
    order.reverse();
    order.push(fresh);
    const why = `browser Reliquat (${t.parsed.mode}): ${t.why}; profile ${trunc(t.parsed.userDataDir ?? '')}; identity re-read at signal time (pid ${t.main.pid}, start-time ${t.main.startTicks}); group of ${order.length} process(es)`;
    d.warn(`resources: stopping browser Reliquat of workspace ${t.wsId} — ${t.main.comm}(${t.main.pid}) ${why}`);
    const sent: ProcSample[] = [];
    for (const m of order) if (d.signal(m.pid, 'SIGTERM')) sent.push(m);
    if (sent.length === 0) continue;
    const entry: ReliquatKilled = {
      pid: t.main.pid, startTicks: t.main.startTicks as number, comm: t.main.comm, cmd: trunc(t.argv.join(' ')), cwd: t.parsed.userDataDir, startedAt: d.startMs(t.main.startTicks as number),
      scope: `browser:${t.parsed.mode}`, evidence: why, signal: 'SIGTERM', outcome: 'exited',
    };
    killed.push(entry);
    armed.push({ t, sent, entry });
    stopped.push({ wsId: t.wsId, pid: t.main.pid, startTicks: t.main.startTicks as number, mode: t.parsed.mode, prefix: t.prefix, profile: t.parsed.userDataDir ?? '', groupSize: order.length });
  }
  const recordOf = (): ReliquatReport | null => {
    if (killed.length === 0 && spared.length === 0) return null;
    return { ...emptyReliquatReport(), killed: [...killed], spared: [...spared], rounds: armed.length > 0 ? 1 : 0, ...(aborted ? { aborted } : {}) };
  };
  if (armed.length > 0) {
    opts.onProgress?.(recordOf() as ReliquatReport);
    await d.sleep(d.graceMs ?? BROWSER_GRACE_MS);
    for (const { sent, entry } of armed) {
      for (const m of sent) {
        const f = d.readProcStat(m.pid);
        if (!f || f.startTicks !== m.startTicks) continue; // gone, or the pid was recycled: never signalled again
        if (!wanted()) break;
        if (d.signal(m.pid, 'SIGKILL') && m.pid === entry.pid) entry.signal = 'SIGKILL';
      }
      const f = d.readProcStat(entry.pid);
      entry.outcome = f && f.startTicks === entry.startTicks ? 'survived' : 'exited';
    }
    for (const s of stopped) {
      const c = tracker.counters.get(s.wsId) ?? { stopped: 0, lastAt: 0, lastPrefix: s.prefix };
      tracker.counters.set(s.wsId, { stopped: c.stopped + 1, lastAt: now, lastPrefix: s.prefix });
      tracker.tracks.delete(`${s.pid}:${s.startTicks}`);
    }
  }
  return { stopped, spared, report: recordOf(), ...(aborted ? { aborted } : {}), errors };
}

/** One bus-status text per owning member per pass: how many were stopped and the profile prefix. English on purpose (a prompt for an agent). */
export function browserStatusText(stopped: readonly BrowserStopped[]): string {
  const prefix = commonProfilePrefix(stopped.map((s) => s.profile), stopped[0].prefix);
  const pipe = stopped.filter((s) => s.mode === 'pipe').length;
  return `Orchestra stopped ${stopped.length} orphaned headless browser(s) you left behind (launcher dead${pipe ? `, ${pipe} in pipe mode` : ''}); profile prefix ${prefix} — profiles were left in place. Re-launch a browser yourself if you still need it.`;
}


/**
 * The REAL client-state reader (Linux): the ports `pid` listens on = LISTEN rows of /proc/net/tcp{,6} whose inode is one of its sockets (/proc/<pid>/fd); a client is
 * connected iff some ESTABLISHED socket has one of those ports as its local port. No listening port ⇒ nobody can connect ⇒ 'no'. Anything unreadable ⇒ 'unknown'
 * (tcp6 simply absent — IPv6 off — is an empty table, not an error).
 */
export function realClientState(pid: number, procRoot = '/proc'): { ports: number[]; client: ClientState } | 'unknown' {
  try {
    const inodes = new Set<number>();
    for (const fd of fs.readdirSync(`${procRoot}/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`${procRoot}/${pid}/fd/${fd}`));
        if (m) inodes.add(Number(m[1]));
      } catch { /* closed meanwhile */ }
    }
    const rows = parseProcNetTcp(fs.readFileSync(`${procRoot}/net/tcp`, 'utf8'));
    try {
      rows.push(...parseProcNetTcp(fs.readFileSync(`${procRoot}/net/tcp6`, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return 'unknown';
    }
    const ports = listeningPortsOf(rows, inodes);
    return { ports, client: ports.length > 0 && clientConnected(rows, ports) ? 'yes' : 'no' };
  } catch {
    return 'unknown';
  }
}

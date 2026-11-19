// Hosting of a run's Docker relay: where its socket lives, which real daemon it forwards to, starting it (docker-env) and closing it (the cleanup step).
// The relay is a DETACHED CHILD PROCESS per run (src/relay-proc.ts), not a part of the `serve` daemon: it survives a daemon restart, a relay bug cannot take the reaper down,
// and the cleanup (which also runs in the `run end` CLI, with no daemon at all) stops it by the identity recorded in `run.relay`. See docs/codebase-map/resource-service.md §A2.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerHostEnv, dockerSocketOverride, type Env } from './env.ts';
import { CliError, EXIT, refused } from './errors.ts';
import { acquire, release } from './lockfile.ts';
import { bootId, identityOf, isAlive, signalIfSame, sleep } from './proc.ts';
import { readState, withState, type Run } from './state.ts';

/**
 * `run.relay` of a run (state.ts leaves the field `unknown`; this is its shape). `upstream` = the daemon the CURRENT relay forwards to, `upstreams` = every daemon any relay of this run instance
 * ever forwarded to (the cleanup clears them all). `pid`/`startTime` are written by the relay process itself before it listens. `closed` = the cleanup began: no relay may start for this
 * instance any more. `removed` = a cleanup completed the container removal (a run closed by a reboot has none: the daemon sweeps it).
 */
export type RelayRecord = { closed?: boolean; removed?: boolean; sock?: string; upstream?: string; upstreams?: string[]; pid?: number; startTime?: number; bootId?: string; startedAt?: number };
export const relayOf = (run: Run | undefined): RelayRecord | undefined => run?.relay as RelayRecord | undefined;
export const own = <T>(m: Record<string, T>, k: string): T | undefined => (Object.hasOwn(m, k) ? m[k] : undefined);
export const upstreamsOf = (r: RelayRecord | undefined): string[] => [...new Set([...(r?.upstreams ?? []), ...(r?.upstream ? [r.upstream] : [])])];

export const RELAY_SUFFIX = '.resctl-docker.sock';
export const relayDir = (dir: string): string => path.join(dir, 'relay');
const lockPath = (dir: string, id: string): string => path.join(relayDir(dir), `${id}.lock`);
/** sun_path is 108 bytes on Linux incl. the NUL. */
const MAX_SOCK_BYTES = 107;

/** The run's socket: `<state>/relay/<id>.resctl-docker.sock`, or `h-<sha256(id)[:16]>` in the same dir when the id makes it too long. Deterministic: the same id always gets the same path. */
export function relaySocketPath(dir: string, id: string): string {
  for (const name of [id, `h-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`]) {
    const p = path.join(relayDir(dir), `${name}${RELAY_SUFFIX}`);
    if (Buffer.byteLength(p) <= MAX_SOCK_BYTES) return p;
  }
  throw new CliError(EXIT.failure, `state dir ${dir} is too long for a unix socket path (max ${MAX_SOCK_BYTES} bytes): set RESCTL_STATE_DIR to a shorter directory`);
}

// ── which real daemon ───────────────────────────────────────────────────────────────────────────────────────────

export type UpstreamDeps = {
  /** `docker context inspect` endpoint of the effective context; null when the CLI is missing or fails. */
  contextHost(env: Env): Promise<string | null>;
  pathKind(p: string): 'socket' | 'missing' | 'other';
};
export type Upstream = { ok: true; socketPath: string; via: string } | { ok: false; reason: string };

const unixPath = (host: string): string | null => (host.startsWith('unix://') ? host.slice('unix://'.length) : null);
/** One of OUR relays: never a daemon (forwarding to it would stack two run labels). */
export const isOwnRelaySocket = (p: string): boolean => p.endsWith(RELAY_SUFFIX);

/**
 * The daemon the caller would have talked to without the relay: `RESCTL_DOCKER_SOCKET`, else its `DOCKER_HOST`, else its effective docker context, else `/var/run/docker.sock`.
 * A `DOCKER_HOST` naming another run's relay is not a daemon and is skipped. Any other unix socket is accepted — including a keeper relay (a different label key: both labels land).
 * A non-unix endpoint (tcp, ssh) is refused, never silently swapped for the local daemon.
 */
export async function resolveUpstream(env: Env, deps: UpstreamDeps): Promise<Upstream> {
  let socketPath: string;
  let via: string;
  const explicit = dockerSocketOverride(env);
  const inherited = dockerHostEnv(env);
  if (explicit) {
    socketPath = unixPath(explicit) ?? explicit;
    via = 'RESCTL_DOCKER_SOCKET';
  } else if (inherited && !isOwnRelaySocket(unixPath(inherited) ?? inherited)) {
    const p = unixPath(inherited);
    if (!p) return { ok: false, reason: `DOCKER_HOST=${inherited} is not a unix socket` };
    socketPath = p;
    via = 'DOCKER_HOST';
  } else {
    const ctxEnv = { ...env };
    delete ctxEnv.DOCKER_HOST;
    const host = await deps.contextHost(ctxEnv);
    if (host === null) {
      socketPath = '/var/run/docker.sock';
      via = 'default';
    } else {
      const p = unixPath(host);
      if (!p) return { ok: false, reason: `docker context endpoint ${host} is not a unix socket` };
      socketPath = p;
      via = 'docker context';
    }
  }
  if (!socketPath.startsWith('/')) return { ok: false, reason: `upstream ${socketPath} is not an absolute path` };
  if (isOwnRelaySocket(socketPath)) return { ok: false, reason: `upstream ${socketPath} (${via}) is a resctl relay, not a daemon` };
  const kind = deps.pathKind(socketPath);
  if (kind !== 'socket') return { ok: false, reason: `upstream ${socketPath} (${via}) ${kind === 'missing' ? 'does not exist: is the Docker daemon running?' : 'is not a socket'}` };
  return { ok: true, socketPath, via };
}

export const realUpstreamDeps: UpstreamDeps = {
  contextHost: (env) =>
    new Promise((resolve) => {
      execFile('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { env, timeout: 5000, encoding: 'utf8' }, (err, out) => {
        const host = out.trim();
        resolve(err || !host ? null : host);
      });
    }),
  pathKind(p) {
    try {
      return fs.statSync(p).isSocket() ? 'socket' : 'other';
    } catch {
      return 'missing';
    }
  },
};

// ── lifecycle ───────────────────────────────────────────────────────────────────────────────────────────────────

const canConnect = (sock: string): Promise<boolean> =>
  new Promise((resolve) => {
    const c = net.connect(sock);
    c.once('connect', () => (c.destroy(), resolve(true)));
    c.once('error', () => resolve(false));
  });

/** Remove a socket file; anything else in its place (a directory, a vanished file) is none of our business and must never mask the real error. */
function unlinkQuiet(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* gone, or not ours */
  }
}

const ENTRY = fileURLToPath(new URL('./relay-proc.ts', import.meta.url));

/** Stop the relay process of `rec` (TERM, then KILL) and remove its socket file. A record without a live process of that identity is a no-op. */
export async function stopRelayProcess(rec: RelayRecord, termWaitMs = 3000): Promise<void> {
  // a record of ANOTHER boot names no process of this one (pid + starttime can coincide across boots): never signal it
  if (rec.pid !== undefined && rec.startTime !== undefined && (!rec.bootId || rec.bootId === bootId())) {
    const id = { pid: rec.pid, startTime: rec.startTime };
    const gone = async (ms: number): Promise<boolean> => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (!isAlive(id)) return true;
      return !isAlive(id);
    };
    if (isAlive(id)) {
      signalIfSame(id, 'SIGTERM');
      if (!(await gone(termWaitMs))) {
        signalIfSame(id, 'SIGKILL');
        if (!(await gone(2000))) throw new Error(`relay process ${id.pid} survived SIGKILL`);
      }
    }
  }
  if (rec.sock) unlinkQuiet(rec.sock);
}

/** Start (or reuse) the run's relay and return its socket. One relay per run: the per-run lock serialises concurrent docker-env calls AND the cleanup's close. */
export async function ensureRelay(dir: string, id: string, env: Env = process.env, deps: UpstreamDeps = realUpstreamDeps): Promise<{ sock: string; upstream: string; reused: boolean }> {
  const sock = relaySocketPath(dir, id);
  fs.mkdirSync(relayDir(dir), { recursive: true, mode: 0o700 });
  const lock = await acquire(lockPath(dir, id), 30_000);
  try {
    const run = own(readState(dir).runs, id);
    if (!run) throw refused(`no such run: ${id} (declare it with run start first)`);
    if (run.state === 'cleaned') throw refused(`run ${id} is cleaned`);
    const rec = relayOf(run);
    if (rec?.closed) throw refused(`run ${id} is being cleaned: no new relay`);
    if (rec?.sock === sock && rec.upstream && rec.pid !== undefined && rec.startTime !== undefined && isAlive({ pid: rec.pid, startTime: rec.startTime })) {
      if (await canConnect(sock)) return { sock, upstream: rec.upstream, reused: true };
      await stopRelayProcess(rec); // alive but not answering: replace it
    }
    const up = await resolveUpstream(env, deps);
    if (!up.ok) throw new CliError(EXIT.failure, `docker-env: ${up.reason}`);

    // 1. record WHERE this relay will forward, before any process exists: whatever happens to this command next, the cleanup knows which daemon to clear
    const boot = bootId();
    const pending: RelayRecord = { sock, upstream: up.socketPath, upstreams: [...new Set([...upstreamsOf(rec), up.socketPath])], startedAt: Date.now(), ...(boot ? { bootId: boot } : {}) };
    const planted = await withState((s) => {
      const cur = own(s.runs, id);
      if (!cur || cur.token !== run.token || cur.state === 'cleaned') return false;
      cur.relay = pending;
      return true;
    }, dir);
    if (!planted) throw refused(`run ${id} ended while its relay started`);

    // 2. the relay process registers ITSELF (pid + starttime) before it listens, and refuses to start for a closed run
    const logPath = path.join(relayDir(dir), `${id}.log`);
    const logFd = fs.openSync(logPath, 'a', 0o600);
    // the relay must not carry the run marker: its stop is the cleanup step's job (and its own watch), not the process sweep's
    const childEnv: NodeJS.ProcessEnv = { ...env, RESCTL_STATE_DIR: dir };
    delete childEnv.RESCTL_RUN;
    delete childEnv.RESCTL_RUN_TOKEN;
    const child = spawn(process.execPath, [ENTRY, id, run.token, sock, up.socketPath], { detached: true, stdio: ['ignore', logFd, logFd], env: childEnv });
    child.unref();
    fs.closeSync(logFd);
    let exited = false;
    child.once('exit', () => (exited = true));
    try {
      for (const end = Date.now() + 10_000; ; await sleep(25)) {
        if (exited) throw new CliError(EXIT.failure, `docker-env: the relay exited at start (see ${logPath})`);
        const reg = relayOf(own(readState(dir).runs, id));
        if (reg !== undefined && reg.pid === child.pid && reg.sock === sock && (await canConnect(sock))) break;
        if (Date.now() >= end) throw new CliError(EXIT.failure, `docker-env: the relay did not listen on ${sock} within 10s`);
      }
    } catch (e) {
      if (!exited) child.kill('SIGKILL'); // our own child, handle still valid
      unlinkQuiet(sock);
      throw e;
    }
    return { sock, upstream: up.socketPath, reused: false };
  } finally {
    release(lock);
  }
}

/** Called by the relay process before it listens: writes its own identity into the run's record. false = this run instance is gone or closed (or the record is not ours): do not serve. */
export async function registerRelay(dir: string, id: string, token: string, sock: string): Promise<boolean> {
  const me = identityOf(process.pid);
  if (!me) return false;
  return withState((s) => {
    const cur = own(s.runs, id);
    const rel = relayOf(cur);
    if (!cur || cur.token !== token || cur.state === 'cleaned' || !rel || rel.closed || rel.sock !== sock) return false;
    cur.relay = { ...rel, pid: me.pid, startTime: me.startTime };
    return true;
  }, dir);
}

/**
 * The cleanup's first act on containers: mark the run's relay `closed` (docker-env refuses from now on), stop the relay process, and hand back what it was.
 * null = this instance has no state record (nothing to clean). A run that never had a relay still gets `{closed:true}` so a docker-env racing the cleanup cannot start one.
 */
export async function closeRelay(dir: string, run: Run): Promise<RelayRecord | null> {
  fs.mkdirSync(relayDir(dir), { recursive: true, mode: 0o700 });
  const lock = await acquire(lockPath(dir, run.id), 30_000);
  try {
    const rec = await withState((s): RelayRecord | null => {
      const cur = own(s.runs, run.id);
      if (!cur || cur.token !== run.token) return null;
      const before = relayOf(cur) ?? {};
      cur.relay = { ...before, closed: true };
      return before;
    }, dir);
    if (rec) await stopRelayProcess(rec);
    return rec;
  } finally {
    release(lock);
  }
}

// The app's own Docker client over the REAL Docker unix socket (#291, ledger #295 FI-1.2). #292 (Pause stops/restarts
// attributed containers) and #293 (container memory per workspace) import this; it is NEVER pointed at a keeper relay —
// the app must see every container, and a relay only exists to stamp what members create.
//
// Injectable: `createDockerApi({ transport })` swaps the HTTP-over-socket call for a fake in tests; `socketPath` points
// it at a scratch daemon. Every method throws {@link DockerApiError} (`kind: 'unavailable'` = no daemon, `'timeout'`,
// `'http'` = the daemon answered an error) — callers record it and never let it block their own work.

import http from 'node:http';
import { resolveRelayUpstream, type UpstreamDeps } from '../shared/docker-relay.ts';
import { realUpstreamDeps } from '../shared/docker-endpoint.ts';

export interface DockerResponse {
  status: number;
  body: Buffer;
}
export interface DockerRequest {
  method: 'GET' | 'POST';
  /** Path + query, no API version prefix (the daemon then speaks its newest). */
  path: string;
  timeoutMs: number;
}
export type DockerTransport = (req: DockerRequest) => Promise<DockerResponse>;

export class DockerApiError extends Error {
  readonly kind: 'unavailable' | 'timeout' | 'http';
  readonly status?: number;
  constructor(message: string, kind: 'unavailable' | 'timeout' | 'http', status?: number) {
    super(message);
    this.name = 'DockerApiError';
    this.kind = kind;
    this.status = status;
  }
}

export interface DockerContainerSummary {
  id: string;
  /** Primary name, no leading slash. */
  name: string;
  image: string;
  /** `running`, `exited`, `created`, `paused`, … */
  state: string;
  status: string;
  /** Unix seconds. */
  created: number;
  labels: Record<string, string>;
}

export interface DockerContainerInspect {
  id: string;
  name: string;
  image: string;
  running: boolean;
  /** `HostConfig.AutoRemove` — `docker run --rm`: stopping such a container DELETES it (FI-1.4). */
  autoRemove: boolean;
  labels: Record<string, string>;
}

export interface ListContainersOptions {
  /** Include stopped containers (default: running only, like `docker ps`). */
  all?: boolean;
  /** Daemon label filters: `key` or `key=value`; all must match. */
  labels?: string[];
  /** Daemon status filters (`running`, `exited`, …). */
  status?: string[];
}

export interface DockerApi {
  /** The socket PINNED at construction, or null when it is resolved per use (the default) or the transport is injected. */
  readonly socketPath: string | null;
  /** The socket the next call would use (resolved like the relay does); null = none. */
  resolveSocket(): Promise<string | null>;
  /** Does a daemon answer `/_ping`? Never throws. */
  available(): Promise<boolean>;
  listContainers(opts?: ListContainersOptions): Promise<DockerContainerSummary[]>;
  /** null = no such container (404). */
  inspectContainer(id: string): Promise<DockerContainerInspect | null>;
  /** `POST /containers/{id}/stop?t=…` — never remove, kill or pause. */
  stopContainer(id: string, timeoutSec?: number): Promise<'stopped' | 'already-stopped' | 'gone'>;
  /** `POST /containers/{id}/start`. */
  startContainer(id: string): Promise<'started' | 'already-running' | 'gone'>;
  /** One-shot `GET /containers/{id}/stats?stream=false&one-shot=true` as the daemon returns it; null = 404. #293 reduces it to bytes. */
  containerStats(id: string): Promise<unknown | null>;
}

// ── socket resolution ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The REAL daemon socket this app talks to — resolved by the SAME function the keeper's relay forwards through
 * (`resolveRelayUpstream`: `ORCHESTRA_DOCKER_SOCKET` → own `DOCKER_HOST` (unix, not a relay: an Orchestra launched from a
 * relay-ON member's shell inherits the relay's — ignored) → effective docker context → `/var/run/docker.sock`), so the
 * daemon that stamps and the daemon Pause queries cannot differ (#291 follow-up F2). Null = unresolvable (tcp/ssh
 * endpoint, nothing at the path). A path with no daemon YET still resolves — calls fail `unavailable` until it appears.
 */
export async function resolveRealDockerSocket(
  env: Record<string, string | undefined> = process.env,
  deps: UpstreamDeps = realUpstreamDeps,
): Promise<string | null> {
  const r = await resolveRelayUpstream(env, deps);
  return r.ok ? r.socketPath : null;
}

// ── transport ───────────────────────────────────────────────────────────────────────────────────────────────────

function socketTransport(socketPath: string): DockerTransport {
  return (req) =>
    new Promise((resolve, reject) => {
      const r = http.request({ socketPath, method: req.method, path: req.path, agent: false, timeout: req.timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', (e) => reject(new DockerApiError(`docker response failed: ${e.message}`, 'unavailable')));
      });
      r.on('timeout', () => {
        r.destroy();
        reject(new DockerApiError(`docker ${req.method} ${req.path} timed out after ${req.timeoutMs} ms`, 'timeout'));
      });
      r.on('error', (e) => reject(e instanceof DockerApiError ? e : new DockerApiError(`docker unavailable: ${e.message}`, 'unavailable')));
      r.end();
    });
}

// ── the client ──────────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5000;

function parseJson<T>(res: DockerResponse, what: string): T {
  try {
    return JSON.parse(res.body.toString('utf8')) as T;
  } catch {
    throw new DockerApiError(`docker ${what}: unparseable response`, 'http', res.status);
  }
}

function httpError(res: DockerResponse, what: string): DockerApiError {
  let detail = '';
  try {
    detail = (JSON.parse(res.body.toString('utf8')) as { message?: string }).message ?? '';
  } catch {
    detail = res.body.toString('utf8').slice(0, 200);
  }
  return new DockerApiError(`docker ${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, 'http', res.status);
}

/** How long a resolved socket is trusted (a context switch is noticed within this); a FAILED resolution is retried sooner so a
 *  daemon that appears later is picked up. */
const RESOLVE_TTL_MS = 60_000;
const RESOLVE_FAIL_TTL_MS = 2_000;

export function createDockerApi(
  opts: {
    /** Pin one socket (tests / a scratch daemon); resolution is skipped. */
    socketPath?: string | null;
    transport?: DockerTransport;
    timeoutMs?: number;
    /** Resolution inputs (default: this process's env + the real docker CLI / fs probes). */
    env?: Record<string, string | undefined>;
    deps?: UpstreamDeps;
  } = {},
): DockerApi {
  const pinned = opts.transport ? null : opts.socketPath !== undefined ? opts.socketPath : undefined;
  let cache: { at: number; path: string | null } | null = null;
  const currentSocket = async (): Promise<string | null> => {
    if (pinned !== undefined) return pinned;
    const now = Date.now();
    if (cache && now - cache.at < (cache.path ? RESOLVE_TTL_MS : RESOLVE_FAIL_TTL_MS)) return cache.path;
    const p = await resolveRealDockerSocket(opts.env ?? process.env, opts.deps ?? realUpstreamDeps);
    cache = { at: Date.now(), path: p };
    return p;
  };
  const socketPath = pinned ?? null;
  const transport: DockerTransport =
    opts.transport ??
    (async (req) => {
      const p = await currentSocket();
      if (!p) throw new DockerApiError('no Docker socket found', 'unavailable');
      return socketTransport(p)(req);
    });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const enc = encodeURIComponent;

  return {
    socketPath,
    resolveSocket: currentSocket,
    async available() {
      try {
        const res = await transport({ method: 'GET', path: '/_ping', timeoutMs });
        return res.status === 200;
      } catch {
        return false;
      }
    },
    async listContainers(o = {}) {
      const filters: Record<string, string[]> = {};
      if (o.labels?.length) filters.label = o.labels;
      if (o.status?.length) filters.status = o.status;
      const q = `all=${o.all ? 1 : 0}${Object.keys(filters).length ? `&filters=${enc(JSON.stringify(filters))}` : ''}`;
      const res = await transport({ method: 'GET', path: `/containers/json?${q}`, timeoutMs });
      if (res.status !== 200) throw httpError(res, 'list containers');
      const rows = parseJson<Array<Record<string, unknown>>>(res, 'list containers');
      return rows.map((r) => ({
        id: String(r.Id),
        name: String((r.Names as string[] | undefined)?.[0] ?? '').replace(/^\//, ''),
        image: String(r.Image ?? ''),
        state: String(r.State ?? ''),
        status: String(r.Status ?? ''),
        created: Number(r.Created ?? 0),
        labels: (r.Labels as Record<string, string> | null) ?? {},
      }));
    },
    async inspectContainer(id) {
      const res = await transport({ method: 'GET', path: `/containers/${enc(id)}/json`, timeoutMs });
      if (res.status === 404) return null;
      if (res.status !== 200) throw httpError(res, `inspect ${id}`);
      const j = parseJson<{
        Id: string;
        Name?: string;
        Config?: { Image?: string; Labels?: Record<string, string> | null };
        State?: { Running?: boolean };
        HostConfig?: { AutoRemove?: boolean };
      }>(res, `inspect ${id}`);
      return {
        id: j.Id,
        name: (j.Name ?? '').replace(/^\//, ''),
        image: j.Config?.Image ?? '',
        running: j.State?.Running === true,
        autoRemove: j.HostConfig?.AutoRemove === true,
        labels: j.Config?.Labels ?? {},
      };
    },
    async stopContainer(id, timeoutSec = 10) {
      const res = await transport({ method: 'POST', path: `/containers/${enc(id)}/stop?t=${timeoutSec}`, timeoutMs: (timeoutSec + 20) * 1000 });
      if (res.status === 204) return 'stopped';
      if (res.status === 304) return 'already-stopped';
      if (res.status === 404) return 'gone';
      throw httpError(res, `stop ${id}`);
    },
    async startContainer(id) {
      const res = await transport({ method: 'POST', path: `/containers/${enc(id)}/start`, timeoutMs: Math.max(timeoutMs, 30_000) });
      if (res.status === 204) return 'started';
      if (res.status === 304) return 'already-running';
      if (res.status === 404) return 'gone';
      throw httpError(res, `start ${id}`);
    },
    async containerStats(id) {
      const res = await transport({ method: 'GET', path: `/containers/${enc(id)}/stats?stream=false&one-shot=true`, timeoutMs: Math.max(timeoutMs, 10_000) });
      if (res.status === 404) return null;
      if (res.status !== 200) throw httpError(res, `stats ${id}`);
      return parseJson<unknown>(res, `stats ${id}`);
    },
  };
}

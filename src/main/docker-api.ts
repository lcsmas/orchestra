// The app's own Docker client over the REAL Docker unix socket (#291, ledger #295 FI-1.2). #292 (Pause stops/restarts
// attributed containers) and #293 (container memory per workspace) import this; it is NEVER pointed at a keeper relay —
// the app must see every container, and a relay only exists to stamp what members create.
//
// Injectable: `createDockerApi({ transport })` swaps the HTTP-over-socket call for a fake in tests; `socketPath` points
// it at a scratch daemon. Every method throws {@link DockerApiError} (`kind: 'unavailable'` = no daemon, `'timeout'`,
// `'http'` = the daemon answered an error) — callers record it and never let it block their own work.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isRelaySocketPath } from '../shared/docker-relay.ts';

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
  /** The socket in use, or null when the transport is injected / no socket was found. */
  readonly socketPath: string | null;
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
 * The REAL daemon socket this app talks to: its own `DOCKER_HOST` when that is a unix socket that is not a relay
 * (an Orchestra launched from a relay-ON member's shell inherits the relay's DOCKER_HOST — ignored), else
 * `/var/run/docker.sock`, else the rootless `$XDG_RUNTIME_DIR/docker.sock`. Null = none exists.
 */
export function resolveRealDockerSocket(
  env: Record<string, string | undefined> = process.env,
  isSocket: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isSocket();
    } catch {
      return false;
    }
  },
): string | null {
  const candidates: string[] = [];
  const dh = env.DOCKER_HOST?.trim();
  if (dh?.startsWith('unix://')) {
    const p = dh.slice('unix://'.length);
    if (!isRelaySocketPath(p)) candidates.push(p);
  }
  candidates.push('/var/run/docker.sock');
  if (env.XDG_RUNTIME_DIR) candidates.push(path.join(env.XDG_RUNTIME_DIR, 'docker.sock'));
  return candidates.find((p) => isSocket(p)) ?? null;
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

const unavailable: DockerTransport = () => Promise.reject(new DockerApiError('no Docker socket found', 'unavailable'));

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

export function createDockerApi(
  opts: { socketPath?: string | null; transport?: DockerTransport; timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): DockerApi {
  const socketPath = opts.transport ? null : opts.socketPath !== undefined ? opts.socketPath : resolveRealDockerSocket(opts.env);
  const transport = opts.transport ?? (socketPath ? socketTransport(socketPath) : unavailable);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const enc = encodeURIComponent;

  return {
    socketPath,
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

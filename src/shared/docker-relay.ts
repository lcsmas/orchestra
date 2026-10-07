// Pure half of the keeper's Docker relay (#291, epic #284, ADR 0004): which API call is a container
// create, how its JSON body gets the ownership labels, where the relay socket lives and which real
// socket it forwards to. No I/O here, so `node --test` drives it without a daemon. The label KEYS live in
// docker-labels.ts (the frozen contract #292/#293 import).


/** `POST /containers/create`, with or without the `/v1.NN` version prefix (docker CLI, compose and client libs all
 *  create containers through this one call). */
const CONTAINER_CREATE = /^\/(?:v\d+(?:\.\d+)*\/)?containers\/create(?:\?|$)/;

export function isContainerCreate(method: string | undefined, url: string | undefined): boolean {
  return method === 'POST' && CONTAINER_CREATE.test(url ?? '');
}

// ── textual JSON surgery ─────────────────────────────────────────────────────────────────────────────────────────
// The create body is edited IN TEXT, never parsed and re-serialised: a JSON.parse/stringify round trip rewrites
// every integer above 2^53 (a compose `ulimits`/`memory` max such as 9223372036854775807 becomes 2^63 and Docker
// refuses the create) — a relay must never turn a working `docker run` into a failing one.

function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
  return i;
}

/** `s[i]` is `"`; returns the index just past the closing quote, or -1 when unterminated. */
function skipString(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
  }
  return -1;
}

/** Index just past the JSON value starting at `i`, or -1 when malformed. */
function skipValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return skipString(s, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const d = s[j];
      if (d === '"') {
        const e = skipString(s, j);
        if (e < 0) return -1;
        j = e - 1;
      } else if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }
  let j = i;
  while (j < s.length && !',}] \t\n\r'.includes(s[j])) j++;
  return j > i ? j : -1;
}

/**
 * Add `labels` to a container-create body, byte-identical everywhere else. Our keys are appended LAST inside
 * `Labels`, so a client-supplied `orchestra.ws` loses (the host's stamp is the truth of ownership). Null when the
 * body is not a JSON object we can edit with certainty — the caller then forwards it UNTOUCHED.
 */
export function stampContainerCreateBody(text: string, labels: Record<string, string>): string | null {
  let i = skipWs(text, 0);
  if (text[i] !== '{') return null;
  const open = i;
  i++;
  let labelsAt: { start: number; end: number } | null = null;
  let nonEmpty = false;
  for (;;) {
    i = skipWs(text, i);
    if (text[i] === '}') break;
    if (nonEmpty) {
      if (text[i] !== ',') return null;
      i = skipWs(text, i + 1);
    }
    if (text[i] !== '"') return null;
    const kEnd = skipString(text, i);
    if (kEnd < 0) return null;
    let key: string;
    try {
      key = JSON.parse(text.slice(i, kEnd)) as string;
    } catch {
      return null;
    }
    i = skipWs(text, kEnd);
    if (text[i] !== ':') return null;
    i = skipWs(text, i + 1);
    const vEnd = skipValue(text, i);
    if (vEnd < 0) return null;
    if (key === 'Labels') labelsAt = { start: i, end: vEnd };
    nonEmpty = true;
    i = vEnd;
  }
  if (skipWs(text, i + 1) !== text.length) return null; // trailing garbage after the object
  const entries = Object.entries(labels)
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',');
  if (!labelsAt) {
    return `${text.slice(0, open + 1)}"Labels":{${entries}}${nonEmpty ? ',' : ''}${text.slice(open + 1)}`;
  }
  const value = text.slice(labelsAt.start, labelsAt.end);
  let stamped: string;
  if (value === 'null') {
    stamped = `{${entries}}`;
  } else if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1);
    stamped = `{${inner}${inner.trim() === '' ? '' : ','}${entries}}`;
  } else {
    return null;
  }
  return text.slice(0, labelsAt.start) + stamped + text.slice(labelsAt.end);
}

/** Largest create body the relay buffers to stamp (a real one is a few KB); past it the call is refused with a 413. */
export const MAX_CREATE_BODY_BYTES = 64 * 1024 * 1024;

/**
 * The stamped create body as bytes, or null = "forward the original". Round-trips the UTF-8 first: a body that is not
 * valid UTF-8 would be rewritten by the decode, so it is left alone rather than risk corrupting it.
 */
export function stampCreateBodyBytes(body: Buffer, labels: Record<string, string>): Buffer | null {
  const text = body.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(body)) return null;
  const stamped = stampContainerCreateBody(text, labels);
  return stamped === null ? null : Buffer.from(stamped, 'utf8');
}

// ── socket path + upstream resolution ───────────────────────────────────────────────────────────────────────────

/** A unix socket path must stay under sun_path (108 incl. NUL); the keeper's own path is already ≤ 100. */
export const MAX_SOCKET_PATH_BYTES = 107;

/** The relay's socket sits beside the keeper's: `<ws>.sock` → `<ws>.docker.sock`. NEVER a `.pid` name —
 *  `listLiveKeepers` reads every `*.pid` in the keepers dir as a workspace id. */
export function relaySocketPath(keeperSock: string): string {
  return keeperSock.endsWith('.sock') ? `${keeperSock.slice(0, -'.sock'.length)}.docker.sock` : `${keeperSock}.docker`;
}

export type UpstreamResolution = { ok: true; socketPath: string; via: string } | { ok: false; reason: string };

export interface UpstreamDeps {
  /** `docker context inspect` endpoint host for the member's env; null when the CLI is missing or fails. */
  dockerContextHost(env: Record<string, string | undefined>): string | null;
  isSocket(p: string): boolean;
}

function unixPath(host: string): string | null {
  return host.startsWith('unix://') ? host.slice('unix://'.length) : null;
}

/**
 * Which REAL docker socket the relay forwards to — the one the member would have talked to without the relay, so
 * switching it on never redirects a member (a non-default `docker context` or a remote `DOCKER_HOST` is NOT silently
 * swapped for the local daemon: no relay, the member keeps its own endpoint and its containers stay unattributed).
 * Order: explicit `ORCHESTRA_DOCKER_SOCKET` → the member's `DOCKER_HOST` → its effective docker context → the default.
 */
export function resolveRelayUpstream(env: Record<string, string | undefined>, deps: UpstreamDeps): UpstreamResolution {
  let socketPath: string;
  let via: string;
  const explicit = env.ORCHESTRA_DOCKER_SOCKET?.trim();
  if (explicit) {
    socketPath = unixPath(explicit) ?? explicit;
    via = 'ORCHESTRA_DOCKER_SOCKET';
  } else if (env.DOCKER_HOST?.trim()) {
    const p = unixPath(env.DOCKER_HOST.trim());
    if (!p) return { ok: false, reason: `DOCKER_HOST=${env.DOCKER_HOST} is not a unix socket` };
    socketPath = p;
    via = 'DOCKER_HOST';
  } else {
    const host = deps.dockerContextHost(env);
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
  if (!deps.isSocket(socketPath)) return { ok: false, reason: `upstream ${socketPath} (${via}) is not a socket` };
  return { ok: true, socketPath, via };
}

// ── app-side decision ───────────────────────────────────────────────────────────────────────────────────────────

/** What the app hands the keeper's `spawn` frame; absent = no relay (the frame is then byte-identical to today). */
export interface DockerRelaySpec {
  runId: string;
}

/**
 * Does this session get a relay? Only a LOCAL keeper-hosted session (sandbox members live in a container and never
 * do), on a platform with unix sockets, whose run froze the `dockerRelay` switch ON. Any missing input = no relay.
 */
export function dockerRelayOffer(args: {
  remote: boolean;
  platform: string;
  runId: string | null | undefined;
  switchOn: boolean;
}): DockerRelaySpec | undefined {
  if (args.remote || args.platform === 'win32' || !args.switchOn) return undefined;
  const runId = args.runId?.trim();
  return runId ? { runId } : undefined;
}

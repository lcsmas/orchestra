// Pure half of the keeper's Docker relay (#291, epic #284, ADR 0004): which API call is a container
// create, how its JSON body gets the ownership labels, where the relay socket lives and which real
// socket it forwards to. No I/O here, so `node --test` drives it without a daemon. The label KEYS live in
// docker-labels.ts (the frozen contract #292/#293 import).

import type { DockerLimitOverrides, DockerLimits } from './docker-limits.ts';


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

interface Member {
  key: string;
  start: number;
  end: number;
}

/** The members of the JSON object whose `{` is at `open`: where each value sits (a duplicate key appears twice — Go's decoder, dockerd's, keeps the LAST) and the index of the closing `}`. Null = not an object we can edit with certainty. */
function scanObject(text: string, open: number): { members: Member[]; close: number } | null {
  if (text[open] !== '{') return null;
  let i = open + 1;
  const members: Member[] = [];
  for (;;) {
    i = skipWs(text, i);
    if (text[i] === '}') return { members, close: i };
    if (members.length) {
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
    members.push({ key, start: i, end: vEnd });
    i = vEnd;
  }
}

const lastOf = (members: Member[], key: string): Member | undefined => {
  for (let k = members.length - 1; k >= 0; k--) if (members[k].key === key) return members[k];
  return undefined;
};

/** One textual edit: replace `[start, end)` with `text` (an insertion has start === end). */
interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((x, y) => y.start - x.start || y.end - x.end)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** A JSON integer token as a BigInt (so 9223372036854775807 survives); null for `null`, a missing key, or anything that is not a plain integer. */
function intToken(text: string, m: Member | undefined): bigint | null {
  if (!m) return null;
  const t = text.slice(m.start, m.end);
  return /^-?\d+$/.test(t) ? BigInt(t) : null;
}

/** What the relay changed in a create's HostConfig: `set` = the client left the field unset (absent / null / 0 / -1 = no limit), `clamped` = the client asked for more than the ceiling. */
export interface LimitChange {
  field: 'Memory' | 'MemorySwap' | 'PidsLimit' | 'NanoCpus' | 'CpuShares';
  kind: 'set' | 'clamped';
  from: string | null;
  to: string;
}

export interface CreateRewrite {
  text: string;
  /** The `HostConfig.Memory` the daemon will get (null when no limits were asked for). The budget counts this one. */
  memoryBytes: bigint | null;
  /** The `HostConfig.NanoCpus` the daemon will get; 0n = none (the client set CpuQuota/CpuPeriod/CpuCount, which the relay leaves alone). */
  nanoCpus: bigint | null;
  changes: LimitChange[];
}

/**
 * Rewrite a container-create body, byte-identical everywhere the relay has nothing to say:
 *  • `labels` are appended LAST inside `Labels` (a client-supplied `orchestra.ws` loses — the host's stamp is the truth of ownership);
 *  • with `limits` (#695), `HostConfig.Memory` / `MemorySwap` / `PidsLimit` / `NanoCpus` are SET when the client left them unset
 *    (absent, null, 0, -1 — compose sends `"Memory":0,"PidsLimit":null`) and CLAMPED down to the ceiling when it asked for more.
 *    A smaller client value is kept (`CpuShares` — container CPU weight — is capped, never raised); unset `Memory`/`NanoCpus` get a quarter of the ceiling (so a stack fits the budget), an explicit ask may reach it; `NanoCpus` is left alone when the client set `CpuQuota`/`CpuPeriod`/`CpuCount` (dockerd refuses the mix).
 * Null when the body is not a JSON object we can edit with certainty — the caller then forwards it UNTOUCHED.
 */
export function rewriteContainerCreate(text: string, labels: Record<string, string>, limits?: DockerLimits | null): CreateRewrite | null {
  const open = skipWs(text, 0);
  const top = scanObject(text, open);
  if (!top) return null;
  if (skipWs(text, top.close + 1) !== text.length) return null; // trailing garbage after the object
  const edits: Edit[] = [];
  const prepend: string[] = []; // top-level members added when the key is absent
  const changes: LimitChange[] = [];
  let memoryBytes: bigint | null = null;
  let nanoCpus: bigint | null = null;

  const labelsAt = lastOf(top.members, 'Labels');
  const entries = Object.entries(labels)
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',');
  if (!labelsAt) {
    prepend.push(`"Labels":{${entries}}`);
  } else {
    const value = text.slice(labelsAt.start, labelsAt.end);
    if (value === 'null') {
      edits.push({ start: labelsAt.start, end: labelsAt.end, text: `{${entries}}` });
    } else if (value.startsWith('{') && value.endsWith('}')) {
      const inner = value.slice(1, -1);
      edits.push({ start: labelsAt.start, end: labelsAt.end, text: `{${inner}${inner.trim() === '' ? '' : ','}${entries}}` });
    } else {
      return null;
    }
  }

  if (limits) {
    const hc = lastOf(top.members, 'HostConfig');
    let hcMembers: Member[] = [];
    let hcOpen = -1;
    if (hc) {
      const v = text.slice(hc.start, hc.end);
      if (v !== 'null') {
        const scanned = scanObject(text, hc.start);
        if (!scanned) return null;
        hcMembers = scanned.members;
        hcOpen = hc.start;
      }
    }
    const ceilMem = BigInt(limits.memoryCeilingBytes);
    const fields: string[] = []; // the members to ADD to HostConfig (absent keys)
    const put = (field: LimitChange['field'], m: Member | undefined, cur: bigint | null, to: bigint, kind: 'set' | 'clamped'): void => {
      changes.push({ field, kind, from: cur === null ? null : String(cur), to: String(to) });
      if (m) edits.push({ start: m.start, end: m.end, text: String(to) });
      else fields.push(`"${field}":${to}`);
    };
    /** unset (null / ≤ 0) → the default; above the ceiling → the ceiling; else untouched. Returns the effective value. */
    const bound = (field: LimitChange['field'], cur: bigint | null, ceiling: bigint, dflt: bigint = ceiling): bigint => {
      const m = lastOf(hcMembers, field);
      if (cur === null || cur <= 0n) {
        put(field, m, cur, dflt, 'set');
        return dflt;
      }
      if (cur > ceiling) {
        put(field, m, cur, ceiling, 'clamped');
        return ceiling;
      }
      return cur;
    };

    const memory = bound('Memory', intToken(text, lastOf(hcMembers, 'Memory')), ceilMem, BigInt(limits.memoryDefaultBytes));
    memoryBytes = memory;
    // no swap: the swap figure is memory + swap, so it must equal Memory. A client value above Memory (some swap) is kept while it stays under the ceiling.
    const swapAt = lastOf(hcMembers, 'MemorySwap');
    const swap = intToken(text, swapAt);
    if (swap === null || swap < memory || swap > ceilMem) put('MemorySwap', swapAt, swap, memory, swap !== null && swap > ceilMem ? 'clamped' : 'set');
    bound('PidsLimit', intToken(text, lastOf(hcMembers, 'PidsLimit')), BigInt(limits.pidsLimit));
    const cpuMix = ['CpuQuota', 'CpuPeriod', 'CpuCount'].some((k) => (intToken(text, lastOf(hcMembers, k)) ?? 0n) > 0n);
    nanoCpus = cpuMix ? 0n : bound('NanoCpus', intToken(text, lastOf(hcMembers, 'NanoCpus')), BigInt(limits.nanoCpus), BigInt(limits.nanoCpusDefault));
    // low CPU priority under contention: unset (0) or above the cap → the cap
    bound('CpuShares', intToken(text, lastOf(hcMembers, 'CpuShares')), BigInt(limits.cpuShares));

    if (fields.length) {
      if (hcOpen >= 0) edits.push({ start: hcOpen + 1, end: hcOpen + 1, text: fields.join(',') + (hcMembers.length ? ',' : '') });
      else if (hc) edits.push({ start: hc.start, end: hc.end, text: `{${fields.join(',')}}` });
      else prepend.push(`"HostConfig":{${fields.join(',')}}`);
    }
  }
  if (prepend.length) edits.push({ start: open + 1, end: open + 1, text: prepend.join(',') + (top.members.length ? ',' : '') });
  return { text: applyEdits(text, edits), memoryBytes, nanoCpus, changes };
}

/** Add `labels` to a container-create body, byte-identical everywhere else (the #291 half of `rewriteContainerCreate`). */
export function stampContainerCreateBody(text: string, labels: Record<string, string>): string | null {
  return rewriteContainerCreate(text, labels)?.text ?? null;
}

/** Largest create body the relay buffers to stamp (a real one is a few KB); past it the call is refused with a 413. */
export const MAX_CREATE_BODY_BYTES = 64 * 1024 * 1024;

/**
 * The rewritten create body as bytes, or null = "forward the original". Round-trips the UTF-8 first: a body that is not
 * valid UTF-8 would be rewritten by the decode, so it is left alone rather than risk corrupting it.
 */
export function rewriteCreateBodyBytes(body: Buffer, labels: Record<string, string>, limits?: DockerLimits | null): (Omit<CreateRewrite, 'text'> & { body: Buffer }) | null {
  const text = body.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(body)) return null;
  const r = rewriteContainerCreate(text, labels, limits);
  return r === null ? null : { body: Buffer.from(r.text, 'utf8'), memoryBytes: r.memoryBytes, nanoCpus: r.nanoCpus, changes: r.changes };
}

export function stampCreateBodyBytes(body: Buffer, labels: Record<string, string>): Buffer | null {
  return rewriteCreateBodyBytes(body, labels)?.body ?? null;
}

/** The API version prefix of a create URL (`/v1.43` or ''), for the relay's own calls to the daemon. */
export function createUrlPrefix(url: string | undefined): string {
  return /^((?:\/v\d+(?:\.\d+)*)?)\/containers\/create/.exec(url ?? '')?.[1] ?? '';
}

// ── socket path + upstream resolution ───────────────────────────────────────────────────────────────────────────

/** sun_path is 108 bytes on Linux, 104 on macOS (incl. the NUL); the keeper's own path is already ≤ 100. */
export function maxSocketPathBytes(platform: string = process.platform): number {
  return platform === 'darwin' ? 103 : 107;
}

/** A keeper relay socket — `<ws>.docker.sock` in the keepers dir, or `okeeper-<hash>.docker.sock` in the tmpdir fallback
 *  (`keeperSocketPath`). NEVER a real daemon: neither the app nor another keeper's relay may forward to one (an inherited
 *  relay `DOCKER_HOST` would stack two relays and let the outer one's labels overwrite the inner's). */
export function isRelaySocketPath(p: string): boolean {
  return /\.docker\.sock$/.test(p.split('/').pop() ?? '');
}

/** The relay's socket sits beside the keeper's: `<ws>.sock` → `<ws>.docker.sock`. NEVER a `.pid` name —
 *  `listLiveKeepers` reads every `*.pid` in the keepers dir as a workspace id. */
export function relaySocketPath(keeperSock: string): string {
  return keeperSock.endsWith('.sock') ? `${keeperSock.slice(0, -'.sock'.length)}.docker.sock` : `${keeperSock}.docker`;
}

/** `daemonUp: false` = the path is where the member would reach its daemon but nothing listens there YET (dockerd not
 *  started, Docker Desktop closed): the relay still comes up and answers 502 until it appears (#291 F4) instead of
 *  leaving the member unattributed for the keeper's whole life. */
/** The file the keeper PUBLISHES its resolved upstream in (`<ws>.docker.upstream`, beside the relay socket; never `.pid`): the app asks it which daemon this member's
 *  containers were stamped on — the relay froze its upstream at spawn, the app's own resolution may have moved since (a `docker context use`, a relaunch with another env). */
export function relayUpstreamFile(keeperSock: string): string {
  return relaySocketPath(keeperSock).replace(/\.docker\.sock$/, '.docker.upstream');
}

/** The file the keeper PUBLISHES what its relay holds in (`<ws>.docker.hold`, #321; never `.pid`): the app's `bus-status` and the Admission notice read it. */
export function relayHoldFile(keeperSock: string): string {
  return relaySocketPath(keeperSock).replace(/\.docker\.sock$/, '.docker.hold');
}

export type UpstreamResolution = { ok: true; socketPath: string; via: string; daemonUp: boolean } | { ok: false; reason: string };

export interface UpstreamDeps {
  /** `docker context inspect` endpoint host for the member's env; null when the CLI is missing or fails. Async: the
   *  keeper must keep answering probes while the CLI runs. */
  dockerContextHost(env: Record<string, string | undefined>): Promise<string | null> | string | null;
  /** `socket` = a daemon socket is there; `missing` = ENOENT (may appear later); `other` = something else is in the way. */
  pathKind(p: string): 'socket' | 'missing' | 'other';
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
export async function resolveRelayUpstream(env: Record<string, string | undefined>, deps: UpstreamDeps): Promise<UpstreamResolution> {
  let socketPath: string;
  let via: string;
  const explicit = env.ORCHESTRA_DOCKER_SOCKET?.trim();
  // A DOCKER_HOST that is itself a relay socket (this shell was launched from another relay-ON member) is NOT the real
  // daemon: ignore it, and hide it from the context lookup (the default context would echo it back).
  const inherited = env.DOCKER_HOST?.trim();
  const relayShaped = !!inherited && isRelaySocketPath(inherited);
  if (explicit) {
    socketPath = unixPath(explicit) ?? explicit;
    via = 'ORCHESTRA_DOCKER_SOCKET';
  } else if (inherited && !relayShaped) {
    const p = unixPath(inherited);
    if (!p) return { ok: false, reason: `DOCKER_HOST=${inherited} is not a unix socket` };
    socketPath = p;
    via = 'DOCKER_HOST';
  } else {
    const ctxEnv = { ...env };
    delete ctxEnv.DOCKER_HOST;
    const host = await deps.dockerContextHost(ctxEnv);
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
  // never forward to (or query) another keeper's relay, whichever input named it (an explicit override, a docker context endpoint, DOCKER_HOST is handled above)
  if (isRelaySocketPath(socketPath)) return { ok: false, reason: `upstream ${socketPath} (${via}) is a keeper relay socket, not a daemon` };
  const kind = deps.pathKind(socketPath);
  if (kind === 'other') return { ok: false, reason: `upstream ${socketPath} (${via}) exists but is not a socket` };
  // "not up YET" is believed only when the member (or a docker context the CLI really read) NAMED the path. The built-in default is a GUESS — reached when the
  // context lookup failed (CLI timed out under load, missing, a podman shim): pinning DOCKER_HOST to a relay for a guessed path would break a member whose real endpoint is elsewhere.
  if (kind === 'missing' && via === 'default') return { ok: false, reason: `upstream ${socketPath} is not there and no docker context named another endpoint` };
  return { ok: true, socketPath, via, daemonUp: kind === 'socket' };
}

// ── app-side decision ───────────────────────────────────────────────────────────────────────────────────────────

/** What the app hands the keeper's `spawn` frame; absent = no relay (the frame is then byte-identical to today). */
export interface DockerRelaySpec {
  runId: string;
  /** #321 — the file the APP publishes the Admission hold state in (`<ORCHESTRA_HOME>/admission.state`); absent ⇒ the relay never holds (today's behaviour). */
  holdState?: string;
  /** #695 — the raise-the-limits setting (`<ORCHESTRA_HOME>/docker-limits.json`), read by the app at spawn and frozen here. */
  limits?: DockerLimitOverrides;
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
  holdState?: string;
  limits?: DockerLimitOverrides;
}): DockerRelaySpec | undefined {
  if (args.remote || args.platform === 'win32' || !args.switchOn) return undefined;
  const runId = args.runId?.trim();
  return runId ? { runId, ...(args.holdState ? { holdState: args.holdState } : {}), ...(args.limits && Object.keys(args.limits).length ? { limits: args.limits } : {}) } : undefined;
}

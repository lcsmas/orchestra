// Must-FAIL preflight for every keyring / libsecret rig (#389, LEAD ruling 2026-10-26 00:30 after the Q2 incident).
//
// A rig that starts a gnome-keyring-daemon or an app that may use libsecret runs inside its OWN `dbus-run-session` with a PRIVATE
// `XDG_RUNTIME_DIR` under the rig dir. This module is the pure rule set that PROVES that, from the rig's own world, before anything is started
// and again once its private bus / daemon are up — and refuses (violations, each naming its clause) when it cannot. It never touches the human's
// bus or keyring: every accessor is injected, the string rules fire BEFORE any filesystem access on a path that names the per-user runtime dir,
// and the real accessors (src/main/keyring-rig-preflight-host.ts) only ever address a bus address this module has already verified to be a
// socket (not a link) INSIDE the rig dir.
//
// Clauses: runtime-dir-scratch · rig-dir-no-mounts · bus-address-private · bus-socket-private · child-env-clean · bus-daemon-in-scratch ·
//          secrets-owner-in-scratch · owner-expected

import path from 'node:path';

export type Env = Record<string, string | undefined>;

export interface Violation {
  clause: string;
  detail: string;
}

export interface Verdict {
  ok: boolean;
  violations: Violation[];
  /** Clauses that were evaluated and held — a verdict with nothing evaluated is not a pass. */
  passed: string[];
}

export type NodeKind = 'socket' | 'symlink' | 'dir' | 'file' | 'other';

/** Every touch of the outside world, injected. The shared rules never call fs themselves. */
export interface Accessors {
  /** Resolve symlinks; null when the path does not exist. */
  realpath: (p: string) => string | null;
  /** lstat (NEVER follows a link): what the final path component is; null when missing. */
  kind: (p: string) => NodeKind | null;
  /** Mode bits and owner of a directory; null when missing / not a directory. */
  dirInfo: (p: string) => { mode: number; uid: number } | null;
  /** Small text file (a bus config); null when unreadable. */
  readText: (p: string) => string | null;
  /** Every mount point on the host (from /proc/self/mountinfo). */
  mountPoints: () => string[];
  uid: number;
}

// ── string rules: fire BEFORE any filesystem access ────────────────────────────────────────────────────────────────────────────────────

/** Any path under the per-user runtime dir (`/run/user[/…]`, `/var/run/user[/…]`): where the human's bus and keyring control socket live. */
const USER_RUNTIME_RE = /\/(?:var\/)?run\/user(?:\/|$)/;
/** `/proc/<pid|self|thread-self>/root` / `cwd` re-roots every absolute path — never a legitimate part of a rig path. */
const PROC_ROOT_RE = /\/proc\/(?:self|thread-self|\d+)\/(?:root|cwd)(?:\/|$)/;

/** True when `value` — read as a path, as a list of paths, collapsed, normalised, or percent-decoded — can name the per-user runtime dir. */
export function touchesUserRuntime(value: string | undefined): boolean {
  if (!value) return false;
  const variants = new Set<string>([value]);
  try {
    variants.add(decodeURIComponent(value));
  } catch { /* an undecodable % is judged as-is */ }
  for (const v of [...variants]) {
    for (const tok of v.split(/[:,;=\s]+/)) {
      if (tok.startsWith('/')) variants.add(path.posix.normalize(tok.replace(/\/{2,}/g, '/')));
    }
  }
  return [...variants].some((v) => USER_RUNTIME_RE.test(v) || PROC_ROOT_RE.test(v));
}

/** realpath that NEVER stats a path which names the per-user runtime dir, a system tree, or is relative (null instead): every string that comes from
 *  an env var or from /proc goes through here, so the real runtime dir is not even lstat'ed. */
export function safeReal(acc: Accessors, p: string | null | undefined): string | null {
  if (!p || !path.isAbsolute(p) || touchesUserRuntime(p)) return null;
  const r = acc.realpath(p);
  return r && !touchesUserRuntime(r) ? r : null;
}

/** True when `child` is `parent` or inside it (both already absolute). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A path that may never be the rig or its runtime dir: relative, system trees, anything naming the per-user runtime dir. */
function badRoot(p: string): string | null {
  if (!path.isAbsolute(p)) return `${p} is not an absolute path`;
  if (touchesUserRuntime(p)) return `${p} names the per-user runtime dir`;
  const n = path.resolve(p);
  if (/^\/(?:run|proc|sys|dev)(?:\/|$)/.test(n)) return `${p} is under a system runtime tree`;
  return null;
}

/** The ONE accepted address shape: a single `unix:path=<absolute path>` (optionally `,guid=<hex>`). No list, abstract, tcp, escapes, `disabled:`. */
export function parseUnixPathAddress(addr: string | undefined): string | null {
  const m = /^unix:path=([^,;%\s]+)(?:,guid=[0-9a-f]+)?$/.exec((addr ?? '').trim());
  return m && path.isAbsolute(m[1]) ? m[1] : null;
}

// ── the world of the rig's tools ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WorldInput {
  rigDir: string;
  /** The env the rig's tools (bus daemon, keyring daemon, gdbus oracle) run with. */
  env: Env;
  /** `false` BEFORE the rig has started its private bus (phase `pre`): the address is judged, the socket is not required yet. */
  requireBusSocket: boolean;
  acc: Accessors;
}

export interface WorldFacts {
  rigReal: string;
  runtimeReal: string;
  /** The verified private bus socket path (its parent is real, inside the scratch runtime dir). */
  busPath: string;
}

export interface WorldVerdict extends Verdict {
  facts: WorldFacts | null;
}

export function checkWorld(input: WorldInput): WorldVerdict {
  const v: Violation[] = [];
  const passed: string[] = [];
  const fail = (clause: string, detail: string) => v.push({ clause, detail });
  const { acc, env } = input;
  const done = (facts: WorldFacts | null): WorldVerdict => ({ ok: v.length === 0 && passed.length > 0 && facts !== null, violations: v, passed, facts });

  // rig dir + mounts
  const rigBad = badRoot(input.rigDir);
  if (rigBad) { fail('runtime-dir-scratch', `rig dir: ${rigBad}`); return done(null); }
  const rigReal = safeReal(acc, input.rigDir);
  if (!rigReal) { fail('runtime-dir-scratch', `rig dir ${input.rigDir} does not exist`); return done(null); }
  const rigRealBad = badRoot(rigReal);
  if (rigRealBad) { fail('runtime-dir-scratch', `rig dir resolves to ${rigReal}: ${rigRealBad}`); return done(null); }
  const mounts = acc.mountPoints().filter((m) => isInside(rigReal, m));
  if (mounts.length) fail('rig-dir-no-mounts', `mount point(s) inside the rig dir (a bind mount can alias the per-user runtime dir): ${mounts.join(', ')}`);
  else passed.push('rig-dir-no-mounts');

  // runtime-dir-scratch
  const runtime = env.XDG_RUNTIME_DIR;
  let runtimeReal: string | null = null;
  if (!runtime) fail('runtime-dir-scratch', 'XDG_RUNTIME_DIR is unset (a daemon would fall back to /run/user/<uid>)');
  else if (badRoot(runtime)) fail('runtime-dir-scratch', `XDG_RUNTIME_DIR: ${badRoot(runtime)}`);
  else {
    runtimeReal = safeReal(acc, runtime);
    if (!runtimeReal) fail('runtime-dir-scratch', `XDG_RUNTIME_DIR=${runtime} does not exist`);
    else if (badRoot(runtimeReal)) { fail('runtime-dir-scratch', `XDG_RUNTIME_DIR resolves to ${runtimeReal}: ${badRoot(runtimeReal)}`); runtimeReal = null; }
    else if (runtimeReal === rigReal || !isInside(rigReal, runtimeReal)) { fail('runtime-dir-scratch', `XDG_RUNTIME_DIR resolves to ${runtimeReal}, not strictly inside the rig dir ${rigReal}`); runtimeReal = null; }
    else {
      const info = acc.dirInfo(runtimeReal);
      if (!info || info.uid !== acc.uid || (info.mode & 0o077) !== 0) { fail('runtime-dir-scratch', `XDG_RUNTIME_DIR must be a 0700 directory owned by uid ${acc.uid}: ${JSON.stringify(info)}`); runtimeReal = null; }
      else passed.push('runtime-dir-scratch');
    }
  }

  // bus-address-private: ONE `unix:path=` inside the scratch runtime dir, whose final component is not a link
  const address = env.DBUS_SESSION_BUS_ADDRESS ?? '';
  const raw = parseUnixPathAddress(address);
  let busPath: string | null = null;
  if (!raw) fail('bus-address-private', `DBUS_SESSION_BUS_ADDRESS=${JSON.stringify(address)} is not a single absolute unix:path= address`);
  else if (touchesUserRuntime(address)) fail('bus-address-private', `DBUS_SESSION_BUS_ADDRESS names the per-user runtime dir: ${raw}`);
  else if (!runtimeReal) fail('bus-address-private', 'cannot judge the address without a valid scratch XDG_RUNTIME_DIR');
  else {
    const dirReal = safeReal(acc, path.dirname(raw));
    const base = path.basename(raw);
    if (!dirReal || !isInside(runtimeReal, dirReal)) fail('bus-address-private', `bus path ${raw} is not inside the scratch runtime dir ${runtimeReal}`);
    else if (base === '..' || base === '.' || base === '') fail('bus-address-private', `bus path ${raw} has no file name`);
    else {
      busPath = path.join(dirReal, base);
      const k = acc.kind(busPath);
      if (k === 'symlink') { fail('bus-address-private', `${busPath} is a symbolic link — it could lead anywhere`); busPath = null; }
      else passed.push('bus-address-private');
    }
  }

  // bus-socket-private (only once the address held, and once the bus is meant to be up)
  if (busPath && input.requireBusSocket) {
    if (acc.kind(busPath) !== 'socket') { fail('bus-socket-private', `${busPath} is not a socket (the private bus is not up)`); busPath = null; }
    else passed.push('bus-socket-private');
  }

  return done(busPath && runtimeReal ? { rigReal, runtimeReal, busPath } : null);
}

// ── the env of every child the rig starts ──────────────────────────────────────────────────────────────────────────────────────────────

/** Env vars that may carry a per-user-runtime path without being a keyring/bus handle: the rig's OWN compositor socket only. */
const ALLOWED_RUNTIME_VARS: Record<string, RegExp> = { WAYLAND_DISPLAY: /^\/(?:var\/)?run\/user\/\d+\/wayland-\d+$/ };
/** Vars that name the keyring control dir / agent sockets — fine only when they resolve inside the rig dir. */
const KEYRING_HANDLE_VARS = ['GNOME_KEYRING_CONTROL', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO'];
/** Vars that must resolve inside the rig dir whenever set: a daemon started without them falls back to the passwd home (`~/.local/share/keyrings`). */
const HOME_VARS = ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'];

export interface ChildEnvInput {
  rigRealDir: string;
  runtimeReal: string;
  env: Env;
  /** A TOOL needs the private address; an APP may have none (unset / empty / exactly `disabled:`) or the private one. No third kind: a keyring rig
   *  has no arm that keeps the real runtime dir. */
  kind: 'tool' | 'app';
  acc: Accessors;
}

export function checkChildEnv(input: ChildEnvInput, label = 'child'): Verdict {
  const v: Violation[] = [];
  const fail = (detail: string) => v.push({ clause: 'child-env-clean', detail: `${label}: ${detail}` });
  const { env, acc } = input;
  const inside = (p: string) => !touchesUserRuntime(p) && isInside(input.rigRealDir, safeReal(acc, p) ?? path.resolve(p));

  for (const [k, val] of Object.entries(env)) {
    if (val === undefined) continue;
    const allowed = ALLOWED_RUNTIME_VARS[k];
    if (touchesUserRuntime(val) && !(allowed && allowed.test(val))) fail(`${k}=${val} references the per-user runtime dir`);
  }
  if (env.DISPLAY !== undefined && env.DISPLAY !== '') fail(`DISPLAY=${env.DISPLAY} would reach the human's X11 session`);

  const rt = env.XDG_RUNTIME_DIR;
  if (rt === undefined || rt === '') fail('XDG_RUNTIME_DIR is unset: the child would resolve /run/user/<uid> itself');
  else if (safeReal(acc, rt) !== input.runtimeReal) fail(`XDG_RUNTIME_DIR=${rt} is not the rig's scratch runtime dir ${input.runtimeReal}`);

  for (const k of HOME_VARS) {
    const val = env[k];
    if (val === undefined || val === '') { if (k === 'HOME') fail('HOME is unset: a keyring daemon would use the passwd home (~/.local/share/keyrings)'); continue; }
    if (!path.isAbsolute(val) || touchesUserRuntime(val) || !inside(val)) fail(`${k}=${val} is not inside the rig dir`);
  }
  for (const k of KEYRING_HANDLE_VARS) {
    const val = env[k];
    if (val && (!path.isAbsolute(val.replace(/^unix:path=/, '')) || !inside(val.replace(/^unix:path=/, '')))) fail(`${k}=${val} is a keyring/agent handle outside the rig dir`);
  }
  for (const k of ['DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE']) if (env[k]) fail(`${k} must be unset`);
  const sys = env.DBUS_SYSTEM_BUS_ADDRESS;
  if (sys !== undefined && sys !== '' && sys !== 'disabled:') fail(`DBUS_SYSTEM_BUS_ADDRESS=${sys} must be unset or exactly disabled:`);

  const addr = env.DBUS_SESSION_BUS_ADDRESS;
  const raw = parseUnixPathAddress(addr);
  if (raw) {
    if (touchesUserRuntime(addr) || !isInside(input.runtimeReal, path.resolve(raw)) || acc.kind(raw) === 'symlink') fail(`DBUS_SESSION_BUS_ADDRESS=${addr} is not a private bus path inside the scratch runtime dir`);
  } else if (input.kind === 'tool') {
    fail(`a tool needs the private DBUS_SESSION_BUS_ADDRESS (one unix:path=), got ${JSON.stringify(addr)}`);
  } else if (!(addr === undefined || addr === '' || addr === 'disabled:')) {
    fail(`DBUS_SESSION_BUS_ADDRESS=${addr} is neither unset, exactly disabled:, nor the private unix:path= address`);
  }
  return { ok: v.length === 0, violations: v, passed: v.length === 0 ? ['child-env-clean'] : [] };
}

// ── who is on the private bus ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the rig learned about a process by asking the PRIVATE bus who owns a name, then reading /proc. */
export interface ProcFacts {
  pid: number;
  exe: string;
  cmdline: string[];
  /** XDG_RUNTIME_DIR from the process's original environment (null if unreadable). */
  runtimeDir: string | null;
}

export interface BusDaemonInput {
  rigRealDir: string;
  runtimeReal: string;
  /** The verified private bus socket path. */
  busPath: string;
  /** The process that answered as owner of org.freedesktop.DBus; null = unidentifiable. */
  busDaemon: ProcFacts | null;
  acc: Accessors;
}

/** The private bus daemon must be a dbus-daemon started with a config inside the rig dir that activates no host service. */
export function checkBusDaemon(input: BusDaemonInput): Verdict {
  const v: Violation[] = [];
  const fail = (detail: string) => v.push({ clause: 'bus-daemon-in-scratch', detail });
  const bd = input.busDaemon;
  if (!bd) fail('could not identify the private bus daemon');
  else {
    const i = bd.cmdline.findIndex((a) => a === '--config-file' || a.startsWith('--config-file='));
    const cfg = i < 0 ? undefined : bd.cmdline[i] === '--config-file' ? bd.cmdline[i + 1] : bd.cmdline[i].slice('--config-file='.length);
    const cfgReal = safeReal(input.acc, cfg);
    const text = cfgReal ? input.acc.readText(cfgReal) : null;
    const rt = safeReal(input.acc, bd.runtimeDir);
    if (!/(?:^|\/)dbus-daemon$/.test(bd.exe)) fail(`the bus daemon is ${bd.exe}, not a dbus-daemon`);
    else if (!cfgReal || !isInside(input.rigRealDir, cfgReal)) fail(`the bus daemon's --config-file is ${cfg ?? '(none)'}: not a config inside the rig dir (it would activate host services)`);
    else if (bd.cmdline.some((a) => touchesUserRuntime(a))) fail(`the bus daemon's argv references the per-user runtime dir: ${bd.cmdline.join(' ')}`);
    else if (!rt || rt !== input.runtimeReal) fail(`the bus daemon runs with XDG_RUNTIME_DIR=${bd.runtimeDir ?? '(unreadable)'}, not the scratch ${input.runtimeReal}`);
    else if (text === null) fail(`the bus config ${cfgReal} is unreadable`);
    else if (/standard_(?:session|system)_servicedirs|<include|<includedir/.test(text)) fail(`the bus config includes the standard / host service dirs: ${cfgReal}`);
    else if (![...text.matchAll(/<servicedir>([^<]+)<\/servicedir>/g)].every((m) => isInside(input.rigRealDir, path.resolve(m[1].trim())))) fail(`the bus config has a <servicedir> outside the rig dir: ${cfgReal}`);
    else {
      const listens = [...text.matchAll(/<listen>([^<]+)<\/listen>/g)].map((m) => m[1].trim());
      if (listens.length !== 1 || parseUnixPathAddress(listens[0]) !== input.busPath) fail(`the bus config must listen on exactly the private socket ${input.busPath}, got ${JSON.stringify(listens)}`);
    }
  }
  return { ok: v.length === 0, violations: v, passed: v.length === 0 ? ['bus-daemon-in-scratch'] : [] };
}

/** What asking the private bus about `org.freedesktop.secrets` produced. */
export type SecretsAnswer =
  | { state: 'none' }
  | { state: 'inconclusive'; why: string }
  | { state: 'owner'; proc: ProcFacts | null };

export interface SecretsInput {
  rigRealDir: string;
  runtimeReal: string;
  answer: SecretsAnswer;
  /** true: this arm starts a keyring daemon; false: a no-service arm; null: the daemon is not started yet (phase `bus`) — not evaluated. */
  expectOwner: boolean | null;
  acc: Accessors;
}

export function checkSecretsOwner(input: SecretsInput): Verdict {
  const v: Violation[] = [];
  const passed: string[] = [];
  const a = input.answer;
  if (input.expectOwner === null) return { ok: true, violations: [], passed: [] };
  if (a.state === 'inconclusive') v.push({ clause: 'owner-expected', detail: `the owner lookup on the private bus was inconclusive (${a.why}) — failing closed` });
  else if (!input.expectOwner) {
    if (a.state === 'owner') v.push({ clause: 'owner-expected', detail: `this arm expects NO Secret Service, but ${a.proc ? `pid ${a.proc.pid} (${a.proc.exe})` : 'an unidentifiable process'} owns org.freedesktop.secrets on the private bus` });
    else passed.push('owner-expected');
  } else if (a.state === 'none') {
    v.push({ clause: 'owner-expected', detail: 'org.freedesktop.secrets has no owner on the private bus, but this arm starts a keyring daemon' });
  } else {
    passed.push('owner-expected');
    const o = a.proc;
    const rt = safeReal(input.acc, o?.runtimeDir);
    if (!o) v.push({ clause: 'secrets-owner-in-scratch', detail: 'the owner of org.freedesktop.secrets could not be identified (its /proc entry is unreadable)' });
    else if (!/(?:^|\/)gnome-keyring-d(?:aemon)?$/.test(o.exe)) v.push({ clause: 'secrets-owner-in-scratch', detail: `the secrets owner is ${o.exe}, not the rig's gnome-keyring-daemon` });
    else if (!rt || rt !== input.runtimeReal) v.push({ clause: 'secrets-owner-in-scratch', detail: `the secrets owner pid ${o.pid} runs with XDG_RUNTIME_DIR=${o.runtimeDir ?? '(unreadable)'}, not the scratch ${input.runtimeReal} — it is NOT the rig's own daemon` });
    else if (o.cmdline.some((x) => touchesUserRuntime(x))) v.push({ clause: 'secrets-owner-in-scratch', detail: `the secrets owner's argv references the per-user runtime dir: ${o.cmdline.join(' ')}` });
    else passed.push('secrets-owner-in-scratch');
  }
  return { ok: v.length === 0 && passed.length > 0, violations: v, passed };
}

/** Merge verdicts: ok only when every part is ok and at least one clause was evaluated. */
export function combine(...parts: Verdict[]): Verdict {
  const violations = parts.flatMap((p) => p.violations);
  const passed = parts.flatMap((p) => p.passed);
  return { ok: violations.length === 0 && passed.length > 0, violations, passed };
}

export function formatVerdict(v: Verdict): string {
  return v.ok ? `PREFLIGHT OK: ${v.passed.join(', ')}` : `PREFLIGHT ABORT: ${v.violations.map((x) => `[${x.clause}] ${x.detail}`).join(' | ')}`;
}

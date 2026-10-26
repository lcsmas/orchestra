// Pure world checks for the #389 keyring rig (scripts/e2e-keyring.mjs). NO fs, NO process, NO network: the driver gathers facts, these
// decide. They exist because a keyring rig is the one rig that STARTS a gnome-keyring-daemon, and the human's own daemon aborted twice after a
// rig Electron held a PKCS#11 session with it (incident Q2, ledger #405): every arm must live in a private runtime dir, on a private bus, and
// the rig must be able to PROVE that nothing in its processes, env or fds names the human's runtime dir. This file is the one place that
// names that path, to refuse it.

/** The human's runtime dir for `uid` — named only so it can be refused. */
export const humanRuntimeDir = (uid: number): string => `/run/user/${uid}`;

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

/** Lexical normalisation (`//`, `/./`, `x/..` collapse) so `/run//user/1`, `/run/./user/1` and `/run/x/../user/1` cannot slip a substring test. */
export function normPath(p: string): string {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}

const HUMAN_RT = /(^|\/)run\/user(\/|$)/;

const referencesLiteral = (value: string): boolean =>
  HUMAN_RT.test(normPath(value)) || value.split(/[:=,;\s]+/).some((piece) => piece.includes('/') && HUMAN_RT.test(normPath(piece)));

/** The value and its `%hh`-decoded forms (D-Bus addresses escape bytes that way: `unix:path=%2Frun%2Fuser%2F1000%2Fbus`; up to 3 rounds for a double
 *  encoding). null = a malformed escape (`50%`, `%zz`, a non-UTF-8 byte): not something to guess about. */
function decodedForms(value: string): string[] | null {
  const forms = [value];
  let cur = value;
  if (cur.includes('%')) {
    try { cur = decodeURIComponent(cur); } catch { return null; }
    forms.push(cur);
    // a further round only while a well-formed escape remains (`%252F` → `%2F` → `/`); a lone `%` left by `%25` is a literal percent, not malformed
    for (let i = 0; i < 2 && /%[0-9a-fA-F]{2}/.test(cur); i++) {
      try { cur = decodeURIComponent(cur); } catch { return null; }
      forms.push(cur);
    }
  }
  return forms;
}

/** Does this env/fd/argv value reach under `/run/user/…` — as a path, inside `unix:path=…`, in a `:`-list, in a `file://` URL, `%hh`-escaped?
 *  A malformed escape FAILS CLOSED (counts as a reference): this is the check that decides whether a keyring rig may start. */
export function referencesHumanRuntime(value: string): boolean {
  const forms = decodedForms(value);
  return forms === null || forms.some(referencesLiteral);
}

/** Keys of `env` whose value reaches the human's runtime dir. */
export const envHumanRuntimeRefs = (env: Record<string, string | undefined>): string[] =>
  Object.entries(env)
    .filter(([, v]) => typeof v === 'string' && referencesHumanRuntime(v))
    .map(([k]) => k)
    .sort();

/** sockaddr_un.sun_path is 108 bytes including the NUL. */
export const SUN_PATH_MAX = 107;
/** The longest socket an arm creates: the app's hooks socket (`/orchestra-<12hex>.sock`, 28), the daemon's `keyring/control`/`pkcs11`, the bus. */
export const longestSocket = (run: string): number => Math.max(`${run}/orchestra-xxxxxxxxxxxx.sock`.length, `${run}/keyring/control`.length, `${run}/bus`.length);

const under = (p: string, dir: string): boolean => {
  const n = normPath(p);
  const d = normPath(dir);
  return n.startsWith(d + '/');
};

// ── 1. the driver's own world (the contained rig exports it; the driver re-proves it before doing anything) ─────────────────────

export interface MountEntry {
  id: number;
  parent: number;
  point: string;
  /** optional propagation fields (`shared:N`, `master:N`, …) */
  tags: string[];
  fstype: string;
}

/** `/proc/self/mountinfo` → entries (`id parent maj:min root point opts [tags…] - fstype source superopts`); unparseable lines are skipped (the proof then simply lacks them). */
export function parseMountinfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const head = line.slice(0, sep).split(' ');
    const tail = line.slice(sep + 3).split(' ');
    const id = Number(head[0]), parent = Number(head[1]);
    if (!Number.isInteger(id) || !Number.isInteger(parent) || head.length < 6 || !tail[0]) continue;
    out.push({ id, parent, point: head[4], tags: head.slice(6), fstype: tail[0] });
  }
  return out;
}

/** The hidden-world PROOF, from the mount namespace itself (a pure read of /proc/self/mountinfo — no bus, no socket, no stat of the dir): the env
 *  variable the rig sets is only the cheap precondition. In the hidden world `bwrap --tmpfs` stacks a FRESH, private tmpfs over the human's
 *  runtime-dir mount. So: ≥ 2 mounts at the point, the topmost is a tmpfs with no propagation tags (the real mount is `shared:`/`master:`), and
 *  nothing is mounted on top of the hiding tmpfs (a re-bind of the real dir would re-expose it). On the host there is exactly ONE mount there. */
export function hiddenRuntimeMountProof(mountinfo: string, uid: number): { ok: boolean; detail: string } {
  const point = humanRuntimeDir(uid);
  const all = parseMountinfo(mountinfo);
  const here = all.filter((m) => m.point === point);
  if (here.length === 0) return { ok: false, detail: `no mount at ${point} in this namespace's mountinfo` };
  if (here.length < 2) return { ok: false, detail: `${here.length} mount at ${point} (the host's own) — nothing hides it in this namespace` };
  const top = here.find((m) => !here.some((o) => o.parent === m.id));
  if (!top) return { ok: false, detail: `mounts at ${point} form no stack` };
  if (top.fstype !== 'tmpfs') return { ok: false, detail: `the topmost mount at ${point} is ${top.fstype}, not a tmpfs` };
  if (top.tags.length > 0) return { ok: false, detail: `the topmost tmpfs carries propagation tags ${top.tags.join(' ')} — a propagated mount, not a private one` };
  const onTop = all.filter((m) => m.parent === top.id);
  if (onTop.length > 0) return { ok: false, detail: `${onTop.map((m) => m.point).join(', ')} is mounted ON the hiding tmpfs` };
  return { ok: true, detail: `${here.length} mounts stacked at ${point}; topmost = private tmpfs (mount ${top.id}), nothing mounted on it` };
}

export interface DriverWorldFacts {
  rigDir: string | undefined;
  /** The driver's own env (a plain object), exactly as received. */
  env: Record<string, string | undefined>;
  /** Whether `${rigDir}/no-session-bus` exists — gathered by the driver from the RIG's dir, never from the env's address. */
  noBusExists: boolean;
  /** `RIG_HIDDEN_WORLD=1`: the rig re-exec'd inside the mount namespace where the human's runtime dir is an empty tmpfs. */
  hiddenWorld: boolean;
  /** `/proc/self/mountinfo` text of this process, or null when unreadable. */
  mountinfo: string | null;
  uid: number;
}

export function driverWorldChecks(f: DriverWorldFacts): Check[] {
  const { rigDir, env } = f;
  const xdg = env.XDG_RUNTIME_DIR ?? '';
  const dbus = env.DBUS_SESSION_BUS_ADDRESS ?? '';
  const wl = env.WAYLAND_DISPLAY ?? '';
  const refs = envHumanRuntimeRefs(env);
  const rig = rigDir ?? '';
  return [
    { id: 'rig-dir-set', ok: rig !== '' && rig.startsWith('/') && !referencesHumanRuntime(rig), detail: `RIG_DIR=${rig || '<unset>'}` },
    { id: 'xdg-is-the-rigs-private-dir', ok: rig !== '' && xdg === `${rig}/xdg` && !referencesHumanRuntime(xdg), detail: `XDG_RUNTIME_DIR=${xdg || '<unset>'} (want ${rig}/xdg)` },
    { id: 'dbus-is-the-rigs-nonexistent-address', ok: rig !== '' && dbus === `unix:path=${rig}/no-session-bus` && !f.noBusExists, detail: `DBUS_SESSION_BUS_ADDRESS=${dbus || '<unset>'}; ${rig}/no-session-bus exists: ${f.noBusExists}` },
    { id: 'no-env-value-reaches-the-human-runtime', ok: refs.length === 0, detail: refs.length ? `env keys naming it: ${refs.join(', ')}` : 'none of the driver env values names it' },
    { id: 'display-is-a-bare-private-name', ok: wl !== '' && !wl.includes('/') && env.DISPLAY === undefined, detail: `WAYLAND_DISPLAY=${wl || '<unset>'} DISPLAY=${env.DISPLAY ?? '<unset>'}` },
    { id: 'hidden-world', ok: f.hiddenWorld, detail: f.hiddenWorld ? 'RIG_HIDDEN_WORLD=1 (the human runtime dir is an empty tmpfs in this namespace)' : 'RIG_HIDDEN_WORLD is not 1 — this rig runs only inside the hidden world (scripts/e2e-keyring.sh sets RIG_HIDE_REAL_RUNTIME=1)' },
    (() => {
      const m = f.mountinfo === null ? { ok: false, detail: '/proc/self/mountinfo unreadable' } : hiddenRuntimeMountProof(f.mountinfo, f.uid);
      return { id: 'hidden-world-mount-proof', ok: m.ok, detail: m.detail };
    })(),
  ];
}

export interface PhysicalFacts {
  rigDir: string;
  /** realpath of the rig dir / of XDG_RUNTIME_DIR, null when it does not resolve. */
  rigReal: string | null;
  xdgReal: string | null;
  /** env key → the physical forms (realpath, symlink target) of every absolute path piece its value names (gathered only AFTER the lexical checks passed). */
  envPhysical: Record<string, string[]>;
}

/** The LEXICAL checks pass `<rig>/xdg -> /run/user/1000`, a symlinked RIG_DIR, or an env value that is a link into it. These read the same facts
 *  physically (the shipped wrapper's R3/R7 do the same): the rig's private runtime dir must be a real directory right under the real rig dir. */
export function physicalWorldChecks(f: PhysicalFacts): Check[] {
  const leaks = Object.entries(f.envPhysical).filter(([, forms]) => forms.some(referencesHumanRuntime)).map(([k]) => k).sort();
  return [
    { id: 'rig-dir-resolves-physically-clean', ok: f.rigReal !== null && !referencesHumanRuntime(f.rigReal), detail: `realpath(RIG_DIR) = ${f.rigReal ?? '<does not resolve>'}` },
    { id: 'xdg-is-physically-the-rigs-dir', ok: f.rigReal !== null && f.xdgReal !== null && f.xdgReal === `${f.rigReal}/xdg` && !referencesHumanRuntime(f.xdgReal), detail: `realpath(XDG_RUNTIME_DIR) = ${f.xdgReal ?? '<does not resolve>'} (want ${f.rigReal ?? '?'}/xdg — a symlink anywhere in it differs)` },
    { id: 'env-path-values-resolve-physically-clean', ok: leaks.length === 0, detail: leaks.length ? `env keys whose value is a link/path into it: ${leaks.join(', ')}` : `${Object.keys(f.envPhysical).length} path-valued env keys resolve physically clean` },
  ];
}

// ── 2. one arm's world ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ArmWorld {
  rigDir: string;
  /** The arm's private XDG_RUNTIME_DIR (holds ITS bus socket + the keyring daemon's control/pkcs11 sockets). */
  run: string;
  /** Every other dir the arm owns (home, ORCHESTRA_HOME, data/config/cache, claude config, the arm dir itself). */
  dirs: Record<string, string>;
  address: string;
  /** The env of each process class the arm starts (bus daemon, keyring daemon/oracle tooling, the app). */
  envs: Record<string, Record<string, string | undefined>>;
}

export function armWorldChecks(w: ArmWorld): Check[] {
  const xdgRoot = `${w.rigDir}/xdg`;
  const outside = Object.entries(w.dirs).filter(([, d]) => !under(d, w.rigDir)).map(([k]) => k);
  const leaks = Object.entries(w.envs).flatMap(([cls, env]) => envHumanRuntimeRefs(env).map((k) => `${cls}.${k}`));
  const xdgs = Object.entries(w.envs).filter(([, env]) => env.XDG_RUNTIME_DIR !== w.run).map(([cls]) => cls);
  const addrs = Object.entries(w.envs).filter(([, env]) => env.DBUS_SESSION_BUS_ADDRESS !== undefined && env.DBUS_SESSION_BUS_ADDRESS !== w.address && env.DBUS_SESSION_BUS_ADDRESS !== 'disabled:').map(([cls]) => cls);
  return [
    { id: 'run-is-a-private-subdir-of-the-rig-runtime', ok: under(w.run, xdgRoot) && !referencesHumanRuntime(w.run), detail: `${w.run} under ${xdgRoot}` },
    { id: 'every-arm-dir-is-inside-the-rig-dir', ok: outside.length === 0, detail: outside.length ? `outside ${w.rigDir}: ${outside.join(', ')}` : `${Object.keys(w.dirs).length} dirs under ${w.rigDir}` },
    { id: 'bus-address-is-inside-the-arm-runtime', ok: w.address === `unix:path=${w.run}/bus`, detail: `${w.address}` },
    { id: 'no-process-env-names-the-human-runtime', ok: leaks.length === 0, detail: leaks.length ? `leaking: ${leaks.join(', ')}` : `${Object.keys(w.envs).join('/')} envs clean` },
    { id: 'every-process-class-has-the-arms-runtime', ok: xdgs.length === 0, detail: xdgs.length ? `XDG_RUNTIME_DIR differs in: ${xdgs.join(', ')}` : `XDG_RUNTIME_DIR=${w.run} in every class` },
    { id: 'arm-socket-paths-fit-sun-path', ok: longestSocket(w.run) <= SUN_PATH_MAX, detail: `longest socket path in this arm: ${longestSocket(w.run)} chars (limit ${SUN_PATH_MAX}: the hooks socket \`${w.run}/orchestra-<12hex>.sock\`)` },
    { id: 'no-process-class-carries-a-foreign-bus-address', ok: addrs.length === 0, detail: addrs.length ? `foreign DBUS_SESSION_BUS_ADDRESS in: ${addrs.join(', ')}` : 'only the arm bus (or none / `disabled:`)' },
  ];
}

/** The private session-bus config must list NO host service dirs (a host service would be D-Bus-activated INTO the rig): exactly one
 *  `<servicedir>` — the arm's own, empty — and nothing that pulls in the standard dirs or another file. */
export function busConfigChecks(conf: string, want: { svc: string; address: string }): Check[] {
  const tags = (re: RegExp): string[] => [...conf.matchAll(re)].map((m) => m[1]);
  const listen = tags(/<listen>([^<]*)<\/listen>/g);
  const svc = tags(/<servicedir>([^<]*)<\/servicedir>/g);
  const pulls = conf.match(/<(standard_session_servicedirs|standard_system_servicedirs|include|includedir|servicehelper)\b/g) ?? [];
  return [
    { id: 'bus-listens-only-on-the-arm-socket', ok: listen.length === 1 && listen[0] === want.address, detail: `listen: ${JSON.stringify(listen)}` },
    { id: 'bus-service-dir-is-only-the-arms-empty-dir', ok: svc.length === 1 && svc[0] === want.svc, detail: `servicedir: ${JSON.stringify(svc)}` },
    { id: 'bus-config-pulls-in-nothing-else', ok: pulls.length === 0, detail: pulls.length ? `pulls in: ${pulls.join(', ')}` : 'no standard dirs / includes / service helper' },
    { id: 'bus-is-a-session-bus', ok: /<type>session<\/type>/.test(conf), detail: '<type>session</type>' },
  ];
}

// ── 3. who owns org.freedesktop.secrets on the arm's private bus ──────────────────────────────────────────────────────────

export interface UnixSocket {
  inode: number;
  path: string;
}

/** `/proc/net/unix` → sockets that have a path (columns: Num RefCount Protocol Flags Type St Inode Path). */
export function parseUnixSockets(text: string): UnixSocket[] {
  const out: UnixSocket[] = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const inode = Number(cols[6]);
    const p = cols.slice(7).join(' ');
    if (Number.isInteger(inode) && p.startsWith('/')) out.push({ inode, path: p });
  }
  return out;
}

export interface SsSocket {
  localPath: string | null;
  localIno: number;
  peerIno: number;
}

/** `ss -xnaeH` rows (`Netid State Recv-Q Send-Q <local path|*> <local inode> <peer path|*> <peer inode> <-> …`). A listener has a local path; the
 *  ACCEPTED end of a connection carries the listener's path; a client's own end has `*` — its peer's inode is the way to the path it reached. */
const SS_ROW = /^\S+\s+\S+\s+\d+\s+\d+\s+(.+?)\s+(\d+)\s+(\*|.+?)\s+(\d+)(?:\s+(?:<->|-->|<--|---)(?:\s.*)?)?$/; // the trailing marker is the shutdown state: `<->`, `-->`, `<--` or `---` (measured on this host)

/** Rows of `ss -xnaeH`; a path may contain spaces (`/run/user/1000/my sock`). Lines that do not parse are returned in `unparsed` — the caller must
 *  fail CLOSED on any: a row that silently disappears is a connection the scan cannot see. */
export function parseSsStrict(text: string): { rows: SsSocket[]; unparsed: string[] } {
  const rows: SsSocket[] = [];
  const unparsed: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const m = SS_ROW.exec(line);
    if (m) rows.push({ localPath: m[1] === '*' ? null : m[1], localIno: Number(m[2]), peerIno: Number(m[4]) });
    else unparsed.push(line.slice(0, 160));
  }
  return { rows, unparsed };
}

/** {@link parseSsStrict}, rows only (for tests / callers that handle `unparsed` themselves). */
export const parseSs = (text: string): SsSocket[] => parseSsStrict(text).rows;

/** The paths a process's socket fds are bound to or connected to: for each socket inode, its own bound path and the path its peer end is bound to.
 *  (`/proc/<pid>/fd` shows a socket only as `socket:[N]`, never a path — so a fd scan by path alone cannot see a connection.) */
export function socketPaths(inodes: readonly number[], ss: readonly SsSocket[]): string[] {
  const byIno = new Map(ss.map((x) => [x.localIno, x]));
  const out = new Set<string>();
  for (const i of inodes) {
    const x = byIno.get(i);
    if (!x) continue;
    if (x.localPath) out.add(x.localPath);
    const peer = byIno.get(x.peerIno);
    if (peer?.localPath) out.add(peer.localPath);
  }
  return [...out].sort();
}

/** `socket:[12345]` (a /proc/<pid>/fd link target) → 12345. */
export const socketInode = (fdTarget: string): number | null => {
  const m = /^socket:\[(\d+)\]$/.exec(fdTarget);
  return m ? Number(m[1]) : null;
};

export interface OwnerEvidence {
  /** pid the PRIVATE bus reports for the owner of org.freedesktop.secrets (SO_PEERCRED of its own connection). */
  ownerPid: number | null;
  driverPid: number;
  /** basename of /proc/<pid>/exe */
  exeBase: string;
  cmdline: string[];
  /** /proc/<pid>/fd link targets of that pid. */
  fdTargets: string[];
  /** KEY=value entries of its environ when readable (empty when not). */
  envEntries: string[];
  /** unix sockets listed in /proc/net/unix (host-wide list; only the ones under the arm's run dir are used). */
  sockets: UnixSocket[];
  /** Paths its socket fds are bound / connected to ({@link socketPaths}). */
  socketPaths: string[];
  run: string;
}

export function secretsOwnerChecks(e: OwnerEvidence): Check[] {
  const mine = new Set(e.sockets.filter((s) => under(s.path, `${e.run}/keyring`)).map((s) => s.inode)); // the daemon's control/pkcs11/ssh sockets — not the bus socket it merely connects to
  const held = e.fdTargets.map(socketInode).filter((i): i is number => i !== null && mine.has(i));
  const sockFds = e.fdTargets.map(socketInode).filter((i) => i !== null).length;
  const refs = [...e.fdTargets, ...e.socketPaths, ...e.envEntries, ...e.cmdline].filter(referencesHumanRuntime);
  const xdgEntry = e.envEntries.find((x) => x.startsWith('XDG_RUNTIME_DIR='));
  return [
    { id: 'owner-found-on-the-private-bus', ok: e.ownerPid !== null && e.ownerPid > 1 && e.ownerPid !== e.driverPid, detail: `owner pid ${e.ownerPid}` },
    { id: 'owner-is-gnome-keyring-daemon', ok: e.exeBase === 'gnome-keyring-daemon' && e.cmdline.some((a) => a.endsWith('gnome-keyring-daemon')), detail: `exe ${e.exeBase}, argv ${JSON.stringify(e.cmdline)}` },
    { id: 'owner-listens-inside-the-arm-keyring-dir', ok: held.length > 0, detail: `holds ${held.length} socket(s) bound under ${e.run}/keyring (arm keyring sockets: ${mine.size})` },
    { id: 'owner-socket-scan-sees-its-own-sockets', ok: sockFds === 0 || e.socketPaths.some((x) => under(x, e.run)), detail: `${sockFds} socket fd(s); resolved socket paths under ${e.run}: ${e.socketPaths.filter((x) => under(x, e.run)).length} — an owner that holds sockets but resolves to none means the scan saw nothing, so the next clause would be vacuous` },
    { id: 'owner-env-and-fds-never-name-the-human-runtime', ok: refs.length === 0, detail: refs.length ? `names it: ${refs.slice(0, 3).join(' | ')}` : `${e.fdTargets.length} fds (${e.socketPaths.length} socket path(s) resolved), ${e.envEntries.length} env entries clean` },
    { id: 'owner-runtime-env-is-the-arms', ok: xdgEntry === undefined || xdgEntry === `XDG_RUNTIME_DIR=${e.run}`, detail: xdgEntry ?? 'environ not readable (daemon rewrote its title)' },
  ];
}

// ── 4. the app's process tree and the rig root ────────────────────────────────────────────────────────────────────────────

export interface TreeEvidence {
  pids: number;
  fdTargets: string[];
  /** Paths the tree's socket fds are bound / connected to ({@link socketPaths}) — the only way a connection to a keyring / bus socket is visible. */
  socketPaths: string[];
  envEntries: string[];
  run: string;
}

export function treeChecks(t: TreeEvidence): Check[] {
  const refs = [...t.fdTargets, ...t.socketPaths, ...t.envEntries].filter(referencesHumanRuntime);
  const sawPrivate = t.socketPaths.some((x) => under(x, t.run)); // the app's own hooks socket lives there: a scan that resolves sockets MUST see it
  return [
    { id: 'tree-has-processes', ok: t.pids >= 3, detail: `${t.pids} processes in the app tree` },
    { id: 'tree-fds-and-env-never-name-the-human-runtime', ok: refs.length === 0, detail: refs.length ? `names it: ${refs.slice(0, 3).join(' | ')}` : `${t.fdTargets.length} fds (${t.socketPaths.length} socket path(s) resolved) + ${t.envEntries.length} env entries across ${t.pids} processes clean` },
    { id: 'tree-scan-sees-the-private-runtime-dir', ok: sawPrivate, detail: sawPrivate ? `positive control: a socket bound/connected under ${t.run}: ${t.socketPaths.filter((x) => under(x, t.run)).slice(0, 2).join(', ')}` : `no socket under ${t.run} — the scan could not have seen a leak either` },
  ];
}

/** The rig's own runtime dir (`<rig>/xdg`) may hold only the compositor's wayland sockets/alias and the arms' sub-dirs: a `keyring`/`bus`/
 *  `p11-kit`/`pulse` entry, or an app hooks socket, means something took the rig root as ITS XDG_RUNTIME_DIR. */
export function rootCensusChecks(entries: readonly string[], armDirs: readonly string[]): Check[] {
  const ok = (n: string): boolean => /^wayland-/.test(n) || armDirs.includes(n);
  const stray = entries.filter((n) => !ok(n));
  return [{ id: 'rig-runtime-root-holds-only-wayland-and-arm-dirs', ok: stray.length === 0, detail: stray.length ? `stray entries: ${stray.join(', ')}` : `entries: ${entries.join(' ') || '<none>'}` }];
}

export const failed = (checks: readonly Check[]): Check[] => checks.filter((c) => !c.ok);

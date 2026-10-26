// The impure half of the keyring-rig preflight (#389): real filesystem / /proc accessors, the ONE question put to the PRIVATE bus ("who is the bus
// daemon; who owns org.freedesktop.secrets?"), the phase markers, and the self-test every rig runs first. The rule set is
// shared/keyring-rig-preflight.ts.
//
// HARD RULE: nothing here opens `/run/user/<uid>/bus` or `/run/user/<uid>/keyring/control`, and nothing even STATS a path that names the per-user
// runtime dir (the shared rules refuse such a path before any accessor is called). `queryPrivateBus` throws without spawning unless the address is a
// socket — not a link — inside the verified scratch runtime dir, re-checked immediately before the spawn, and runs `gdbus` with an allowlist env that
// holds only that address. Explicit `.ts` imports: this module is also loaded by the type-stripping test runner.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  checkBusDaemon,
  checkChildEnv,
  checkSecretsOwner,
  checkWorld,
  combine,
  formatVerdict,
  isInside,
  touchesUserRuntime,
  type Accessors,
  type Env,
  type NodeKind,
  type ProcFacts,
  type SecretsAnswer,
  type Verdict,
} from '../shared/keyring-rig-preflight.ts';

export type Phase = 'pre' | 'bus' | 'daemon';
const PHASES: Phase[] = ['pre', 'bus', 'daemon'];

export interface PreflightSpec {
  /** The rig's scratch tree root (every arm dir, run dir, data dir lives under it). */
  rigDir: string;
  /** `pre` = before ANY process starts (judge the declared envs only; contacts nothing); `bus` = the private bus is up; `daemon` = the keyring daemon too. */
  phase: Phase;
  /** The env the rig's tools (bus daemon, keyring daemon, gdbus oracle) run with. */
  toolEnv: Env;
  /** Every other env the rig will hand a child (apps), judged the same way. */
  children: Array<{ label: string; kind: 'tool' | 'app'; env: Env }>;
  /** Whether this arm starts a keyring daemon (false for a no-service arm). */
  expectOwner: boolean;
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface HostDeps {
  acc: Accessors;
  spawn: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; encoding: 'utf8'; timeout: number }) => SpawnResult;
  readProc: (pid: number) => ProcFacts | null;
}

function kindOf(p: string): NodeKind | null {
  try {
    const s = fs.lstatSync(p);
    return s.isSymbolicLink() ? 'symlink' : s.isSocket() ? 'socket' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

/** Mount points from /proc/self/mountinfo (field 5, with the kernel's octal escapes decoded). */
export function mountPointsFromMountinfo(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.split(' ')[4])
    .filter((x): x is string => !!x)
    .map((x) => x.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8))));
}

export const realAccessors: Accessors = {
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
  kind: kindOf,
  dirInfo: (p) => { try { const s = fs.statSync(p); return s.isDirectory() ? { mode: s.mode & 0o777, uid: s.uid } : null; } catch { return null; } },
  readText: (p) => { try { const s = fs.statSync(p); return s.isFile() && s.size < 65536 ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } },
  mountPoints: () => { try { return mountPointsFromMountinfo(fs.readFileSync('/proc/self/mountinfo', 'utf8')); } catch { return []; } },
  uid: process.getuid?.() ?? 0,
};

/** exe / argv / original XDG_RUNTIME_DIR of a process, from /proc (null when it is gone or unreadable). */
export function readProc(pid: number): ProcFacts | null {
  try {
    const exe = fs.readlinkSync(`/proc/${pid}/exe`);
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    let runtimeDir: string | null = null;
    try {
      const e = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((x) => x.startsWith('XDG_RUNTIME_DIR='));
      runtimeDir = e ? e.slice('XDG_RUNTIME_DIR='.length) : null;
    } catch { /* unreadable environ stays null — the clauses treat it as "not the rig's process" */ }
    return { pid, exe, cmdline, runtimeDir };
  } catch {
    return null;
  }
}

export const realDeps: HostDeps = {
  acc: realAccessors,
  spawn: (cmd, args, opts) => {
    const r = spawnSync(cmd, args, opts);
    return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  },
  readProc,
};

/** One D-Bus question to the PRIVATE bus. Refuses — throws, spawns nothing — unless `busPath` is a socket (never a link) inside the scratch runtime dir. */
export function queryPrivateBus(deps: HostDeps, busPath: string, runtimeReal: string, member: 'GetNameOwner' | 'GetConnectionUnixProcessID', arg: string): SpawnResult {
  const ok = path.isAbsolute(busPath) && !touchesUserRuntime(busPath) && isInside(runtimeReal, busPath) && deps.acc.kind(busPath) === 'socket' && deps.acc.realpath(busPath) === busPath;
  if (!ok) throw new Error(`refusing to query a bus that is not the rig's private bus socket: ${busPath}`);
  return deps.spawn('gdbus', ['call', '--session', '--timeout', '3', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', `org.freedesktop.DBus.${member}`, arg], {
    env: { PATH: '/usr/bin:/bin', DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}`, XDG_RUNTIME_DIR: runtimeReal, LANG: 'C.UTF-8' },
    encoding: 'utf8',
    timeout: 5000,
  });
}

const pidOf = (r: SpawnResult): number | null => {
  const m = r.status === 0 ? /\(uint32 (\d+),\)/.exec(r.stdout) : null;
  return m ? Number(m[1]) : null;
};

/** Judge the rig's world. Static clauses first; the private bus is only ever contacted after they all held, and contact stops at the first failed clause. */
export function evaluate(spec: PreflightSpec, deps: HostDeps = realDeps): Verdict {
  const world = checkWorld({ rigDir: spec.rigDir, env: spec.toolEnv, requireBusSocket: spec.phase !== 'pre', acc: deps.acc });
  if (!world.facts) return world;
  const { rigReal, runtimeReal, busPath } = world.facts;
  const parts: Verdict[] = [world, checkChildEnv({ rigRealDir: rigReal, runtimeReal, env: spec.toolEnv, kind: 'tool', acc: deps.acc }, 'toolEnv')];
  for (const c of spec.children) parts.push(checkChildEnv({ rigRealDir: rigReal, runtimeReal, env: c.env, kind: c.kind, acc: deps.acc }, c.label));
  const staticVerdict = combine(...parts);
  if (!staticVerdict.ok || spec.phase === 'pre') return staticVerdict; // nothing is contacted after a failed static clause, nor before the bus exists

  // contact #1: who is the bus daemon? A wrong answer ends the preflight right here (a link / bind mount / forwarder cannot get a second question).
  const busPid = pidOf(queryPrivateBus(deps, busPath, runtimeReal, 'GetConnectionUnixProcessID', 'org.freedesktop.DBus'));
  const daemon = checkBusDaemon({ rigRealDir: rigReal, runtimeReal, busPath, busDaemon: busPid ? deps.readProc(busPid) : null, acc: deps.acc });
  const withDaemon = combine(staticVerdict, daemon);
  if (!daemon.ok) return withDaemon;

  // contact #2/#3: who owns org.freedesktop.secrets? (phase bus + a keyring arm: the daemon is not started yet — not evaluated)
  const expect: boolean | null = spec.phase === 'bus' && spec.expectOwner ? null : spec.expectOwner;
  let answer: SecretsAnswer = { state: 'none' };
  if (expect !== null) {
    const o = queryPrivateBus(deps, busPath, runtimeReal, 'GetNameOwner', 'org.freedesktop.secrets');
    const unique = o.status === 0 ? /\('([^']+)',\)/.exec(o.stdout)?.[1] : undefined;
    if (unique) {
      const pid = pidOf(queryPrivateBus(deps, busPath, runtimeReal, 'GetConnectionUnixProcessID', unique));
      answer = { state: 'owner', proc: pid ? deps.readProc(pid) : null };
    } else if (o.status === 0 || /NameHasNoOwner|ServiceUnknown/.test(o.stderr)) answer = { state: 'none' };
    else answer = { state: 'inconclusive', why: `gdbus status ${o.status}: ${o.stderr.trim().slice(0, 120)}` };
  }
  return combine(withDaemon, checkSecretsOwner({ rigRealDir: rigReal, runtimeReal, answer, expectOwner: expect, acc: deps.acc }));
}

// ── phase markers: a rig cannot start a daemon without the earlier phases having passed ─────────────────────────────────────────────────────────────

const markerFile = (rigDir: string, phase: Phase) => path.join(rigDir, `.keyring-preflight-${phase}.ok`);

export function markPhase(rigDir: string, phase: Phase): void {
  fs.writeFileSync(markerFile(rigDir, phase), `${new Date().toISOString()}\n`);
}

/** Throws unless `phase` (and every earlier one) passed for this rig dir — call it right before starting the bus (needs `pre`) / the daemon (`bus`). */
export function requirePhase(rigDir: string, phase: Phase): void {
  for (const p of PHASES.slice(0, PHASES.indexOf(phase) + 1)) {
    if (!fs.existsSync(markerFile(rigDir, p))) throw new Error(`keyring-rig preflight phase "${p}" has not passed for ${rigDir} — refusing to continue`);
  }
}

/** The rig's one entry point. ASYNC (the self-test builds a real unix socket): a rig MUST `await` it. Exit 4 = the self-test failed (a verdict clause is not
 *  armed), 3 = ABORT naming each clause. On success the phase marker is written. */
export async function preflightOrDie(spec: PreflightSpec, deps: HostDeps = realDeps): Promise<Verdict> {
  const st = await selftest();
  if (!st.ok) {
    console.error(`PREFLIGHT SELFTEST FAILED — the guard is not armed: ${JSON.stringify(st.arms.filter((a) => !a.ok))}`);
    process.exit(4);
  }
  const v = evaluate(spec, deps);
  console.log(`[keyring-rig-preflight] selftest ${st.arms.length}/${st.arms.length} arms · phase ${spec.phase} · ${formatVerdict(v)}`);
  if (!v.ok) process.exit(3);
  markPhase(spec.rigDir, spec.phase);
  return v;
}

// ── the self-test: ONE table of arms, run through the SAME evaluate() / clauses as the real run. Every VERDICT clause has a must-FAIL arm, so a verdict
//    clause deleted from the rules turns the self-test red (33 of 46 mutants do; the rest are the contact bound, the exit codes and the string rules'
//    redundant spellings — pinned by the unit tests, not by the self-test). The unit tests iterate this very table too. ────────────────────────────────

export interface Arm {
  name: string;
  /** 'pass' or the clause that must fire. */
  expect: string;
  spec: PreflightSpec;
  deps: HostDeps;
}

export interface Fixture {
  root: string;
  rigDir: string;
  run: string;
  bus: string;
  address: string;
  tool: Env;
  close: () => void;
}

/** A REAL scratch tree (temp dirs, a real unix socket, a bus config file) — nothing of the human's, and no bus is ever started. */
export async function buildFixture(): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-fixture-'));
  const rigDir = path.join(root, 'rig');
  const run = path.join(rigDir, 'arm', 'run');
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  fs.chmodSync(run, 0o700);
  fs.mkdirSync(path.join(rigDir, 'arm', 'home'), { recursive: true });
  fs.mkdirSync(path.join(rigDir, 'arm', 'svc'));
  const bus = path.join(run, 'bus');
  fs.writeFileSync(path.join(rigDir, 'arm', 'session.conf'), `<busconfig><type>session</type><listen>unix:path=${bus}</listen><servicedir>${path.join(rigDir, 'arm', 'svc')}</servicedir></busconfig>`);
  const srv = net.createServer().listen(bus);
  await new Promise((r) => srv.once('listening', r));
  // a DECOY socket outside the rig: a link that leads to it must be refused by the realpath equality alone, not by "no such file"
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
  const decoy = net.createServer().listen(path.join(elsewhere, 'bus'));
  await new Promise((r) => decoy.once('listening', r));
  const address = `unix:path=${bus}`;
  const tool: Env = { PATH: '/usr/bin:/bin', HOME: path.join(rigDir, 'arm', 'home'), XDG_RUNTIME_DIR: run, XDG_DATA_HOME: path.join(rigDir, 'arm', 'data'), DBUS_SESSION_BUS_ADDRESS: address, LANG: 'C.UTF-8' };
  return { root, rigDir, run, bus, address, tool, close: () => { srv.close(); decoy.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** The arms. `deps` hold a FAKE process table and a FAKE private bus (no bus of any kind is contacted); accessors are the real ones over the fixture. */
export function buildArms(f: Fixture): Arm[] {
  const cfg = path.join(f.rigDir, 'arm', 'session.conf');
  const kr: ProcFacts = { pid: 11, exe: '/usr/bin/gnome-keyring-daemon', cmdline: ['gnome-keyring-daemon', '--start', '--components=secrets'], runtimeDir: f.run };
  const busd: ProcFacts = { pid: 10, exe: '/usr/bin/dbus-daemon', cmdline: ['dbus-daemon', `--config-file=${cfg}`, '--print-address=4'], runtimeDir: f.run };
  const human: ProcFacts = { pid: 99, exe: '/usr/bin/gnome-keyring-daemon', cmdline: ['/usr/bin/gnome-keyring-daemon', '--start', '--foreground'], runtimeDir: '/run/user/1000' };
  // outside-the-rig fixtures for the symlink / mount / foreign-config arms
  const elsewhere = path.join(f.root, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(elsewhere, 'session.conf'), `<busconfig><listen>unix:path=${f.bus}</listen></busconfig>`); // otherwise valid: only its LOCATION is wrong
  const linkRun = path.join(f.rigDir, 'arm', 'run-link');
  const wide = path.join(f.rigDir, 'arm', 'wide');
  const linkBus = path.join(f.run, 'linkbus');
  const linkDir = path.join(f.run, 'linkdir');
  const stdCfg = path.join(f.rigDir, 'arm', 'std.conf');
  const farCfg = path.join(f.rigDir, 'arm', 'far.conf');
  const listenCfg = path.join(f.rigDir, 'arm', 'listen.conf');
  if (!kindOf(linkRun)) fs.symlinkSync(elsewhere, linkRun);
  if (!kindOf(wide)) { fs.mkdirSync(wide); fs.chmodSync(wide, 0o755); }
  if (!kindOf(linkBus)) fs.symlinkSync(f.bus, linkBus);
  if (!kindOf(linkDir)) fs.symlinkSync(elsewhere, linkDir);
  fs.writeFileSync(stdCfg, `<busconfig><standard_session_servicedirs/><listen>unix:path=${f.bus}</listen></busconfig>`);
  fs.writeFileSync(farCfg, `<busconfig><listen>unix:path=${f.bus}</listen><servicedir>${elsewhere}</servicedir></busconfig>`);
  fs.writeFileSync(listenCfg, `<busconfig><listen>unix:path=${path.join(elsewhere, 'bus')}</listen></busconfig>`);

  const fakeDeps = (answers: { owner?: ProcFacts | null | 'unreadable' | 'timeout'; busd?: ProcFacts | null; mounts?: string[]; calls?: string[] } = {}): HostDeps => {
    const owner = answers.owner === undefined ? kr : answers.owner;
    const bd = answers.busd === undefined ? busd : answers.busd;
    return {
      acc: { ...realAccessors, mountPoints: () => answers.mounts ?? [] },
      spawn: (_c, args, opts) => {
        answers.calls?.push(opts.env.DBUS_SESSION_BUS_ADDRESS ?? '');
        const member = args.find((a) => a.startsWith('org.freedesktop.DBus.')) ?? '';
        const arg = args[args.length - 1];
        if (member.endsWith('GetConnectionUnixProcessID')) return { status: 0, stdout: `(uint32 ${arg === 'org.freedesktop.DBus' ? 10 : owner && typeof owner === 'object' ? owner.pid : 11},)\n`, stderr: '' };
        if (owner === 'timeout') return { status: null, stdout: '', stderr: '' };
        if (!owner) return { status: 1, stdout: '', stderr: 'Error: org.freedesktop.DBus.Error.NameHasNoOwner' };
        return { status: 0, stdout: "(':1.7',)\n", stderr: '' };
      },
      readProc: (pid) => (pid === 10 ? bd : owner && typeof owner === 'object' && pid === owner.pid ? owner : owner === 'unreadable' ? null : pid === 11 ? kr : null),
    };
  };
  const child = (env: Env, kind: 'tool' | 'app' = 'app', label = 'app') => ({ label, kind, env });
  const appEnv: Env = { ...f.tool, DBUS_SESSION_BUS_ADDRESS: undefined };
  const spec = (over: Partial<PreflightSpec> = {}): PreflightSpec => ({ rigDir: f.rigDir, phase: 'daemon', toolEnv: f.tool, children: [child(appEnv)], expectOwner: true, ...over });
  const tool = (over: Env) => ({ toolEnv: { ...f.tool, ...over } });
  const arm = (name: string, expect: string, s: PreflightSpec, d: HostDeps = fakeDeps()): Arm => ({ name, expect, spec: s, deps: d });
  const real = '/run/user/1000';

  return [
    arm('POSITIVE: a private world with its own daemon', 'pass', spec()),
    arm('POSITIVE: phase pre contacts nothing and passes with no bus yet', 'pass', spec({ phase: 'pre' })),
    arm('POSITIVE: phase pre with a bus that does not exist YET', 'pass', spec({ phase: 'pre', ...tool({ DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(f.run, 'later-bus')}` }), children: [] })),
    // runtime-dir-scratch
    arm('the REAL per-user runtime dir', 'runtime-dir-scratch', spec(tool({ XDG_RUNTIME_DIR: real }))),
    arm('the real runtime dir, spelled /run//user/1000', 'runtime-dir-scratch', spec(tool({ XDG_RUNTIME_DIR: '/run//user/1000' }))),
    arm('the real runtime dir, via /proc/self/root', 'runtime-dir-scratch', spec(tool({ XDG_RUNTIME_DIR: '/proc/self/root/run/user/1000' }))),
    arm('XDG_RUNTIME_DIR unset', 'runtime-dir-scratch', spec(tool({ XDG_RUNTIME_DIR: undefined }))),
    arm('a RELATIVE XDG_RUNTIME_DIR', 'runtime-dir-scratch', spec(tool({ XDG_RUNTIME_DIR: 'arm/run' }))),
    arm('a runtime dir outside the rig dir', 'runtime-dir-scratch', spec(tool({ XDG_RUNTIME_DIR: elsewhere }))),
    arm('a link inside the rig that leads out of it', 'runtime-dir-scratch', spec(tool({ XDG_RUNTIME_DIR: linkRun }))),
    arm('a runtime dir that is not 0700', 'runtime-dir-scratch', spec(tool({ XDG_RUNTIME_DIR: wide }))),
    arm('a runtime dir owned by another uid', 'runtime-dir-scratch', spec(), { ...fakeDeps(), acc: { ...fakeDeps().acc, uid: realAccessors.uid + 1 } }),
    arm('a rig dir that does not exist', 'runtime-dir-scratch', spec({ rigDir: path.join(f.root, 'no-such-rig') })),
    arm('a rig dir under the per-user runtime dir', 'runtime-dir-scratch', spec({ rigDir: '/run/user/1000/rig' })),
    // rig-dir-no-mounts
    arm('a mount point inside the rig dir (a bind mount can alias /run/user/<uid>)', 'rig-dir-no-mounts', spec(), fakeDeps({ mounts: [path.join(f.run, 'mnt')] })),
    // bus-address-private
    arm('an inherited REAL bus address', 'bus-address-private', spec(tool({ DBUS_SESSION_BUS_ADDRESS: `unix:path=${real}/bus` }))),
    arm('a list: the real bus second', 'bus-address-private', spec(tool({ DBUS_SESSION_BUS_ADDRESS: `${f.address};unix:path=${real}/bus` }))),
    arm('an abstract socket', 'bus-address-private', spec(tool({ DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/x' }))),
    arm('disabled: for a tool', 'bus-address-private', spec(tool({ DBUS_SESSION_BUS_ADDRESS: 'disabled:' }))),
    arm('a percent-escaped real path', 'bus-address-private', spec(tool({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=%2Frun%2Fuser%2F1000%2Fbus' }))),
    arm('a bus path outside the scratch runtime dir', 'bus-address-private', spec(tool({ DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(elsewhere, 'bus')}` }))),
    arm('a bus path whose final component is a SYMLINK', 'bus-address-private', spec(tool({ DBUS_SESSION_BUS_ADDRESS: `unix:path=${linkBus}` }))),
    arm('a bus path through a symlinked directory', 'bus-address-private', spec(tool({ DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(linkDir, 'bus')}` }))),
    // bus-socket-private
    arm('a private-looking address with no bus behind it', 'bus-socket-private', spec(tool({ DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(f.run, 'ghost-bus')}` }))),
    // child-env-clean
    arm('an app env carrying the real bus', 'child-env-clean', spec({ children: [child({ ...appEnv, DBUS_SESSION_BUS_ADDRESS: `unix:path=${real}/bus` })] })),
    arm('an app env with a LIST that ends in the real bus', 'child-env-clean', spec({ children: [child({ ...appEnv, DBUS_SESSION_BUS_ADDRESS: `${f.address};unix:path=/run//user/1000/bus` })] })),
    arm('an app env with disabled: followed by a real address', 'child-env-clean', spec({ children: [child({ ...appEnv, DBUS_SESSION_BUS_ADDRESS: `disabled:;unix:path=${real}/bus` })] })),
    arm('an app env with a private-LOOKING bus path outside the scratch dir', 'child-env-clean', spec({ children: [child({ ...appEnv, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(elsewhere, 'bus')}` })] })),
    arm('an app env whose bus path is a SYMLINK', 'child-env-clean', spec({ children: [child({ ...appEnv, DBUS_SESSION_BUS_ADDRESS: `unix:path=${linkBus}` })] })),
    arm('a tool child without the private bus address', 'child-env-clean', spec({ children: [child({ ...appEnv }, 'tool', 'tool-child')] })),
    arm("a child whose XDG_RUNTIME_DIR is another (foreign) directory", 'child-env-clean', spec({ children: [child({ ...appEnv, XDG_RUNTIME_DIR: elsewhere })] })),
    arm('an app env with autolaunch:', 'child-env-clean', spec({ children: [child({ ...appEnv, DBUS_SESSION_BUS_ADDRESS: 'autolaunch:' })] })),
    arm('a child with the REAL runtime dir', 'child-env-clean', spec({ children: [child({ ...appEnv, XDG_RUNTIME_DIR: real })] })),
    arm('a child with the real keyring control dir', 'child-env-clean', spec({ children: [child({ ...appEnv, GNOME_KEYRING_CONTROL: `${real}/keyring` })] })),
    arm('a child with a foreign keyring control dir (no /run/user text)', 'child-env-clean', spec({ children: [child({ ...appEnv, GNOME_KEYRING_CONTROL: elsewhere })] })),
    arm('a child with the real HOME (a daemon would write ~/.local/share/keyrings)', 'child-env-clean', spec({ children: [child({ ...appEnv, HOME: os.homedir() })] })),
    arm('a child with no HOME', 'child-env-clean', spec({ children: [child({ ...appEnv, HOME: undefined })] })),
    arm('a child with XDG_DATA_HOME outside the rig', 'child-env-clean', spec({ children: [child({ ...appEnv, XDG_DATA_HOME: path.join(os.homedir(), '.local', 'share') })] })),
    arm('a child with an X11 DISPLAY', 'child-env-clean', spec({ children: [child({ ...appEnv, DISPLAY: ':0' })] })),
    arm('a child hiding the real path in an unrelated variable', 'child-env-clean', spec({ children: [child({ ...appEnv, SOME_CONFIG: `x:${real}/keyring/control` })] })),
    arm('WAYLAND_DISPLAY abused to carry the bus', 'child-env-clean', spec({ children: [child({ ...appEnv, WAYLAND_DISPLAY: `${real}/bus` })] })),
    // bus-daemon-in-scratch
    arm('a bus daemon with no --config-file (standard session config = host service dirs)', 'bus-daemon-in-scratch', spec(), fakeDeps({ busd: { ...busd, cmdline: ['dbus-daemon', '--session'] } })),
    arm('a bus daemon with a config outside the rig dir', 'bus-daemon-in-scratch', spec(), fakeDeps({ busd: { ...busd, cmdline: ['dbus-daemon', `--config-file=${path.join(elsewhere, 'session.conf')}`] } })),
    arm('a bus daemon whose config includes the standard service dirs', 'bus-daemon-in-scratch', spec(), fakeDeps({ busd: { ...busd, cmdline: ['dbus-daemon', `--config-file=${stdCfg}`] } })),
    arm('a bus daemon whose config has a <servicedir> outside the rig', 'bus-daemon-in-scratch', spec(), fakeDeps({ busd: { ...busd, cmdline: ['dbus-daemon', `--config-file=${farCfg}`] } })),
    arm('a bus daemon whose config listens elsewhere', 'bus-daemon-in-scratch', spec(), fakeDeps({ busd: { ...busd, cmdline: ['dbus-daemon', `--config-file=${listenCfg}`] } })),
    arm('a bus daemon running with the REAL XDG_RUNTIME_DIR', 'bus-daemon-in-scratch', spec(), fakeDeps({ busd: { ...busd, runtimeDir: real } })),
    arm('a bus daemon that is not a dbus-daemon (a forwarder)', 'bus-daemon-in-scratch', spec(), fakeDeps({ busd: { ...busd, exe: '/usr/bin/socat' } })),
    arm('an unidentifiable bus daemon', 'bus-daemon-in-scratch', spec(), fakeDeps({ busd: null })),
    arm('POSITIVE: --config-file as two argv entries', 'pass', spec(), fakeDeps({ busd: { ...busd, cmdline: ['dbus-daemon', '--config-file', cfg] } })),
    // secrets-owner-in-scratch
    arm("the HUMAN'S daemon owns the secrets name", 'secrets-owner-in-scratch', spec(), fakeDeps({ owner: human })),
    arm('a foreign Secret Service provider', 'secrets-owner-in-scratch', spec(), fakeDeps({ owner: { ...kr, exe: '/usr/bin/kwalletd6' } })),
    arm('an owner whose environ is unreadable', 'secrets-owner-in-scratch', spec(), fakeDeps({ owner: { ...kr, runtimeDir: null } })),
    arm('an owner that cannot be identified at all', 'secrets-owner-in-scratch', spec(), fakeDeps({ owner: 'unreadable' })),
    arm('an owner with argv naming the real runtime dir', 'secrets-owner-in-scratch', spec(), fakeDeps({ owner: { ...kr, cmdline: ['gnome-keyring-daemon', `--control-directory=${real}/keyring`] } })),
    // owner-expected
    arm('a keyring arm with no owner', 'owner-expected', spec(), fakeDeps({ owner: null })),
    arm('a no-service arm that sees an owner (the real one leaking in)', 'owner-expected', spec({ phase: 'bus', expectOwner: false }), fakeDeps({ owner: kr })),
    arm('a no-service arm whose owner lookup TIMES OUT (fail closed)', 'owner-expected', spec({ phase: 'bus', expectOwner: false }), fakeDeps({ owner: 'timeout' })),
    arm('a no-service arm whose owner exists but is unreadable (fail closed)', 'owner-expected', spec({ phase: 'bus', expectOwner: false }), fakeDeps({ owner: 'unreadable' })),
    arm('POSITIVE: a no-service arm with no owner', 'pass', spec({ phase: 'bus', expectOwner: false }), fakeDeps({ owner: null })),
    arm('POSITIVE: phase bus of a keyring arm (daemon not started yet) asks no owner question', 'pass', spec({ phase: 'bus', expectOwner: true }), fakeDeps({ owner: null })),
  ];
}

export interface SelftestArm {
  name: string;
  expect: string;
  got: 'pass' | string[];
  ok: boolean;
}

export async function selftest(): Promise<{ ok: boolean; arms: SelftestArm[] }> {
  const f = await buildFixture();
  try {
    const arms = buildArms(f).map((a): SelftestArm => {
      let v: Verdict;
      try {
        v = evaluate(a.spec, a.deps);
      } catch (e) {
        return { name: a.name, expect: a.expect, got: [`THREW ${(e as Error).message}`], ok: false };
      }
      const fired = [...new Set(v.violations.map((x) => x.clause))];
      return { name: a.name, expect: a.expect, got: v.ok ? 'pass' : fired, ok: a.expect === 'pass' ? v.ok : !v.ok && fired.includes(a.expect) };
    });
    return { ok: arms.length > 0 && arms.every((a) => a.ok), arms };
  } finally {
    f.close();
  }
}

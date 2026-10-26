// Linux keyring backend selection, applied before `app.ready` (#389). The decision is the pure
// shared/password-store.ts; this file owns the two impure parts: the wait-only Secret Service probe and
// the switch. Chromium fixes its os_crypt backend at `ready`, so a switch appended later is ignored.
// Explicit `.ts` imports: this module is loaded by the type-stripping test runner too.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decidePasswordStore,
  parseCollectionLocked,
  type PasswordStoreDecision,
  type SecretServiceState,
} from '../shared/password-store.ts';

/** How long the PARENT waits for the probe before deciding `unavailable` (the main thread is blocked, before the window exists: the worst-case startup
 *  cost of an unrecognised desktop with a dead service). It only STOPS WAITING — it never signals the child (see {@link WAIT_ONLY_SH}). */
export const PROBE_WAIT_MS = 5000;
const defaultScratchDirs = (env: NodeJS.ProcessEnv): ScratchBase[] => [os.tmpdir(), ...(env.XDG_RUNTIME_DIR ? [env.XDG_RUNTIME_DIR] : [])];
/** gdbus's own per-call timeout (seconds), deliberately LONG: gdbus sends an `Introspect` first and only then the `Properties.Get`, each with this
 *  timeout, and a client that vanishes while a call is in flight made the human's gnome-keyring-daemon abort twice (2026-10-26, `gkd_secret_service_get_
 *  pkcs11_session: assertion 'client' failed`). The child outlives our deadline and finishes (or times out) on its own. */
export const DBUS_CALL_TIMEOUT_S = '30';
/** Wall-clock backstop for the WRAPPER (`sh`), never for gdbus: the wrapper holds no call, so killing it abandons nothing. */
const WRAPPER_BACKSTOP_SLACK_MS = 2000;

/** Wait-only wrapper: starts the probe child in the background (output to a file, no pipe shared with us), polls it for at most `$2` × 0.1 s, then
 *  either reports its exit status or exits 3 WITHOUT touching it — no signal is ever sent, the child finishes its own call and exits by itself.
 *  (Linux: finished-ness is read from /proc, because `kill -0` succeeds on a zombie.) */
export const WAIT_ONLY_SH = `out=$1; limit=$2; shift 2
"$@" >"$out" 2>/dev/null </dev/null &
pid=$!
n=0
alive() { [ -e "/proc/$pid" ] && ! grep -q '^State:[[:space:]]*Z' "/proc/$pid/status" 2>/dev/null; }
while [ "$n" -lt "$limit" ] && alive; do sleep 0.1; n=$((n+1)); done
if alive; then exit 3; fi
wait "$pid"`;

/** A scratch-dir parent: a plain path (must already exist) or `{ dir, create: true }` (ours — made 0700 if missing; only the app's own userData). */
export type ScratchBase = string | { dir: string; create: true };

/** A private scratch dir for the probe's output file: the first of `bases` that accepts a `mkdtemp`. A read-only or missing TMPDIR must not turn a
 *  healthy keyring into `unavailable` silently — each failure is reported through `note` (it reaches the startup log) and the next base is tried.
 *  Only a `create` base is ever created: a missing `$XDG_RUNTIME_DIR` is the session's to make, not ours. null = none worked. */
export function makeProbeDir(bases: readonly ScratchBase[], note: (msg: string) => void = () => {}): string | null {
  for (const b of bases) {
    const base = typeof b === 'string' ? b : b.dir;
    try {
      if (typeof b !== 'string') fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      return fs.mkdtempSync(path.join(base, 'orch-secret-probe-'));
    } catch (e) {
      note(`mkdtemp ${base}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  return null;
}

/** Read `Locked` of the DEFAULT collection without prompting, WITHOUT ever abandoning the call: the parent waits at most `waitMs`; past that the answer
 *  is `unavailable` and the decision falls back to Chromium's default, while the orphaned gdbus completes on its own. Anything but a clean boolean
 *  answer (no `gdbus`, no owner, no default collection, a dead daemon, no writable scratch dir) is `unavailable` too. */
export function probeSecretService(
  opts: {
    program?: string;
    waitMs?: number;
    env?: NodeJS.ProcessEnv;
    spawn?: typeof spawnSync;
    /** Candidate parents of the scratch dir, in order (default: the OS temp dir, then $XDG_RUNTIME_DIR). */
    scratchDirs?: readonly ScratchBase[];
    note?: (msg: string) => void;
  } = {},
): SecretServiceState {
  const waitMs = opts.waitMs ?? PROBE_WAIT_MS;
  const env = opts.env ?? process.env;
  let dir: string | null = null;
  try {
    dir = makeProbeDir(opts.scratchDirs ?? defaultScratchDirs(env), opts.note);
    if (!dir) return 'unavailable';
    const out = path.join(dir, 'out');
    const r = (opts.spawn ?? spawnSync)(
      'sh',
      [
        '-c', WAIT_ONLY_SH, 'probe', out, String(Math.ceil(waitMs / 100)),
        opts.program ?? 'gdbus',
        'call', '--session', '--timeout', DBUS_CALL_TIMEOUT_S,
        '--dest', 'org.freedesktop.secrets',
        '--object-path', '/org/freedesktop/secrets/aliases/default',
        '--method', 'org.freedesktop.DBus.Properties.Get',
        'org.freedesktop.Secret.Collection', 'Locked',
      ],
      {
        encoding: 'utf8',
        timeout: waitMs + WRAPPER_BACKSTOP_SLACK_MS, // wedged-`sh` backstop only; the wrapper holds no call
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'ignore', 'ignore'],
        env,
      },
    );
    if (r.error || r.status !== 0) return 'unavailable'; // sh missing, deadline (3), or gdbus failed
    return parseCollectionLocked(fs.readFileSync(out, 'utf8'));
  } catch {
    return 'unavailable';
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true }); // an orphaned gdbus keeps its open fd; unlinking is safe
  }
}

/** `DBUS_SESSION_BUS_ADDRESS` as an address someone can connect to. Electron itself sets the variable
 *  to `disabled:` in its main process when the launcher exported none (measured, Electron 33) — that is
 *  "no address", not an address. */
export const usableBusAddress = (env: NodeJS.ProcessEnv): string | null => {
  const v = env.DBUS_SESSION_BUS_ADDRESS?.trim() ?? '';
  return v === '' || v.startsWith('disabled:') ? null : v;
};

/** How a session bus is reachable the way GLib/libsecret would find it: the env address, else the
 *  `$XDG_RUNTIME_DIR/bus` socket, else not at all. */
export function sessionBusKind(env: NodeJS.ProcessEnv): 'env' | 'runtime-dir' | 'none' {
  if (usableBusAddress(env)) return 'env';
  if (!env.XDG_RUNTIME_DIR) return 'none';
  try {
    return fs.statSync(path.join(env.XDG_RUNTIME_DIR, 'bus')).isSocket() ? 'runtime-dir' : 'none';
  } catch {
    return 'none';
  }
}

export const sessionBusReachable = (env: NodeJS.ProcessEnv): boolean => sessionBusKind(env) !== 'none';

/** The environment the probe child sees: a `disabled:` (or missing) address is replaced by the
 *  runtime-dir socket when that is where the bus is, so the probe asks the same bus libsecret will. */
export function probeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (sessionBusKind(env) !== 'runtime-dir') return env;
  return { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(env.XDG_RUNTIME_DIR as string, 'bus')}` };
}

export interface KeyringSelectionDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  /** `app.commandLine.hasSwitch` / `.appendSwitch`. */
  hasSwitch: (name: string) => boolean;
  appendSwitch: (name: string, value: string) => void;
  /** Make the runtime-dir bus the process's session bus (`process.env.DBUS_SESSION_BUS_ADDRESS = …`). */
  exportBusAddress: (address: string) => void;
  probe?: () => SecretServiceState;
  /** Extra fallback parents for the probe's scratch dir after the OS temp dir and $XDG_RUNTIME_DIR (index.ts: the userData dir). */
  extraScratchDirs?: readonly string[];
}

/** Decide and apply `--password-store`. Returns null off Linux; otherwise the decision (for the
 *  startup log, which does not exist yet at this point), the probe cost when one ran, and the facts used. */
export function selectLinuxPasswordStore(
  deps: KeyringSelectionDeps,
): (PasswordStoreDecision & { probeMs: number | null; facts: string }) | null {
  if (deps.platform !== 'linux') return null;
  let probeMs: number | null = null;
  const notes: string[] = [];
  const probe =
    deps.probe ??
    (() =>
      probeSecretService({
        env: probeEnv(deps.env),
        scratchDirs: [...defaultScratchDirs(deps.env), ...(deps.extraScratchDirs ?? []).map((dir) => ({ dir, create: true as const }))],
        note: (m) => notes.push(m),
      }));
  const decision = decidePasswordStore({
    env: deps.env,
    passwordStoreAlreadySelected:
      deps.hasSwitch('password-store') || deps.argv.some((a) => a.startsWith('--password-store')),
    sessionBusReachable: sessionBusReachable(deps.env),
    probe: () => {
      const t0 = Date.now();
      try {
        return probe();
      } finally {
        probeMs = Date.now() - t0;
      }
    },
  });
  if (decision.store) deps.appendSwitch('password-store', decision.store);
  // libsecret reaches the bus through GLib, which reads THIS process's env — and Electron has set it to
  // `disabled:` when the launcher exported none (measured). Selecting libsecret without an address it can
  // use would leave safeStorage unavailable, so name the bus we probed.
  const bus = sessionBusKind(deps.env);
  const exported = decision.store === 'gnome-libsecret' && bus === 'runtime-dir'; // never for `basic`: an isolated instance must not carry the bus
  if (exported) deps.exportBusAddress(probeEnv(deps.env).DBUS_SESSION_BUS_ADDRESS as string);
  // What the decision saw, for the startup log: a wrong guess about a user's desktop is diagnosable from it.
  const facts = `desktop="${deps.env.XDG_CURRENT_DESKTOP ?? ''}" session="${deps.env.DESKTOP_SESSION ?? ''}" bus=${bus}${exported ? ' (exported)' : ''}${notes.length ? ` probe-notes="${notes.join('; ')}"` : ''}`;
  return { ...decision, probeMs, facts };
}

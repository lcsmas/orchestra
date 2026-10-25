// Linux keyring backend selection, applied before `app.ready` (#389). The decision is the pure
// shared/password-store.ts; this file owns the two impure parts: the bounded Secret Service probe and
// the switch. Chromium fixes its os_crypt backend at `ready`, so a switch appended later is ignored.
// Explicit `.ts` imports: this module is loaded by the type-stripping test runner too.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  decidePasswordStore,
  parseCollectionLocked,
  type PasswordStoreDecision,
  type SecretServiceState,
} from '../shared/password-store.ts';

/** Hard kill for the probe child. The probe is SYNCHRONOUS on the main process before the window
 *  exists, so this is the worst-case startup cost of an unrecognised desktop — never a stall. */
export const PROBE_TIMEOUT_MS = 1500;
/** gdbus's own call timeout (seconds), kept under our kill so it reports the error itself. */
const DBUS_CALL_TIMEOUT_S = '1';

/** Read `Locked` of the DEFAULT collection without prompting, in a killable child. Anything but a
 *  clean boolean answer (no `gdbus`, no owner, no default collection, timeout) is `unavailable`. */
export function probeSecretService(
  opts: { program?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): SecretServiceState {
  const r = spawnSync(
    opts.program ?? 'gdbus',
    [
      'call', '--session', '--timeout', DBUS_CALL_TIMEOUT_S,
      '--dest', 'org.freedesktop.secrets',
      '--object-path', '/org/freedesktop/secrets/aliases/default',
      '--method', 'org.freedesktop.DBus.Properties.Get',
      'org.freedesktop.Secret.Collection', 'Locked',
    ],
    {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: opts.env ?? process.env,
    },
  );
  if (r.error || r.status !== 0) return 'unavailable'; // ENOENT, ETIMEDOUT, non-zero exit
  return parseCollectionLocked(r.stdout);
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
}

/** Decide and apply `--password-store`. Returns null off Linux; otherwise the decision (for the
 *  startup log, which does not exist yet at this point), the probe cost when one ran, and the facts used. */
export function selectLinuxPasswordStore(
  deps: KeyringSelectionDeps,
): (PasswordStoreDecision & { probeMs: number | null; facts: string }) | null {
  if (deps.platform !== 'linux') return null;
  let probeMs: number | null = null;
  const probe = deps.probe ?? (() => probeSecretService({ env: probeEnv(deps.env) }));
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
  const facts = `desktop="${deps.env.XDG_CURRENT_DESKTOP ?? ''}" session="${deps.env.DESKTOP_SESSION ?? ''}" bus=${bus}${exported ? ' (exported)' : ''}`;
  return { ...decision, probeMs, facts };
}

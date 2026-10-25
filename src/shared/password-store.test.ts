import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decidePasswordStore,
  isIsolatedInstance,
  isRecognisedDesktop,
  parseCollectionLocked,
  type SecretServiceState,
} from './password-store.ts';

// #389 — one test per branch of the `--password-store` decision. `probe` counts its calls: a branch that
// does not depend on the Secret Service must never run it (the probe is a child process).

const BUS = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
const SWAY = { ...BUS, XDG_CURRENT_DESKTOP: 'sway' };

function decide(env: Record<string, string>, state: SecretServiceState, explicit = false, bus = true) {
  let probes = 0;
  const d = decidePasswordStore({ env, passwordStoreAlreadySelected: explicit, sessionBusReachable: bus, probe: () => (probes++, state) });
  return { ...d, probes };
}

test('unrecognised desktop + UNLOCKED collection → gnome-libsecret', () => {
  assert.deepEqual(decide(SWAY, 'unlocked'), { store: 'gnome-libsecret', reason: 'unlocked-service', probes: 1 });
});

test('unrecognised desktop + LOCKED collection → skipped (a prompt nobody answers = startup stall)', () => {
  assert.deepEqual(decide(SWAY, 'locked'), { store: null, reason: 'locked-service', probes: 1 });
});

test('unrecognised desktop + no usable Secret Service → Chromium keeps its choice', () => {
  assert.deepEqual(decide(SWAY, 'unavailable'), { store: null, reason: 'no-service', probes: 1 });
});

test('recognised desktop (GNOME, KDE, …) → Chromium keeps its choice and the probe never runs', () => {
  for (const env of [
    { ...BUS, XDG_CURRENT_DESKTOP: 'GNOME' },
    { ...BUS, XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, // colon list, mixed case
    { ...BUS, XDG_CURRENT_DESKTOP: 'KDE' },
    { ...BUS, XDG_CURRENT_DESKTOP: 'sway', DESKTOP_SESSION: 'gnome' }, // recognised through DESKTOP_SESSION
    { ...BUS, KDE_FULL_SESSION: 'true' }, // presence var alone
    { ...BUS, GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' },
    { ...BUS, XDG_CURRENT_DESKTOP: 'LXQt' }, // Chromium picks basic_text on purpose: its choice, not ours
  ]) {
    assert.deepEqual(decide(env, 'unlocked'), { store: null, reason: 'recognised-desktop', probes: 0 }, JSON.stringify(env));
  }
});

test('other tiling compositors are unrecognised and reach the probe', () => {
  for (const name of ['sway', 'Hyprland', 'river', 'niri', 'i3', '']) {
    const d = decide({ ...BUS, XDG_CURRENT_DESKTOP: name }, 'unlocked');
    assert.equal(d.store, 'gnome-libsecret', `XDG_CURRENT_DESKTOP="${name}"`);
  }
  assert.equal(decide(BUS, 'unlocked').store, 'gnome-libsecret', 'no XDG_CURRENT_DESKTOP at all');
});

test('an explicit --password-store always wins and the probe never runs', () => {
  assert.deepEqual(decide(SWAY, 'unlocked', true), { store: null, reason: 'explicit-switch', probes: 0 });
});

test('an isolated instance (ORCHESTRA_HOME set) never binds to the keyring: Chromium default, probe never runs — unless ORCHESTRA_KEYRING=probe opts in', () => {
  const scratch = { ...SWAY, ORCHESTRA_HOME: '/scratch-home' };
  assert.deepEqual(decide(scratch, 'unlocked'), { store: null, reason: 'isolated-instance', probes: 0 });
  assert.deepEqual(decide({ ...scratch, ORCHESTRA_KEYRING: 'probe' }, 'unlocked'), { store: 'gnome-libsecret', reason: 'unlocked-service', probes: 1 });
  assert.equal(decide({ ...scratch, ORCHESTRA_KEYRING: 'off' }, 'unlocked').reason, 'isolated-instance', 'only the exact word "probe" opts in');
  assert.equal(decide({ ...SWAY, ORCHESTRA_KEYRING: 'probe' }, 'unlocked').store, 'gnome-libsecret', 'the opt-in alone changes nothing');
  assert.equal(decide({ ...SWAY, ORCHESTRA_HOME: '' }, 'unlocked').store, 'gnome-libsecret', 'an empty ORCHESTRA_HOME is not set (index.ts relocates only on a truthy value)');
  assert.equal(decide({ ...SWAY, ORCHESTRA_HOME: '  ' }, 'unlocked').reason, 'isolated-instance', 'any non-empty value relocates the instance, so it is isolated too');
  assert.equal(decide(scratch, 'unlocked', true).reason, 'explicit-switch', 'an explicit --password-store still wins');
  assert.equal(isIsolatedInstance({}), false);
});

test('no reachable session bus → nothing to name, the probe never runs', () => {
  assert.deepEqual(decide({ XDG_CURRENT_DESKTOP: 'sway' }, 'unlocked', false, false), { store: null, reason: 'no-session-bus', probes: 0 });
});

test('a bus reachable ONLY through the runtime-dir socket (no DBUS_SESSION_BUS_ADDRESS) still reaches the probe — the sway-from-tty case', () => {
  assert.deepEqual(decide({ XDG_CURRENT_DESKTOP: 'sway' }, 'unlocked', false, true), { store: 'gnome-libsecret', reason: 'unlocked-service', probes: 1 });
  assert.equal(decide({}, 'unlocked', false, true).store, 'gnome-libsecret', 'no desktop variables at all');
});

test('isRecognisedDesktop: empty and whitespace values are not a desktop', () => {
  assert.equal(isRecognisedDesktop({ KDE_FULL_SESSION: '  ', XDG_CURRENT_DESKTOP: ':', DESKTOP_SESSION: ' ' }), false);
});

test('parseCollectionLocked: only the exact variant-wrapped boolean is an answer', () => {
  assert.equal(parseCollectionLocked('(<false>,)\n'), 'unlocked');
  assert.equal(parseCollectionLocked('(<true>,)\n'), 'locked');
  for (const junk of ['', 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown', '(<false>, <true>)', '(<"false">,)', 'false', '(<1>,)']) {
    assert.equal(parseCollectionLocked(junk), 'unavailable', JSON.stringify(junk));
  }
});

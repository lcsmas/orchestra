// Which Chromium `--password-store` backend Orchestra asks for on Linux (#389).
//
// Electron's safeStorage encrypts through the backend Chromium selects from the
// desktop environment. On a compositor Chromium does not recognise (sway,
// Hyprland, river, niri) it selects `basic_text`, so `isEncryptionAvailable()`
// is false and every secret lands in plaintext — even with a working keyring on
// the session bus. Rule (adopted from Orca, docs/research/orca-linux-cannibalize.md):
// ask for `gnome-libsecret` ONLY when an UNLOCKED Secret Service collection
// answers on an unrecognised desktop. A LOCKED collection is skipped (libsecret
// would wait on an unlock prompt nobody can answer — a ~76 s startup stall), and a
// recognised desktop keeps Chromium's own choice (overriding it would strand
// credentials sealed under kwallet, etc.).
//
// Pure: the D-Bus probe is injected and deferred, so it never runs when the
// decision does not depend on it. The probe itself is src/main/linux-keyring.ts.

/** What the probe of the default Secret Service collection found. */
export type SecretServiceState =
  /** Answered, and `Locked == false`: openable without a prompt. */
  | 'unlocked'
  /** Answered, and `Locked == true`: libsecret would block on an unlock prompt. */
  | 'locked'
  /** No owner / no default collection / the probe failed or timed out / no `gdbus`. */
  | 'unavailable';

export type PasswordStoreReason =
  | 'explicit-switch'
  | 'no-session-bus'
  | 'recognised-desktop'
  | 'unlocked-service'
  | 'locked-service'
  | 'no-service';

export interface PasswordStoreDecision {
  /** The `--password-store` value to append, or null to leave Chromium's choice alone. */
  store: 'gnome-libsecret' | null;
  reason: PasswordStoreReason;
}

/** `XDG_CURRENT_DESKTOP` / `DESKTOP_SESSION` tokens Chromium maps to a backend of its own. LXQt is
 *  listed on purpose: Chromium deliberately selects basic_text for it, which is its choice to keep. */
const RECOGNISED_DESKTOP_TOKENS: ReadonlySet<string> = new Set([
  'cinnamon', 'deepin', 'gnome', 'kde', 'kde4', 'kde5', 'kde6', 'kde-plasma', 'lxqt', 'mate',
  'pantheon', 'plasma', 'ukui', 'unity', 'x-cinnamon', 'xfce', 'xubuntu',
]);

/** Presence alone makes Chromium pick a backend (a KDE session without `XDG_CURRENT_DESKTOP` is still kwallet). */
const DESKTOP_PRESENCE_VARS = ['GNOME_DESKTOP_SESSION_ID', 'KDE_FULL_SESSION', 'KDE_SESSION_VERSION'] as const;

type Env = Record<string, string | undefined>;

/** True when Chromium resolves this desktop to a backend itself. */
export function isRecognisedDesktop(env: Env): boolean {
  if (DESKTOP_PRESENCE_VARS.some((name) => (env[name]?.trim() ?? '') !== '')) return true;
  // `XDG_CURRENT_DESKTOP` is a colon-separated, mixed-case list ("ubuntu:GNOME").
  const tokens = (env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .concat(env.DESKTOP_SESSION ?? '')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '');
  return tokens.some((t) => RECOGNISED_DESKTOP_TOKENS.has(t));
}

export function decidePasswordStore(input: {
  env: Env;
  /** An explicit `--password-store` (the user's or an E2E's) always wins. */
  passwordStoreAlreadySelected: boolean;
  /** A session bus is reachable: `DBUS_SESSION_BUS_ADDRESS` is set OR `$XDG_RUNTIME_DIR/bus` exists —
   *  GLib/libsecret fall back to that socket, and a tiling-WM session often exports no address at all
   *  (measured on this host: unset, socket present). Without a bus the probe could only autolaunch one. */
  sessionBusReachable: boolean;
  /** Deferred: invoked only when the decision depends on it. */
  probe: () => SecretServiceState;
}): PasswordStoreDecision {
  if (input.passwordStoreAlreadySelected) return { store: null, reason: 'explicit-switch' };
  if (!input.sessionBusReachable) return { store: null, reason: 'no-session-bus' };
  if (isRecognisedDesktop(input.env)) return { store: null, reason: 'recognised-desktop' };
  const state = input.probe();
  if (state === 'unlocked') return { store: 'gnome-libsecret', reason: 'unlocked-service' };
  return { store: null, reason: state === 'locked' ? 'locked-service' : 'no-service' };
}

/** Parse `gdbus call … Properties.Get org.freedesktop.Secret.Collection Locked`, which prints the
 *  variant-wrapped boolean: `(<false>,)` or `(<true>,)`. Anything else is not an answer. */
export function parseCollectionLocked(stdout: string): SecretServiceState {
  const m = /^\(<(true|false)>,\)\s*$/.exec(stdout.trim());
  if (!m) return 'unavailable';
  return m[1] === 'false' ? 'unlocked' : 'locked';
}

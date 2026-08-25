// The push-to-talk HOTKEY, as a per-user preference persisted in localStorage.
// Pure + dependency-free (mirrors `composer-vim-pref.ts`), so it is
// node-testable and readable from both the composer and a settings surface.
//
// WHY THIS IS CONFIGURABLE, and why it binds `code` rather than `key`:
//
// The hotkey shipped as a hardcoded Ctrl+M matched on `e.key === 'm' ||
// e.code === 'KeyM'`. That is silently DEAD on a physical AZERTY keyboard
// driven by a `us` software layout (a common MacBook setup): the key LABELLED
// M sits at <AC10>, which `us` maps to semicolon, so it reports
// `key=';' code='Semicolon'` and matches neither term. Meanwhile `code='KeyM'`
// lands on <AB07> — the key labelled `,`. Reported from the real app as
// "Ctrl+M does nothing", with the mic icon visible and clicking it working.
//
// `code` is the physical position and is layout-INDEPENDENT, which is what we
// want to store: whatever key the user physically pressed while binding is the
// key that will work, on any layout, without us maintaining a layout table.
// The trade-off is that we cannot infer a nice LABEL from `code` alone
// (`Semicolon` is the M key here), so the binding UI records the printable
// `key` the user produced purely for DISPLAY.
//
// Matching on `code` also fixes the release path for free: a keyup after the
// user lifts Ctrl first reports a different `key` on some layouts, but `code`
// is invariant for the whole press.

/** A bound chord. `code` is authoritative for matching; `label` is cosmetic. */
export interface VoiceHotkey {
  /** `KeyboardEvent.code` — the physical key position. Layout-independent. */
  code: string;
  /** What to show in tooltips/settings, e.g. "M" or ";". Display only. */
  label: string;
  /** Require Ctrl (or Cmd on mac) — always true today; here for future chords. */
  ctrl: boolean;
}

export const VOICE_HOTKEY_KEY = 'orchestra:voiceHotkey';

/** The historical default: Ctrl+M on a US-QWERTY layout. Unchanged for every
 *  user whose keyboard actually produces `KeyM` where M is printed. */
export const DEFAULT_VOICE_HOTKEY: VoiceHotkey = { code: 'KeyM', label: 'M', ctrl: true };

/** Read the persisted hotkey, falling back to Ctrl+M. Never throws: a corrupt
 *  or partial record reads as the default rather than disabling dictation. */
export function readVoiceHotkey(
  storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage(),
): VoiceHotkey {
  const raw = storage?.getItem(VOICE_HOTKEY_KEY);
  if (!raw) return DEFAULT_VOICE_HOTKEY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_VOICE_HOTKEY;
    const { code, label, ctrl } = parsed as Partial<VoiceHotkey>;
    // `code` is the only load-bearing field; without it there is nothing to
    // match on, so anything missing it is treated as absent, not as "no hotkey".
    if (typeof code !== 'string' || !code) return DEFAULT_VOICE_HOTKEY;
    return {
      code,
      label: typeof label === 'string' && label ? label : code,
      ctrl: ctrl !== false,
    };
  } catch {
    return DEFAULT_VOICE_HOTKEY;
  }
}

/** Persist the hotkey. No-op if localStorage is unavailable. */
export function writeVoiceHotkey(
  value: VoiceHotkey,
  storage: Pick<Storage, 'setItem'> | undefined = safeLocalStorage(),
): void {
  try {
    storage?.setItem(VOICE_HOTKEY_KEY, JSON.stringify(value));
  } catch {
    // Quota/locked-down storage: the in-memory binding still applies this session.
  }
}

/** Does this keyboard event fire the hotkey?
 *
 *  Matched on `code` (physical position) so it is layout-independent. Alt is
 *  excluded because AltGr surfaces as ctrl+alt on Windows/Linux and would make
 *  every AltGr chord on the bound key trigger dictation.
 *
 *  `requireModifier` is false for KEY-UP: releasing Ctrl before the letter is a
 *  normal way to end the gesture, and the keyup then reports ctrlKey=false.
 *  Dropping that release would strand the mic ON. */
export function matchesVoiceHotkey(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  hotkey: VoiceHotkey = DEFAULT_VOICE_HOTKEY,
  requireModifier = true,
): boolean {
  if (e.code !== hotkey.code) return false;
  if (e.altKey) return false;
  if (!requireModifier) return true;
  return hotkey.ctrl ? e.ctrlKey || e.metaKey : true;
}

/** Build a hotkey from the keydown captured in the "press a key" binding UI.
 *
 *  Returns null for a press that is only a modifier (the user is mid-chord) or
 *  that carries no usable `code`, so the recorder keeps waiting instead of
 *  binding Ctrl to itself. */
export function hotkeyFromEvent(
  e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey'>,
): VoiceHotkey | null {
  const code = e.code;
  if (!code) return null;
  if (/^(Control|Shift|Alt|Meta|OS)/.test(code)) return null;
  // Prefer the printable character the user sees on the keycap; fall back to
  // the physical code for non-printing keys (F5, Space…).
  const label = e.key && e.key.length === 1 ? e.key.toUpperCase() : prettyCode(code);
  return { code, label, ctrl: e.ctrlKey || e.metaKey };
}

/** Human-readable chord for tooltips and settings, e.g. "Ctrl+M". */
export function voiceHotkeyLabel(hotkey: VoiceHotkey = DEFAULT_VOICE_HOTKEY): string {
  return hotkey.ctrl ? `Ctrl+${hotkey.label}` : hotkey.label;
}

function prettyCode(code: string): string {
  return code.replace(/^(Key|Digit)/, '');
}

function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    // Accessing localStorage can throw in locked-down contexts.
    return undefined;
  }
}

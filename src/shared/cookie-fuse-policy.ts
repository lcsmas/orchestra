// The Settings > Browser at-rest warning, derived from the REAL state of the running app (#407): the fuse of the binary it runs AND whether the platform keyring
// backend can encrypt right now. Pure. Until the maintainer accepts the measured trap (docs/evidence/407-cookie-fuse.jsonl) the shipped fuse is OFF, so every real
// state ends in the always-on PROFILE_AT_REST_WARNING — the same text the UI showed before this function existed.
import { PROFILE_AT_REST_WARNING } from './browser-profile.ts';

export type CookieFuseState = 'enabled' | 'disabled' | 'unknown';

export interface AtRestState {
  /** `EnableCookieEncryption` in the binary this process runs, read from its own fuse wire (src/main/cookie-fuse-state.ts). */
  fuse: CookieFuseState;
  /** `SecretsState.encrypted`: safeStorage can encrypt NOW with a real keyring (false for `basic_text`, a locked keyring, no keyring); null = not known yet. */
  backendEncrypted: boolean | null;
}

/** The fuse is ON but the key is Chromium's built-in `basic_text` one (no usable keyring): the cookie DB is scrambled, not secret. */
export const PROFILE_AT_REST_OBFUSCATED_WARNING =
  'Cookies and sign-ins of a profile are scrambled on disk with a key built into this app (no keyring is in use): readable by anything running as you. Create profiles only for accounts you accept that for.';

/** The warning to show while creating / listing profiles, or null when cookies really are encrypted with a keyring-held key.
 *  Fails CLOSED: an unknown / not-yet-loaded state is the old always-on warning (story 25: choose knowingly). */
export function profileAtRestWarning(state: AtRestState | null): string | null {
  if (!state || state.fuse !== 'enabled') return PROFILE_AT_REST_WARNING;
  return state.backendEncrypted === true ? null : PROFILE_AT_REST_OBFUSCATED_WARNING;
}

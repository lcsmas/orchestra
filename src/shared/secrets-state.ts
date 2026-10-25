// What Settings tells the human about secret storage (#389). `SecretsState` is the IPC payload
// (`getSecretsState`, channel `secrets:state`); `secretsNotice` is the pure rule for the warning.

/** Encrypted / not-encrypted state of the secrets file. `encrypted` is whether the platform can encrypt
 *  NOW; the counts say what is actually on disk. */
export interface SecretsState {
  /** safeStorage can encrypt/decrypt right now. False → new secrets are stored in plaintext and
   *  already-encrypted ones cannot be read until a keyring is available again. */
  encrypted: boolean;
  /** The Chromium backend safeStorage selected (`gnome_libsecret`, `kwallet5`, `basic_text`, …), or null. */
  backend: string | null;
  /** Stored entries currently in plaintext / as ciphertext. */
  plaintextEntries: number;
  encryptedEntries: number;
}

export interface SecretsNotice {
  kind: 'unencrypted' | 'unreadable';
  text: string;
}

/** The warning to show, or null — nothing at all when encryption works. When it does not, stored
 *  ciphertext (written on an earlier run with a keyring) is unreadable until the keyring is back, which
 *  is worth saying: the keys are not lost, but they do not work either. */
export function secretsNotice(state: SecretsState | null): SecretsNotice | null {
  if (!state || state.encrypted) return null;
  const text = 'Secrets are stored unencrypted on this machine: no keyring is available.';
  if (state.encryptedEntries > 0) {
    const n = state.encryptedEntries;
    return {
      kind: 'unreadable',
      text: `${text} ${n} stored secret${n === 1 ? ' is' : 's are'} encrypted and unreadable until the keyring is unlocked.`,
    };
  }
  return { kind: 'unencrypted', text };
}

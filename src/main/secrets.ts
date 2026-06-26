// Persistent storage for the user's secrets (currently just the Linear API
// key), set from the app's settings UI rather than an env var.
//
// The key is encrypted at rest with Electron's safeStorage — on Linux this uses
// the OS secret service (libsecret / KDE wallet), on macOS the Keychain, on
// Windows DPAPI. We store the ciphertext as base64 in a JSON file under
// userData. If safeStorage reports no OS backend (a headless box, no keyring
// daemon), we fall back to storing the raw value with a 0600 file mode and a
// logged warning — better a working feature than a hard failure, and the file
// is already user-only in userData.

import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { log } from './logger';

/** On-disk shape. `enc` marks whether `linearApiKey` is safeStorage ciphertext
 *  (base64) or a plaintext fallback, so reads decode correctly even if keyring
 *  availability changes between writes. */
interface SecretsFile {
  linearApiKey?: string;
  /** true → `linearApiKey` is base64 safeStorage ciphertext; false → plaintext. */
  enc?: boolean;
}

let cached: SecretsFile | null = null;

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'orchestra', 'secrets.json');
}

async function readFileSafe(): Promise<SecretsFile> {
  if (cached) return cached;
  const file = secretsPath();
  if (!existsSync(file)) {
    cached = {};
    return cached;
  }
  try {
    cached = JSON.parse(await readFile(file, 'utf8')) as SecretsFile;
  } catch {
    cached = {};
  }
  return cached;
}

async function writeFileSafe(data: SecretsFile): Promise<void> {
  const file = secretsPath();
  const dir = path.dirname(file);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(data), 'utf8');
  // Best-effort tighten perms (no-op / throws on Windows — ignore).
  await chmod(file, 0o600).catch(() => {});
  cached = data;
}

/** The Linear API key the user saved in-app, decrypted, or undefined if none.
 *  This is the stored secret only — env-var fallback is layered on by the
 *  caller in linear.ts. */
export async function getLinearApiKey(): Promise<string | undefined> {
  const data = await readFileSafe();
  const raw = data.linearApiKey;
  if (!raw) return undefined;
  if (!data.enc) return raw; // plaintext fallback path
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'));
  } catch (err) {
    // Ciphertext written under a different OS user/keyring can't be decrypted.
    log.warn('could not decrypt stored Linear API key', { err: String(err) });
    return undefined;
  }
}

/** Persist a Linear API key, encrypted when the OS supports it. Trims the
 *  value; an empty/blank key clears the stored secret instead of saving it. */
export async function setLinearApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) return clearLinearApiKey();
  const data = await readFileSafe();
  if (safeStorage.isEncryptionAvailable()) {
    data.linearApiKey = safeStorage.encryptString(trimmed).toString('base64');
    data.enc = true;
  } else {
    log.warn('safeStorage unavailable — storing Linear API key unencrypted', {
      file: secretsPath(),
    });
    data.linearApiKey = trimmed;
    data.enc = false;
  }
  await writeFileSafe(data);
}

/** Remove the stored Linear API key (env-var fallback, if any, still applies). */
export async function clearLinearApiKey(): Promise<void> {
  const data = await readFileSafe();
  delete data.linearApiKey;
  delete data.enc;
  await writeFileSafe(data);
}

/** Wipe the whole secrets file (used by tests / a hard reset). */
export async function clearAllSecrets(): Promise<void> {
  cached = {};
  const file = secretsPath();
  if (existsSync(file)) await rm(file).catch(() => {});
}

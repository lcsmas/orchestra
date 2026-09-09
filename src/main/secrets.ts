// Persistent storage for the user's secrets (the Linear API key, and each
// account's Anthropic API key), set from the app's settings UI rather than an
// env var.
//
// The key is encrypted at rest with Electron's safeStorage (via the platform
// seam) — on Linux this uses the OS secret service (libsecret / KDE wallet),
// on macOS the Keychain, on Windows DPAPI. We store the ciphertext as base64
// in a JSON file under userData. If the seam reports no encryption backend (a
// headless box, or no keyring service available), we fall back to storing the
// raw value with a 0600 file mode
// and a logged warning — better a working feature than a hard failure, and the
// file is already user-only in userData.

import { platform } from './platform';
import { readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { log } from './logger';

/** One stored secret: the value plus whether it is safeStorage ciphertext, so
 *  a read decodes correctly even if keyring availability changed between
 *  writes. Per-entry (not per-file) because accounts are written one at a time
 *  and a global flag would mislabel every other entry. */
interface StoredSecret {
  value: string;
  /** true → `value` is base64 safeStorage ciphertext; false → plaintext. */
  enc: boolean;
}

/** On-disk shape. `linearApiKey`/`enc` are the ORIGINAL top-level pair and stay
 *  as-is for backward compatibility (a file written by an older build must keep
 *  working); per-account keys live under `accountApiKeys`, keyed by account id. */
interface SecretsFile {
  linearApiKey?: string;
  /** true → `linearApiKey` is base64 safeStorage ciphertext; false → plaintext. */
  enc?: boolean;
  /** Anthropic API key per account id (see Account.auth in shared/accounts.ts). */
  accountApiKeys?: Record<string, StoredSecret>;
}

let cached: SecretsFile | null = null;

function secretsPath(): string {
  return path.join(platform.getUserDataDir(), 'orchestra', 'secrets.json');
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
    return platform.decryptString(Buffer.from(raw, 'base64'));
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
  if (platform.isEncryptionAvailable()) {
    data.linearApiKey = platform.encryptString(trimmed).toString('base64');
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

// ---- per-account Anthropic API keys ------------------------------------------

/** Encrypt when the OS offers a backend, else store plaintext (same tradeoff as
 *  the Linear key: the file is 0600 under userData). */
function encodeSecret(value: string, what: string): StoredSecret {
  if (platform.isEncryptionAvailable()) {
    return { value: platform.encryptString(value).toString('base64'), enc: true };
  }
  log.warn(`safeStorage unavailable — storing ${what} unencrypted`, { file: secretsPath() });
  return { value, enc: false };
}

/** Decode a stored secret, or undefined when the ciphertext can't be read (it
 *  was written under a different OS user/keyring). */
function decodeSecret(secret: StoredSecret | undefined, what: string): string | undefined {
  if (!secret?.value) return undefined;
  if (!secret.enc) return secret.value;
  try {
    return platform.decryptString(Buffer.from(secret.value, 'base64'));
  } catch (err) {
    log.warn(`could not decrypt stored ${what}`, { err: String(err) });
    return undefined;
  }
}

/** The Anthropic API key stored for one account, decrypted, or undefined. */
export async function getAccountApiKey(accountId: string): Promise<string | undefined> {
  const data = await readFileSafe();
  return decodeSecret(data.accountApiKeys?.[accountId], `API key for account ${accountId}`);
}

/** Every account id that currently has a stored key — lets the renderer show
 *  "key set" without the key itself ever crossing the IPC boundary. */
export async function accountApiKeyIds(): Promise<string[]> {
  const data = await readFileSafe();
  return Object.entries(data.accountApiKeys ?? {})
    .filter(([, v]) => Boolean(v?.value))
    .map(([id]) => id);
}

/** Persist an account's API key, encrypted where supported. A blank value
 *  clears it instead of storing an empty string. */
export async function setAccountApiKey(accountId: string, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) return clearAccountApiKey(accountId);
  const data = await readFileSafe();
  const keys = { ...(data.accountApiKeys ?? {}) };
  keys[accountId] = encodeSecret(trimmed, `API key for account ${accountId}`);
  await writeFileSafe({ ...data, accountApiKeys: keys });
}

/** Remove one account's stored API key. */
export async function clearAccountApiKey(accountId: string): Promise<void> {
  const data = await readFileSafe();
  if (!data.accountApiKeys?.[accountId]) return;
  const keys = { ...data.accountApiKeys };
  delete keys[accountId];
  await writeFileSafe({ ...data, accountApiKeys: keys });
}

/** Drop keys whose account no longer exists, so a deleted account's secret
 *  cannot linger on disk. Called after every accounts save. */
export async function pruneAccountApiKeys(liveIds: string[]): Promise<void> {
  const data = await readFileSafe();
  const stored = data.accountApiKeys;
  if (!stored) return;
  const live = new Set(liveIds);
  const keys = Object.fromEntries(Object.entries(stored).filter(([id]) => live.has(id)));
  if (Object.keys(keys).length === Object.keys(stored).length) return;
  await writeFileSafe({ ...data, accountApiKeys: keys });
}

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
// file is already user-only in userData. Plaintext entries are re-encrypted by
// `reencryptPlaintextSecrets` at the first start where encryption works (#389).

// Explicit `.ts` imports: the type-stripping test runner loads this module (secrets.test.ts).
import { platform } from './platform/index.ts';
import { readFile, writeFile, mkdir, rm, rename, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { log } from './logger.ts';
import type { SecretsState } from '../shared/secrets-state.ts';

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
  /** `ANTHROPIC_BASE_URL` per account id. A private proxy/gateway hostname is a
   *  secret too (it names reachable infrastructure), so it lives here beside the
   *  key rather than in store.json, which is plain config. */
  accountBaseUrls?: Record<string, StoredSecret>;
}

let cached: SecretsFile | null = null;

function secretsPath(): string {
  return path.join(platform.getUserDataDir(), 'orchestra', 'secrets.json');
}

/** One in-flight disk read at a time: concurrent first callers share it (each parsing its own copy let
 *  the last writer win and drop the others' updates). */
let loading: Promise<void> | null = null;

async function loadFromDisk(): Promise<void> {
  const file = secretsPath();
  if (!existsSync(file)) {
    cached = {};
    return;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    // `null` / `0` / `""` / an array are valid JSON but not a secrets file: a falsy `cached` would loop `readFileSafe` forever.
    cached = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SecretsFile) : {};
  } catch {
    cached = {};
  }
}

async function readFileSafe(): Promise<SecretsFile> {
  while (!cached) {
    loading ??= loadFromDisk().finally(() => {
      loading = null;
    });
    await loading;
  }
  return cached;
}

/** Every mutation runs under this lock (read-modify-write plus its write), so two concurrent writers —
 *  or the startup re-encryption and a user save — can never build on the same stale copy and drop one
 *  another's update. Reads are not serialised: they only see a complete `cached`. */
let lock: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/** Atomic (tmp file + rename): a crash or a failed write can never leave `secrets.json` truncated, so
 *  the previous contents — possibly the only copy of a plaintext key — survive. `cached` follows the
 *  disk: it only changes once the rename has landed. */
async function writeFileSafe(data: SecretsFile): Promise<void> {
  const file = secretsPath();
  const dir = path.dirname(file);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    // Best-effort tighten perms (no-op / throws on Windows — ignore).
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
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
export function setLinearApiKey(key: string): Promise<void> {
  return serial(() => setLinearApiKeyNow(key));
}
async function setLinearApiKeyNow(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) return clearLinearApiKeyNow();
  const data = { ...(await readFileSafe()) };
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
export function clearLinearApiKey(): Promise<void> {
  return serial(clearLinearApiKeyNow);
}
async function clearLinearApiKeyNow(): Promise<void> {
  const data = { ...(await readFileSafe()) };
  delete data.linearApiKey;
  delete data.enc;
  await writeFileSafe(data);
}

/** Wipe the whole secrets file (used by tests / a hard reset). */
export function clearAllSecrets(): Promise<void> {
  return serial(async () => {
    cached = {};
    const file = secretsPath();
    if (existsSync(file)) await rm(file).catch(() => {});
  });
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
export function setAccountApiKey(accountId: string, key: string): Promise<void> {
  return serial(() => setAccountApiKeyNow(accountId, key));
}
async function setAccountApiKeyNow(accountId: string, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) return clearAccountApiKeyNow(accountId);
  const data = await readFileSafe();
  const keys = { ...(data.accountApiKeys ?? {}) };
  keys[accountId] = encodeSecret(trimmed, `API key for account ${accountId}`);
  await writeFileSafe({ ...data, accountApiKeys: keys });
}

/** Remove one account's stored API key. */
export function clearAccountApiKey(accountId: string): Promise<void> {
  return serial(() => clearAccountApiKeyNow(accountId));
}
async function clearAccountApiKeyNow(accountId: string): Promise<void> {
  const data = await readFileSafe();
  if (!data.accountApiKeys?.[accountId]) return;
  const keys = { ...data.accountApiKeys };
  delete keys[accountId];
  await writeFileSafe({ ...data, accountApiKeys: keys });
}

/** Drop keys whose account no longer exists, so a deleted account's secret
 *  cannot linger on disk. Called after every accounts save. */
export function pruneAccountApiKeys(liveIds: string[]): Promise<void> {
  return serial(() => pruneAccountApiKeysNow(liveIds));
}
async function pruneAccountApiKeysNow(liveIds: string[]): Promise<void> {
  const data = await readFileSafe();
  const live = new Set(liveIds);
  const keep = (m: Record<string, StoredSecret> | undefined) =>
    m ? Object.fromEntries(Object.entries(m).filter(([id]) => live.has(id))) : undefined;
  const keys = keep(data.accountApiKeys);
  const urls = keep(data.accountBaseUrls);
  const keysChanged = keys && Object.keys(keys).length !== Object.keys(data.accountApiKeys ?? {}).length;
  const urlsChanged = urls && Object.keys(urls).length !== Object.keys(data.accountBaseUrls ?? {}).length;
  if (!keysChanged && !urlsChanged) return;
  await writeFileSafe({
    ...data,
    ...(keys ? { accountApiKeys: keys } : {}),
    ...(urls ? { accountBaseUrls: urls } : {}),
  });
}

// ---- per-account base URLs ---------------------------------------------------

/** The `ANTHROPIC_BASE_URL` stored for one account, decrypted, or undefined. */
export async function getAccountBaseUrl(accountId: string): Promise<string | undefined> {
  const data = await readFileSafe();
  return decodeSecret(data.accountBaseUrls?.[accountId], `base URL for account ${accountId}`);
}

/** Persist an account's base URL. A blank value clears it (→ api.anthropic.com). */
export function setAccountBaseUrl(accountId: string, url: string): Promise<void> {
  return serial(() => setAccountBaseUrlNow(accountId, url));
}
async function setAccountBaseUrlNow(accountId: string, url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) return clearAccountBaseUrlNow(accountId);
  const data = await readFileSafe();
  const urls = { ...(data.accountBaseUrls ?? {}) };
  urls[accountId] = encodeSecret(trimmed, `base URL for account ${accountId}`);
  await writeFileSafe({ ...data, accountBaseUrls: urls });
}

/** Remove one account's stored base URL. */
export function clearAccountBaseUrl(accountId: string): Promise<void> {
  return serial(() => clearAccountBaseUrlNow(accountId));
}
async function clearAccountBaseUrlNow(accountId: string): Promise<void> {
  const data = await readFileSafe();
  if (!data.accountBaseUrls?.[accountId]) return;
  const urls = { ...data.accountBaseUrls };
  delete urls[accountId];
  await writeFileSafe({ ...data, accountBaseUrls: urls });
}

/** Ids of the accounts that have a stored base URL — lets the settings UI show
 *  "set" without the value crossing IPC. */
export async function accountBaseUrlIds(): Promise<string[]> {
  const data = await readFileSafe();
  return Object.entries(data.accountBaseUrls ?? {})
    .filter(([, v]) => Boolean(v?.value))
    .map(([id]) => id);
}

/** One-shot migration for accounts released with `auth.baseUrl` in store.json
 *  (v0.5.265): move each value into the keystore. Returns the ids it migrated so
 *  the caller can strip them from store.json — leaving the URL in both places
 *  would defeat the point. Skips an account that already has one stored. */
export function migrateBaseUrlsIntoKeystore(
  fromStore: Array<{ id: string; baseUrl: string }>,
): Promise<string[]> {
  return serial(() => migrateBaseUrlsNow(fromStore));
}
async function migrateBaseUrlsNow(fromStore: Array<{ id: string; baseUrl: string }>): Promise<string[]> {
  if (fromStore.length === 0) return [];
  const data = await readFileSafe();
  const urls = { ...(data.accountBaseUrls ?? {}) };
  const moved: string[] = [];
  for (const { id, baseUrl } of fromStore) {
    const trimmed = baseUrl.trim();
    if (!trimmed || urls[id]?.value) continue;
    urls[id] = encodeSecret(trimmed, `base URL for account ${id}`);
    moved.push(id);
  }
  if (moved.length === 0) return [];
  await writeFileSafe({ ...data, accountBaseUrls: urls });
  return moved;
}

// ---- encryption state + re-encryption (#389) ----------------------------------

function* entriesOf(data: SecretsFile): Generator<{ enc: boolean }> {
  if (data.linearApiKey) yield { enc: data.enc === true };
  for (const map of [data.accountApiKeys, data.accountBaseUrls]) {
    for (const v of Object.values(map ?? {})) if (v?.value) yield { enc: v.enc === true };
  }
}

function countEntries(data: SecretsFile): { plaintext: number; encrypted: number } {
  let plaintext = 0;
  let encrypted = 0;
  for (const e of entriesOf(data)) e.enc ? encrypted++ : plaintext++;
  return { plaintext, encrypted };
}

/** The encrypted / not-encrypted state for Settings. Touches safeStorage, so call it when Settings opens,
 *  not at startup. */
export async function getSecretsState(): Promise<SecretsState> {
  const { plaintext, encrypted } = countEntries(await readFileSafe());
  return {
    encrypted: platform.isEncryptionAvailable(),
    backend: platform.getSecretBackend(),
    plaintextEntries: plaintext,
    encryptedEntries: encrypted,
  };
}

export interface ReencryptResult {
  reencrypted: number;
  /** Entries left in plaintext because sealing them failed (kept readable, retried next start). */
  failed: number;
  skipped: 'no-plaintext' | 'encryption-unavailable' | null;
}

/** Seal every plaintext entry now that the platform can encrypt. Never loses a secret: each entry is
 *  replaced only by ciphertext that decrypts back to the SAME value, a failing entry stays plaintext,
 *  and the file is rewritten once, atomically — if that write fails the old file is untouched. With
 *  nothing in plaintext it returns before touching safeStorage (no keyring access at startup). */
export function reencryptPlaintextSecrets(): Promise<ReencryptResult> {
  return serial(reencryptNow);
}
async function reencryptNow(): Promise<ReencryptResult> {
  const data = await readFileSafe();
  if (countEntries(data).plaintext === 0) return { reencrypted: 0, failed: 0, skipped: 'no-plaintext' };
  if (!platform.isEncryptionAvailable()) return { reencrypted: 0, failed: 0, skipped: 'encryption-unavailable' };

  let reencrypted = 0;
  let failed = 0;
  const seal = (value: string, what: string): StoredSecret | null => {
    try {
      const cipher = platform.encryptString(value);
      if (platform.decryptString(cipher) !== value) throw new Error('round-trip mismatch');
      return { value: cipher.toString('base64'), enc: true };
    } catch (err) {
      log.warn(`could not re-encrypt ${what} — left in plaintext`, { err: String(err) });
      failed++;
      return null;
    }
  };
  const next: SecretsFile = { ...data };
  if (data.linearApiKey && !data.enc) {
    const sealed = seal(data.linearApiKey, 'Linear API key');
    if (sealed) {
      next.linearApiKey = sealed.value;
      next.enc = true;
      reencrypted++;
    }
  }
  for (const field of ['accountApiKeys', 'accountBaseUrls'] as const) {
    const map = data[field];
    if (!map) continue;
    const out: Record<string, StoredSecret> = { ...map };
    for (const [id, secret] of Object.entries(map)) {
      if (!secret?.value || secret.enc) continue;
      const sealed = seal(secret.value, `${field === 'accountApiKeys' ? 'API key' : 'base URL'} for account ${id}`);
      if (sealed) {
        out[id] = sealed;
        reencrypted++;
      }
    }
    next[field] = out;
  }
  if (reencrypted > 0) await writeFileSafe(next);
  return { reencrypted, failed, skipped: null };
}

/** Fire the re-encryption without awaiting it, and log what it did. `why` names the trigger: `startup` (only when this
 *  process just selected libsecret after an UNLOCKED probe — safeStorage cannot block there) or `settings` (the human
 *  opened a dialog that already touches safeStorage). Never throws; a failure keeps the plaintext. */
export function reencryptInBackground(why: 'startup' | 'settings'): void {
  void reencryptPlaintextSecrets()
    .then((r) => {
      if (r.reencrypted || r.failed) log.info(`[secrets] (${why}) re-encrypted ${r.reencrypted} plaintext entr(ies), ${r.failed} left in plaintext`);
      else if (r.skipped === 'encryption-unavailable') log.info(`[secrets] (${why}) plaintext entries kept: no keyring available to encrypt them`);
    })
    .catch((e) => log.warn(`[secrets] (${why}) re-encryption failed — plaintext kept`, e));
}

/** Test seam: forget the in-memory copy so the next read goes to disk. */
export function __resetSecretsCacheForTests(): void {
  cached = null;
}

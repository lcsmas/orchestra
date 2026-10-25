import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import { initPlatform, type OrchestraPlatform } from './platform/index.ts';
import {
  __resetSecretsCacheForTests,
  accountApiKeyIds,
  clearLinearApiKey,
  getAccountApiKey,
  getAccountBaseUrl,
  getLinearApiKey,
  getSecretsState,
  reencryptPlaintextSecrets,
  setAccountApiKey,
  setAccountBaseUrl,
  setLinearApiKey,
} from './secrets.ts';

// #389 — the secrets module over a FAKE platform: plaintext written while no keyring answered must be
// re-encrypted once one does, stay readable throughout, and NEVER be lost when sealing or the write fails.

interface Fake {
  available: boolean;
  /** encryptString throws from the Nth call (1-based) on; 0 = never. */
  encryptThrowsFrom: number;
  /** decryptString returns garbage (a keyring that seals but cannot unseal). */
  decryptBroken: boolean;
  encryptCalls: number;
  availabilityChecks: number;
}

let dir: string;
let fake: Fake;
const file = () => path.join(dir, 'orchestra', 'secrets.json');
const raw = () => fs.readFileSync(file(), 'utf8');
const onDisk = () => JSON.parse(raw());
/** Drop the in-memory copy so every read proves what is on DISK. */
const reload = () => __resetSecretsCacheForTests();

function installFake(): void {
  const seal = (s: string) => Buffer.from(`SEALED:${Buffer.from(s).toString('hex')}`);
  const platform = {
    kind: 'electron',
    getUserDataDir: () => dir,
    isEncryptionAvailable: () => (fake.availabilityChecks++, fake.available),
    getSecretBackend: () => (fake.available ? 'fake_keyring' : 'basic_text'),
    encryptString: (plain: string) => {
      fake.encryptCalls++;
      if (!fake.available) throw new Error('Error while encrypting the text provided to safeStorage.encryptString. Encryption is not available.');
      if (fake.encryptThrowsFrom && fake.encryptCalls >= fake.encryptThrowsFrom) throw new Error('keyring hiccup');
      return seal(plain);
    },
    decryptString: (cipher: Buffer) => {
      if (!fake.available) throw new Error('Decryption is not available.');
      if (fake.decryptBroken) return 'garbage';
      const s = cipher.toString();
      if (!s.startsWith('SEALED:')) throw new Error('not sealed by this keyring');
      return Buffer.from(s.slice('SEALED:'.length), 'hex').toString();
    },
    getLogsDir: () => path.join(dir, 'logs'),
  } as unknown as OrchestraPlatform;
  initPlatform(new Proxy(platform, { get: (t, p) => (p in t ? (t as never)[p] : () => undefined) }));
}

beforeEach(() => {
  dir = mkHomeScratch('secrets-test-');
  fake = { available: false, encryptThrowsFrom: 0, decryptBroken: false, encryptCalls: 0, availabilityChecks: 0 };
  installFake();
  reload();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The state after "the human used Orchestra on a box with no keyring": every kind of entry in plaintext. */
async function seedPlaintext(): Promise<void> {
  await setLinearApiKey('lin_api_PLAINTEXT_1');
  await setAccountApiKey('acc-a', 'sk-ant-PLAINTEXT-A');
  await setAccountApiKey('acc-b', 'sk-ant-PLAINTEXT-B');
  await setAccountBaseUrl('acc-a', 'https://gateway.internal.example');
}
const ALL = {
  linear: 'lin_api_PLAINTEXT_1',
  a: 'sk-ant-PLAINTEXT-A',
  b: 'sk-ant-PLAINTEXT-B',
  url: 'https://gateway.internal.example',
};
async function readAll() {
  return {
    linear: await getLinearApiKey(),
    a: await getAccountApiKey('acc-a'),
    b: await getAccountApiKey('acc-b'),
    url: await getAccountBaseUrl('acc-a'),
  };
}

test('no keyring: entries are stored plaintext, 0600, and the state says not-encrypted', async () => {
  await seedPlaintext();
  assert.equal(onDisk().enc, false);
  assert.ok(raw().includes('sk-ant-PLAINTEXT-A'));
  assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  assert.deepEqual(await getSecretsState(), { encrypted: false, backend: 'basic_text', plaintextEntries: 4, encryptedEntries: 0 });
});

test('plaintext + encryption now available → re-encrypted at startup, nothing readable on disk, every value still readable', async () => {
  await seedPlaintext();
  reload();
  fake.available = true;

  const r = await reencryptPlaintextSecrets();
  assert.deepEqual(r, { reencrypted: 4, failed: 0, skipped: null });

  for (const secret of Object.values(ALL)) assert.ok(!raw().includes(secret), `"${secret}" is no longer in the file`);
  const disk = onDisk();
  assert.equal(disk.enc, true);
  assert.ok(disk.accountApiKeys['acc-a'].enc && disk.accountApiKeys['acc-b'].enc && disk.accountBaseUrls['acc-a'].enc);
  assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  reload();
  assert.deepEqual(await readAll(), ALL, 'still readable (decrypted) after a cold read from disk');
  assert.deepEqual(await accountApiKeyIds(), ['acc-a', 'acc-b']);
  assert.deepEqual(await getSecretsState(), { encrypted: true, backend: 'fake_keyring', plaintextEntries: 0, encryptedEntries: 4 });
  assert.deepEqual(fs.readdirSync(path.dirname(file())), ['secrets.json'], 'no tmp residue');
});

test('encryption failing MID-WAY → the failing entries keep their plaintext, nothing is lost, a later start finishes the job', async () => {
  await seedPlaintext();
  reload();
  fake.available = true;
  fake.encryptThrowsFrom = 3; // the 3rd seal (and later ones) throws: linear + acc-a key sealed, acc-b key + base URL not

  const r = await reencryptPlaintextSecrets();
  assert.deepEqual(r, { reencrypted: 2, failed: 2, skipped: null });
  reload();
  assert.deepEqual(await readAll(), ALL, 'every value readable after the partial run');
  const disk = onDisk();
  assert.equal(disk.accountApiKeys['acc-b'].enc, false);
  assert.equal(disk.accountApiKeys['acc-b'].value, ALL.b, 'the failed entry is still the plaintext, byte for byte');
  assert.equal(disk.accountBaseUrls['acc-a'].value, ALL.url);
  assert.ok(!raw().includes(ALL.linear) && !raw().includes(ALL.a), 'the sealed ones are no longer plaintext');
  assert.deepEqual(await getSecretsState(), { encrypted: true, backend: 'fake_keyring', plaintextEntries: 2, encryptedEntries: 2 });

  fake.encryptThrowsFrom = 0; // the hiccup is over: the next startup retries only what is left
  assert.deepEqual(await reencryptPlaintextSecrets(), { reencrypted: 2, failed: 0, skipped: null });
  reload();
  assert.deepEqual(await readAll(), ALL);
  assert.equal((await getSecretsState()).plaintextEntries, 0);
});

test('a keyring that seals but cannot unseal (round-trip fails) → NOTHING is replaced and the file is not even rewritten', async () => {
  await seedPlaintext();
  reload();
  fake.available = true;
  fake.decryptBroken = true;
  const before = raw();

  const r = await reencryptPlaintextSecrets();
  assert.deepEqual(r, { reencrypted: 0, failed: 4, skipped: null });
  assert.equal(raw(), before, 'file byte-identical');
  fake.decryptBroken = false;
  reload();
  assert.deepEqual(await readAll(), ALL);
});

test('encryption still unavailable → a no-op that leaves the file untouched', async () => {
  await seedPlaintext();
  reload();
  const before = raw();
  assert.deepEqual(await reencryptPlaintextSecrets(), { reencrypted: 0, failed: 0, skipped: 'encryption-unavailable' });
  assert.equal(raw(), before);
  assert.equal(fake.encryptCalls, 0, 'never tried to encrypt');
});

test('nothing in plaintext → returns before touching safeStorage at all (no keyring access at startup)', async () => {
  fake.available = true;
  await setLinearApiKey('lin_api_ALREADY_ENCRYPTED');
  reload();
  fake.availabilityChecks = 0;
  assert.deepEqual(await reencryptPlaintextSecrets(), { reencrypted: 0, failed: 0, skipped: 'no-plaintext' });
  assert.equal(fake.availabilityChecks, 0, 'isEncryptionAvailable was not called');
  fs.rmSync(file());
  reload();
  assert.deepEqual(await reencryptPlaintextSecrets(), { reencrypted: 0, failed: 0, skipped: 'no-plaintext' }, 'no secrets file at all');
});

test('the WRITE failing (disk error) → rejects, the plaintext file is untouched and a retry succeeds', async () => {
  await seedPlaintext();
  reload();
  fake.available = true;
  const before = raw();
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.mkdirSync(tmp); // the temp path is a directory: writing it fails with EISDIR before `secrets.json` is touched

  await assert.rejects(() => reencryptPlaintextSecrets(), /EISDIR/);
  assert.equal(raw(), before, 'secrets.json byte-identical after the failed write');
  reload();
  assert.deepEqual(await readAll(), ALL, 'plaintext still readable (cache dropped, re-read from disk)');

  fs.rmdirSync(tmp);
  assert.deepEqual(await reencryptPlaintextSecrets(), { reencrypted: 4, failed: 0, skipped: null });
  reload();
  assert.deepEqual(await readAll(), ALL);
});

test('encrypted entries on disk but the keyring gone (locked next boot) → state says not-encrypted WITH the count; reads fail soft, nothing is rewritten', async () => {
  fake.available = true;
  await setLinearApiKey('lin_api_SEALED');
  await setAccountApiKey('acc-a', 'sk-ant-SEALED');
  reload();
  fake.available = false;
  const before = raw();

  assert.deepEqual(await getSecretsState(), { encrypted: false, backend: 'basic_text', plaintextEntries: 0, encryptedEntries: 2 });
  assert.equal(await getLinearApiKey(), undefined);
  assert.equal(await getAccountApiKey('acc-a'), undefined);
  assert.deepEqual(await reencryptPlaintextSecrets(), { reencrypted: 0, failed: 0, skipped: 'no-plaintext' });
  assert.equal(raw(), before, 'the ciphertext is kept for the day the keyring is back');
  fake.available = true;
  assert.equal(await getLinearApiKey(), 'lin_api_SEALED');
});

test('concurrent writers never lose an update (writes queue behind each other on a fresh cache)', async () => {
  fake.available = true;
  await Promise.all([setAccountApiKey('a', 'ka'), setAccountApiKey('b', 'kb'), setLinearApiKey('lin_x'), setAccountBaseUrl('a', 'https://u')]);
  reload();
  assert.deepEqual(await accountApiKeyIds(), ['a', 'b']);
  assert.equal(await getLinearApiKey(), 'lin_x');
  assert.equal(await getAccountBaseUrl('a'), 'https://u');
});

test('a user write racing the startup re-encryption survives it', async () => {
  await seedPlaintext();
  reload();
  fake.available = true;
  const [r] = await Promise.all([reencryptPlaintextSecrets(), setAccountApiKey('acc-c', 'sk-ant-NEW-C')]);
  assert.equal(r.reencrypted, 4);
  reload();
  assert.equal(await getAccountApiKey('acc-c'), 'sk-ant-NEW-C');
  assert.deepEqual(await readAll(), ALL);
});

test('a FAILED Linear-key write leaves the in-memory copy equal to the disk (set and clear)', async () => {
  fake.available = true;
  await setLinearApiKey('lin_OLD');
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.mkdirSync(tmp);
  await assert.rejects(() => clearLinearApiKey(), /EISDIR/);
  assert.equal(await getLinearApiKey(), 'lin_OLD', 'the key the disk still holds is still the key we report');
  assert.equal((await getSecretsState()).encryptedEntries, 1);
  await assert.rejects(() => setLinearApiKey('lin_NEW'), /EISDIR/);
  assert.equal(await getLinearApiKey(), 'lin_OLD');
  fs.rmdirSync(tmp);
  await setAccountApiKey('a', 'ka'); // an unrelated write must not drop the Linear key
  reload();
  assert.equal(await getLinearApiKey(), 'lin_OLD');
});

test('a secrets.json that is valid JSON but not an object (null, 0, "", []) reads as empty instead of hanging', async () => {
  for (const body of ['null', '0', '""', '[]', 'false']) {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), body);
    reload();
    const got = await Promise.race([getLinearApiKey(), new Promise((r) => setTimeout(() => r('HUNG'), 3000))]);
    assert.equal(got, undefined, `body ${body}`);
  }
});

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import { accountAgentEnv } from '../shared/accounts.ts';
import { initPlatform, type OrchestraPlatform } from './platform/index.ts';
import {
  __resetSecretsCacheForTests,
  accountApiKeyIds,
  clearLinearApiKey,
  getAccountApiCredentials,
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

// ---- F3 (review): an API key never travels without its base URL ----------------------------------------------------------

test('credentials: key + URL both readable → both returned; a key with no stored URL → just the key (nothing withheld)', async () => {
  fake.available = true;
  await setAccountApiKey('a', 'ka');
  await setAccountBaseUrl('a', 'https://gw.example');
  await setAccountApiKey('b', 'kb');
  reload();
  assert.deepEqual(await getAccountApiCredentials('a'), { apiKey: 'ka', baseUrl: 'https://gw.example' });
  assert.deepEqual(await getAccountApiCredentials('b'), { apiKey: 'kb', baseUrl: undefined });
  assert.deepEqual(await getAccountApiCredentials('nobody'), { apiKey: undefined, baseUrl: undefined });
});

test('FAIL CLOSED: a key re-typed in plaintext while the keyring was gone, its base URL still ciphertext → the key is WITHHELD, not sent to the default host', async () => {
  fake.available = true;
  await setAccountApiKey('a', 'k-old');
  await setAccountBaseUrl('a', 'https://gw.example');
  reload();
  fake.available = false; // the keyring is gone: the URL can no longer be decrypted
  await setAccountApiKey('a', 'k-new'); // stored in plaintext, so it is readable by itself
  assert.equal(await getAccountApiKey('a'), 'k-new', 'the raw key IS readable — the unsafe half of the pair');
  assert.equal(await getAccountBaseUrl('a'), undefined, 'and its URL is not');
  assert.deepEqual(await getAccountApiCredentials('a'), { withheld: 'base-url-unreadable' });
  fake.available = true; // the keyring is back: both readable, the key flows with its URL again
  assert.deepEqual(await getAccountApiCredentials('a'), { apiKey: 'k-new', baseUrl: 'https://gw.example' });
});

test('credentials: a stored key that cannot be decrypted is reported as key-unreadable (not as "no key"); an unreadable URL with NO key leaks nothing and withholds nothing', async () => {
  fake.available = true;
  await setAccountApiKey('a', 'ka');
  await setAccountBaseUrl('b', 'https://only-url.example');
  reload();
  fake.available = false;
  assert.deepEqual(await getAccountApiCredentials('a'), { withheld: 'key-unreadable' });
  assert.deepEqual(await getAccountApiCredentials('b'), { apiKey: undefined, baseUrl: undefined });
});

// ---- F2 (review): temp residue and a symlinked secrets.json ---------------------------------------------------------------

test('a temp file left by a killed process is swept at load; unrelated files and other names are not', async () => {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ linearApiKey: 'lin_KEEP', enc: false }));
  const stale = `${file()}.4242.tmp`, stale2 = `${file()}.7.tmp`, other = `${file()}.bak`, note = path.join(path.dirname(file()), 'notes.tmp'), notPid = `${file()}.abc.tmp`;
  const prefixed = path.join(path.dirname(file()), 'xsecrets.json.1.tmp'), suffixed = `${file()}.1.tmp.old`;
  for (const f of [stale, stale2, other, note, notPid, prefixed, suffixed]) fs.writeFileSync(f, 'sk-ant-PLAINTEXT-RESIDUE');
  const dirNamedLikeATemp = `${file()}.5.tmp`;
  fs.mkdirSync(dirNamedLikeATemp);
  fs.writeFileSync(path.join(dirNamedLikeATemp, 'inside'), 'not a regular file of ours');
  reload();
  assert.equal(await getLinearApiKey(), 'lin_KEEP');
  assert.ok(!fs.existsSync(stale) && !fs.existsSync(stale2), 'the stale secrets.json.<pid>.tmp files are gone');
  for (const f of [other, note, notPid, prefixed, suffixed]) assert.ok(fs.existsSync(f), `${path.basename(f)} is not ours to delete (anchored name match)`);
  assert.ok(fs.existsSync(path.join(dirNamedLikeATemp, 'inside')), 'a directory is never swept');
});

test('a symlinked secrets.json is written THROUGH: the link survives, the target holds the new content, no residue (also when the link dangles)', async () => {
  const real = path.join(dir, 'dotfiles');
  fs.mkdirSync(real, { recursive: true });
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(path.join(real, 'secrets.json'), JSON.stringify({ linearApiKey: 'lin_VIA_LINK', enc: false }));
  fs.symlinkSync(path.join(real, 'secrets.json'), file());
  fs.writeFileSync(path.join(real, `secrets.json.777.tmp`), 'stale residue next to the TARGET');
  reload();
  assert.equal(await getLinearApiKey(), 'lin_VIA_LINK', 'read through the link');
  assert.ok(!fs.existsSync(path.join(real, 'secrets.json.777.tmp')), 'the sweep looks next to the target');
  await setAccountApiKey('a', 'ka');
  assert.ok(fs.lstatSync(file()).isSymbolicLink(), 'secrets.json is still a symlink');
  assert.ok(fs.readFileSync(path.join(real, 'secrets.json'), 'utf8').includes('ka'), 'the TARGET holds the write');
  assert.deepEqual(fs.readdirSync(real), ['secrets.json'], 'no tmp residue beside the target');
  reload();
  assert.equal(await getAccountApiKey('a'), 'ka');
  // dangling link
  fs.rmSync(file());
  const gone = path.join(dir, 'dotfiles2');
  fs.mkdirSync(gone);
  fs.symlinkSync(path.join(gone, 'secrets.json'), file());
  reload();
  await setLinearApiKey('lin_NEW');
  assert.ok(fs.lstatSync(file()).isSymbolicLink() && fs.existsSync(path.join(gone, 'secrets.json')), 'a dangling link is written through too');
});

test('a RELATIVE symlink (stow-style) and a symlinked userData/orchestra directory: the write lands where the kernel resolves the link', async () => {
  const real = path.join(dir, 'dotfiles', 'sub');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dotfiles', 'x.json'), JSON.stringify({ linearApiKey: 'lin_REL', enc: false }));
  fs.symlinkSync(real, path.join(dir, 'orchestra')); // userData/orchestra → dotfiles/sub  (the DIRECTORY is a link)
  fs.symlinkSync('../x.json', path.join(real, 'secrets.json')); // relative: dotfiles/sub/../x.json = dotfiles/x.json
  reload();
  assert.equal(await getLinearApiKey(), 'lin_REL');
  await setAccountApiKey('a', 'ka');
  assert.ok(fs.readFileSync(path.join(dir, 'dotfiles', 'x.json'), 'utf8').includes('ka'), 'the TARGET (dotfiles/x.json) holds the write');
  assert.ok(fs.lstatSync(path.join(real, 'secrets.json')).isSymbolicLink(), 'the relative link survives');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'dotfiles')).sort(), ['sub', 'x.json'], 'no stray file next to the wrong target, no temp residue');
  reload();
  assert.equal(await getAccountApiKey('a'), 'ka');
});

test('F3 composed with the real env builder: a WITHHELD key leaves the agent with NO key and NO base URL, and strips an ambient shell key', async () => {
  fake.available = true;
  await setAccountApiKey('a', 'k-old');
  await setAccountBaseUrl('a', 'https://gw.example');
  reload();
  fake.available = false;
  await setAccountApiKey('a', 'k-new'); // plaintext key, ciphertext URL
  const account = { env: {}, auth: { mode: 'apiKey' } } as never;
  const { apiKey, baseUrl, withheld } = await getAccountApiCredentials('a');
  const { set, strip } = accountAgentEnv(account, '/home/x', { ANTHROPIC_API_KEY: 'ambient-shell-key' }, apiKey, baseUrl);
  assert.equal(withheld, 'base-url-unreadable');
  assert.equal(set.ANTHROPIC_API_KEY, undefined, 'the gateway key is NOT handed to the agent');
  assert.equal(set.ANTHROPIC_BASE_URL, undefined);
  assert.ok(strip.includes('ANTHROPIC_API_KEY') && strip.includes('ANTHROPIC_BASE_URL'), 'an ambient key is stripped, not substituted');
  fake.available = true;
  const ok = await getAccountApiCredentials('a');
  const env2 = accountAgentEnv(account, '/home/x', {}, ok.apiKey, ok.baseUrl);
  assert.deepEqual([env2.set.ANTHROPIC_API_KEY, env2.set.ANTHROPIC_BASE_URL], ['k-new', 'https://gw.example'], 'with the keyring back the pair flows together');
});

#!/usr/bin/env node
// #389 — unit-level mutation set for the keyring work. Each mutant edits ONE clause of the shipped source IN PLACE, runs the test files that
// must catch it, requires them to go RED (and the unmutated control to be GREEN first), then restores the file byte-exact and proves it with
// a sha256 compare. The mutant string must occur EXACTLY ONCE in the file (verified live, per mutant) — a pattern that matches nothing
// would "survive" for the wrong reason. Run: node scripts/keyring-mutants.mjs [--only U3,U9]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const only = (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);
const PS = 'src/shared/password-store.ts';
const LK = 'src/main/linux-keyring.ts';
const SE = 'src/main/secrets.ts';
const SS = 'src/shared/secrets-state.ts';
const IX = 'src/main/index.ts';
const T_PS = ['src/shared/password-store.test.ts'];
const T_LK = ['src/main/linux-keyring.test.ts'];
const T_SE = ['src/main/secrets.test.ts'];
const T_SS = ['src/shared/secrets-state.test.ts'];
const T_WI = ['src/main/keyring-wiring.test.ts'];

/** [id, file, find, replace, tests that must go red, what clause it removes] */
const MUTANTS = [
  ['U1', PS, "if (state === 'unlocked') return", "if (state !== 'unavailable') return", T_PS, 'select libsecret on a LOCKED collection (the 76 s stall)'],
  ['U2', PS, "  if (isRecognisedDesktop(input.env)) return { store: null, reason: 'recognised-desktop' };\n", '', T_PS, 'recognised desktop keeps Chromium\'s choice'],
  ['U3', PS, "  if (input.passwordStoreAlreadySelected) return { store: null, reason: 'explicit-switch' };\n", '', T_PS, 'an explicit --password-store wins'],
  ['U4', PS, "  if (!input.sessionBusReachable) return { store: null, reason: 'no-session-bus' };\n", '', T_PS, 'no bus → no probe'],
  ['U5', PS, "  if (!input.sessionBusReachable) return { store: null, reason: 'no-session-bus' };", "  input.probe();\n  if (!input.sessionBusReachable) return { store: null, reason: 'no-session-bus' };", T_PS, 'the probe is deferred (never runs when the decision does not need it)'],
  ['U6', PS, "return m[1] === 'false' ? 'unlocked' : 'locked';", "return m[1] === 'false' ? 'locked' : 'unlocked';", T_PS, 'Locked=false means unlocked'],
  ['U7', PS, "'cinnamon', 'deepin', 'gnome', 'kde', 'kde4',", "'cinnamon', 'deepin', 'gnome', 'kde4',", T_PS, 'KDE is a recognised desktop'],
  ['U8', PS, "'GNOME_DESKTOP_SESSION_ID', 'KDE_FULL_SESSION', 'KDE_SESSION_VERSION'", "'GNOME_DESKTOP_SESSION_ID', 'KDE_SESSION_VERSION'", T_PS, 'KDE_FULL_SESSION alone marks a recognised desktop'],
  ['U9', LK, "      timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS,\n", '', T_LK, 'the probe is killed at a timeout (startup never stalls)'],
  ['U10', LK, "  return v === '' || v.startsWith('disabled:') ? null : v;", "  return v === '' ? null : v;", T_LK, 'Electron\'s `disabled:` is not an address'],
  ['U11', LK, "  if (exported) deps.exportBusAddress(probeEnv(deps.env).DBUS_SESSION_BUS_ADDRESS as string);\n", '', T_LK, 'libsecret is handed the bus it was probed on'],
  ['U12', LK, "isSocket() ? 'runtime-dir' : 'none'", "isFile() ? 'runtime-dir' : 'none'", T_LK, 'the runtime-dir bus must be a socket'],
  ['U13', LK, "  if (r.error || r.status !== 0) return 'unavailable'; // ENOENT, ETIMEDOUT, non-zero exit\n", '', T_LK, 'a failed / timed-out probe reads unavailable'],
  ['U14', SE, "      if (platform.decryptString(cipher) !== value) throw new Error('round-trip mismatch');\n", '', T_SE, 'ciphertext must decrypt back to the same value before it replaces the plaintext'],
  ['U15', SE, "      if (sealed) {\n        out[id] = sealed;\n        reencrypted++;\n      }", "      if (sealed) {\n        out[id] = sealed;\n        reencrypted++;\n      } else {\n        delete out[id];\n      }", T_SE, 'a failing entry keeps its plaintext (never lost)'],
  ['U16', SE, "  if (!platform.isEncryptionAvailable()) return { reencrypted: 0, failed: 0, skipped: 'encryption-unavailable' };\n", '', T_SE, 'no re-encryption while encryption is unavailable'],
  ['U17', SE, "  if (countEntries(data).plaintext === 0) return { reencrypted: 0, failed: 0, skipped: 'no-plaintext' };\n  if (!platform.isEncryptionAvailable()) return { reencrypted: 0, failed: 0, skipped: 'encryption-unavailable' };\n", "  if (!platform.isEncryptionAvailable()) return { reencrypted: 0, failed: 0, skipped: 'encryption-unavailable' };\n  if (countEntries(data).plaintext === 0) return { reencrypted: 0, failed: 0, skipped: 'no-plaintext' };\n", T_SE, 'nothing plaintext → safeStorage is not touched at startup'],
  ['U18', SE, "  const tmp = `${file}.${process.pid}.tmp`;", '  const tmp = file;', T_SE, 'atomic write (tmp + rename)'],
  ['U19', SE, "  const run = lock.then(fn, fn);", "  const run = fn();", T_SE, 'mutations are serialised (no lost update)'],
  ['U20', SE, "    encrypted: platform.isEncryptionAvailable(),", "    encrypted: true,", T_SE, 'the state reports availability'],
  ['U21', SS, "if (!state || state.encrypted) return null;", "if (!state) return null;", T_SS, 'no notice when encryption works'],
  ['U22', SS, "if (state.encryptedEntries > 0) {", "if (state.encryptedEntries >= 0) {", T_SS, 'the unreadable variant only with ciphertext on disk'],
  ['U23', IX, "const keyringDecision = ORCHESTRA_CLI_MODE\n  ? null\n", "const keyringDecision = !ORCHESTRA_CLI_MODE\n  ? null\n", T_WI, 'never select in CLI mode / always in the GUI'],
  ['U24', IX, "      if (keyringDecision?.store === 'gnome-libsecret') reencryptInBackground('startup');", "      // (mutant) no startup re-encryption", T_WI, 're-encryption runs at startup after our own libsecret selection'],
  ['U25', SE, "async function clearLinearApiKeyNow(): Promise<void> {\n  const data = { ...(await readFileSafe()) };", "async function clearLinearApiKeyNow(): Promise<void> {\n  const data = await readFileSafe();", T_SE, 'a failed Linear write must not mutate the cached copy'],
  ['U26', SE, "    cached = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SecretsFile) : {};", "    cached = parsed as SecretsFile;", T_SE, 'a non-object secrets.json reads as empty (no infinite read loop)'],
  ['U27', 'src/main/api-handlers.ts', "    if (state.encrypted && state.plaintextEntries > 0) reencryptInBackground('settings');\n", '', T_WI, 'Settings re-attempts the re-encryption with a working keyring'],
  ['U28', IX, "      if (keyringDecision?.store === 'gnome-libsecret') reencryptInBackground('startup');", "      reencryptInBackground('startup');", T_WI, 'startup re-encryption only after our own unlocked-probe selection (never touches a locked/recognised keyring)'],
  ['U29', 'src/renderer/components/LinearSettings.tsx', "secrets?.encrypted === true && secrets.plaintextEntries === 0 && ", "secrets?.encrypted === true && ", T_WI, 'no "stored encrypted" claim while plaintext is on disk'],
  ['U30', PS, "  if (isIsolatedInstance(input.env)) return { store: null, reason: 'isolated-instance' };\n", '', T_PS, 'a scratch/dev instance (ORCHESTRA_HOME) never binds to the human\'s real keyring (review F1)'],
  ['U31', PS, "env.ORCHESTRA_KEYRING?.trim() !== 'probe'", "true", T_PS, 'ORCHESTRA_KEYRING=probe opts a rig in'],
  ['U32', SE, "  if (apiKey !== undefined && urlEntry?.value && baseUrl === undefined) return { withheld: 'base-url-unreadable' };\n", '', T_SE, 'a key whose base URL is unreadable is withheld — fail closed (review F3)'],
  ['U33', SE, "  if (keyEntry?.value && apiKey === undefined) return { withheld: 'key-unreadable' };\n", '', T_SE, 'a stored-but-unreadable key is reported, not "absent"'],
  ['U34', SE, "async function loadFromDisk(): Promise<void> {\n  await sweepStaleTemps();\n", "async function loadFromDisk(): Promise<void> {\n", T_SE, 'stale secrets.json.<pid>.tmp is swept at load (review F2)'],
  ['U35', SE, "async function writeFileSafe(data: SecretsFile): Promise<void> {\n  const file = await writeTarget();", "async function writeFileSafe(data: SecretsFile): Promise<void> {\n  const file = secretsPath();", T_SE, 'a symlinked secrets.json is written through (review F2)'],
  ['U36', SS, "encrypted and unreadable until a keyring is available again.", "encrypted and unreadable until the keyring is unlocked.", T_SS, 'the unreadable notice names no cause (review F4b)'],
  ['U37', SS, "  if (withheld === 'key-unreadable') return 'API key stored but unreadable';\n", '', T_SS, 'a stored-but-unreadable key is not "no API key stored" (review F4a)'],
  ['U38', 'src/main/agent-sdk.ts', "import { getAccountApiCredentials } from './secrets';", "import { getAccountApiKey, getAccountBaseUrl, getAccountApiCredentials } from './secrets';", T_WI, 'the agent env cannot bypass the fail-closed pair accessor'],
  ['U39', SE, "new RegExp(`^${path.basename(target)", "new RegExp(`${path.basename(target)", T_SE, 'the sweep name match is anchored at the start (xsecrets.json.1.tmp is not ours)'],
  ['U40', SE, "tmp$`);", "tmp`);", T_SE, 'the sweep name match is anchored at the end (secrets.json.1.tmp.old is not ours)'],
  ['U41', SE, "    await rm(path.join(dir, n), { force: true }).catch(() => {});", "    await rm(path.join(dir, n), { force: true, recursive: true }).catch(() => {});", T_SE, 'a directory that carries a temp-looking name is never deleted (non-recursive rm)'],
  ['U42', SE, "    file = path.resolve(path.dirname(file), link);", "    file = path.resolve(link);", T_SE, 'a relative symlink resolves from the link\'s own directory'],
  ['U43', SE, "let file = path.join(await realpath(path.dirname(lexical)).catch(() => path.dirname(lexical)), path.basename(lexical));", "let file = lexical;", T_SE, 'a symlinked userData/orchestra directory is resolved physically (review pre-review #3)'],
  ['U44', PS, "return Boolean(env.ORCHESTRA_HOME) &&", "return (env.ORCHESTRA_HOME?.trim() ?? '') !== '' &&", T_PS, 'isolated iff index.ts relocates (same truthiness)'],
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function runTests(files) {
  const r = spawnSync('node', ['--test', '--test-force-exit', '--experimental-strip-types', ...files], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
  const out = `${r.stdout}\n${r.stderr}`;
  return { rc: r.status, pass: +(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN), fail: +(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN), skipped: +(/^# skipped (\d+)/m.exec(out)?.[1] ?? NaN), out };
}

let bad = 0;
const rows = [];
// Control: every test file, unmutated, GREEN with 0 skipped — the instrument can say PASS.
const allTests = [...new Set(MUTANTS.flatMap((m) => m[4]))];
const control = runTests(allTests);
console.log(`CONTROL (unmutated) ${allTests.join(' ')} → rc ${control.rc}, pass ${control.pass}, fail ${control.fail}, skipped ${control.skipped}`);
if (control.rc !== 0 || control.fail !== 0 || control.skipped !== 0) { console.log('ABORT: the unmutated control is not green'); process.exit(2); }

for (const [id, file, find, replace, tests, what] of MUTANTS) {
  if (only.length && !only.includes(id)) continue;
  const abs = path.join(ROOT, file);
  const orig = fs.readFileSync(abs);
  const src = orig.toString('utf8');
  const n = src.split(find).length - 1;
  if (n !== 1) { console.log(`${id}: VOID — the mutant string occurs ${n}× in ${file} (must be exactly 1)`); bad++; rows.push([id, 'VOID', what]); continue; }
  let verdict;
  try {
    fs.writeFileSync(abs, src.replace(find, () => replace));
    const mutated = fs.readFileSync(abs);
    if (mutated.equals(orig)) { console.log(`${id}: VOID — the replacement changed nothing`); bad++; rows.push([id, 'VOID', what]); continue; }
    const r = runTests(tests);
    verdict = r.rc !== 0 && r.fail > 0 ? `KILLED (rc ${r.rc}, ${r.fail} failing of ${r.pass + r.fail})` : `SURVIVED (rc ${r.rc}, fail ${r.fail})`;
    if (!(r.rc !== 0 && r.fail > 0)) bad++;
  } finally {
    fs.writeFileSync(abs, orig);
  }
  const restored = fs.readFileSync(abs);
  const same = restored.equals(orig) && sha(restored) === sha(orig);
  if (!same) { console.log(`${id}: RESTORE FAILED for ${file}`); process.exit(3); }
  console.log(`${id}: ${verdict} · restored byte-exact (sha ${sha(orig).slice(0, 12)}) · ${what}`);
  rows.push([id, verdict, what]);
}
const post = runTests(allTests);
console.log(`POST-RUN control (after every restore) → rc ${post.rc}, pass ${post.pass}, fail ${post.fail}, skipped ${post.skipped}`);
if (post.rc !== 0) bad++;
const git = spawnSync('git', ['status', '--porcelain', '--', ...new Set(MUTANTS.map((m) => m[1]))], { cwd: ROOT, encoding: 'utf8' }).stdout;
console.log(`\n${rows.filter((r) => r[1].startsWith('KILLED')).length}/${rows.length} KILLED; ${bad ? `${bad} PROBLEM(S)` : 'no survivors, no voids'}`);
process.exit(bad ? 1 : 0);

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
const RW = 'src/shared/keyring-rig-world.ts';
const DR = 'scripts/e2e-keyring.mjs';
const SH = 'scripts/e2e-keyring.sh';
const T_RW = ['src/shared/keyring-rig-world.test.ts'];
const T_RD = ['src/main/keyring-rig-driver.test.ts'];
const RP = 'scripts/lib/rig-procs.mjs';
const T_RP = ['src/main/rig-procs.test.ts'];

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
  ['U9', LK, "timeout: waitMs + WRAPPER_BACKSTOP_SLACK_MS,", "timeout: waitMs - 1,", T_LK, 'the wedged-wrapper backstop sits above the wait (it never cuts the wait short)'],
  ['U10', LK, "  return v === '' || v.startsWith('disabled:') ? null : v;", "  return v === '' ? null : v;", T_LK, 'Electron\'s `disabled:` is not an address'],
  ['U11', LK, "  if (exported) deps.exportBusAddress(probeEnv(deps.env).DBUS_SESSION_BUS_ADDRESS as string);\n", '', T_LK, 'libsecret is handed the bus it was probed on'],
  ['U12', LK, "isSocket() ? 'runtime-dir' : 'none'", "isFile() ? 'runtime-dir' : 'none'", T_LK, 'the runtime-dir bus must be a socket'],
  ['U13', LK, "  if (r.error || r.status !== 0) return 'unavailable'; // sh missing, deadline (3), or gdbus failed\n", '', T_LK, 'a failed / timed-out probe reads unavailable'],
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
  ['U30', PS, "  if (isIsolatedInstance(input.env)) return { store: 'basic', reason: 'isolated-instance' };\n", '', T_PS, 'a scratch/dev instance (ORCHESTRA_HOME) never binds to the human\'s real keyring (review F1)'],
  ['U31', PS, "env.ORCHESTRA_KEYRING?.trim() !== 'probe'", "true", T_PS, 'ORCHESTRA_KEYRING=probe opts a rig in'],
  ['U32', SE, "  if (apiKey !== undefined && urlEntry?.value && baseUrl === undefined) return { withheld: 'base-url-unreadable' };\n", '', T_SE, 'a key whose base URL is unreadable is withheld — fail closed (review F3)'],
  ['U33', SE, "  if (keyEntry?.value && apiKey === undefined) return { withheld: 'key-unreadable' };\n", '', T_SE, 'a stored-but-unreadable key is reported, not "absent"'],
  ['U34', SE, "async function loadFromDisk(): Promise<void> {\n  await sweepStaleTemps();\n", "async function loadFromDisk(): Promise<void> {\n", T_SE, 'stale secrets.json.<pid>.tmp is swept at load (review F2)'],
  ['U35', SE, "async function writeFileSafe(data: SecretsFile): Promise<void> {\n  const file = await writeTarget();", "async function writeFileSafe(data: SecretsFile): Promise<void> {\n  const file = secretsPath();", T_SE, 'a symlinked secrets.json is written through (review F2)'],
  ['U36', SS, "'until a keyring is available again'", "'until the keyring is unlocked'", T_SS, 'the unreadable notice names no cause (review F4b)'],
  ['U37', SS, "  if (withheld === 'key-unreadable') return 'API key stored but unreadable';\n", '', T_SS, 'a stored-but-unreadable key is not "no API key stored" (review F4a)'],
  ['U38', 'src/main/agent-sdk.ts', "import { getAccountApiCredentials } from './secrets';", "import { getAccountApiKey, getAccountBaseUrl, getAccountApiCredentials } from './secrets';", T_WI, 'the agent env cannot bypass the fail-closed pair accessor'],
  ['U39', SE, "new RegExp(`^${path.basename(target)", "new RegExp(`${path.basename(target)", T_SE, 'the sweep name match is anchored at the start (xsecrets.json.1.tmp is not ours)'],
  ['U40', SE, "tmp$`);", "tmp`);", T_SE, 'the sweep name match is anchored at the end (secrets.json.1.tmp.old is not ours)'],
  ['U41', SE, "    await rm(path.join(dir, n), { force: true }).catch(() => {});", "    await rm(path.join(dir, n), { force: true, recursive: true }).catch(() => {});", T_SE, 'a directory that carries a temp-looking name is never deleted (non-recursive rm)'],
  ['U42', SE, "    file = path.resolve(path.dirname(file), link);", "    file = path.resolve(link);", T_SE, 'a relative symlink resolves from the link\'s own directory'],
  ['U43', SE, "let file = path.join(await realpath(path.dirname(lexical)).catch(() => path.dirname(lexical)), path.basename(lexical));", "let file = lexical;", T_SE, 'a symlinked userData/orchestra directory is resolved physically (review pre-review #3)'],
  ['U44', PS, "return Boolean(env.ORCHESTRA_HOME) &&", "return (env.ORCHESTRA_HOME?.trim() ?? '') !== '' &&", T_PS, 'isolated iff index.ts relocates (same truthiness)'],
  ['U45', LK, "const exported = decision.store === 'gnome-libsecret' && bus === 'runtime-dir';", "const exported = decision.store !== null && bus === 'runtime-dir';", T_LK, 'an isolated (basic) instance never exports the bus (review m1)'],
  ['U46', PS, "return { store: 'basic', reason: 'isolated-instance' };", "return { store: null, reason: 'isolated-instance' };", T_PS, 'an isolated instance FORCES basic — Chromium\'s own choice on a recognised desktop would bind the real keyring (review m1)'],
  ['U47', SS, "const text =\n    state.selectionReason === 'isolated-instance'", "const text =\n    false", T_SS, 'the notice says "isolated", not "no keyring is available" (review m2)'],
  ['U50', SS, "${state.selectionReason === 'isolated-instance' ? 'in this instance (sealed by a keyring earlier)'", "${false ? 'in this instance (sealed by a keyring earlier)'", T_SS, 'the unreadable variant does not promise a keyring coming back to an isolated instance'],
  ['U48', IX, "setKeyringSelectionReason(keyringDecision?.reason ?? null);\n", '', T_WI, 'index.ts hands the selection reason to Settings (review m2)'],
  ['U49', SE, "    encryptedEntries: encrypted,\n    selectionReason,\n  };", "    encryptedEntries: encrypted,\n  };", T_SE, 'getSecretsState carries the selection reason (review m2)'],
  ['U51', LK, "if alive; then exit 3; fi", 'if alive; then kill "$pid"; exit 3; fi', T_LK, 'at the deadline the parent only STOPS WAITING — it never signals the in-flight gdbus (review round 3 MAJOR)'],
  ['U52', LK, "export const DBUS_CALL_TIMEOUT_S = '30';", "export const DBUS_CALL_TIMEOUT_S = '1';", T_LK, 'gdbus gets a LONG per-call timeout (Introspect first, then the Get)'],
  ['U53', LK, "export const PROBE_WAIT_MS = 5000;", "export const PROBE_WAIT_MS = 60000;", T_LK, 'the main-thread block stays small'],
  ['U54', LK, 'while [ "$n" -lt "$limit" ] && alive; do', 'while alive; do', T_LK, 'the parent never waits unboundedly on the child (a deaf / hung gdbus cannot block the main thread)'],
  ['U55', LK, "stdio: ['ignore', 'ignore', 'ignore'],", "stdio: ['ignore', 'pipe', 'ignore'],", T_LK, 'no pipe shared with the orphaned child (spawnSync would wait for its EOF)'],
  ['U56', SS, "      : state.selectionReason === 'locked-service'\n        ? 'Secrets", "      : false\n        ? 'Secrets", T_SS, 'a keyring found LOCKED says so — not "no keyring is available" (review round 3 MINOR 2)'],
  ['U57', SS, "state.selectionReason === 'locked-service' ? 'until the keyring is unlocked and Orchestra restarted'", "false ? 'until the keyring is unlocked and Orchestra restarted'", T_SS, 'the unreadable-ciphertext variant for a locked keyring says how to get it back'],
  ['U58', LK, "      if (typeof b !== 'string') fs.mkdirSync(base, { recursive: true, mode: 0o700 });\n", '', T_LK, 'a missing `create` base (userData) is created, so a missing TMPDIR cannot silence a healthy keyring'],
  ['U64', LK, "      if (typeof b !== 'string') fs.mkdirSync(base, { recursive: true, mode: 0o700 });", "      fs.mkdirSync(base, { recursive: true, mode: 0o700 });", T_LK, 'a missing plain base ($XDG_RUNTIME_DIR) is never created (review round-4 rewire m8)'],
  ['U59', LK, "    } catch (e) {\n      note(`mkdtemp ${base}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);", "    } catch (e) {\n      void e;", T_LK, 'every unusable scratch base is NOTED (never swallowed silently)'],
  ['U60', LK, "for (const b of bases) {", "for (const b of bases.slice(0, 1)) {", T_LK, 'the probe falls back past the first unusable base'],
  ['U61', LK, "${notes.length ? ` probe-notes=\"${notes.join('; ')}\"` : ''}", "", T_LK, 'the scratch failures reach the startup-log facts'],
  ['U62', LK, "...(deps.extraScratchDirs ?? [])", "", T_LK, 'index.ts\'s extra fallback base (userData) is used by the real probe'],
  ['U63', IX, "      extraScratchDirs: [app.getPath('userData')], // the probe's scratch dir if TMPDIR and $XDG_RUNTIME_DIR are unusable\n", '', T_WI, 'index.ts passes the userData fallback base'],
  // ---- the rewired rig (round-4 rewire, ledger #405 incident Q2): pure world checks + the driver + the launcher ----
  ['W1', RW, "if (out.length > 0 && out[out.length - 1] !== '..') out.pop();", "if (false) out.pop();", T_RW, 'a `..` collapses (a /run/x/../user/1000 spelling cannot slip the human-runtime test)'],
  ['W2', RW, "const HUMAN_RT = /(^|\\/)run\\/user(\\/|$)/;", "const HUMAN_RT = /^\\/run\\/user\\/\\d/;", T_RW, 'the human-runtime pattern also catches the bare dir and any container shape'],
  ['W3', RW, "  return value.split(/[:=,;\\s]+/).some((piece) => piece.includes('/') && HUMAN_RT.test(normPath(piece)));", "  return false;", T_RW, 'a path INSIDE `unix:path=…` / a PATH list / a URL is found'],
  ['W4', RW, "return n.startsWith(d + '/');", "return n.startsWith(d);", T_RW, 'containment is by path segment (a sibling sharing the rig dir\'s name as a prefix is outside)'],
  ['W5', RW, "{ id: 'hidden-world', ok: f.hiddenWorld,", "{ id: 'hidden-world', ok: true,", T_RW, 'the rig refuses to run outside the hidden world'],
  ['W6', RW, "dbus === `unix:path=${rig}/no-session-bus` && !f.noBusExists,", "dbus === `unix:path=${rig}/no-session-bus`,", T_RW, 'the private no-bus path must not exist'],
  ['W7', RW, "ok: rig !== '' && xdg === `${rig}/xdg` && !referencesHumanRuntime(xdg),", "ok: xdg !== '',", T_RW, 'the driver\'s XDG_RUNTIME_DIR is exactly the rig\'s private dir'],
  ['W8', RW, " && !wl.includes('/') && env.DISPLAY === undefined,", " && !wl.includes('/'),", T_RW, 'X11 is unreachable (DISPLAY absent)'],
  ['W9', RW, ".filter(([, d]) => !under(d, w.rigDir))", ".filter(([, d]) => false)", T_RW, 'every arm dir lies inside the rig dir'],
  ['W10', RW, "|standard_system_servicedirs|include|includedir|servicehelper)", "|servicehelper)", T_RW, 'the private bus config pulls in no standard service dirs / includes'],
  ['W11', RW, "ok: e.exeBase === 'gnome-keyring-daemon' && e.cmdline.some", "ok: e.cmdline.some", T_RW, 'the secrets owner is gnome-keyring-daemon by exe, not by claim'],
  ['W12', RW, "&& e.ownerPid !== e.driverPid,", ",", T_RW, 'the owner is not the driver itself'],
  ['W13', RW, "under(s.path, `${e.run}/keyring`)", "under(s.path, '/')", T_RW, 'the owner holds a socket under the ARM\'s keyring dir (not just any socket)'],
  ['W14', RW, "const sawPrivate = t.socketPaths.some((x) => under(x, t.run));", "const sawPrivate = true;", T_RW, 'the tree scan has a positive control (it can see the private dir)'],
  ['W15', RW, "|| armDirs.includes(n);", "|| true;", T_RW, 'the rig runtime root holds only wayland sockets and arm dirs'],
  ['D1', DR, "hiddenWorld: hiddenWorldProof() });", "hiddenWorld: true });", T_RD, 'the driver refuses outside the hidden world'],
  ['D2', DR, "try { RIG_XDG = privateRuntimeDir(); } catch (e) { refuse(e.message); }", "RIG_XDG = `${RIG_DIR}/xdg`;", T_RD, 'the driver takes XDG_RUNTIME_DIR through privateRuntimeDir() (refuses a real/foreign one)'],
  ['D3', DR, "if (PREFLIGHT_ONLY) { console.log('PREFLIGHT-OK'); process.exit(0); }", "if (PREFLIGHT_ONLY) { console.log('PREFLIGHT-OK'); }", T_RD, '--preflight-only stops right after the checks (nothing else may start)'],
  ['D4', DR, "    if (failed(worldCs).length) throw new Error('the arm world is not private — nothing was started');\n", '', T_RD, 'an arm whose world is not private starts nothing'],
  ['D5', DR, "spawnSync('gdbus', ['call', '--address', w.address,", "spawnSync('gdbus', ['call', '--session',", T_RD, 'the oracle names the arm bus explicitly (never "the session bus")'],
  ['D6', DR, "w.run = path.join(RIG_XDG, `k-${name}`);", "w.run = path.join(RIG_DIR, `k-${name}`);", T_RD, 'each arm\'s runtime dir is inside the rig\'s private runtime dir'],
  ['D7', DR, "      ownerCs('/after-relock');\n", '', T_RD, 'a relocked (new) keyring daemon\'s ownership is proved again'],
  ['D8', RP, "s.state !== 'Z' && s.start === start;", "s.state !== 'Z';", T_RP, 'teardown signals by identity (pid + start time), not by a recycled pid'],
  ['D9', DR, "clause('ctl/hidden-runtime-dir-stayed-empty', hiddenEntries.length === 0,", "clause('ctl/hidden-runtime-dir-stayed-empty', true,", T_RD, 'anything created in the hidden stand-in of the human runtime dir is a finding'],
  ['D10', DR, "  clause('forged/nothing-was-started', rootAfter === rootBefore &&", "  clause('forged/nothing-was-started', true ||", T_RD, 'the forged arm proves nothing was started'],
  ['D11', SH, "export RIG_HIDE_REAL_RUNTIME=1\n", '', T_RD, 'the launcher hides the real runtime dir on every run'],
  ['D12', DR, "|| readNul(`/proc/${process.ppid}/environ`).includes('RIG_HIDDEN_WORLD=1');", ";", T_RD, 'the hidden-world proof survives `env -i` by asking the rig bash (my parent) — without it every real run is refused (review BLOCKING 1)'],
  ['D13', DR, "'--timeout', '30', ...args]", "'--timeout', '2', ...args]", T_RD, 'the arm oracle waits long: a client vanishing mid-call aborts the arm daemon (review MAJOR 3)'],
  ['D14', DR, "if (holdsArmSocket(w, p, rows)) track(w, p);", "track(w, p);", T_RD, 'a pid the bus reports is signalled only if it holds a socket of THIS arm (review m5)'],
  ['D15', DR, "t.socketPaths = socketPaths(inodesOf(t.fdTargets), ssRows());", "t.socketPaths = [];", T_RD, 'the app tree\'s sockets are resolved to paths (a fd link is only `socket:[N]`)'],
  ['D16', DR, "  w.busProc = { pid: child.pid, start: procStat(child.pid)?.start };", "  void 0; w.busProc = null; w._x = { pid: child.pid, start: procStat(child.pid)?.start };", T_RD, 'the bus group leader is recorded before waiting for its socket (a bus that never starts is still reaped)'],
  ['D17', DR, "throw new Error('child DBUS_SESSION_BUS_ADDRESS is not the private bus');", "refuse('child DBUS_SESSION_BUS_ADDRESS is not the private bus');", T_RD, 'a world violation inside an arm throws (the finally reaps), never process.exit'],
  ['D18', DR, "clause(`forged/${name}-is-refused`, r.rc === 3 && /^REFUSED: /m.test(r.out) && why.test(r.out) &&", "clause(`forged/${name}-is-refused`, r.rc === 3 && /^REFUSED: /m.test(r.out) &&", T_RD, 'a forged world counts as caught only if the refusal NAMES the forged clause'],
  ['W16', RW, "    const peer = byIno.get(x.peerIno);\n    if (peer?.localPath) out.add(peer.localPath);\n", "", T_RW, 'a client end (`*`) resolves to the path its PEER end is bound to — the shape of a connection to a keyring/bus socket'],
  ['W17', RW, "ok: longestSocket(w.run) <= SUN_PATH_MAX,", "ok: true,", T_RW, 'every arm socket path fits sun_path (the hooks socket is 28 chars)'],
  ['W18', RW, "const sawPrivate = t.socketPaths.some((x) => under(x, t.run));", "const sawPrivate = t.fdTargets.some((x) => under(x, t.run));", T_RW, 'the tree-scan positive control is a SOCKET under the arm dir (fd links never show socket paths)'],
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

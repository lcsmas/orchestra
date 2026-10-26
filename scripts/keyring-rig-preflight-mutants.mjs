#!/usr/bin/env node
// #389 preflight — mutation set. Each mutant weakens ONE clause of the shipped source IN PLACE, the preflight test files must go RED (the self-test is the
// same table, so it goes red with them), then the file is restored byte-exact (sha256 compare). A mutant string must occur EXACTLY ONCE (verified live per
// mutant). The unmutated control must be green with 0 skipped first and again after every restore. Run: node scripts/keyring-rig-preflight-mutants.mjs [--only S1,H2]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const only = (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);
const SH = 'src/shared/keyring-rig-preflight.ts';
const HO = 'src/main/keyring-rig-preflight-host.ts';
const CLI = 'scripts/keyring-rig-preflight.mjs';
const TESTS = ['src/shared/keyring-rig-preflight.test.ts', 'src/main/keyring-rig-preflight-host.test.ts'];

/** [id, file, find, replace, what the mutant removes] */
const MUTANTS = [
  // string rules
  ['S1', SH, "if (!p || !path.isAbsolute(p) || touchesUserRuntime(p)) return null;", "if (!p || !path.isAbsolute(p)) return null;", 'safeReal never stats a path naming the per-user runtime dir'],
  ['S2', SH, "      if (tok.startsWith('/')) variants.add(path.posix.normalize(", "      if (tok.startsWith('/')) variants.add((", 'a path is normalised before the runtime-dir test (/usr/../run/user)'],
  ['S3', SH, "    variants.add(decodeURIComponent(value));", "    void value;", 'percent-escaped runtime paths are decoded'],
  ['S4', SH, "|| PROC_ROOT_RE.test(v)", "|| false", '/proc/<pid>/root re-rooting is refused'],
  ['S6', SH, "const m = /^unix:path=([^,;%\\s]+)", "const m = /^unix:path=([^,;%]+)", 'a whitespace-bearing address is not an address'],
  // checkWorld
  ['W1', SH, "const mounts = acc.mountPoints().filter((m) => isInside(rigReal, m));", "const mounts: string[] = [];", 'no mount point inside the rig dir'],
  ['W2', SH, "else if (runtimeReal === rigReal || !isInside(rigReal, runtimeReal)) {", "else if (false) {", 'the scratch runtime dir is strictly inside the rig dir'],
  ['W3', SH, "(info.mode & 0o077) !== 0) {", "false) {", 'the runtime dir is 0700'],
  ['W4', SH, "if (!info || info.uid !== acc.uid ||", "if (!info ||", 'the runtime dir is owned by this uid'],
  ['W5', SH, "if (k === 'symlink') {", "if (false) {", 'the bus path is not a symbolic link'],
  ['W6', SH, "if (!dirReal || !isInside(runtimeReal, dirReal)) fail('bus-address-private'", "if (!dirReal) fail('bus-address-private'", 'the bus path is inside the scratch runtime dir'],
  ['W7', SH, "if (acc.kind(busPath) !== 'socket') {", "if (false) {", 'the private bus socket must be a socket'],
  ['W8', SH, "if (busPath && input.requireBusSocket) {", "if (busPath) {", 'phase pre does not require a bus that is not started yet'],
  // child env
  ['C1', SH, "if (touchesUserRuntime(val) && !(allowed && allowed.test(val))) fail(", "if (false) fail(", 'no child env value may name the per-user runtime dir'],
  ['C2', SH, "WAYLAND_DISPLAY: /^", "WAYLAND_DISPLAY: /.*|^", "only the rig's own compositor socket may carry a runtime path"],
  ['C3', SH, "if (env.DISPLAY !== undefined && env.DISPLAY !== '') fail(", "if (false) fail(", 'no X11 DISPLAY (it would reach the human\'s session)'],
  ['C4', SH, "if (!path.isAbsolute(val) || touchesUserRuntime(val) || !inside(val)) fail(", "if (false) fail(", 'HOME / XDG_*_HOME resolve inside the rig dir'],
  ['C5', SH, "if (k === 'HOME') fail('HOME is unset", "if (false) fail('HOME is unset", 'HOME must be set (else the passwd home is used)'],
  ['C6', SH, "if (val && (!path.isAbsolute(val.replace(/^unix:path=/, '')) ||", "if (false && (!path.isAbsolute(val.replace(/^unix:path=/, '')) ||", 'a keyring/agent handle var points inside the rig dir'],
  ['C7', SH, "if (touchesUserRuntime(addr) || !isInside(input.runtimeReal, path.resolve(raw)) || acc.kind(raw) === 'symlink') fail(", "if (false) fail(", 'a child bus address is a private socket path'],
  ['C8', SH, "} else if (!(addr === undefined || addr === '' || addr === 'disabled:')) {", "} else if (false) {", 'an app address is unset, exactly disabled:, or private'],
  ['C9', SH, "} else if (input.kind === 'tool') {", "} else if (false) {", 'a tool carries the private address'],
  ['C10', SH, "else if (safeReal(acc, rt) !== input.runtimeReal) fail(", "else if (false) fail(", "a child's XDG_RUNTIME_DIR is the scratch one"],
  // bus daemon
  ['B1', SH, String.raw`if (!/(?:^|\/)dbus-daemon$/.test(bd.exe)) fail(`, "if (false) fail(", 'the bus daemon is a dbus-daemon (not a forwarder)'],
  ['B2', SH, "else if (!cfgReal || !isInside(input.rigRealDir, cfgReal)) fail(", "else if (false) fail(", "the bus daemon's config is inside the rig dir"],
  ['B3', SH, "else if (!rt || rt !== input.runtimeReal) fail(`the bus daemon", "else if (false) fail(`the bus daemon", 'the bus daemon runs with the scratch runtime dir'],
  ['B4', SH, "else if (/standard_(?:session|system)_servicedirs|<include|<includedir/.test(text)) fail(", "else if (false) fail(", 'the bus config includes no standard / host service dirs'],
  ['B5', SH, "else if (![...text.matchAll(", "else if (false && ![...text.matchAll(", 'every <servicedir> is inside the rig dir'],
  ['B6', SH, "if (listens.length !== 1 || parseUnixPathAddress(listens[0]) !== input.busPath) fail(", "if (false) fail(", 'the bus config listens on exactly the private socket'],
  // secrets owner
  ['O1', SH, "if (a.state === 'inconclusive') v.push({", "if (false) v.push({", 'an inconclusive owner lookup fails closed'],
  ['O2', SH, "    if (a.state === 'owner') v.push({ clause: 'owner-expected', detail: `this arm expects NO", "    if (false) v.push({ clause: 'owner-expected', detail: `this arm expects NO", 'a no-service arm sees no owner'],
  ['O3', SH, String.raw`else if (!/(?:^|\/)gnome-keyring-d(?:aemon)?$/.test(o.exe)) v.push(`, "else if (false) v.push(", 'the secrets owner is gnome-keyring-daemon'],
  ['O4', SH, "else if (!rt || rt !== input.runtimeReal) v.push({ clause: 'secrets-owner-in-scratch'", "else if (false) v.push({ clause: 'secrets-owner-in-scratch'", "the secrets owner runs with the SCRATCH runtime dir (not the human's)"],
  ['O5', SH, "else if (o.cmdline.some((x) => touchesUserRuntime(x))) v.push(", "else if (false) v.push(", "the owner's argv does not name the per-user runtime dir"],
  ['O6', SH, "return { ok: violations.length === 0 && passed.length > 0, violations, passed };", "return { ok: violations.length === 0, violations, passed };", 'a verdict with nothing evaluated is not a pass'],
  // host
  ['H1', HO, "&& deps.acc.kind(busPath) === 'socket' && deps.acc.realpath(busPath) === busPath;", "&& deps.acc.kind(busPath) === 'socket';", 'the private-bus query re-checks that the socket is not reached through a link'],
  ['H2', HO, "if (!staticVerdict.ok || spec.phase === 'pre') return staticVerdict;", "if (spec.phase === 'pre') return staticVerdict;", 'nothing is contacted after a failed static clause'],
  ['H3', HO, "if (!daemon.ok) return withDaemon;", "", 'a wrong bus daemon ends the preflight (no second query)'],
  ['H4', HO, "else if (o.status === 0 || /NameHasNoOwner|ServiceUnknown/.test(o.stderr)) answer = { state: 'none' };", "else answer = { state: 'none' };", 'a timed-out / failed owner lookup is not "no owner"'],
  ['H5', HO, "const expect: boolean | null = spec.phase === 'bus' && spec.expectOwner ? null : spec.expectOwner;", "const expect: boolean | null = spec.expectOwner;", 'phase bus of a keyring arm asks no owner question'],
  ['H6', HO, "env: { PATH: '/usr/bin:/bin', DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}`, XDG_RUNTIME_DIR: runtimeReal, LANG: 'C.UTF-8' },", "env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}`, XDG_RUNTIME_DIR: runtimeReal, LANG: 'C.UTF-8' },", 'the private-bus query runs with an allowlist env'],
  ['H7', HO, "PHASES.slice(0, PHASES.indexOf(phase) + 1)", "[phase]", 'a later phase needs the earlier ones'],
  ['H8', HO, "const s = fs.lstatSync(p);", "const s = fs.statSync(p);", 'kind() never follows a link'],
  ['H9', HO, "if (!v.ok) process.exit(3);", "", 'a failed preflight exits 3'],
  ['H10', HO, "arm('a bus path whose final component is a SYMLINK', 'bus-address-private'", "arm('a bus path whose final component is a SYMLINK', 'pass'", 'the table arm for a symlinked bus path expects the abort'],
  ['H11', HO, ".map((x) => x.replace(/\\\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8))));", ";", 'mountinfo octal escapes are decoded'],
  ['L1', CLI, "    console.error(`cannot read the spec ${file}: ${e.message}`);\n    process.exit(2);", "    console.error('x');", 'an unreadable spec exits 2 (never 0)'],
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** The rig-facing self-test (what `preflightOrDie` runs first): exit 0 = armed, 4 = NOT armed. */
function runSelftest() {
  const r = spawnSync('node', ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/keyring-rig-preflight.mjs', 'selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return r.status;
}
function runTests() {
  const r = spawnSync('node', ['--test', '--test-force-exit', '--experimental-strip-types', ...TESTS], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout}\n${r.stderr}`;
  return { rc: r.status, pass: +(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN), fail: +(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN), skipped: +(/^# skipped (\d+)/m.exec(out)?.[1] ?? NaN) };
}

let bad = 0;
let selftestRed = 0;
let selftestTotal = 0;
const rows = [];
const control = runTests();
console.log(`CONTROL (unmutated) → rc ${control.rc}, pass ${control.pass}, fail ${control.fail}, skipped ${control.skipped}`);
if (control.rc !== 0 || control.fail !== 0 || control.skipped !== 0) { console.log('ABORT: the unmutated control is not green'); process.exit(2); }

for (const [id, file, find, replace, what] of MUTANTS) {
  if (only.length && !only.includes(id)) continue;
  const abs = path.join(ROOT, file);
  const orig = fs.readFileSync(abs);
  const src = orig.toString('utf8');
  const n = src.split(find).length - 1;
  if (n !== 1) { console.log(`${id}: VOID — the mutant string occurs ${n}× in ${file} (must be exactly 1)`); bad++; rows.push([id, 'VOID']); continue; }
  let verdict;
  try {
    fs.writeFileSync(abs, src.replace(find, () => replace));
    const r = runTests();
    const st = file === CLI ? null : runSelftest();
    const killed = r.rc !== 0 && r.fail > 0;
    if (st !== null) selftestRed += st === 4 || st === 1 ? 1 : 0;
    if (st !== null) selftestTotal++;
    verdict = killed ? `KILLED (rc ${r.rc}, ${r.fail} failing of ${r.pass + r.fail}; self-test ${st === null ? 'n/a' : st === 0 ? 'still GREEN' : `RED rc ${st}`})` : `SURVIVED (rc ${r.rc}, fail ${r.fail})`;
    if (!killed) bad++;
  } finally {
    fs.writeFileSync(abs, orig);
  }
  const restored = fs.readFileSync(abs);
  if (!restored.equals(orig) || sha(restored) !== sha(orig)) { console.log(`${id}: RESTORE FAILED for ${file}`); process.exit(3); }
  console.log(`${id}: ${verdict} · restored byte-exact (sha ${sha(orig).slice(0, 12)}) · ${what}`);
  rows.push([id, verdict]);
}
const post = runTests();
console.log(`POST-RUN control → rc ${post.rc}, pass ${post.pass}, fail ${post.fail}, skipped ${post.skipped}`);
if (post.rc !== 0) bad++;
console.log(`\nthe rig-facing SELF-TEST went RED under ${selftestRed}/${selftestTotal} mutants (it runs the same arm table as the unit tests)`);
console.log(`\n${rows.filter((r) => r[1].startsWith('KILLED')).length}/${rows.length} KILLED; ${bad ? `${bad} PROBLEM(S)` : 'no survivors, no voids'}`);
process.exit(bad ? 1 : 0);

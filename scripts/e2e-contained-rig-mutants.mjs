#!/usr/bin/env node
// Mutation proof for scripts/e2e-contained-rig.sh's two preflights (incident Q2, ledger #405).
// Each mutant edits the REAL rig IN PLACE (no copy — a copy can drift from what ships), runs the
// matching self-test arms through the real rig, and demands that EXACTLY the arms named in `red`
// go FAIL while the rest of the selected set stays PASS; the rig is restored byte-exact from a
// backup and `cmp`-verified after every mutant (and on SIGINT/exit). A mutant string that is not
// found live (or not found `nth` times) is an ERROR, never a silent no-op.
//   node scripts/e2e-contained-rig-mutants.mjs [--only name,name] [--unfixed]
//   --unfixed  also runs the pre-Q2 rig (git show <ref>:scripts/e2e-contained-rig.sh) through the SAME
//              arms: the unfixed build must FAIL them (it is the must-FAIL counterpart of the controls).
// Exit 0 only when every mutant behaved as declared (a declared `equivalent` survivor is reported, not failed).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RIG = path.join(HERE, 'e2e-contained-rig.sh');
const SELFTEST = path.join(HERE, 'e2e-contained-rig-selftest.sh');
const argv = process.argv.slice(2);
const only = (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);

const RUNTIME_PRESWAY = ['R1a', 'R1b', 'R2', 'R3', 'R4', 'R5a', 'R5b', 'R5c', 'R6a', 'R6b', 'R6c', 'R7a', 'R8'];
const line = (s) => s + ' \\\n'; // a `[[ … ]] \` continuation line, as written in the rig
// name · find · replace · nth occurrence (1-based) · red = arms that must go FAIL · extra = arms run + required PASS · equivalent = why it may survive
const MUTANTS = [
  { name: 'preflight-noop', find: '  local arr="$1" stage="$2" xdg dbus kv name resolved real_rt="/run/user/${RIG_UID}"\n', replace: '  local arr="$1" stage="$2" xdg dbus kv name resolved real_rt="/run/user/${RIG_UID}"\n  return 0\n', red: [...RUNTIME_PRESWAY, 'R7b'] },
  { name: 'r1-real-dir', find: line('  [[ "${xdg}" != "${real_rt}" && "${xdg}" != "${real_rt}/"* && "${xdg}" != "/run/user/"* ]]'), replace: line('  true'), red: ['R1a', 'R1b'] },
  { name: 'r1-prefix-only-exact', find: '[[ "${xdg}" != "${real_rt}" && "${xdg}" != "${real_rt}/"* && "${xdg}" != "/run/user/"* ]]', replace: '[[ "${xdg}" != "${real_rt}" ]]', red: ['R1b'], extra: ['R1a'] },
  { name: 'r2-own-dir', find: line('  [[ "${xdg}" == "${RIG_XDG}" ]]'), replace: line('  true'), red: ['R2'] },
  { name: 'r3-symlink', find: '[[ ! -L "${xdg}" ]] || die', replace: 'true || die', red: ['R3'] },
  { name: 'r3b-resolved-path', find: '[[ "${resolved}" != "/run/user/"* ]] || die', replace: 'true || die', red: [], extra: ['R3'], equivalent: 'only reachable through a rig base that symlinks into /run/user/<uid>, which the self-test must never create (accepted gap, ledger #405)' },
  { name: 'r4-mode-owner-dir', find: line('  [[ -d "${xdg}" && -O "${xdg}" && "$(stat -c %a -- "${xdg}")" == "700" ]]'), replace: line('  true'), red: ['R4'] },
  { name: 'r5a-keyring-glob', find: '"${xdg}"/keyring* ', replace: '', red: ['R5a'], extra: ['R5b', 'R5c'] },
  { name: 'r5b-bus-glob', find: '"${xdg}"/bus* ', replace: '', red: ['R5b'], extra: ['R5a', 'R5c'] },
  { name: 'r5c-pulse-glob', find: ' "${xdg}"/pulse*; do', replace: '; do', red: ['R5c'], extra: ['R5a', 'R5b'] },
  { name: 'r6-dbus-value', find: line('  [[ "${dbus}" == "unix:path=${RIG_NO_BUS}" ]]'), replace: line('  true'), red: ['R6a', 'R6b'] },
  { name: 'r6-dbus-path-exists', find: line('  [[ ! -e "${RIG_NO_BUS}" && ! -L "${RIG_NO_BUS}" ]]'), replace: line('  true'), red: ['R6c'] },
  { name: 'r7-env-value-scan', find: line('    [[ "${kv#*=}" != *"/run/user/"* ]]'), replace: line('    true'), red: ['R7a', 'R7b'] },
  { name: 'r8-length', find: line('  (( ${#xdg} <= 80 ))'), replace: line('  true'), red: ['R8'] },
  { name: 'launch-stage-call-removed', find: 'preflight_runtime_world CHILD_ENV launch\n', replace: '', red: ['R7b'], extra: ['R7a'] },
  // R5 (planted entry) is a property of the dir both arrays share, so the SWAY_ENV pre-sway call still catches it: not part of this mutant's kill set
  { name: 'presway-child-call-removed', find: 'preflight_runtime_world CHILD_ENV pre-sway\n', replace: '', red: ['R1a', 'R6a', 'R7a'] },
  // construction drift: someone re-hard-codes the real runtime dir / drops the bus pin in an array — the control must go RED
  { name: 'sway-env-real-xdg', find: '  XDG_RUNTIME_DIR="${RIG_XDG}"\n', replace: '  XDG_RUNTIME_DIR="/run/user/${RIG_UID}"\n', nth: 1, red: ['C1'] },
  { name: 'child-env-real-xdg', find: '  XDG_RUNTIME_DIR="${RIG_XDG}"\n', replace: '  XDG_RUNTIME_DIR="/run/user/${RIG_UID}"\n', nth: 2, red: ['C1', 'C3'] },
  { name: 'child-env-dbus-dropped', find: '  DBUS_SESSION_BUS_ADDRESS="unix:path=${RIG_NO_BUS}"\n', replace: '', nth: 2, red: ['C1', 'C3'] },
  { name: 'alias-dropped', find: 'set_child_env WAYLAND_DISPLAY "${RIG_WL_ALIAS}"', replace: 'set_child_env WAYLAND_DISPLAY "${MINE}"', red: ['C1', 'C3'] },
  { name: 'alias-target-unverified', find: line('  [[ -S "${RIG_XDG}/${want}" && "$(readlink -- "${RIG_XDG}/${want}")" == "${target}" ]]'), replace: line('  true'), red: ['W6'] },
  { name: 'reap-kill-dropped', find: '    kill "${p}" 2>/dev/null || true\n', replace: '    :\n', red: ['C4'] },
  // the display preflight (clauses touched by this change)
  { name: 'w-path-clause', find: line('  [[ "${got}" != */* ]]'), replace: line('  true'), red: ['W1'] },
  { name: 'w-equality-clause', find: line('  [[ "${got}" == "${want}" ]]'), replace: line('  true'), red: ['W2', 'W3'] },
  { name: 'w-display-clause', find: '  if child_env_has DISPLAY; then', replace: '  if false; then', red: ['W4'] },
];

const backup = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rigmut-')), 'e2e-contained-rig.sh.orig');
fs.copyFileSync(RIG, backup);
const mode = fs.statSync(RIG).mode;
let restored = false;
function restore() {
  if (restored) return;
  fs.copyFileSync(backup, RIG); fs.chmodSync(RIG, mode); restored = true;
  const same = spawnSync('cmp', ['-s', backup, RIG]).status === 0;
  if (!same) { console.error('FATAL: rig NOT byte-identical after restore'); process.exitCode = 3; }
}
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(130); });

function runArms(arms) {
  const r = spawnSync('bash', [SELFTEST], { encoding: 'utf8', env: { ...process.env, RIG_SELFTEST_ONLY: arms.join(' ') }, timeout: 600000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const result = {};
  for (const m of out.matchAll(/^\s+(PASS|FAIL)\s+(\S+)\s/gm)) result[m[2]] = m[1];
  return { result, out };
}

let bad = 0; let killed = 0; const survivors = [];
const rows = [];
for (const mu of MUTANTS) {
  if (only.length && !only.includes(mu.name)) continue;
  const src = fs.readFileSync(backup, 'utf8');
  const nth = mu.nth ?? 1;
  const parts = src.split(mu.find);
  if (parts.length - 1 < nth) { console.log(`ERROR ${mu.name}: mutant string found ${parts.length - 1}× (need ≥ ${nth}) — NOT verified live`); bad++; continue; }
  const mutated = parts.slice(0, nth).join(mu.find) + mu.replace + parts.slice(nth).join(mu.find);
  if (mutated === src) { console.log(`ERROR ${mu.name}: mutation is a no-op`); bad++; continue; }
  fs.writeFileSync(RIG, mutated); fs.chmodSync(RIG, mode); restored = false;
  if (spawnSync('bash', ['-n', RIG]).status !== 0) { restore(); console.log(`ERROR ${mu.name}: mutated rig has a syntax error (a mutant must be a real clause removal, not a parse failure)`); bad++; continue; }
  const arms = [...new Set([...mu.red, ...(mu.extra ?? [])])];
  const { result } = runArms(arms.length ? arms : ['C1']);
  restore();
  const wrongGreen = mu.red.filter((a) => result[a] !== 'FAIL');   // should have been killed
  const wrongRed = (mu.extra ?? []).filter((a) => result[a] !== 'PASS'); // collateral damage
  const ok = wrongGreen.length === 0 && wrongRed.length === 0;
  if (!mu.red.length) { survivors.push(mu.name); }
  else if (ok) killed++;
  if (!ok) bad++;
  rows.push(`${ok ? 'OK ' : 'BAD'} ${mu.name.padEnd(28)} red-expected=[${mu.red.join(' ')}] got=${arms.map((a) => `${a}:${result[a] ?? '∅'}`).join(' ')}${mu.equivalent ? `  (declared survivor: ${mu.equivalent})` : ''}${wrongGreen.length ? `  NOT KILLED: ${wrongGreen.join(',')}` : ''}${wrongRed.length ? `  COLLATERAL: ${wrongRed.join(',')}` : ''}`);
  console.log(rows[rows.length - 1]);
}

if (argv.includes('--unfixed')) {
  const ref = execFileSync('git', ['-C', path.join(HERE, '..'), 'rev-parse', '--verify', 'origin/ops-browser-orca-388'], { encoding: 'utf8' }).trim();
  const old = execFileSync('git', ['-C', path.join(HERE, '..'), 'show', `${ref}:scripts/e2e-contained-rig.sh`], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (old.includes('preflight_runtime_world')) { console.log('ERROR unfixed: the reference rig already has the runtime-world preflight'); bad++; }
  else {
    fs.writeFileSync(RIG, old); fs.chmodSync(RIG, mode); restored = false;
    const arms = ['R1a', 'R6a', 'C2', 'C3'];
    const { result } = runArms(arms);
    restore();
    const notRed = arms.filter((a) => result[a] !== 'FAIL');
    if (notRed.length) { bad++; console.log(`BAD unfixed(${ref.slice(0, 8)}) arms NOT red: ${notRed.join(',')} got=${JSON.stringify(result)}`); }
    else console.log(`OK  unfixed(${ref.slice(0, 8)}) the pre-Q2 rig FAILS ${arms.join(' ')} through the same selftest`);
  }
}

restore();
const same = spawnSync('cmp', ['-s', backup, RIG]).status === 0;
console.log(`RIG-MUTANTS: killed=${killed} survivors=[${survivors.join(',')}] bad=${bad} rig-restored-byte-exact=${same}`);
process.exit(bad === 0 && same ? 0 : 1);

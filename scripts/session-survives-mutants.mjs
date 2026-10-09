// In-place mutants for #332 (Q9: the member scope is a delegated parent with two leaves — keeper in k, CLI + tools in w): one per changed clause. Each mutant edits ONE anchor in the live source
// (byte-exact backup, restored in `finally`, compared with Buffer.compare AND `git diff --quiet`), runs its unit test files and — with --rig — its rig arms, and REQUIRES a red.
//
//   node scripts/session-survives-mutants.mjs --check                 every anchor matches exactly once (no run)
//   node scripts/session-survives-mutants.mjs --unit-only [--only a,b]  unit/wiring targets only (cheap, no token); a mutant only a rig arm can kill prints NEEDS-RIG, not SURVIVED
//   node scripts/session-survives-mutants.mjs --rig [--only a,b]        unit + rig targets (HEAVY: real keepers in real scopes — take the heavy-rig token first)
//   node scripts/session-survives-mutants.mjs --selftest                positive control: a no-op mutant must stay green on the unit targets
// Separate from scripts/memory-cap-mutants.mjs on purpose (that file is #320/#322's; the rig itself is shared: scripts/e2e-memory-cap.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RIG = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'e2e-memory-cap.mjs')];
const SHARED = 'src/shared/memory-scope.ts';
const LEAVES = 'src/keeper/member-leaves.ts';
const KEEPER = 'src/keeper/index.ts';
const FI1 = 'src/main/memory-scope.ts';
const U_SHARED = ['src/shared/memory-scope.test.ts'];
const U_LEAVES = ['src/keeper/member-leaves.test.ts'];
const U_BIND = ['src/keeper/member-leaves-binding.test.ts'];
const U_FI1 = ['src/main/memory-scope.test.ts'];
const ARM = 'session_survives_chain';

/** target: { unit: [test files], rig: [arms] }.  clause = the design / AC clause the mutant attacks. */
const MUTANTS = [
  // ── the scope: delegated, backstop limit above the work leaf's ─────────────────────────────────────────────────────
  { id: 'scope-not-delegated', clause: 'the scope is DELEGATED (the keeper builds its leaves inside it)', file: SHARED, find: "props.push('Delegate=yes', ...(backstop === null", replace: 'props.push(...(backstop === null', target: { unit: U_SHARED, rig: [ARM] } },
  { id: 'scope-limit-no-reserve', clause: "the scope's own limit is hard + keeper room: the WORK leaf always trips first", file: SHARED, find: 'reserveBytes > 0 ? hardBytes + reserveBytes : null', replace: 'reserveBytes > 0 ? hardBytes : null', target: { unit: U_SHARED, rig: ['backstop_scope_limit'] } },
  { id: 'leaf-path-unmapped', clause: 'a leaf path maps back to its scope (kernel lines, the keeper check, FI-1)', file: SHARED, find: 'return slash > 0 && SCOPE_LEAVES.includes(cgPath.slice(slash + 1)) ? cgPath.slice(0, slash) : cgPath;', replace: 'return cgPath;', target: { unit: U_SHARED } },
  { id: 'kernel-line-leaf-ignored', clause: 'a kernel kill whose victim lived in the work leaf belongs to the unit (the kill records keep naming victims)', file: SHARED, find: "const inWork = (p: string): boolean => base(p) === unit || (base(p) === SCOPE_LEAF_WORK && parentBase(p) === unit);", replace: 'const inWork = (p: string): boolean => base(p) === unit;', target: { unit: U_SHARED } },
  // ── the leaf builder (keeper) ──────────────────────────────────────────────────────────────────────────────────────
  { id: 'leaf-keeper-not-moved', clause: 'the keeper moves ITSELF into leaf k (the scope must be process-free before controllers are handed down)', file: LEAVES, find: "['move the keeper into its leaf', () => a.fs.write(path.join(keeperDir, 'cgroup.procs'), String(a.pid))]", replace: "['move the keeper into its leaf', () => undefined]", target: { unit: U_LEAVES, rig: [ARM] } },
  { id: 'leaf-memory-not-enabled', clause: 'the memory controller is enabled for the children (without it the work leaf has no limit)', file: LEAVES, find: "a.fs.write(path.join(a.scopeDir, 'cgroup.subtree_control'), '+memory')", replace: 'undefined', target: { unit: U_LEAVES } },
  { id: 'leaf-limit-not-set', clause: "the member's hard level is written on the WORK leaf", file: LEAVES, find: "a.fs.write(path.join(workDir, 'memory.max'), String(a.hardBytes))", replace: 'undefined', target: { unit: U_LEAVES } },
  { id: 'leaf-limit-unchecked', clause: 'fail closed: the limit is read back and must be the one asked (not delegated / "max" ⇒ not-applied)', file: LEAVES, find: 'if (limit === null || limit > a.hardBytes || limit < a.hardBytes - LEAF_LIMIT_SLACK_BYTES) {', replace: 'if (false) {', target: { unit: U_LEAVES } },
  { id: 'leaf-step-failure-ignored', clause: 'fail closed: a failing step stops the build and is named', file: LEAVES, find: '    if (failed) return failed;\n  }', replace: '  }', target: { unit: U_LEAVES } },
  { id: 'leaf-swap-escape-open', clause: "the work leaf's swap escape is closed too", file: LEAVES, find: "step('close the work leaf\\'s swap escape', () => a.fs.write(path.join(workDir, 'memory.swap.max'), '0'));", replace: '', target: { unit: U_LEAVES } },
  // ── the keeper's wiring ────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'keeper-leaves-failure-continues', clause: 'leaves that could not be built ⇒ not-applied, tools still wrapped, no watch (return before it)', file: KEEPER, find: '(only the scope\'s backstop limit holds, if any); tools are still wrapped (adj 1000: a backstop episode takes a tool first), no kill watch`);\n    return cliEnv(null);', replace: '(only the scope\'s backstop limit holds, if any); tools are still wrapped (adj 1000: a backstop episode takes a tool first), no kill watch`);', target: { unit: U_BIND, rig: ['not_applied_reported'] } },
  { id: 'keeper-watch-on-scope', clause: 'the cap checks and the kill watch are on the work leaf', file: KEEPER, find: 'const dir = leaves.workDir;', replace: 'const dir = path.join(CGROUP_ROOT, scopePath);', target: { unit: U_BIND, rig: ['kill_at_hard', ARM] } },
  { id: 'keeper-leaf-before-scope-check', clause: 'the scope is verified to be OURS before anything is created or moved', file: KEEPER, find: "if (!cgPath || !scopePath || path.basename(scopePath) !== cap.unit) {", replace: 'if (!cgPath || !scopePath) {', target: { unit: U_BIND } },
  // ── FI-1 readers (the scope\'s processes live in its leaves) ───────────────────────────────────────────────────────
  { id: 'fi1-procs-scope-only', clause: "FI-1 lists the scope's members from BOTH leaves (its own cgroup.procs is empty)", file: FI1, find: "  for (const leaf of SCOPE_LEAVES) {\n    try {\n      out.push(...parse(e.readFile(path.join(cgroupDir, leaf, 'cgroup.procs'))));", replace: "  for (const leaf of ([] as string[])) {\n    try {\n      out.push(...parse(e.readFile(path.join(cgroupDir, leaf, 'cgroup.procs'))));", target: { unit: U_FI1, rig: ['delete_stops_scope'] } },
  { id: 'fi1-leaf-error-swallowed', clause: 'a leaf that exists but cannot be read is an error, not a quiet undercount', file: FI1, find: "if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;", replace: '/* swallowed */', target: { unit: U_FI1 } },
  { id: 'fi1-keeper-pid-scope-only', clause: 'the keeper in leaf k is recognised by its pid file (its cgroup maps to the scope)', file: FI1, find: 'path.join(e.cgroupRoot, scopePathOfCgroup(cg)) === cgroupDir', replace: 'path.join(e.cgroupRoot, cg) === cgroupDir', target: { unit: U_FI1 } },
  { id: 'fi1-outside-strict-equality', clause: 'listKeeperTreeOutsideScope: the scope\'s two leaves are INSIDE it (a strict path equality would list every tool as an escapee, or none)', file: FI1, find: 'if (cg === null || scopePathOfCgroup(cg) === scopeCg) continue;', replace: 'if (cg === null || cg === scopeCg) continue;', target: { unit: U_FI1 } },
  { id: 'fi1-outside-keeper-leaf', clause: 'listKeeperTreeOutsideScope: a keeper in leaf k still belongs to the scope (else the escapee bridge answers [] forever)', file: FI1, find: 'if (keeperCg === null || scopePathOfCgroup(keeperCg) !== scopeCg) return [];', replace: 'if (keeperCg === null || keeperCg !== scopeCg) return [];', target: { unit: U_FI1 } },
  { id: 'scopestop-keeper-unit-leaf', clause: '#327 scope stop: the tracked keeper\'s unit is its SCOPE (not the leaf k) — else the live scope is not recognised by the pid', file: 'src/main/scope-stop-host-core.ts', find: 'path.posix.basename(scopePathOfCgroup(cg))', replace: 'path.posix.basename(cg)', target: { unit: ['src/main/scope-stop-host.test.ts'] } },
  { id: 'fi1-cap-from-scope', clause: "readScopeMemory: the cap (max, swap, events) is the work leaf's", file: FI1, find: "const capDir = e.exists(path.join(workDir, 'memory.max')) ? workDir : d;", replace: 'const capDir = d;', target: { unit: U_FI1 } },
  { id: 'wrapper-no-leaf-move', clause: 'a capped member\'s tool shell moves ITSELF into the work leaf (the only cgroup that carries the hard level)', file: SHARED, find: '[ -n "\\${${WORK_LEAF_ENV}:-}" ] && echo $$ > "\\$${WORK_LEAF_ENV}/cgroup.procs" 2>/dev/null\n', replace: '', target: { unit: U_SHARED, rig: [ARM, 'kill_at_hard'] } },
  { id: 'keeper-no-leaf-env', clause: 'the keeper hands the work leaf to the tool wrapper through the CLI environment', file: KEEPER, find: '...(workLeaf ? { [WORK_LEAF_ENV]: workLeaf } : {})', replace: '', target: { unit: U_BIND, rig: [ARM, 'kill_at_hard'] } },
  { id: 'keeper-limit-failure-unwrapped', clause: 'a work leaf whose limit did not read back keeps the tools wrapped too', file: KEEPER, find: "tools are still wrapped (adj 1000), no kill watch`);\n    return cliEnv(null);", replace: "tools are still wrapped (adj 1000), no kill watch`);\n    return env;", target: { unit: U_BIND } },
  { id: 'reserve-env-ignored', clause: 'rigs (scopes ≤ 300 MB) can turn the scope-level backstop off through ORCHESTRA_MEMCAP_RESERVE_BYTES', file: SHARED, find: 'if (raw === undefined || !/^\\d+$/.test(raw.trim())) return KEEPER_LEAF_RESERVE_BYTES;', replace: 'return KEEPER_LEAF_RESERVE_BYTES;', target: { unit: U_SHARED } },
  { id: 'fi1-count-swap-from-scope', clause: 'countMemberScopes reads the swap escape of the WORK leaf (the scope\'s own may be open)', file: FI1, find: "e.exists(path.join(dir, SCOPE_LEAF_WORK, 'memory.max')) ? path.join(dir, SCOPE_LEAF_WORK) : dir, 'memory.swap.max'", replace: "dir, 'memory.swap.max'", target: { unit: U_FI1 } },
];

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--only=')) ? argv.find((a) => a.startsWith('--only=')).slice(7) : argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);
const mode = argv.includes('--check') ? 'check' : argv.includes('--selftest') ? 'selftest' : argv.includes('--rig') ? 'rig' : argv.includes('--unit-only') ? 'unit' : 'help';
const list = only.length ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
const count = (s, needle) => s.split(needle).length - 1;
const sh = (cmd, args, env = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20 * 60_000 });
const armPass = (out, arm) => new RegExp(`^PASS ${arm}\\b`, 'm').test(out);
const armFail = (out, arm) => new RegExp(`^FAIL ${arm}\\b`, 'm').test(out);

function check() {
  let bad = 0;
  const ids = new Set();
  for (const m of MUTANTS) {
    if (ids.has(m.id)) { console.log(`FAIL duplicate id ${m.id}`); bad++; }
    ids.add(m.id);
    const s = fs.readFileSync(path.join(REPO, m.file), 'utf8');
    const n = count(s, m.find);
    console.log(`${n === 1 ? 'ok  ' : 'FAIL'} anchor ${m.id} in ${m.file}: ${n} match${n === 1 ? '' : 'es (must be exactly 1)'}`);
    if (n !== 1) bad++;
    if (m.find === m.replace) { console.log(`FAIL ${m.id}: replace === find`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} anchor problem(s)`);
  return bad;
}
if (mode === 'help') { console.log('usage: --check | --unit-only [--only a,b] | --rig [--only a,b] | --selftest'); process.exit(2); }
if (mode === 'check') process.exit(check() ? 1 : 0);
if (check()) { console.log('refusing to run with broken anchors'); process.exit(1); }

const unitRun = (files) => sh(process.execPath, ['--test', '--test-timeout=20000', '--experimental-strip-types', ...files]);
const unitFiles = [...new Set(list.flatMap((m) => m.target.unit ?? []))];
let baseBad = 0;
for (const u of unitFiles) { const r = unitRun([u]); const ok = r.status === 0 && /# skipped 0/.test(r.stdout); console.log(`baseline ${ok ? 'GREEN' : 'RED  '} unit:${u}`); if (!ok) baseBad++; }
const arms = mode === 'rig' ? [...new Set(list.flatMap((m) => m.target.rig ?? []))] : [];
for (const arm of arms) { const r = sh(process.execPath, [...RIG, arm, '--contained']); const ok = armPass(r.stdout + r.stderr, arm); console.log(`baseline ${ok ? 'GREEN' : 'RED  '} rig:${arm}`); if (!ok) baseBad++; }
if (baseBad) { console.log(`BASELINE NOT GREEN (${baseBad}) — a mutant cannot be judged against a red baseline`); process.exit(1); }

if (mode === 'selftest') {
  const noop = { file: LEAVES, find: '// #332 (Q9): the keeper builds the member scope', replace: '// #332 (Q9):  the keeper builds the member scope' };
  const abs = path.join(REPO, noop.file);
  const orig = fs.readFileSync(abs);
  try {
    if (count(orig.toString('utf8'), noop.find) !== 1) { console.log('SELFTEST VOID: no-op anchor not found'); process.exit(1); }
    fs.writeFileSync(abs, orig.toString('utf8').replace(noop.find, () => noop.replace));
    const r = unitRun([...U_LEAVES, ...U_BIND]);
    console.log(`selftest no-op mutant: unit ${r.status === 0 ? 'green' : 'RED'}`);
    if (r.status !== 0) { console.log('SELFTEST FAILED: a no-op mutation went red — the instrument cries wolf'); process.exitCode = 1; } else console.log('SELFTEST OK: a no-op mutant survives the unit targets');
  } finally { fs.writeFileSync(abs, orig); }
  process.exit(process.exitCode ?? 0);
}

let survived = 0, needsRig = 0, restoreBad = 0;
for (const m of list) {
  const abs = path.join(REPO, m.file);
  const orig = fs.readFileSync(abs); // byte-exact backup
  const src = orig.toString('utf8');
  const cleanBefore = sh('git', ['diff', '--quiet', '--', m.file]).status === 0;
  const reds = [];
  const notRed = [];
  let voided = false;
  try {
    fs.writeFileSync(abs, src.replace(m.find, () => m.replace));
    if (m.target.unit?.length) { const r = unitRun(m.target.unit); (r.status !== 0 ? reds : notRed).push(`unit:${m.target.unit.map((u) => path.basename(u)).join('+')}`); }
    if (mode === 'rig') for (const arm of m.target.rig ?? []) {
      const r = sh(process.execPath, [...RIG, arm, '--contained'], { MC_MUTANT_TAG: m.id });
      const out = r.stdout + r.stderr;
      if (armFail(out, arm)) reds.push(`rig:${arm}`); else { notRed.push(`rig:${arm}`); if (!armPass(out, arm)) voided = true; }
    }
  } finally {
    fs.writeFileSync(abs, orig);
    const same = Buffer.compare(fs.readFileSync(abs), orig) === 0 && (!cleanBefore || sh('git', ['diff', '--quiet', '--', m.file]).status === 0);
    if (!same) { restoreBad++; console.error(`RESTORE MISMATCH for ${m.file}`); }
  }
  const killed = reds.length > 0;
  const rigOnly = !killed && mode === 'unit' && (m.target.rig?.length ?? 0) > 0;
  if (rigOnly) needsRig++; else if (!killed || voided) survived++;
  console.log(`${killed ? 'KILLED  ' : rigOnly ? 'NEEDS-RIG' : 'SURVIVED'} ${m.id}  [${m.clause}]  by: ${reds.join(',') || '—'}${notRed.length ? `  (not red: ${notRed.join(',')})` : ''}${voided ? '  ← VOID run (no verdict from a rig arm)' : ''}`);
}
const dirty = sh('git', ['status', '--porcelain', '--', ...new Set(list.map((m) => m.file))]).stdout.trim();
console.log(`SCOPE-STOP MUTANTS (${mode}): ${list.length - survived - needsRig}/${list.length} killed, ${survived} survived/void, ${needsRig} need the rig, restore mismatches ${restoreBad}`);
console.log(dirty ? `NOTE: mutated files show in git status (expected only if they carry uncommitted work):\n${dirty}` : 'tree clean after the sweep');
process.exit(survived || restoreBad ? 1 : 0);

#!/usr/bin/env node
// Mutants of the #390 clauses (pinned Node for the keepers). Each mutant edits a MIRROR of the tree (the repo on disk is never written — its
// sha256 is asserted unchanged at the end) and must turn the named rig arm / unit test RED. Controls: the unmutated mirror passes everything it
// is asked about (0 skipped), every anchor matches EXACTLY once (a drifted anchor throws instead of "surviving"), and one provably EQUIVALENT
// edit must SURVIVE — proof the harness can say SURVIVED, not only KILLED.
// Run: node scripts/pinned-node-mutants.mjs   (rc 0 = every mutant killed, the equivalent one survived)
// Terminator: `PINNED-NODE-MUTANTS: ALL KILLED (N/N), equivalent survived` or `… FAIL …`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = 'scripts/pinned-node/lib.cjs';
const PACK = 'scripts/pinned-node/pack-check.cjs';
const SMOKE = 'scripts/pinned-node/smoke.cjs';
const RT = 'src/shared/keeper-runtime.ts';
const INST = 'src/main/keeper-runtime-install.ts';
const KC = 'src/main/keeper-client.ts';
const U_RT = 'src/shared/keeper-runtime.test.ts';
const U_INST = 'src/main/keeper-runtime-install.test.ts';

/** { id, file, edits: [[from, to]…], rig?: [arm…] (each must print `ARM <arm>: FAIL`), unit?: [test file…] (must go red), equivalent?: true } */
const MUTANTS = [
  { id: 'download-hash-unchecked', file: LIB, edits: [["      assertSha256(part, pin.tarballSha256, `downloaded ${pin.tarball}`); // BEFORE it is ever extracted\n", '']], rig: ['fetch_corrupt_download'] },
  { id: 'cached-tarball-trusted', file: LIB, edits: [["    assertSha256(tarball, pin.tarballSha256, `cached ${pin.tarball}`);\n    ok = true;", '    ok = true;']], rig: ['fetch_poisoned_cache'] },
  { id: 'extracted-binary-unchecked', file: LIB, edits: [["    assertSha256(extracted, pin.nodeSha256, 'extracted bin/node');\n", '']], rig: ['extract_binary_tamper'] },
  { id: 'extracted-size-unchecked', file: LIB, edits: [['!st.isFile() || st.size !== pin.nodeBytes', '!st.isFile()']], rig: ['extract_size_tamper'] },
  { id: 'pack-hash-unchecked', file: PACK, edits: [['if (got !== pin.nodeSha256) throw', 'if (false) throw']], rig: ['pack_corrupt_byte'] },
  { id: 'pack-size-unchecked', file: PACK, edits: [['if (st.size !== pin.nodeBytes) throw', 'if (false) throw']], rig: ['pack_truncated'] },
  { id: 'pack-exec-bit-unchecked', file: PACK, edits: [['if ((st.mode & 0o111) === 0) throw', 'if (false) throw']], rig: ['pack_not_executable'] },
  { id: 'pack-manifest-unchecked', file: PACK, edits: [["    if (manifest[k] !== (k === 'arch' ? arch : pin[k])) throw", '    if (false) throw']], rig: ['pack_manifest_mismatch'] },
  { id: 'pack-cross-arch-quiet-skip', file: PACK, edits: [['    if (!allowUnsmokedCross) {', '    if (false) {']], rig: ['pack_cross_arch_refused'] },
  { id: 'smoke-skipped', file: PACK, edits: [['const r = await smokeKeeper({ nodePath, keeperJs, expectVersion: pin.version });', 'const r = { version: `v${pin.version}`, exe: nodePath };']], rig: ['smoke_garbage_binary', 'smoke_stub_binary', 'smoke_wrong_version', 'smoke_exec_proxy'] },
  { id: 'smoke-version-unchecked', file: SMOKE, edits: [['if (expectVersion && version !==', 'if (false && version !==']], rig: ['smoke_wrong_version'] },
  { id: 'smoke-exe-identity-unchecked', file: SMOKE, edits: [['if (exe !== want) throw', 'if (false) throw']], rig: ['smoke_exec_proxy'] },
  {
    id: 'smoke-relay-unchecked',
    file: SMOKE,
    edits: [
      ["const got = await rd.next((f) => f.t === 'stdout' || f.t === 'err' || f.t === 'exit', 10000, 'the child echo');", "const got = { t: 'stdout', b64: Buffer.from('\"echo\":\"pinned-node-smoke\"').toString('base64') };"],
      ["await rd.next((f) => f.t === 'exit', 10000, 'the child exit after kill');", ''],
    ],
    rig: ['smoke_hello_only_keeper'],
  },
  { id: 'pick-bundled-ignored', file: RT, edits: [['if (i.bundledNode) return', 'if (false && i.bundledNode) return']], unit: [U_RT], rig: ['bundled_launch'] },
  { id: 'pick-path-before-bundled', file: RT, edits: [["  if (i.bundledNode) return { kind: 'bundled', cmd: i.bundledNode, electronRunAsNode: false };\n  if (i.appImage) {\n    if (i.pathNode)", "  if (i.appImage) {\n    if (i.pathNode)"], ["  return { kind: 'app', cmd: i.execPath, electronRunAsNode: true };\n}", "  if (i.bundledNode) return { kind: 'bundled', cmd: i.bundledNode, electronRunAsNode: false };\n  return { kind: 'app', cmd: i.execPath, electronRunAsNode: true };\n}"]], unit: [U_RT] },
  { id: 'runtime-dir-not-versioned', file: RT, edits: [['return `node-${m.version}-${m.nodeSha256.slice(0, 12)}`;', "return 'node';"]], unit: [U_RT, U_INST], rig: ['update_keeps_running_keeper'] },
  { id: 'install-hash-unchecked', file: INST, edits: [["      if (got !== manifest.nodeSha256) return", '      if (false) return']], unit: [U_INST] },
  { id: 'install-always-recopies', file: INST, edits: [["    if (usable(dest, manifest) && (o.trust?.checked.has(dest) || contentGood(dest, manifest))) return finish(dest, manifest, false);\n\n    fs.mkdirSync(o.binDir", '    fs.mkdirSync(o.binDir']], unit: [U_INST] },
  { id: 'install-arch-unchecked', file: INST, edits: [['if (manifest.arch !== arch) return', 'if (false) return']], unit: [U_INST] },
  { id: 'launcher-ignores-bundled', file: KC, edits: [['bundledNode: bundled,', 'bundledNode: null,']], rig: ['bundled_launch'] },
  { id: 'launcher-no-reinstall', file: KC, edits: [['  if (!bundled) bundled = refreshBundledRuntime();\n', '']], rig: ['reinstall_when_wiped'] },
  { id: 'startup-install-removed', file: KC, edits: [['  installOomWrapper();\n  refreshBundledRuntime();\n', '  installOomWrapper();\n']], rig: ['bundled_launch', 'update_keeps_running_keeper'] },
  { id: 'install-exec-unchecked', file: INST, edits: [['      if (!canExec(dest)) reason =', '      if (false) reason =']], unit: [U_INST], rig: ['noexec_bin_refused'] },
  { id: 'gather-ignores-appimage', file: RT, edits: [['const appImage = !!o.appImagePath;', 'const appImage = false;']], unit: [U_RT] },
  { id: 'gather-path-lookup-unconditional', file: RT, edits: [["pathNode: appImage ? o.findOnPath('node') : null", "pathNode: o.findOnPath('node')"]], unit: [U_RT] },
  { id: 'install-race-replaces-winner', file: INST, edits: [['        if (usable(dest, manifest) && contentGood(dest, manifest)) return finish(dest, manifest, false); // another instance won the race\n', '']], unit: [U_INST], rig: ['concurrent_install_keeps_winner'] },
  { id: 'install-content-unchecked', file: INST, edits: [['(o.trust?.checked.has(dest) || contentGood(dest, manifest))', 'true']], unit: [U_INST], rig: ['corrupt_runtime_healed_at_start'] },
  { id: 'install-probe-skipped', file: INST, edits: [['const p = probe(dest);', 'const p: string | null = null;']], unit: [U_INST], rig: ['unrunnable_runtime_falls_through'] },
  { id: 'trust-not-remembered', file: INST, edits: [['      o.trust?.checked.set(dest, reason);\n', '']], unit: [U_INST] },
  // INSTRUMENT CHECK: a provably EQUIVALENT edit (same read buffer size). It MUST survive.
  { id: 'equiv-buffer-size', file: LIB, edits: [['Buffer.allocUnsafe(1 << 20)', 'Buffer.allocUnsafe(1048576)']], rig: ['fetch_real_ok', 'pack_ok_real'], equivalent: true },
];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const TRACKED = [...new Set(MUTANTS.map((m) => m.file))];
const before = Object.fromEntries(TRACKED.map((f) => [f, sha(path.join(REPO, f))]));

// ── the mirror: everything the rig imports, node_modules + the hash-checked cache linked ────────────────────────────────────────────────────────────
const MIRROR = fs.mkdtempSync(path.join(os.tmpdir(), 'pnmut-'));
for (const d of ['src', 'scripts']) fs.cpSync(path.join(REPO, d), path.join(MIRROR, d), { recursive: true });
fs.copyFileSync(path.join(REPO, 'package.json'), path.join(MIRROR, 'package.json'));
fs.mkdirSync(path.join(MIRROR, 'dist-electron'));
fs.copyFileSync(path.join(REPO, 'dist-electron', 'keeper.js'), path.join(MIRROR, 'dist-electron', 'keeper.js'));
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(MIRROR, 'node_modules'));
fs.mkdirSync(path.join(MIRROR, 'build', 'pinned-node'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'build', 'pinned-node', '.cache'), path.join(MIRROR, 'build', 'pinned-node', '.cache'));

const RIG = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './scripts/.r2-register.mjs', 'scripts/e2e-pinned-node.mjs'];
function runRig(arms) {
  const r = spawnSync(process.execPath, [...RIG, arms.join(',')], { cwd: MIRROR, encoding: 'utf8', timeout: 300_000, env: { ...process.env, TMPDIR: os.tmpdir() } });
  return { rc: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function runUnit(files) {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: MIRROR, encoding: 'utf8', timeout: 300_000 });
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout || '')?.[1] ?? NaN);
  return { rc: r.status, pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests') };
}
const armLine = (out, arm) => out.split('\n').find((l) => l.startsWith(`ARM ${arm}:`)) ?? '(no line)';

const allRigArms = [...new Set(MUTANTS.flatMap((m) => m.rig ?? []))];
const allUnit = [...new Set(MUTANTS.flatMap((m) => m.unit ?? []))];
let bad = 0;
const line = (s) => console.log(s);

// control 1: the unmutated mirror is green on everything a mutant is judged by
{
  const r = runRig(allRigArms);
  const reds = allRigArms.filter((a) => !armLine(r.out, a).startsWith(`ARM ${a}: PASS`));
  const u = runUnit(allUnit);
  const ok = r.rc === 0 && reds.length === 0 && u.rc === 0 && u.fail === 0 && u.skipped === 0 && u.tests > 0 && u.tests === u.pass;
  line(`control (unmutated): rig ${allRigArms.length - reds.length}/${allRigArms.length} PASS rc=${r.rc}; unit ${u.pass}/${u.tests} pass, ${u.skipped} skipped → ${ok ? 'GREEN' : 'NOT GREEN ' + reds.join(',')}`);
  if (!ok) bad++;
}

for (const m of MUTANTS) {
  const f = path.join(MIRROR, m.file);
  const orig = fs.readFileSync(f, 'utf8');
  let mut = orig;
  let anchorOk = true;
  for (const [from, to] of m.edits) {
    const count = mut.split(from).length - 1;
    if (count !== 1) { line(`${m.id}: ANCHOR MATCHES ${count}× in ${m.file} — drifted, mutant not applied`); anchorOk = false; break; }
    mut = mut.replace(from, () => to);
  }
  if (!anchorOk) { bad++; continue; }
  fs.writeFileSync(f, mut);
  try {
    const verdicts = [];
    let allRed = true; // every named arm / test file went red
    let anyRed = false;
    if (m.rig) {
      const r = runRig(m.rig);
      const red = m.rig.filter((a) => armLine(r.out, a).startsWith(`ARM ${a}: FAIL`));
      verdicts.push(`rig red ${red.length}/${m.rig.length} (${red.join(',') || 'none'})`);
      allRed = allRed && red.length === m.rig.length;
      anyRed = anyRed || red.length > 0;
    }
    if (m.unit) {
      const u = runUnit(m.unit);
      verdicts.push(`unit fail ${u.fail}/${u.tests}`);
      allRed = allRed && u.rc !== 0 && u.fail > 0;
      anyRed = anyRed || (u.rc !== 0 && u.fail > 0);
    }
    if (m.equivalent) {
      line(`${m.id}: ${!anyRed ? 'SURVIVED (expected — equivalent edit)' : 'KILLED — the equivalent edit must not be killed'}  [${verdicts.join('; ')}]`);
      if (anyRed) bad++;
    } else {
      line(`${m.id}: ${allRed ? 'KILLED' : 'SURVIVED  ← not (fully) killed'}  [${verdicts.join('; ')}]`);
      if (!allRed) bad++;
    }
  } finally {
    fs.writeFileSync(f, orig); // restore the mirror file byte-exact for the next mutant
    if (fs.readFileSync(f, 'utf8') !== orig) throw new Error(`mirror restore failed for ${m.file}`);
  }
}

// control 2: the repo on disk is untouched, and the mirror is green again after every restore
const after = Object.fromEntries(TRACKED.map((f) => [f, sha(path.join(REPO, f))]));
const repoClean = TRACKED.every((f) => before[f] === after[f]);
{
  const r = runRig(allRigArms);
  const reds = allRigArms.filter((a) => !armLine(r.out, a).startsWith(`ARM ${a}: PASS`));
  line(`control (restored): rig ${allRigArms.length - reds.length}/${allRigArms.length} PASS${reds.length ? ` — NOT PASS: ${reds.map((a) => armLine(r.out, a).slice(0, 160)).join(' | ')}` : ''}; repo files byte-equal before/after: ${repoClean}`);
  if (reds.length || !repoClean) bad++;
}
fs.rmSync(MIRROR, { recursive: true, force: true });
const killedN = MUTANTS.filter((m) => !m.equivalent).length;
line(bad === 0 ? `PINNED-NODE-MUTANTS: ALL KILLED (${killedN}/${killedN}), equivalent survived` : `PINNED-NODE-MUTANTS: FAIL (${bad} problem(s))`);
process.exit(bad === 0 ? 0 : 1);

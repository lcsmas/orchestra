// #407 — mutation proof of the verdict function: every mutant below changes ONE clause of src/shared/cookie-fuse-verdict.ts and the unit tests
// (src/shared/cookie-fuse-verdict.test.ts) must go RED. The mutant string is verified LIVE (it must occur exactly once), the file is restored
// byte-exact and `cmp`ed against the pristine copy after every mutant (also when the run is killed). Usage: node scripts/cookie-fuse-verdict-mutants.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src/shared/cookie-fuse-verdict.ts');
const test = 'src/shared/cookie-fuse-verdict.test.ts';
const pristine = fs.readFileSync(target);
const backup = `${target}.pristine-${process.pid}`;
fs.writeFileSync(backup, pristine);
const restore = () => { fs.writeFileSync(target, pristine); };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); fs.rmSync(backup, { force: true }); process.exit(130); });

const MUTANTS = [
  ['stall limit 10 s → 100 s', 'stallMs: 10_000,', 'stallMs: 100_000,'],
  ['single-run limit 15 s → 150 s', 'stallSingleMs: 15_000,', 'stallSingleMs: 150_000,'],
  ['null-control limit 2.5 s → 250 s', 'nullMs: 2_500,', 'nullMs: 250_000,'],
  ['minimum runs 3 → 1', 'minRuns: 3,', 'minRuns: 1,'],
  ['minimum cookies 20 → 2', 'minCookies: 20,', 'minCookies: 2,'],
  ['fully-encrypted accepts a partly-plain census', 'return s.total >= min && s.encrypted === s.total;', 'return s.total >= min && s.encrypted >= s.total - 1;'],
  ['fully-plain accepts anything', 'return s.total >= min && s.plain === s.total;', 'return true;'],
  ['positive control accepts anything', '!isFullyEncrypted(d.old) && isFullyPlain(d.old)', 'true'],
  ['a lost login is not a loss', "if (!j.loginKept) parts.push('login LOST');", "if (false) parts.push('login LOST');"],
  ['(b) never fires on a lost cookie', 'if (l.lost) { b.fired = true;', 'if (false) { b.fired = true;'],
  ['H2 ignores a hang', 'if (x.crashed || x.hung) { h2.fired = true;', 'if (x.crashed) { h2.fired = true;'],
  ['H2 ignores a lost plaintext cookie in a plaintext-only locked / absent / basic start', 'if (l.lost) { h2.fired = true; h2.why.push(`${st.scope}/${st.keyring} run', 'if (false) { h2.fired = true; h2.why.push(`${st.scope}/${st.keyring} run'],
  ['H2 ignores a lost pre-existing cookie after sealed rows met a keyring-less / basic_text / locked start', 'if (l?.lost) { h2.fired = true;', 'if (false) { h2.fired = true;'],
  ['H3 counts the documented fuse-OFF step D1', "x.step !== 'D1' && !DIAGNOSTIC", "!DIAGNOSTIC"],
  ['H3 forgets a lost login', 'if (j.oldReadable < j.oldExpected || !j.loginKept) { H3.fired = true;', 'if (j.oldReadable < j.oldExpected) { H3.fired = true;'],
  ['H4 never fires', "const H4: Finding = { fired: !(meta && meta.fuseWire.off === 'disabled' && meta.fuseWire.on === 'enabled'), why: [] };", 'const H4: Finding = { fired: false, why: [] };'],
  ['cost is a plain GO', "verdict = 'GO-WITH-COST'; reasons.push(...cost.why);", "verdict = 'GO'; reasons.push(...cost.why);"],
  ['permanent loss is not a NO-GO', 'a.fired || b.fired || c.fired || d.fired || cost.permanentLoss', 'a.fired || b.fired || c.fired || d.fired'],
  ['unrecovered cookies are not permanent', 'if (unreadable && !recovered) { cost.permanentLoss = true;', 'if (false) { cost.permanentLoss = true;'],
  ['the scope filter keeps recognised-desktop boots', "r.kind === 'boot' ? r.scope !== 'host' :", "r.kind === 'boot' ? false :"],
  ['backend mismatch is not a control failure', 'b.backend !== b.backendExpected && !b.crashed && !b.hung', 'false'],
  ['keyring-state mismatch is not a control failure', 'if (!b.keyringOk) missing.push', 'if (false) missing.push'],
  ['a red control record is ignored', 'for (const c of controlRecs) if (!c.ok) missing.push', 'for (const c of controlRecs) if (false) missing.push'],
  ['null control uses no timing boots', 'b.run === run && b.timing && b.build === build', 'b.run === run && !b.timing && b.build === build'],
  ['stall is judged on the minimum, not the median', "(median(timed.map((x) => x.readyMs)) as number) - base", "Math.min(...timed.map((x) => x.readyMs)) - base"],
  ['stall baseline taken from the fuse-ON boots', "x.build === 'off' && x.keyring === keyring && x.scope === scope", "x.build === 'on' && x.keyring === keyring && x.scope === scope"],
  ['restore control A2 never fails', "else if (j.oldReadable !== j.oldExpected || j.newReadable !== j.newExpected || !j.loginKept) missing.push(`restore control", "else if (false) missing.push(`restore control"],
  ['the keyring-less and basic_text pairs are not judged', ", ['C2N', 'C2NU', 'keyring-less', false], ['C2B', 'C2BU', 'basic_text', false]];", "];"],
  ['H3 counts the diagnostic X arm', '!DIAGNOSTIC_BRANCHES.has(x.branch) && ', ''],
  ['squash keeps every run as its own line', "const key = m ? l.replace(/\\brun \\d+\\b/, 'run *') : l;", "const key = l;"],
  ['aborted attempts still count as data', "run === undefined || !abortedIds.has(run) ||", "true ||"],
  ['the DB rows left after a boot are not looked at', "if (d && d.old.total < j.oldExpected) parts.push(", "if (false) parts.push("],
  ['the post-write jar is not looked at', "if (post && post.oldReadable < post.oldExpected) parts.push(", "if (false) parts.push("],
  ['the known-stall control is optional', "'instrument/reads-a-known-stall', 'oracle/reads-a-synthetic-sealed-row-as-sealed'];", "];"],
  ['an aborted attempt contributes no crash / hang evidence', "(r.kind === 'boot' && r.build === 'on' && (r.crashed || r.hung))", "false"],
  ['recovery after unlock is not required for the keyring-less pair', "if (!j2) { missing.push(`cost arm ${first} run", "if (false) { missing.push(`cost arm ${first} run"],
  ['byte-diff control accepts any difference', 'meta.fuseWire.byteDiff !== 1', 'false'],
];

let survived = 0;
let aborted = null;
const out = [];
// `process.exit` inside the try would skip the finally and strand the backup / a mutated file: abort by throwing, exit after the restore
class Abort extends Error {}
try {
  const base = spawnSync(process.execPath, ['--test', '--experimental-strip-types', test], { cwd: root, encoding: 'utf8' });
  if (base.status !== 0) throw new Abort('ABORT: the unmutated tests are not green');
  console.log(`baseline: unmutated tests green (${/# pass (\d+)/.exec(base.stdout)?.[1]} pass)`);
  for (const [name, find, repl] of MUTANTS) {
    const src = pristine.toString('utf8');
    const n = src.split(find).length - 1;
    if (n !== 1) throw new Abort(`ABORT: mutant "${name}": the target string occurs ${n}× (want exactly 1) — the mutant would not be live`);
    fs.writeFileSync(target, src.replace(find, () => repl));
    const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', test], { cwd: root, encoding: 'utf8' });
    const failedTests = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0;
    restore();
    const same = Buffer.compare(fs.readFileSync(target), pristine) === 0 && spawnSync('cmp', ['-s', target, backup]).status === 0;
    if (!same) throw new Abort('ABORT: restore is not byte-exact');
    if (!killed) survived++;
    out.push({ name, killed, by: failedTests.slice(0, 2) });
    console.log(`  ${killed ? 'KILLED  ' : 'SURVIVED'} ${name}${killed ? `  ← ${failedTests[0]?.slice(0, 80) ?? 'a crash'}` : ''}`);
  }
} catch (e) { if (e instanceof Abort) aborted = e.message; else throw e; } finally { restore(); fs.rmSync(backup, { force: true }); }
if (aborted) { console.log(aborted); process.exit(2); }
const cmpOk = Buffer.compare(fs.readFileSync(target), pristine) === 0;
console.log(`\n${MUTANTS.length - survived}/${MUTANTS.length} killed; ${survived} survived; file restored byte-exact: ${cmpOk}`);
process.exit(survived === 0 && cmpOk ? 0 : 1);

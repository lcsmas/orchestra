// In-place mutants on MY detached worktree of the candidate (never the candidate branch). Byte-exact backup + cmp restore.
const fs = require('node:fs');
const cp = require('node:child_process');
const W = '/home/lmas/.orchestra/worktrees/a8rev-cand';
const F = W + '/src/main/account-inherit.ts';
const BAK = '/tmp/a8rev-mut-orig.ts';
fs.copyFileSync(F, BAK);
const orig = fs.readFileSync(F, 'utf8');
const T = 'src/main/account-inherit.test.ts';
function runTests() {
  const r = cp.spawnSync('node', ['--test', '--experimental-strip-types', T], { cwd: W, encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const g = (k) => (out.match(new RegExp('^# ' + k + ' (\\d+)', 'm')) || [])[1];
  const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1].replace(/\\#235 /, ''));
  return { tests: g('tests'), pass: g('pass'), fail: g('fail'), skipped: g('skipped'), failed };
}
const mutants = [
  ['MG isReadableDir rejects a SYMLINK source (dotfiles-style ~/.claude -> dir)', 'fs.readdirSync(p);\n    return true;', 'if (fs.lstatSync(p).isSymbolicLink()) return false;\n    fs.readdirSync(p);\n    return true;'],
];
let restored = 0; const rows = [];
const clean0 = runTests(); console.log('CLEAN control:', JSON.stringify({ ...clean0, failed: clean0.failed.length }));
if (clean0.fail !== '0' || clean0.pass !== '23') { console.log('ABORT: clean control not 23/0'); process.exit(3); }
for (const [name, from, to] of mutants) {
  const n = orig.split(from).length - 1;
  if (n !== 1) { console.log(`SKIP ${name}: pattern found ${n}x`); continue; }
  fs.writeFileSync(F, orig.replace(from, to));
  const res = runTests();
  fs.copyFileSync(BAK, F);
  const same = fs.readFileSync(F).equals(fs.readFileSync(BAK));
  if (same) restored++;
  rows.push(name);
  console.log(`MUTANT ${name}: tests=${res.tests} pass=${res.pass} fail=${res.fail} skipped=${res.skipped} | red arms: ${JSON.stringify(res.failed)} | restored-cmp=${same}`);
}
console.log(`DONE mutants-run=${rows.length} restored-clean=${restored}`);

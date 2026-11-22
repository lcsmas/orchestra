#!/usr/bin/env node
// #479 rig — `orchestra fanout open` + `deliver` through the BUILT CLI (dist-electron/cli.js) against a scratch BARE repo and a fake `gh`
// (a script on PATH that reads branch tips from the bare repo and keeps PRs / CI in a json file; like GitHub it refuses a merge whose
// --match-head-commit != the branch tip). Light: no Electron, no network, no real tokens, scratch dirs under $TMPDIR only.
//   node scripts/e2e-fanout-open.mjs            baseline: every arm must PASS
//   node scripts/e2e-fanout-open.mjs --mutants  each patched copy of the BUILT bundle must be KILLED (≥1 arm FAILs); baseline run first as the control
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const H = (c) => c.repeat(40);

const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
const S = process.env.FAKE_GH_STATE, BARE = process.env.FAKE_GH_BARE;
const st = JSON.parse(fs.readFileSync(S, 'utf8')); const save = () => fs.writeFileSync(S, JSON.stringify(st));
const git = (...a) => spawnSync('git', ['--git-dir', BARE, ...a], { encoding: 'utf8' });
const tip = (b) => { const r = git('rev-parse', '--verify', 'refs/heads/' + b); return r.status === 0 ? r.stdout.trim() : ''; };
let args = process.argv.slice(2); st.log.push(args.join(' '));
const ri = args.indexOf('--repo'); if (ri >= 0) args.splice(ri, 2);
const val = (f) => args[args.indexOf(f) + 1];
const out = (o) => { save(); process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o)); process.exit(0); };
const fail = (m) => { save(); process.stderr.write(m + '\\n'); process.exit(1); };
const [a, b] = args;
const headOf = (p) => (p.state === 'OPEN' ? tip(p.headRefName) : p.head);
if (a === 'pr' && b === 'list') {
  const base = args.includes('--base') ? val('--base') : null, head = val('--head');
  out(st.prs.filter((p) => p.headRefName === head && (!base || p.base === base)).map((p) => ({ number: p.number, url: p.url, state: p.state, baseRefName: p.base, headRefOid: headOf(p) })));
}
if (a === 'pr' && b === 'create') {
  const n = 100 + st.prs.length;
  st.prs.push({ number: n, url: 'https://github.com/o/r/pull/' + n, state: 'OPEN', base: val('--base'), headRefName: val('--head'), head: '' });
  out('https://github.com/o/r/pull/' + n + '\\n');
}
if (a === 'pr' && b === 'view') {
  const p = st.prs.find((x) => String(x.number) === args[2]); if (!p) fail('not found');
  const head = headOf(p); const green = st.ciGreen.includes(head);
  out({ state: p.state, baseRefName: p.base, headRefOid: head, mergeable: 'MERGEABLE', mergeCommit: { oid: head },
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: green ? 'COMPLETED' : 'IN_PROGRESS', conclusion: green ? 'SUCCESS' : '', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/901' }] });
}
if (a === 'run' && b === 'view') out({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }, { name: 'Complete job', conclusion: 'success' }] }] });
if (a === 'pr' && b === 'merge') {
  const p = st.prs.find((x) => String(x.number) === args[2]);
  const want = args.includes('--match-head-commit') ? val('--match-head-commit') : null;
  const held = tip(p.headRefName);
  if (want !== null && want !== held) fail('Pull request is not mergeable: the head branch was modified. Review and try the merge again.');
  const r = git('update-ref', 'refs/heads/' + p.base, held); if (r.status !== 0) fail('update-ref: ' + r.stderr);
  p.state = 'MERGED'; p.head = held; out('');
}
fail('unexpected gh call: ' + args.join(' '));
`;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

/** One scratch world: bare origin, a work clone, the fake gh. */
function world(cliPath) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'fanout-open-rig-'));
  if (!path.resolve(dir).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
  const bare = path.join(dir, 'origin.git'), work = path.join(dir, 'work'), bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  for (const d of [bin, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const state = path.join(dir, 'gh-state.json');
  fs.writeFileSync(state, JSON.stringify({ prs: [], ciGreen: [], log: [] }));
  const gitEnv = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@x', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@x', HOME: home, PATH: process.env.PATH };
  const g = (args, cwd = work) => sh('git', args, { cwd, env: gitEnv }).stdout.trim();
  sh('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: gitEnv });
  sh('git', ['clone', '-q', bare, work], { env: gitEnv });
  g(['checkout', '-q', '-b', 'master']);
  fs.writeFileSync(path.join(work, 'f.txt'), 'base\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']); g(['push', '-q', 'origin', 'master']);
  const commitOn = (branch, text) => {
    if (g(['branch', '--list', branch]) === '') g(['checkout', '-q', '-b', branch, 'master']); else g(['checkout', '-q', branch]);
    fs.writeFileSync(path.join(work, `${branch}.txt`), text); g(['add', '.']); g(['commit', '-q', '-m', text]); g(['push', '-q', 'origin', branch]);
    return g(['rev-parse', 'HEAD']);
  };
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_GH_STATE: state, FAKE_GH_BARE: bare };
  const cli = (args, timeoutMs = 60_000) => {
    const r = spawnSync(process.execPath, [cliPath, 'fanout', ...args], { encoding: 'utf8', env, timeout: timeoutMs, cwd: work });
    let json = null; try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* usage error */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const ghState = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  const setCi = (head) => { const s = ghState(); s.ciGreen.push(head); fs.writeFileSync(state, JSON.stringify(s)); };
  const masterTip = () => sh('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/master']).stdout.trim();
  const count = (verb) => ghState().log.filter((l) => l.startsWith(verb)).length;
  return { dir, cli, commitOn, ghState, setCi, masterTip, count, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Every arm; returns [{name, ok, detail}]. `cliPath` is the bundle under test (baseline or a mutant). */
function scenarios(cliPath) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const DEL = (b, head) => ['deliver', '--branch', b, '--into', 'master', '--ticket', 'T-1', '--no-review-gate', '--verified-head', head, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1'];
  const OPEN = (b) => ['open', '--branch', b, '--into', 'master', '--ticket', 'T-1'];

  // A. open at nomination; idempotent; the flag form is the same path; never merges.
  const A = world(cliPath);
  try {
    const base = A.masterTip();
    const h1 = A.commitOn('impl-a', 'one');
    const o1 = A.cli(OPEN('impl-a'));
    arm('A1 open creates ONE PR: exit 0, opened, reused:false, head = branch tip', o1.code === 0 && o1.json?.verdict === 'opened' && o1.json.reused === false && o1.json.head === h1 && o1.json.pr === 100, o1.stdout + o1.stderr);
    const o2 = A.cli(OPEN('impl-a'));
    arm('A2 open again REUSES it (reused:true, same pr/url), no second create', o2.code === 0 && o2.json?.reused === true && o2.json.pr === o1.json?.pr && o2.json.url === o1.json?.url && A.count('pr create') === 1, JSON.stringify(o2.json));
    const o3 = A.cli(['deliver', '--open-only', '--branch', 'impl-a', '--into', 'master', '--ticket', 'T-1']);
    arm('A3 `deliver --open-only` is the same path (reused:true, same pr)', o3.code === 0 && o3.json?.reused === true && o3.json.pr === o1.json?.pr, o3.stdout + o3.stderr);
    arm('A4 open never merges: no `pr merge` call, target tip unchanged', A.count('pr merge') === 0 && A.masterTip() === base, `merges=${A.count('pr merge')}`);
    const bad = A.cli(['open', '--branch', 'impl-a']);
    arm('A5 usage error is exit 1, no JSON', bad.code === 1 && bad.json === null, `code=${bad.code}`);
  } finally { A.cleanup(); }

  // B. open, then the head moves after the gate: deliver at the OLD verified head refuses head-moved; at the NEW head it waits for CI on that head, then merges there.
  const B = world(cliPath);
  try {
    const base = B.masterTip();
    const h1 = B.commitOn('impl-b', 'one');
    B.cli(OPEN('impl-b'));
    B.setCi(h1); // CI ran green on the nominated head while the verifier gated
    const h2 = B.commitOn('impl-b', 'two'); // pushed AFTER the gate; CI not green on it
    const d1 = B.cli(DEL('impl-b', h1));
    arm('B1 head pushed after open: deliver at the verified head refuses head-moved (exit 2), master unchanged', d1.code === 2 && d1.json?.reason === 'head-moved' && B.masterTip() === base, d1.stdout + d1.stderr);
    const d2 = B.cli(DEL('impl-b', h2));
    arm('B2 re-verified at the NEW head with CI not green on it: deliver does NOT merge (exit 1 timeout), master unchanged', d2.code === 1 && d2.json?.reason === 'timeout' && B.masterTip() === base && B.count('pr merge') === 0, d2.stdout + d2.stderr);
    B.setCi(h2);
    const d3 = B.cli(DEL('impl-b', h2));
    arm('B3 CI green on the new head: deliver merges AT it (exit 0), master = new head, merge bound to it', d3.code === 0 && d3.json?.verdict === 'merged' && B.masterTip() === h2 && B.ghState().log.some((l) => l.startsWith('pr merge') && l.includes(`--match-head-commit ${h2}`)), d3.stdout + d3.stderr);
    arm('B4 deliver reused the opened PR: exactly one `pr create` in the whole story', B.count('pr create') === 1, `creates=${B.count('pr create')}`);
  } finally { B.cleanup(); }

  // C. unmodified head: open at nomination, CI green on it, deliver merges.
  const C = world(cliPath);
  try {
    const h1 = C.commitOn('impl-c', 'one');
    const o = C.cli(OPEN('impl-c'));
    C.setCi(h1);
    const d = C.cli(DEL('impl-c', h1));
    arm('C1 unmodified head: open then deliver merges at it (exit 0), same PR, master = head', d.code === 0 && d.json?.verdict === 'merged' && d.json.pr === o.json?.pr && C.masterTip() === h1, d.stdout + d.stderr);
  } finally { C.cleanup(); }

  // D. MUST-FAIL core: CI never green on the head ⇒ deliver must not merge (a mutant that merges without CI on the head reddens D1).
  const D = world(cliPath);
  try {
    const base = D.masterTip();
    const h1 = D.commitOn('impl-d', 'one');
    D.cli(OPEN('impl-d'));
    const d = D.cli(DEL('impl-d', h1)); // CI pending on h1
    arm('D1 CI not green on the head: deliver does NOT merge (exit 1 timeout), master unchanged', d.code === 1 && d.json?.reason === 'timeout' && D.masterTip() === base && D.count('pr merge') === 0, d.stdout + d.stderr);
  } finally { D.cleanup(); }

  return res;
}

function report(title, res) {
  console.log(`\n== ${title}`);
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
  const bad = res.filter((r) => !r.ok).length;
  console.log(`-- ${res.length - bad}/${res.length} PASS`);
  return bad;
}

const mutants = [
  { name: 'deliver merges without CI on the head (decideDelivery returns merge right after the conflict check)', find: '  if (pr.mergeable === "CONFLICTING") return { action: "refuse", reason: "merge-conflict", detail: "the PR conflicts with its base" };\n', put: (m) => `${m}  return { action: "merge", head: pr.headRefOid };\n` },
  { name: 'open is not idempotent (never reuses the open PR)', find: 'const mine = open2.find((p) => p.baseRefName === opts.into);', put: () => 'const mine = void 0;' },
  { name: 'open also merges (calls `gh pr merge` after creating the PR)', find: 'deps.log(`opened PR #${num2} ${url}`);\n    const view', put: (m) => `await deps.gh(["pr", "merge", String(num2), "--merge"]);\n    ${m}` },
  { name: 'deliver merges the moved head unbound (no head-moved check AND no --match-head-commit)', find: '  if (pr.headRefOid !== i.verifiedHead && !i.headSameTree) {\n    return { action: "refuse", reason: "head-moved", detail: `PR head is', put: (m) => m.replace('if (pr.headRefOid !== i.verifiedHead && !i.headSameTree)', 'if (false)'), extra: [{ find: 'await gh(["pr", "merge", prId, `--${opts.strategy}`, "--match-head-commit", d.head])', put: () => 'await gh(["pr", "merge", prId, `--${opts.strategy}`])' }] },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!orig.includes('fanout-open') && !orig.includes('runOpenRoute')) { console.error('dist-electron/cli.js has no `fanout open` — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

const baselineBad = report('baseline (built bundle)', scenarios(CLI));
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-open-mut-'));
for (const [i, m] of mutants.entries()) {
  let src = orig;
  for (const step of [m, ...(m.extra ?? [])]) {
    const n = src.split(step.find).length - 1;
    if (n !== 1) { console.error(`MUTANT ${i} "${m.name}": anchor found ${n}× (needs exactly 1) — the bundle shape changed, fix the rig`); process.exit(1); }
    src = src.replace(step.find, () => step.put(step.find));
  }
  const file = path.join(scratch, `mutant-${i}.js`);
  fs.writeFileSync(file, src);
  if (src === orig) { console.error(`MUTANT ${i} did not change the bundle`); process.exit(1); }
  const bad = report(`MUTANT ${i}: ${m.name}`, scenarios(file));
  console.log(bad > 0 ? `   → KILLED (${bad} arm(s) red)` : '   → SURVIVED (no arm noticed it)');
  if (bad === 0) survived++;
}
fs.rmSync(scratch, { recursive: true, force: true });
if (fs.readFileSync(CLI, 'utf8') !== orig) { console.error('the real bundle changed during the run'); process.exit(1); }
console.log(`\n${mutants.length - survived}/${mutants.length} mutants killed; real bundle byte-identical`);
process.exit(survived ? 1 : 0);

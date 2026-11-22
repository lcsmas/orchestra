#!/usr/bin/env node
// #542 rig — `jest --config <tracked repo file> <frozen files>` through the BUILT CLI (dist-electron/cli.js) against a scratch BARE repo, a fake `jest` and a fake `gh` (a script on PATH
// reading bytes / branch tips from the bare repo). Light: no Electron, no network, no tokens, scratch under $TMPDIR.
//   node scripts/e2e-fanout-jest-config.mjs            baseline: every arm must PASS (must-PASS + must-FAIL per clause)
//   node scripts/e2e-fanout-jest-config.mjs --mutants  each patched copy of the BUILT bundle must be KILLED (≥1 arm FAILs); the baseline is the control
// Sibling of e2e-fanout-acceptance-mutants.mjs (#510): same world shape, its own arms; the fake gh below is copied from it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const CFG = 'packages/api-v2/jest.e2e.config.ts';
const TEST = 'packages/api-v2/test/a.e2e.test.js';
const RUN = `jest --config ${CFG} ${TEST}`;
const SPEC = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { f } = require('../src.js');\ntest('f is what the spec says', () => { assert.equal(f(), 1); });\n";
const CFG_BYTES = 'export default { testRegex: ".e2e.test.js$" };\n';

// a fake jest: records how it was called (marker beside the checkout), refuses a missing config, FAILs on a config that says so, then runs the frozen files with node --test
const FAKE_JEST = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const a = process.argv.slice(2); let cfg = null; const files = [];
for (let i = 0; i < a.length; i++) { if (a[i] === '--config') cfg = a[++i]; else if (a[i].startsWith('--config=')) cfg = a[i].slice(9); else if (!a[i].startsWith('-')) files.push(a[i]); }
fs.writeFileSync(path.join(process.cwd(), '..', 'jest-called.json'), JSON.stringify({ cwd: process.cwd(), argv: a, cfg }));
if (!cfg || !fs.existsSync(cfg)) process.exit(3);
if (/FAILALL/.test(fs.readFileSync(cfg, 'utf8'))) process.exit(1);
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
process.exit(cp.spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env }).status ?? 1);
`;

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
if (a === 'api') {
  const url = args[args.length - 1];
  let m = /^repos\\/o\\/r\\/issues\\/comments\\/(\\d+)$/i.exec(url);
  if (m) { const id = String(Number(m[1])); if (st.comments[id] === undefined) fail('gh: Not Found (HTTP 404)'); out({ body: st.comments[id] }); }
  m = /\\/contents\\/(.+)\\?ref=([0-9a-f]{40})$/.exec(url);
  if (/\\/commits\\/[0-9a-f]{40}$/.test(url)) out({});
  if (m) { const r = git('show', m[2] + ':' + decodeURIComponent(m[1])); if (r.status !== 0) fail('gh: Not Found (HTTP 404)'); out(r.stdout); }
  fail('gh: Not Found (HTTP 404)');
}
if (a === 'pr' && b === 'list') {
  const base = args.includes('--base') ? val('--base') : null, head = val('--head');
  const states = val('--state');
  out(st.prs.filter((p) => p.headRefName === head && (!base || p.base === base) && (states === 'all' || p.state.toLowerCase() === states)).map((p) => ({ number: p.number, url: p.url, state: p.state, baseRefName: p.base, headRefOid: headOf(p) })));
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
  p.state = 'MERGED'; p.head = held; out('');
}
fail('unexpected gh call: ' + args.join(' '));
`;


function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

/** One scratch world: bare origin (master with the tracked config, a symlink config, a symlinked dir), the writer's clone (+ an UNTRACKED config), the candidate checkout, fake jest + gh. */
function world(cliPath) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'fanout-jestcfg-rig-'));
  if (!path.resolve(dir).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
  const bare = path.join(dir, 'origin.git'), work = path.join(dir, 'work'), cand = path.join(dir, 'cand'), bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  for (const d of [bin, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'jest'), FAKE_JEST, { mode: 0o755 });
  const state = path.join(dir, 'gh-state.json');
  fs.writeFileSync(state, JSON.stringify({ prs: [], ciGreen: [], log: [], comments: { 900: 'Decision (ledger): the e2e config now bails early.', 901: 'Decision 2 (ledger): the e2e run needs no config any more.' } }));
  const gitEnv = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@x', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: home, PATH: process.env.PATH };
  const gIn = (cwd) => (args) => sh('git', args, { cwd, env: gitEnv }).stdout.trim();
  const gw = gIn(work), gc = gIn(cand);
  sh('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: gitEnv });
  sh('git', ['clone', '-q', bare, work], { env: gitEnv });
  gw(['checkout', '-q', '-b', 'master']);
  fs.mkdirSync(path.join(work, 'packages/api-v2/test'), { recursive: true });
  fs.writeFileSync(path.join(work, 'packages/api-v2/src.js'), 'exports.f = () => 0;\n');
  fs.writeFileSync(path.join(work, CFG), CFG_BYTES);
  fs.mkdirSync(path.join(work, 'cfgdir')); fs.writeFileSync(path.join(work, 'cfgdir/real.config.ts'), 'export default {};\n');
  fs.symlinkSync('real.config.ts', path.join(work, 'cfgdir/link.config.ts')); fs.symlinkSync('cfgdir', path.join(work, 'linkdir'));
  gw(['add', '.']); gw(['commit', '-q', '-m', 'base']); gw(['push', '-q', 'origin', 'master']);
  gw(['checkout', '-q', '-b', 'writer-542']);
  fs.writeFileSync(path.join(work, TEST), SPEC);
  fs.writeFileSync(path.join(work, 'packages/api-v2/writer-only.config.ts'), 'export default {};\n');
  gw(['add', '.']); gw(['commit', '-q', '-m', 'writer: acceptance tests + a config only on its branch']); gw(['push', '-q', 'origin', 'writer-542']); gw(['checkout', '-q', 'master']);
  fs.writeFileSync(path.join(work, 'packages/api-v2/untracked.config.ts'), 'export default {};\n'); // never committed
  sh('git', ['clone', '-q', bare, cand], { env: gitEnv });
  gc(['checkout', '-q', '-b', 'good', 'origin/master']);
  gc(['checkout', 'origin/writer-542', '--', TEST]);
  fs.writeFileSync(path.join(cand, 'packages/api-v2/src.js'), 'exports.f = () => 1;\n');
  gc(['add', '.']); gc(['commit', '-q', '-m', 'impl + tests copied unchanged']); gc(['push', '-q', 'origin', 'good']); gw(['fetch', '-q', 'origin']);
  const good = gc(['rev-parse', 'HEAD']);
  /** A branch off `good` with one more commit (the arm's change), pushed to origin; the checkout stays ON it. */
  const variant = (name, change) => {
    gc(['checkout', '-q', '-B', name, good]);
    change(cand, gc);
    gc(['add', '-A']); gc(['commit', '-q', '--allow-empty', '-m', name]); gc(['push', '-q', '-f', 'origin', name]);
    return { branch: name, head: gc(['rev-parse', 'HEAD']) };
  };
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'rig', FAKE_GH_STATE: state, FAKE_GH_BARE: bare, GIT_CONFIG_GLOBAL: '/dev/null' };
  // `env` PATH has no node dir: the fake scripts use an absolute shebang; the CLI is run with process.execPath
  const cli = (args, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [cliPath, 'fanout', ...args], { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 90_000, cwd: work });
    let json = null; try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not a JSON verb */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const statePath = path.join(home, 'fanout', 'rig', 'state.json');
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const ghState = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  const patchGh = (fn) => { const s = ghState(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  cli(['state', 'init', '--run', 'rig', '--repo', 'o/r']);
  const freeze = (run = RUN, extra = []) => cli(['acceptance', 'freeze', 'T-1', '--run', 'rig', '--files', TEST, '--run-cmd', run, '--from', 'origin/writer-542', ...extra]);
  const acc = () => readState().tickets['T-1']?.acceptance ?? null;
  const gate = (v) => { fs.rmSync(path.join(dir, 'jest-called.json'), { force: true }); return cli(['gate', '--branch', v.branch, '--into', 'master', '--head', v.head, '--ticket', 'T-1', '--run', 'rig', '--cwd', cand]); };
  const called = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'jest-called.json'), 'utf8')); } catch { return null; } };
  const deliver = (v, extra = []) => cli(['deliver', '--branch', v.branch, '--into', 'master', '--ticket', 'T-1', '--run', 'rig', '--no-review-gate', '--verified-head', v.head, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1', ...extra]);
  const receiptFile = (name, r) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(r)); return f; };
  const count = (verb) => ghState().log.filter((l) => l.startsWith(verb)).length;
  const amend = (decision, sentence, extra) => cli(['acceptance', 'amend', 'T-1', '--run', 'rig', '--decision', `https://github.com/o/r/issues/542#issuecomment-${decision}`, '--spec-sentence', sentence, '--files', TEST, ...extra]);
  return { dir, work, cand, gw, gc, variant, good, cli, freeze, acc, gate, called, deliver, receiptFile, readState, patchGh, count, amend, setCi: (h) => patchGh((s) => s.ciGreen.push(h)), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Every arm; returns [{name, ok, detail}]. `cliPath` is the bundle under test (baseline or a mutant). */
function scenarios(cliPath) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const J = (r) => `${r.code} ${r.stdout}${r.stderr}`.slice(0, 600);

  // ── freeze: the parser + tracked-ness clauses ───────────────────────────────────────────────────────
  const F = world(cliPath);
  try {
    const refuse = (id, what, run, code, re) => {
      const r = F.freeze(run);
      arm(`${id} must-FAIL ${what}: exit ${code}, nothing frozen`, r.code === code && re.test(r.stderr) && F.acc() === null, J(r));
    };
    refuse('P1', 'an UNTRACKED config', `jest --config packages/api-v2/untracked.config.ts ${TEST}`, 2, /not a file tracked/);
    refuse('P2', 'a config tracked only on the writer\'s branch (not at the target tip)', `jest --config packages/api-v2/writer-only.config.ts ${TEST}`, 2, /not a file tracked/);
    refuse('P3', 'a config that does not exist', `jest --config packages/api-v2/nope.config.ts ${TEST}`, 2, /not a file tracked/);
    refuse('P4', 'a tracked SYMLINK as the config', `jest --config cfgdir/link.config.ts ${TEST}`, 2, /not a regular file/);
    refuse('P5', 'a config behind a symlinked DIRECTORY (symlink escape)', `jest --config linkdir/real.config.ts ${TEST}`, 2, /not a file tracked/);
    refuse('P6', 'an ABSOLUTE config path', `jest --config /etc/hostname ${TEST}`, 1, /unsafe acceptance path/);
    refuse('P7', 'a `..` config path', `jest --config ../outside.config.js ${TEST}`, 1, /unsafe acceptance path/);
    refuse('P7b', 'a `--config=` value with `..` inside', `jest --config=packages/../../x.js ${TEST}`, 1, /unsafe acceptance path/);
    refuse('P8', 'a NON-frozen test path next to --config', `jest --config ${CFG} packages/api-v2/test/other.e2e.test.js ${TEST}`, 1, /not a frozen file/);
    refuse('P9', 'a shell metacharacter', `jest --config ${CFG};id ${TEST}`, 1, /shell metacharacters/);
    refuse('P10', 'a SECOND --config', `jest --config ${CFG} --config=${CFG} ${TEST}`, 1, /given twice/);
    refuse('P11', '--config with NO value', `jest ${TEST} --config`, 1, /needs a value/);
    refuse('P12', 'another unlisted jest flag', `jest --config ${CFG} --setupFiles=./x.js ${TEST}`, 1, /inert-flag allowlist/);
    refuse('P13', '`-c <path>` (the short spelling is not allowlisted)', `jest -c ${CFG} ${TEST}`, 1, /inert-flag allowlist/);
    refuse('P15', 'the --config file ALSO named as a frozen test', `jest --config ${TEST} ${TEST}`, 1, /also a frozen test/);
        refuse('P14', '--config on another runner', `node --config ${CFG} ${TEST}`, 1, /inert-flag allowlist/);

    const f = F.freeze();
    const a = F.acc();
    const want = createHash('sha256').update(CFG_BYTES).digest('hex');
    arm('P0 must-PASS `jest --config <tracked file> <frozen file>` freezes, records {path, sha256 of the target-tip bytes}, the hash covers it', f.code === 0 && a?.run === RUN && a.config?.path === CFG && a.config.sha256 === want && /runner config/.test(f.stdout), J(f));
  } finally { F.cleanup(); }

  const E = world(cliPath);
  try {
    const f = E.freeze(`jest --config=${CFG} ${TEST}`);
    arm('P0b must-PASS the `--config=<path>` spelling freezes the same', f.code === 0 && E.acc()?.config?.path === CFG, J(f));
  } finally { E.cleanup(); }

  // ── gate + deliver + amend: the config bytes residue ─────────────────────────────────────────────────
  const W = world(cliPath);
  try {
    const fr = W.freeze();
    arm('W0 must-PASS the world freezes `jest --config` (precondition of every gate / deliver / amend arm)', fr.code === 0 && W.acc()?.config?.path === CFG, J(fr));
    if (fr.code !== 0) return res; // a mutant that cannot freeze is killed by W0 / P0
    const hash0 = W.acc().hash;
    const ok = W.variant('g-ok', () => {});
    const g1 = W.gate(ok);
    const c1 = W.called();
    arm('G1 must-PASS an untouched config: exit 0, acceptance.ok, config same, jest ran as frozen (`--config <path>` + the file, cwd = the checkout)',
      g1.code === 0 && g1.json?.acceptance?.ok === true && g1.json.acceptance.config?.status === 'same' && g1.json.acceptance.receipt?.hash === hash0 && c1?.cfg === CFG && c1.argv.join(' ') === RUN.split(' ').slice(1).join(' ') && c1.cwd === fs.realpathSync(W.cand), J(g1));

    const edited = W.variant('g-cfg-edit', (c) => fs.appendFileSync(path.join(c, CFG), '// benign-looking edit\n'));
    const g2 = W.gate(edited);
    arm('G2 must-FAIL a candidate that EDITS the config (benign-looking): exit 2, frozen-config-changed, config changed, receipt.ok false, jest NEVER run',
      g2.code === 2 && g2.json?.reason === 'frozen-config-changed' && g2.json.acceptance?.config?.status === 'changed' && g2.json.acceptance.receipt?.ok === false && W.called() === null, J(g2));
    const weak = W.variant('g-cfg-weak', (c) => fs.writeFileSync(path.join(c, CFG), 'export default { testRegex: "NOTHING" };\n'));
    const g3 = W.gate(weak);
    arm('G3 must-FAIL a candidate that rewrites the config to match nothing: exit 2, frozen-config-changed (the run is never reached)', g3.code === 2 && g3.json?.reason === 'frozen-config-changed' && W.called() === null, J(g3));
    const gone = W.variant('g-cfg-gone', (c) => fs.rmSync(path.join(c, CFG)));
    const g4 = W.gate(gone);
    arm('G4 must-FAIL a candidate that DELETES the config: exit 2, frozen-config-changed, status missing', g4.code === 2 && g4.json?.reason === 'frozen-config-changed' && g4.json.acceptance?.config?.status === 'missing', J(g4));
    const link = W.variant('g-cfg-link', (c) => { fs.writeFileSync(path.join(c, 'elsewhere.ts'), CFG_BYTES); fs.rmSync(path.join(c, CFG)); fs.symlinkSync('../../elsewhere.ts', path.join(c, CFG)); });
    const g5 = W.gate(link);
    arm('G5 must-FAIL a candidate that turns the config into a SYMLINK with the same bytes: exit 2, frozen-config-changed, status missing', g5.code === 2 && g5.json?.reason === 'frozen-config-changed' && g5.json.acceptance?.config?.status === 'missing', J(g5));
    const red = W.variant('g-red', (c) => fs.writeFileSync(path.join(c, 'packages/api-v2/src.js'), 'exports.f = () => 2;\n'));
    const g6 = W.gate(red);
    arm('G6 must-FAIL a red frozen test still ends frozen-test-failed (the config clause is additive): exit 2, ran.exit ≠ 0', g6.code === 2 && g6.json?.reason === 'frozen-test-failed' && g6.json.acceptance?.ran?.exit !== 0, J(g6));

    const hide = W.variant('g-cfg-hide', (c, g) => fs.appendFileSync(path.join(c, CFG), '// edited at HEAD\n'));
    W.gc(['update-index', '--assume-unchanged', CFG]); fs.writeFileSync(path.join(W.cand, CFG), CFG_BYTES); // the worktree shows the frozen bytes, `git status` is clean, the committed blob is not
    const g7 = W.gate(hide);
    arm('G7 must-FAIL a config whose WORKTREE bytes are the frozen ones but whose blob AT HEAD is not (assume-unchanged trick): exit 2, frozen-config-changed', g7.code === 2 && g7.json?.reason === 'frozen-config-changed', J(g7));
    W.gc(['update-index', '--no-assume-unchanged', CFG]);
    W.gc(['checkout', '--', CFG]);

    // deliver: a forged-valid receipt cannot hide a config changed at the PR head (the gh byte re-read)
    const dEdit = W.variant('d-cfg-edit', (c) => fs.appendFileSync(path.join(c, CFG), '// drift\n')); W.setCi(dEdit.head);
    const d1 = W.deliver(dEdit, ['--acceptance', W.receiptFile('forged', { head: dEdit.head, hash: hash0, ok: true })]);
    arm('D1 must-FAIL a config changed AT THE HEAD behind a forged-valid receipt: exit 2, frozen-config-changed (the gh re-read), no PR, no merge', d1.code === 2 && d1.json?.reason === 'frozen-config-changed' && W.count('pr create') === 0 && W.count('pr merge') === 0, J(d1));
    const dGone = W.variant('d-cfg-gone', (c) => fs.rmSync(path.join(c, CFG))); W.setCi(dGone.head);
    const d2 = W.deliver(dGone, ['--acceptance', W.receiptFile('forged2', { head: dGone.head, hash: hash0, ok: true })]);
    arm('D2 must-FAIL a config DELETED at the head behind a valid receipt: exit 2, frozen-config-changed', d2.code === 2 && d2.json?.reason === 'frozen-config-changed', J(d2));
    const dOk = W.variant('d-ok', () => {}); W.setCi(dOk.head);
    W.gc(['checkout', '-q', 'd-ok']);
    const real = W.cli(['gate', '--branch', dOk.branch, '--into', 'master', '--head', dOk.head, '--ticket', 'T-1', '--run', 'rig', '--cwd', W.cand]);
    const d3 = W.deliver(dOk, ['--acceptance', W.receiptFile('real', real.json?.acceptance?.receipt ?? {})]);
    arm('D3 must-PASS the gate\'s own receipt, config + tests byte-identical at the head: exit 0, merged, acceptanceChecked, one merge', d3.code === 0 && d3.json?.verdict === 'merged' && d3.json.acceptanceChecked === true && W.count('pr merge') === 1, `${J(real)} ||| ${J(d3)}`);

    // show + hash binding + amend (the legitimate way to move the config)
    const sh1 = W.cli(['acceptance', 'show', 'T-1', '--run', 'rig']);
    arm('S1 must-PASS `acceptance show` prints the recorded config path + bytes hash', sh1.code === 0 && sh1.stdout.includes(`config: ${W.acc().config.sha256.slice(0, 12)}  ${CFG}`), J(sh1));
    W.gw(['checkout', '-q', 'master']); fs.writeFileSync(path.join(W.work, CFG), 'export default { testRegex: ".e2e.test.js$", bail: 1 };\n');
    W.gw(['add', '.']); W.gw(['commit', '-q', '-m', 'target moves the config']); W.gw(['push', '-q', 'origin', 'master']);
    const a1 = W.amend('900', 'the e2e config now bails early', []);
    const acc1 = W.acc();
    arm('A1 must-PASS an amend (ledger decision) re-records the config from the TARGET tip: exit 0, new sha256, hash changed and bound to it', a1.code === 0 && acc1.config.sha256 !== W.readState().tickets['T-1'].acceptance.amendments[0].hashBefore && acc1.hash !== hash0 && acc1.config.path === CFG, J(a1));
    const a2 = W.amend('901', 'the e2e run needs no config any more', ['--run-cmd', `jest --ci ${TEST}`]);
    arm('A2 must-PASS an amend with a config-less command drops the record: exit 0, no `config`, run replaced', a2.code === 0 && W.acc().config === undefined && W.acc().run === `jest --ci ${TEST}`, J(a2));
    const live = fs.readFileSync(path.join(W.dir, 'home/fanout/rig/state.json'), 'utf8');
    const forged = JSON.parse(live);
    forged.tickets['T-1'].acceptance.config = { path: CFG, sha256: 'a'.repeat(64) };
    fs.writeFileSync(path.join(W.dir, 'home/fanout/rig/state.json'), JSON.stringify(forged));
    const s2 = W.cli(['acceptance', 'show', 'T-1', '--run', 'rig']);
    arm('S2 must-FAIL a hand-edited state (a config the command does not name / a hash that no longer matches) is unreadable: exit 1', s2.code === 1 && /acceptance\.hash does not match|names no --config/.test(s2.stderr), J(s2));
    fs.writeFileSync(path.join(W.dir, 'home/fanout/rig/state.json'), live);
    const help = W.cli(['acceptance', '--help']);
    arm('H1 must-PASS `fanout acceptance --help` documents jest --config', help.code === 0 && /jest --config <path>/.test(help.stdout) && /TRACKED/.test(help.stdout) && /frozen-config-changed/.test(help.stdout), J(help));
  } finally { W.cleanup(); }
  return res;
}

function report(title, res) {
  console.log(`\n== ${title}`);
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
  const bad = res.filter((r) => !r.ok).length;
  console.log(`-- ${res.length - bad}/${res.length} PASS`);
  return bad;
}

// NOT mutated (equivalent in verdict): the gate's mode check on the config — `io.readFile` is lstat-isFile, so a symlink reads as null (missing) even without it (arm G5 pins the verdict).
// Each mutant breaks ONE clause in the BUILT bundle; the anchor must occur exactly once. `extra` = a second edit of the same mutant.
const mutants = [
  { name: 'tracked-ness: an untracked / absent config at the target tip is accepted (any path is "tracked")', find: 'if (!mode) throw new Refusal(`the runner config', put: () => 'if (false) throw new Refusal(`the runner config' },
  { name: 'tracked-ness: the config is read from the writer\'s SOURCE head, not the target tip', find: 'for (const c2 of [`origin/${target}`, target]) {', put: () => 'for (const c2 of [`origin/writer-542`]) {' },
  { name: 'symlink: a non-regular config (symlink / dir / submodule) is accepted', find: 'if (!REGULAR_MODES.has(mode)) throw new Refusal(`the runner config', put: () => 'if (false) throw new Refusal(`the runner config' },
  { name: 'path escape: an absolute / `..` config path is accepted (the config path is not validated)', find: 'function assertConfigPath(p) {\n  assertAcceptancePath(p);', put: () => 'function assertConfigPath(p) {\n  return p;' },
  { name: 'path escape: the dot-dot / empty-segment rule of assertAcceptancePath is dropped for config paths', find: 'p.split("/").some((seg) => seg === ".." ||', put: () => 'p.split("/").some((seg) => false ||' },
  { name: 'frozen-only args: a non-frozen path is accepted next to --config', find: 'if (!paths.includes(t)) why(', put: () => 'if (false) why(' },
  { name: 'second --config: accepted (the last one wins)', find: 'if (config !== null) why("--config given twice");', put: () => '' },
  { name: '--config without a value: accepted', find: 'if (v === void 0 || v === "" || v.startsWith("-")) why(', put: () => 'if (false) why(' },
  { name: 'the --config file may also be a frozen test', find: 'if (config !== null && paths.includes(config)) why(', put: () => 'if (false) why(' },
  { name: 'other flags: any jest flag accepted', find: 'if (!runner.flags.some((re) => re.test(t))) why(', put: () => 'if (false) why(' },
  { name: '--config accepted on EVERY runner (node / vitest / mocha …), not jest only', find: 'runner.config && t === "--config"', put: () => 't === "--config"', extra: [{ find: 'runner.config && t.startsWith("--config=")', put: () => 't.startsWith("--config=")' }] },
  { name: 'hash: the config bytes are not part of the frozen hash', find: '(config ? `config\\0${config.path}\\0${config.sha256}\n` : "")', put: () => '""' },
  { name: 'gate: a changed / missing config is not refused (the run proceeds)', find: 'if (facts.config && facts.config.status !== "same") return refuse(', put: () => 'if (false) return refuse(' },
  { name: 'gate: the config is never read in the candidate (always "same")', find: 'status: sha256Hex(bytes) === cfg.sha256 && atHead ? "same" : "changed"', put: () => 'status: "same"' },
  { name: 'gate: only the worktree bytes of the config are compared (the blob at HEAD is not)', find: 'status: sha256Hex(bytes) === cfg.sha256 && atHead ? "same" : "changed"', put: () => 'status: sha256Hex(bytes) === cfg.sha256 ? "same" : "changed"' },
  { name: 'deliver: the config at the PR head is not re-read', find: 'if (acc.config) {', put: () => 'if (false) {' },
  { name: 'deliver: a config that is gone at the head counts as unchanged', find: "status: r.code !== 0 ? \"missing\" : ", put: () => 'status: r.code !== 0 ? "same" : ' },
  { name: 'amend: the config is not re-recorded (the old sha256 is kept via the stale record)', find: '...config ? { config } : {}, now: deps.now() });', put: () => 'now: deps.now() });' },
  { name: 'freeze: the config is not recorded (the command names one, the state does not)', find: 'return freezeInto(cur, ticket, { files: frozen.files, run, ...config ? { config } : {}, source, now: deps.now() });', put: () => 'return freezeInto(cur, ticket, { files: frozen.files, run, source, now: deps.now() });' },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!orig.includes('given twice')) { console.error('dist-electron/cli.js has no #542 clause — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

const baselineBad = report('baseline (built bundle)', scenarios(CLI));
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-jestcfg-mut-'));
for (const [i, m] of mutants.entries()) {
  if (process.env.MUT_ONLY && !process.env.MUT_ONLY.split(',').includes(String(i))) continue;
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

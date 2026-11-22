#!/usr/bin/env node
// #512 rig — a verifier verdict is keyed on the git TREE (candidate + upstream trees), not the commit sha, through the BUILT CLI (dist-electron/cli.js)
// against a scratch bare repo + a fake `gh` (a script on PATH: trees / ancestry / file bytes from the bare repo, PRs + CI in a json file). Light: no Electron, no network, no tokens.
//   node scripts/e2e-fanout-tree-verdict.mjs            baseline: every arm must PASS (a must-PASS and a must-FAIL arm per clause)
//   node scripts/e2e-fanout-tree-verdict.mjs --mutants  each patched copy of the BUILT bundle must be KILLED (≥1 arm FAILs); the baseline is the control
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNFIXED = !!process.env.RIG_UNFIXED_CLI; // the same arms against a bundle built from the tree WITHOUT #512 — they must FAIL there (the control)
const CLI = UNFIXED ? process.env.RIG_UNFIXED_CLI : path.join(ROOT, 'dist-electron', 'cli.js');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const SPEC = ["const test = require('node:test');", "const assert = require('node:assert');", "const { f } = require('../src/impl.js');", "test('f', () => { assert.equal(f(), 1); });", ''].join('\n');

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
  let m = /\\/commits\\/([0-9a-f]{7,40})$/.exec(url);
  if (m) { const t = git('rev-parse', '--verify', m[1] + '^{tree}'); if (t.status !== 0) fail('gh: Not Found (HTTP 404)'); out({ commit: { tree: { sha: t.stdout.trim() } } }); }
  m = /\\/compare\\/([0-9a-f]{7,40})\\.\\.\\.([0-9a-f]{7,40})$/.exec(url);
  if (m) { const x = git('rev-parse', m[1]).stdout.trim(), y = git('rev-parse', m[2]).stdout.trim(); out({ status: x === y ? 'identical' : git('merge-base', '--is-ancestor', x, y).status === 0 ? 'ahead' : 'diverged' }); }
  m = /\\/contents\\/(.+)\\?ref=([0-9a-f]{40})$/.exec(url);
  if (m) { const r = git('show', m[2] + ':' + decodeURIComponent(m[1])); if (r.status !== 0) fail('gh: Not Found (HTTP 404)'); out(r.stdout); }
  fail('gh: Not Found (HTTP 404)');
}
if (a === 'pr' && b === 'list') {
  const base = args.includes('--base') ? val('--base') : null, head = val('--head');
  const states = val('--state');
  out(st.prs.filter((p) => p.headRefName === head && (!base || p.base === base) && (states === 'all' || p.state.toLowerCase() === states)).map((p) => ({ number: p.number, url: p.url, state: p.state, baseRefName: p.base, headRefOid: headOf(p), mergeCommit: { oid: headOf(p) } })));
}
if (a === 'pr' && b === 'create') {
  const n = 100 + st.prs.length;
  st.prs.push({ number: n, url: 'https://github.com/o/r/pull/' + n, state: 'OPEN', base: val('--base'), headRefName: val('--head'), head: '' });
  out('https://github.com/o/r/pull/' + n + '\\n');
}
if (a === 'pr' && b === 'view') {
  const p = st.prs.find((x) => String(x.number) === args[2]); if (!p) fail('not found');
  const head = headOf(p); const green = st.ciGreen.includes(head);
  out({ number: p.number, state: p.state, baseRefName: p.base, headRefOid: head, mergeable: 'MERGEABLE', mergeCommit: { oid: head },
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: green ? 'COMPLETED' : 'IN_PROGRESS', conclusion: green ? 'SUCCESS' : '', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/901' }] });
}
if (a === 'pr' && b === 'diff') out('src/impl.js\\n');
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

/** One scratch world: bare origin, ONE clone (`cand`, the CLI's cwd and the gate's checkout), the fake gh, a state with T-1 (frozen tests) and T-2. */
function world(cliPath) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'fanout-tree-rig-'));
  if (!path.resolve(dir).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
  const bare = path.join(dir, 'origin.git'), cand = path.join(dir, 'cand'), bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  for (const d of [bin, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const ghFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(ghFile, JSON.stringify({ prs: [], ciGreen: [], log: [] }));
  const gitEnv = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@x', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: home, PATH: process.env.PATH };
  const g = (args, extra = {}) => sh('git', args, { cwd: cand, env: { ...gitEnv, ...extra } }).stdout.trim();
  sh('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: gitEnv });
  sh('git', ['clone', '-q', bare, cand], { env: gitEnv });
  g(['checkout', '-q', '-b', 'master']);
  fs.mkdirSync(path.join(cand, 'src')); fs.writeFileSync(path.join(cand, 'src/impl.js'), 'exports.f = () => 0;\n');
  g(['add', '.']); g(['commit', '-q', '-m', 'base']); g(['push', '-q', 'origin', 'master']);
  g(['checkout', '-q', '-b', 'writer-510']);
  fs.mkdirSync(path.join(cand, 't')); fs.writeFileSync(path.join(cand, 't/spec.test.js'), SPEC);
  g(['add', '.']); g(['commit', '-q', '-m', 'writer: acceptance tests']); g(['push', '-q', 'origin', 'writer-510']);
  g(['checkout', '-q', 'master']);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'rig', FAKE_GH_STATE: ghFile, FAKE_GH_BARE: bare, GIT_CONFIG_GLOBAL: '/dev/null' };
  const cli = (args, envExtra = {}) => {
    const r = spawnSync(process.execPath, [cliPath, 'fanout', ...args], { encoding: 'utf8', env: { ...env, ...envExtra }, timeout: 90_000, cwd: cand });
    let json = null; try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not a JSON verb */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const readState = () => JSON.parse(fs.readFileSync(path.join(home, 'fanout', 'rig', 'state.json'), 'utf8'));
  const ghState = () => JSON.parse(fs.readFileSync(ghFile, 'utf8'));
  const patchGh = (fn) => { const s = ghState(); fn(s); fs.writeFileSync(ghFile, JSON.stringify(s)); };
  const count = (verb) => ghState().log.filter((l) => l.startsWith(verb)).length;
  const lastMerge = () => ghState().log.filter((l) => l.startsWith('pr merge')).at(-1) ?? '';
  const head = () => g(['rev-parse', 'HEAD']);
  const tree = (rev) => g(['rev-parse', `${rev}^{tree}`]);
  /** A branch off `from` with one commit (file ← text), pushed; the checkout stays ON it. Returns its head. */
  const branch = (name, from, file, text) => {
    g(['checkout', '-q', '-B', name, from]);
    fs.mkdirSync(path.dirname(path.join(cand, file)), { recursive: true });
    fs.writeFileSync(path.join(cand, file), text);
    g(['add', '-A']); g(['commit', '-q', '-m', `${name}: ${file}`]); g(['push', '-q', '-f', 'origin', name]);
    return head();
  };
  /** The author rewrite / no-op rebase of the TIP of `name`: another sha, the SAME tree. */
  const rewrite = (name) => {
    g(['checkout', '-q', name]);
    g(['commit', '-q', '--amend', '--reset-author', '-m', `${name}: rewritten ${Math.random()}`], { GIT_AUTHOR_DATE: '2026-11-22T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-22T12:00:00Z' });
    g(['push', '-q', '-f', 'origin', name]);
    return head();
  };
  /** One more byte on `name`: another sha AND another tree. */
  const bump = (name) => {
    g(['checkout', '-q', name]);
    fs.appendFileSync(path.join(cand, 'src/impl.js'), '// one byte more\n');
    g(['add', '-A']); g(['commit', '-q', '-m', `${name}: bump`]); g(['push', '-q', '-f', 'origin', name]);
    return head();
  };
  const reset = (name, sha) => { g(['checkout', '-q', '-B', name, sha]); g(['push', '-q', '-f', 'origin', name]); };
  const deliver = (b, ticket, verified, extra = []) => cli(['deliver', '--branch', b, '--into', 'master', '--ticket', ticket, '--run', 'rig', '--no-review-gate', '--verified-head', verified, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1', ...extra]);
  const gate = (b, ticket, headSha, extra = []) => cli(['gate', '--branch', b, '--into', 'master', '--head', headSha, '--ticket', ticket, '--run', 'rig', '--require-check', 'ci', ...extra]);
  const file = (name, o) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o)); return f; };
  cli(['state', 'init', '--run', 'rig', '--repo', 'o/r']);
  for (const t of ['T-G', 'T-D', 'T-E', 'T-F', 'T-H']) cli(['state', 'set', t, '--run', 'rig', '--status', 'started']); // a ticket the state does not name is refused (A: a mistyped --ticket must not skip a clause)
  return { dir, cand, cli, g, readState, patchGh, ghState, count, lastMerge, head, tree, branch, rewrite, bump, reset, deliver, gate, file, setCi: (...hs) => patchGh((s) => s.ciGreen.push(...hs)), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Every arm; returns [{name, ok, detail}]. `cliPath` is the bundle under test (baseline or a mutant). */
function scenarios(cliPath) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const J = (r) => `${r.code} ${r.stdout}${r.stderr}`.slice(0, 600);
  const W = world(cliPath);
  const tk = (id) => W.readState().tickets[id];
  const setPass = (id, branch, headSha, extra = []) => W.cli(['state', 'set', id, '--run', 'rig', '--branch', branch, '--head', headSha, '--status', 'gated', '--verdict', 'pass', ...extra]);
  try {
    // ── state: the tree is DERIVED from the head ───────────────────────────────────────────────────────────
    const a1 = W.branch('t-a', 'master', 'src/impl.js', 'exports.f = () => 1;\n');
    const s1 = setPass('T-A', 't-a', a1);
    arm('S1 must-PASS `state set --head` records the git tree of the head (derived, not typed)', s1.code === 0 && tk('T-A').tree === W.tree(a1), `${J(s1)} tree=${tk('T-A')?.tree} want=${W.tree(a1)}`);
    const s2 = W.cli(['state', 'set', 'T-A', '--run', 'rig', '--json', JSON.stringify({ tree: 'f'.repeat(40) })]);
    arm('S2 must-FAIL `state set --json` writing the tree: exit 1, unknown field, state unchanged', s2.code === 1 && /unknown field "tree"/.test(s2.stderr) && tk('T-A').tree === W.tree(a1), J(s2));

    const s3 = W.cli(['state', 'set', 'T-S', '--run', 'rig', '--head', a1, '--status', 'nominated']);
    const treeBefore = tk('T-S')?.tree;
    const s3b = W.cli(['state', 'set', 'T-S', '--run', 'rig', '--head', 'ab'.repeat(20)]); // a sha git and gh cannot read
    arm('S3 must-FAIL an UNREADABLE tree is unknown (null), never the previous head\'s tree', s3.code === 0 && treeBefore === W.tree(a1) && s3b.code === 0 && tk('T-S')?.tree === null && /unreadable/.test(s3b.stderr), `${J(s3)} ${J(s3b)} ${JSON.stringify(tk('T-S'))}`);

    // ── resume ─────────────────────────────────────────────────────────────────────────────────────────────
    const a2 = W.rewrite('t-a');
    const r1 = W.cli(['resume', '--run', 'rig']);
    arm('R1 must-PASS the branch moved to a NEW sha with the SAME tree: resume exit 0, no divergence, verdict pass kept, head follows', a2 !== a1 && W.tree(a2) === W.tree(a1) && r1.code === 0 && tk('T-A').verdict === 'pass' && tk('T-A').head === a2 && tk('T-A').status === 'gated', `${J(r1)} head=${tk('T-A').head}`);
    const a3 = W.bump('t-a');
    const r2 = W.cli(['resume', '--run', 'rig']);
    arm('R2 must-FAIL ONE byte changed in the candidate tree: resume exit 2 head-moved, verdict reset to none/nominated', r2.code === 2 && /head-moved/.test(r2.stdout) && tk('T-A').verdict === 'none' && tk('T-A').status === 'nominated' && a3 !== a2 && tk('T-A').tree === W.tree(a3), `${J(r2)} verdict=${tk('T-A').verdict}`);

    // ── resume: upstream trees ─────────────────────────────────────────────────────────────────────────────
    const u1 = W.branch('t-up', 'master', 'src/up.js', 'exports.up = 1;\n');
    W.cli(['state', 'set', 'UP', '--run', 'rig', '--branch', 't-up', '--head', u1, '--status', 'gated', '--verdict', 'pass']);
    const d1 = W.branch('t-dep', 't-up', 'src/dep.js', 'exports.dep = 1;\n');
    const sd = W.cli(['state', 'set', 'DEP', '--run', 'rig', '--branch', 't-dep', '--head', d1, '--depends-on', 'UP', '--built-on', `UP=${u1}`, '--status', 'gated', '--verdict', 'pass']);
    arm('U0 the dependent records the TREE of the upstream head it was built on (builtOnTree)', sd.code === 0 && tk('DEP')?.builtOnTree?.UP === W.tree(u1), `${J(sd)} ${JSON.stringify(tk('DEP'))}`);
    const u2 = W.rewrite('t-up');
    const r3 = W.cli(['resume', '--run', 'rig']);
    arm('U1 must-PASS the UPSTREAM was rewritten (new sha, same tree): no upstream-changed, the dependent keeps its pass verdict', u2 !== u1 && !/upstream-changed/.test(r3.stdout) && tk('DEP').verdict === 'pass', J(r3));
    W.bump('t-up');
    const r4 = W.cli(['resume', '--run', 'rig']);
    arm('U2 must-FAIL ONE byte changed in the UPSTREAM tree: upstream-changed reported, the dependent verdict reset', /DEP upstream-changed/.test(r4.stdout) && tk('DEP').verdict === 'none', J(r4));

    // ── gate: CI of another sha, same tree ─────────────────────────────────────────────────────────────────
    const b1 = W.branch('t-g', 'master', 'src/impl.js', 'exports.f = () => 1;\n');
    const b2 = W.rewrite('t-g');
    W.patchGh((s) => s.prs.push({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', base: 'master', headRefName: 't-g', head: '' }));
    W.setCi(b2);
    const g1 = W.gate('t-g', 'T-G', b1);
    arm('G1 must-PASS --head is the OLD sha, the PR head is the rewritten sha with the same tree: headMatches + sameTree', g1.json?.headMatches === true && g1.json?.sameTree === true && g1.json?.prHead === b2 && b1 !== b2, J(g1));
    const b3 = W.bump('t-g'); W.setCi(b3);
    const g2 = W.gate('t-g', 'T-G', b1);
    arm('G2 must-FAIL the PR head carries ONE changed byte: headMatches false, sameTree false, ciGreenOnHead false', g2.json?.headMatches === false && g2.json?.sameTree === false && g2.json?.ciGreenOnHead === false, J(g2));

    // ── deliver ────────────────────────────────────────────────────────────────────────────────────────────
    const c1 = W.branch('t-d', 'master', 'src/impl.js', 'exports.f = () => 1;\n');
    const c2 = W.rewrite('t-d'); W.setCi(c1, c2);
    const dv1 = W.deliver('t-d', 'T-D', c1);
    arm('D1 must-PASS verified head = the gated (old) sha, PR head = the rewritten sha, same tree: merged, `pr merge --match-head-commit` on the REAL head, viaTree reported',
      dv1.code === 0 && dv1.json?.verdict === 'merged' && dv1.json.head === c2 && dv1.json.viaTree?.verifiedHead === c1 && dv1.json.viaTree?.tree === W.tree(c2) && W.lastMerge().includes(`--match-head-commit ${c2}`), `${J(dv1)} ${W.lastMerge()}`);
    const e1 = W.branch('t-e', 'master', 'src/impl.js', 'exports.f = () => 1;\n');
    const e2 = W.bump('t-e'); W.setCi(e1, e2);
    const before = W.count('pr merge');
    const dv2 = W.deliver('t-e', 'T-E', e1);
    arm('D2 must-FAIL ONE byte changed in the candidate tree: exit 2 head-moved (trees differ), no merge call', dv2.code === 2 && dv2.json?.reason === 'head-moved' && /trees differ/.test(dv2.json.detail) && W.count('pr merge') === before, J(dv2));
    const f1 = W.branch('t-f', 'master', 'src/impl.js', 'exports.f = () => 1;\n');
    const f2 = W.rewrite('t-f'); W.setCi(f1, f2);
    const dv3 = W.cli(['deliver', '--branch', 't-f', '--into', 'master', '--ticket', 'T-F', '--run', 'rig', '--review-verdict', W.file('rv-f.json', { round: 1, blocking: 0, major: 0, minor: 0, head: f1 }), '--verified-head', f2, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1']);
    arm('D3 must-PASS the review round reviewed the OLD sha, the verified head is the rewritten sha, same tree: merged', dv3.code === 0 && dv3.json?.verdict === 'merged' && dv3.json.reviewGated === true, J(dv3));
    const h1 = W.branch('t-h', 'master', 'src/impl.js', 'exports.f = () => 1;\n'); W.setCi(h1);
    const other = W.branch('t-other', 'master', 'src/other.js', "exports.other = 'another ticket';\n");
    const dv4 = W.cli(['deliver', '--branch', 't-h', '--into', 'master', '--ticket', 'T-H', '--run', 'rig', '--review-verdict', W.file('rv-other.json', { round: 1, blocking: 0, major: 0, minor: 0, head: other }), '--verified-head', h1, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1']);
    arm('D4 must-FAIL a review verdict for ANOTHER ticket\'s tree: exit 2 verdict-head-mismatch (the trees differ), no merge', dv4.code === 2 && dv4.json?.reason === 'verdict-head-mismatch' && /trees differ/.test(dv4.json.detail), J(dv4));

    // ── deliver + acceptance receipt (A's receipt is tree-keyed too; its hash refusal is kept) ─────────────
    const fz = W.cli(['acceptance', 'freeze', 'T-1', '--run', 'rig', '--files', 't/spec.test.js', '--run-cmd', 'node --test t/spec.test.js', '--from', 'origin/writer-510']);
    W.g(['checkout', '-q', 'master']);
    const k1 = W.branch('t-k', 'master', 'src/impl.js', 'exports.f = () => 1;\n');
    W.g(['checkout', 'origin/writer-510', '--', 't/spec.test.js']); W.g(['commit', '-q', '-m', 'tests copied unchanged']); W.g(['push', '-q', '-f', 'origin', 't-k']);
    const k1h = W.head();
    const gk = W.cli(['gate', '--branch', 't-k', '--into', 'master', '--head', k1h, '--ticket', 'T-1', '--run', 'rig', '--cwd', W.cand]);
    const rc = gk.json?.acceptance?.receipt;
    arm('A0 the gate receipt names the TREE of the checkout and the ticket', fz.code === 0 && gk.code === 0 && rc?.tree === W.tree(k1h) && rc?.ticket === 'T-1' && rc?.head === k1h, `${J(fz)} ${J(gk)}`);
    const k2 = W.rewrite('t-k'); W.setCi(k1h, k2);
    const da1 = W.deliver('t-k', 'T-1', k2, ['--acceptance', W.file('rc.json', rc ?? {})]);
    arm('A1 must-PASS the receipt was issued for the OLD sha, the verified head is the rewritten sha, same tree: merged, acceptanceChecked, viaTree', da1.code === 0 && da1.json?.verdict === 'merged' && da1.json.acceptanceChecked === true, J(da1));
    const m1 = W.branch('t-m', 'master', 'src/impl.js', 'exports.f = () => 1;\n');
    W.g(['checkout', 'origin/writer-510', '--', 't/spec.test.js']); W.g(['commit', '-q', '-m', 'tests copied unchanged']); W.g(['push', '-q', '-f', 'origin', 't-m']);
    const m1h = W.head(); const m2 = W.bump('t-m'); W.setCi(m1h, m2);
    const da2 = W.deliver('t-m', 'T-1', m2, ['--acceptance', W.file('rc-old.json', rc ?? {})]);
    arm('A2 must-FAIL the receipt\'s tree is NOT the verified head\'s tree (one byte changed): exit 2 acceptance-stale, no merge', da2.code === 2 && da2.json?.reason === 'acceptance-stale', J(da2));
    const da3 = W.deliver('t-k', 'T-1', k2, ['--acceptance', W.file('rc-t2.json', { ...(rc ?? {}), ticket: 'T-2' })]);
    arm('A3 must-FAIL a receipt issued for ANOTHER ticket, even for the same tree: exit 2 acceptance-stale', da3.code === 2 && da3.json?.reason === 'acceptance-stale' && /ticket T-2/.test(da3.json.detail), J(da3));
    const da4 = W.deliver('t-k', 'T-1', k2, ['--acceptance', W.file('rc-hash.json', { ...(rc ?? {}), hash: 'e'.repeat(64) })]);
    arm('A4 must-FAIL (A\'s refusal kept) a receipt for another frozen set/command: exit 2 acceptance-stale even on the same tree', da4.code === 2 && da4.json?.reason === 'acceptance-stale', J(da4));

    // ── deliver: the upstream was rebase-merged ────────────────────────────────────────────────────────────
    const up1 = W.branch('x-up', 'master', 'src/up.js', 'exports.up = 1;\n');
    W.cli(['state', 'set', 'XUP', '--run', 'rig', '--branch', 'x-up', '--head', up1, '--pr', '50', '--status', 'gated', '--verdict', 'pass']);
    const xd1 = W.branch('x-dep', 'x-up', 'src/dep.js', 'exports.dep = 1;\n');
    W.cli(['state', 'set', 'XDEP', '--run', 'rig', '--branch', 'x-dep', '--head', xd1, '--depends-on', 'XUP', '--built-on', `XUP=${up1}`, '--status', 'gated', '--verdict', 'pass']);
    const up2 = W.rewrite('x-up'); // the upstream is rebase-merged at a rewritten sha with the SAME tree
    W.patchGh((s) => s.prs.push({ number: 50, url: 'https://github.com/o/r/pull/50', state: 'MERGED', base: 'master', headRefName: 'x-up', head: up2 }));
    W.setCi(xd1);
    const dx1 = W.deliver('x-dep', 'XDEP', xd1);
    arm('X1 must-PASS the upstream merged at a REWRITTEN sha with the SAME tree the dependent was built on: the dependent merges', up2 !== up1 && dx1.code === 0 && dx1.json?.verdict === 'merged', J(dx1));
    const yup1 = W.branch('y-up', 'master', 'src/up2.js', 'exports.up2 = 1;\n');
    W.cli(['state', 'set', 'YUP', '--run', 'rig', '--branch', 'y-up', '--head', yup1, '--pr', '51', '--status', 'gated', '--verdict', 'pass']);
    const yd1 = W.branch('y-dep', 'y-up', 'src/dep2.js', 'exports.dep2 = 1;\n');
    W.cli(['state', 'set', 'YDEP', '--run', 'rig', '--branch', 'y-dep', '--head', yd1, '--depends-on', 'YUP', '--built-on', `YUP=${yup1}`, '--status', 'gated', '--verdict', 'pass']);
    const yup2 = W.bump('y-up'); // merged at ONE changed byte
    W.patchGh((s) => s.prs.push({ number: 51, url: 'https://github.com/o/r/pull/51', state: 'MERGED', base: 'master', headRefName: 'y-up', head: yup2 }));
    W.setCi(yd1);
    const mergesBefore = W.count('pr merge');
    const dx2 = W.deliver('y-dep', 'YDEP', yd1);
    arm('X2 must-FAIL the upstream merged with ONE changed byte in its tree: exit 2 upstream-changed, no merge', dx2.code === 2 && dx2.json?.reason === 'upstream-changed' && W.count('pr merge') === mergesBefore, J(dx2));
    // ── resume: the PR head moved (a different probe than the branch tip) ───────────────────────────────────
    const p1 = W.branch('t-p', 'master', 'src/impl.js', 'exports.f = () => 1;\n');
    W.patchGh((s) => s.prs.push({ number: 60, url: 'https://github.com/o/r/pull/60', state: 'OPEN', base: 'master', headRefName: 't-p', head: '' }, { number: 61, url: 'https://github.com/o/r/pull/61', state: 'OPEN', base: 'master', headRefName: 't-q', head: '' }));
    W.cli(['state', 'set', 'T-P', '--run', 'rig', '--pr', '60', '--head', 'ab'.repeat(20), '--status', 'nominated']); // head unreadable ⇒ tree unknown
    const q1 = W.branch('t-q', 'master', 'src/q.js', 'exports.q = 1;\n');
    W.cli(['state', 'set', 'T-Q', '--run', 'rig', '--pr', '61', '--head', q1, '--status', 'nominated']);
    W.rewrite('t-q'); // the PR head is now another sha with T-Q's tree
    const pr1 = W.cli(['resume', '--run', 'rig', '--no-write']);
    arm('P1 must-FAIL a recorded head with an UNKNOWN tree and another PR head sha: pr-head-moved reported (unknown never matches)', /T-P pr-head-moved/.test(pr1.stdout) && p1 !== undefined, J(pr1));
    arm('P2 must-PASS the PR head is another sha with the recorded tree: no pr-head-moved for it', !/T-Q pr-head-moved/.test(pr1.stdout), J(pr1));
  } catch (e) { arm('CRASH the arms threw (a bundle that cannot run is red)', false, String(e?.stack ?? e).slice(0, 400)); } finally { W.cleanup(); }
  return res;
}

function report(title, res) {
  console.log(`\n== ${title}`);
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
  const bad = res.filter((r) => !r.ok).length;
  console.log(`-- ${res.length - bad}/${res.length} PASS`);
  return bad;
}

// Each mutant breaks ONE clause in the BUILT bundle; the anchor must occur exactly once. `extra` = a second edit of the same mutant.
const mutants = [
  { name: 'state: the tree is never recorded (head set ⇒ tree null)', find: 'if ("head" in patch) next.tree = derived.tree !== void 0', put: () => 'if ("head" in patch) next.tree = null; if (false) next.tree = derived.tree !== void 0' },
  // 'a changed head with NO derived tree keeps the old head\'s tree' is not reachable through the CLI (it always passes derived.tree, null when unreadable): pinned by the unit arm in src/shared/fanout-tree-verdict.test.ts + a hand mutation (see the ledger).
  { name: 'state: builtOnTree never recorded', find: 'const t = dTrees[k] ??', put: () => 'const t = void 0 ??' },
  { name: 'content key: any two trees match (sameContent ignores the tree value)', find: '!!aTree && !!bTree && aTree === bTree', put: () => '!!aTree && !!bTree' },
  { name: 'content key: an UNKNOWN tree matches', find: '!!aTree && !!bTree && aTree === bTree', put: () => '!aTree || !bTree || aTree === bTree' },
  { name: 'resume: a head moved to the same tree still voids the verdict (tree ignored)', find: '&& t.tree && r.branchTree === t.tree) {', put: () => '&& false) {' },
  { name: 'resume: a moved head is always "same tree" (the tree is not compared)', find: '&& t.tree && r.branchTree === t.tree) {', put: () => '&& t.tree) {' },
  { name: 'resume: the head-moved write-back leaves the OLD tree on the new head', find: 'patch: { head: r.branchHead, tree: r.branchTree ?? null, verdict: "none"', put: () => 'patch: { head: r.branchHead, verdict: "none"' },
  { name: 'resume: the upstream tip\'s tree is not read (a rewritten upstream voids the dependent)', find: 'reality[u]?.error ? null : reality[u]?.branchHead, reality[u]?.branchTree)', put: () => 'reality[u]?.error ? null : reality[u]?.branchHead, void 0)' },
  { name: 'resume: the upstream tree is ignored (any rewritten upstream passes)', find: 'if (!sameContent(built, dep.builtOnTree[up], head, upHead != null ? upTree : u.tree))', put: () => 'if (false)' },
  { name: 'deliver: a different PR head is always accepted (headSameTree forced)', find: 'headSameTree = !!a && a === b;', put: () => 'headSameTree = true;' },
  { name: 'deliver: the PR-head tree is never compared (the unfixed rule)', find: 'headSameTree = !!a && a === b;', put: () => 'headSameTree = false;' },
  { name: 'deliver: the merge binds to the VERIFIED sha, not the real head', find: 'return { action: "merge", head: pr.headRefOid };', put: () => 'return { action: "merge", head: i.verifiedHead };' },
  { name: 'deliver: a review verdict for another tree accepted', find: 'if (a && a === b) {\n      verdictSameTree = true;', put: () => 'if (true) {\n      verdictSameTree = true;' },
  { name: 'deliver: a review verdict of another sha never kept (the unfixed rule)', find: 'if (a && a === b) {\n      verdictSameTree = true;', put: () => 'if (false) {\n      verdictSameTree = true;' },
  { name: 'receipt: any tree matches the verified head', find: '!(receipt.tree && ctx.headTree && receipt.tree === ctx.headTree)', put: () => '!(receipt.tree && ctx.headTree)' },
  { name: 'receipt: a head-only rule (the tree is not consulted)', find: '!(receipt.tree && ctx.headTree && receipt.tree === ctx.headTree)', put: () => 'true' },
  { name: 'receipt: the ticket is not checked', find: 'receipt.ticket !== void 0 && ctx.ticket !== void 0 && receipt.ticket !== ctx.ticket', put: () => 'false' },
  { name: 'receipt: the gate does not record the tree', find: '...facts.cwdTree ? { tree: facts.cwdTree } : {}', put: () => '...{}' },
  { name: 'receipt: the gate does not record the ticket', find: '...facts.ticket ? { ticket: facts.ticket } : {}', put: () => '...{}' },
  { name: 'gate: the PR head tree is not read (CI of a rewritten head never accepted)', find: 'if (snap && snap.view.headRefOid !== opts.head) {', put: () => 'if (false) {' },
  { name: 'gate: any PR head tree is "the same"', find: 'const sameTree = prHead !== null && prHead !== i.head && !!i.headTree && !!i.prTree && i.headTree === i.prTree;', put: () => 'const sameTree = prHead !== null && prHead !== i.head;' },
  { name: 'upstream: the recorded builtOnTree is ignored for the merged upstream (a changed upstream passes)', find: 'base.sameTree = (u.builtOnTree ?? await treeOf(u.builtOn)) === await treeOf(mergedHead);', put: () => 'base.sameTree = true;' },
  { name: 'upstream: a rewritten merged upstream is never the same tree (the unfixed rule)', find: 'base.sameTree = (u.builtOnTree ?? await treeOf(u.builtOn)) === await treeOf(mergedHead);', put: () => 'base.sameTree = false;' },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!UNFIXED && !orig.includes('builtOnTree')) { console.error('dist-electron/cli.js has no #512 tree key — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

const baselineBad = report(UNFIXED ? 'UNFIXED bundle (expected: red)' : 'baseline (built bundle)', scenarios(CLI));
if (UNFIXED) process.exit(baselineBad > 0 ? 0 : 1); // inverted: the unfixed arm must FAIL
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

for (const [i, m] of mutants.entries()) for (const step of [m, ...(m.extra ?? [])]) {
  const n = orig.split(step.find).length - 1;
  if (n !== 1) { console.error(`MUTANT ${i} "${m.name}": anchor found ${n}× (needs exactly 1) — the bundle shape changed, fix the rig`); process.exit(1); }
}
let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-tree-mut-'));
for (const [i, m] of mutants.entries()) {
  if (process.env.MUT_ONLY && !process.env.MUT_ONLY.split(',').includes(String(i))) continue; // iterate on a few: MUT_ONLY=2,3
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

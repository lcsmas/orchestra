#!/usr/bin/env node
// #515 rig — the acceptance flow FORCED by code, through the BUILT CLI (dist-electron/cli.js) against a FAKE HOST on a unix socket: the fake host runs the REAL host half
// (src/shared/fanout-acceptance-host.ts, loaded from SHARED_DIR) with a recorded spawn + bus; a scratch bare origin + a fake `gh`. Light: no Electron, no network, no tokens, scratch under $TMPDIR.
//   node scripts/e2e-fanout-acceptance-forced.mjs            baseline: every arm must PASS (each clause has a must-PASS and a must-FAIL arm)
//   node scripts/e2e-fanout-acceptance-forced.mjs --mutants each patched copy of the BUILT bundle / of src/shared must be KILLED (≥1 arm FAILs); the baseline is the control
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const SHARED = path.join(ROOT, 'src', 'shared');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const SPEC = (fn, n) => [
  "const test = require('node:test');", "const assert = require('node:assert');", `const { ${fn} } = require('../src/impl.js');`,
  `test('${fn} is what the spec says', () => { assert.equal(${fn}(), ${n}); });`, ''].join('\n');
const DECISION = (n) => `https://github.com/o/r/issues/511#issuecomment-${n}`;
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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

// The fake host: the REAL dispatchFanoutAcceptance behind a unix socket; spawn/post are recorded to host.log (jsonl).
const HOST_JS = `
import http from 'node:http'; import fs from 'node:fs';
const { dispatchFanoutAcceptance } = await import(process.env.SHARED_DIR + '/fanout-acceptance-host.ts');
const log = (o) => fs.appendFileSync(process.env.HOST_LOG, JSON.stringify(o) + '\\n');
let n = 0;
const deps = { home: process.env.ORCHESTRA_HOME, now: () => new Date().toISOString(), isWorkspace: (id) => id === process.env.RUN_ID, repoPath: () => undefined,
  spawn: async (i) => { n++; log({ kind: 'spawn', ...i }); return { ok: true, id: 'writer-' + n }; },
  post: (i) => { log({ kind: 'post', ...i }); } };
http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
  const out = req.url === '/fanoutAcceptance' ? await dispatchFanoutAcceptance(JSON.parse(b), deps) : {};
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out)); }); }).listen(process.env.SOCK, () => fs.writeFileSync(process.env.READY, '1'));
`;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

function world(cliPath, sharedDir) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'fanout-forced-rig-'));
  if (!path.resolve(dir).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
  const bare = path.join(dir, 'origin.git'), work = path.join(dir, 'work'), wr = path.join(dir, 'writer'), cand = path.join(dir, 'cand'), bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  for (const d of [bin, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const ghState = path.join(dir, 'gh-state.json');
  fs.writeFileSync(ghState, JSON.stringify({ prs: [], ciGreen: [], log: [], comments: { 900: 'Ledger decision: ticket T-5 is docs only, it has no testable promise.', 901: 'Ledger decision about T-9 only.' } }));
  const gitEnv = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@x', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: home, PATH: process.env.PATH };
  const gIn = (cwd) => (args) => sh('git', args, { cwd, env: gitEnv }).stdout.trim();
  sh('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: gitEnv });
  for (const d of [work, wr, cand]) sh('git', ['clone', '-q', bare, d], { env: gitEnv, stdio: 'ignore' });
  const gw = gIn(work), gr = gIn(wr), gc = gIn(cand);
  gw(['checkout', '-q', '-b', 'master']);
  fs.mkdirSync(path.join(work, 'src')); fs.writeFileSync(path.join(work, 'src/impl.js'), 'exports.f = () => 0; exports.g = () => 0;\n');
  gw(['add', '.']); gw(['commit', '-q', '-m', 'base']); gw(['push', '-q', 'origin', 'master']);
  for (const g of [gr, gc]) g(['fetch', '-q', 'origin']);
  // the host
  const sock = path.join(dir, 'sock'), ready = path.join(dir, 'ready'), hostLog = path.join(dir, 'host.log');
  fs.writeFileSync(hostLog, '');
  const hostFile = path.join(dir, 'host.mjs'); fs.writeFileSync(hostFile, HOST_JS);
  const hostProc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', hostFile], { env: { PATH: process.env.PATH, SHARED_DIR: sharedDir, ORCHESTRA_HOME: home, RUN_ID: 'rig', SOCK: sock, READY: ready, HOST_LOG: hostLog }, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let k = 0; k < 100 && !fs.existsSync(ready); k++) sleepMs(100);
  if (!fs.existsSync(ready)) throw new Error('the fake host did not come up');
  const env = (id, extra = {}) => ({ ...gitEnv, PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: id, ORCHESTRA_SOCK: sock, FAKE_GH_STATE: ghState, FAKE_GH_BARE: bare, GIT_CONFIG_GLOBAL: '/dev/null', ...extra });
  const cli = (as, args, cwd = work, timeoutMs = 90_000, extra = {}) => {
    const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: env(as, extra), timeout: timeoutMs, cwd });
    let json = null; try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not a JSON verb */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const readState = () => JSON.parse(fs.readFileSync(path.join(home, 'fanout', 'rig', 'state.json'), 'utf8'));
  const hostEvents = () => fs.readFileSync(hostLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const gh = () => JSON.parse(fs.readFileSync(ghState, 'utf8'));
  const patchGh = (fn) => { const s = gh(); fn(s); fs.writeFileSync(ghState, JSON.stringify(s)); };
  const count = (verb) => gh().log.filter((l) => l.startsWith(verb)).length;
  /** a ticket's writer commits its tests (branch accept-<id>, never pushed) */
  const writerTests = (ticket, file, fn, n) => {
    gr(['checkout', '-q', '-B', `accept-${ticket}`, 'origin/master']);
    fs.mkdirSync(path.join(wr, 't'), { recursive: true }); fs.writeFileSync(path.join(wr, file), SPEC(fn, n));
    gr(['add', '-A']); gr(['commit', '-q', '-m', `writer ${ticket}`]);
  };
  const freezeAs = (writerId, ticket, file, extra = []) => cli(writerId, ['fanout', 'acceptance', 'freeze', ticket, '--run', 'rig', '--files', file, '--run-cmd', `node --test ${file}`, ...extra], wr);
  /** the candidate: branch off master, optionally copy the frozen files from the shared branch, impl code, pushed */
  const candidate = (name, o) => {
    gc(['fetch', '-q', 'origin']); gc(['checkout', '-q', '-B', name, 'origin/master']);
    if (o.copy) { gc(['fetch', '-q', 'origin', 'acceptance/rig']); gc(['checkout', 'FETCH_HEAD', '--', ...o.copy]); }
    fs.writeFileSync(path.join(cand, 'src/impl.js'), o.code ?? 'exports.f = () => 1; exports.g = () => 1;\n');
    gc(['add', '-A']); gc(['commit', '-q', '-m', name]); gc(['push', '-q', '-f', 'origin', name]);
    return { branch: name, head: gc(['rev-parse', 'HEAD']) };
  };
  const gate = (v, ticket, extra = ['--cwd', cand], as = 'verif-1') => cli(as, ['fanout', 'gate', '--branch', v.branch, '--into', 'master', '--head', v.head, '--ticket', ticket, '--run', 'rig', ...extra], work);
  const deliver = (v, ticket, extra = []) => cli('rig', ['fanout', 'deliver', '--branch', v.branch, '--into', 'master', '--ticket', ticket, '--run', 'rig', '--no-review-gate', '--verified-head', v.head, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1', ...extra], work);
  const receipt = (name, json) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(json)); return f; };
  const register = (ticket, extra = []) => cli('rig', ['fanout', 'state', 'set', ticket, '--run', 'rig', '--spec', `docs/spec.md#${ticket}`, '--implementer', 'impl-1', '--verifier', 'verif-1', ...extra]);
  cli('rig', ['fanout', 'state', 'init', '--run', 'rig', '--repo', 'o/r']);
  return { dir, work, wr, cand, cli, env, readState, hostEvents, gh, patchGh, count, writerTests, freezeAs, candidate, gate, deliver, receipt, register, bare, gc, gr, kill: () => { hostProc.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function scenarios(cliPath, sharedDir) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const J = (r) => `${r.code} ${r.stdout}${r.stderr}`.slice(0, 600);
  const W = world(cliPath, sharedDir);
  try {
    const spawns = () => W.hostEvents().filter((e) => e.kind === 'spawn');
    const posts = () => W.hostEvents().filter((e) => e.kind === 'post');
    const tk = (id) => W.readState().tickets[id];

    // ── register → auto-spawn ────────────────────────────────────────────────────────────────────────────
    const r1 = W.register('T-1', ['--branch', 'impl-t1']);
    arm('R1 must-PASS register with --spec: the HOST spawned ONE accept- writer (name, parent = the run, brief = spec + ticket), recorded on the ticket',
      r1.code === 0 && spawns().length === 1 && spawns()[0].name === 'accept-T-1' && spawns()[0].from === 'rig' && /docs\/spec\.md#T-1/.test(spawns()[0].task) && !/impl-t1/.test(spawns()[0].task) && tk('T-1').accept?.acceptor?.id === 'writer-1' && /spawned its test writer accept-T-1/.test(r1.stdout), J(r1));
    const r2 = W.cli('rig', ['fanout', 'state', 'set', 'T-2', '--run', 'rig', '--status', 'started']);
    const r3 = W.cli('rig', ['fanout', 'state', 'set', 'T-1', '--run', 'rig', '--status', 'started']);
    arm('R2 must-PASS no flow when it is not owed: a ticket WITHOUT --spec and a re-set of a ticket that HAS a writer spawn nothing', r2.code === 0 && r3.code === 0 && spawns().length === 1, `${spawns().length} spawns`);
    const t2 = W.register('T-2b');
    arm('R3 must-PASS a second ticket gets its own writer (one writer per ticket)', t2.code === 0 && spawns().length === 2 && spawns()[1].name === 'accept-T-2b' && tk('T-2b').accept?.acceptor?.id === 'writer-2', J(t2));
    const down = W.cli('rig', ['fanout', 'state', 'set', 'T-6', '--run', 'rig', '--spec', 'x'], W.work, 30_000, { ORCHESTRA_SOCK: path.join(W.dir, 'no-such-socket') });
    arm('R4 must-FAIL host unreachable: exit 1 naming the ticket and the retry verb; the ticket IS registered (spec set), no writer recorded',
      down.code === 1 && /T-6 is registered but its test writer was NOT spawned/.test(down.stderr) && /acceptance spawn T-6/.test(down.stderr) && tk('T-6').spec === 'x' && !tk('T-6').accept?.acceptor, J(down));
    const rt = W.cli('rig', ['fanout', 'acceptance', 'spawn', 'T-6', '--run', 'rig']);
    arm('R5 must-PASS `acceptance spawn` re-requests it once the host is back; must-FAIL when a writer already exists', rt.code === 0 && tk('T-6').accept?.acceptor?.id === 'writer-3' && W.cli('rig', ['fanout', 'acceptance', 'spawn', 'T-1', '--run', 'rig']).code === 2, J(rt));

    // ── freeze: own ticket, shared branch, status ────────────────────────────────────────────────────────
    W.writerTests('T-1', 't/spec.test.js', 'f', 1);
    const wrong = W.freezeAs('writer-1', 'T-2b', 't/spec.test.js');
    arm('F1 must-FAIL a writer freezes ONLY its own ticket: exit 2, nothing recorded, no branch published', wrong.code === 2 && /you may freeze only that ticket/.test(wrong.stderr) && !tk('T-2b').acceptance && sh('git', ['--git-dir', W.bare, 'rev-parse', '--verify', '-q', 'acceptance/rig'], { allowFail: true }).status !== 0, J(wrong));
    const fz = W.freezeAs('writer-1', 'T-1', 't/spec.test.js');
    const ev = posts();
    arm('F2 must-PASS the freeze publishes to ONE shared branch acceptance/<run> (the writer\'s bytes), records path + command, and the host tells implementer AND verifier (path + command in the status)',
      fz.code === 0 && sh('git', ['--git-dir', W.bare, 'show', 'acceptance/rig:t/spec.test.js']).stdout === SPEC('f', 1) && tk('T-1').acceptance?.source.branch === 'acceptance/rig' && ev.length === 2 && ev.map((e) => e.to).sort().join() === 'impl-1,verif-1' && ev.every((e) => e.sender === 'writer-1' && /t\/spec\.test\.js/.test(e.body) && /Run: node --test t\/spec\.test\.js/.test(e.body)), `${J(fz)} posts=${JSON.stringify(ev).slice(0, 300)}`);
    const brief = W.cli('impl-1', ['fanout', 'acceptance', 'show', 'T-1', '--run', 'rig', '--brief']);
    const sshow = W.cli('rig', ['fanout', 'state', 'show', '--run', 'rig']);
    arm('F3 must-PASS `show --brief` and `state show` print the path and the run command', /acceptance\/rig@[0-9a-f]{12}.*t\/spec\.test\.js.*run: node --test t\/spec\.test\.js/.test(brief.stdout) && /T-1\s+frozen\s+acceptance\/rig@[0-9a-f]{12}.*run: node --test/.test(sshow.stdout), `${brief.stdout} | ${sshow.stdout}`);
    const stranger = W.cli('rig', ['fanout', 'acceptance', 'freeze', 'T-1', '--run', 'rig', '--files', 't/spec.test.js', '--run-cmd', 'node --test t/spec.test.js'], W.wr);
    arm('F4 must-FAIL a second freeze is refused (exit 2) — amend is the way', stranger.code === 2 && /already frozen/.test(stranger.stderr), J(stranger));
    W.writerTests('T-2b', 't/spec.test.js', 'f', 2); // same path, other bytes
    const clash = W.freezeAs('writer-2', 'T-2b', 't/spec.test.js');
    arm('F5 must-FAIL a path another ticket froze with OTHER bytes on the shared branch is refused (exit 2), the branch tip does not move',
      clash.code === 2 && /already on acceptance\/rig with other bytes/.test(clash.stderr) && !tk('T-2b').acceptance, J(clash));

    // ── NORMAL PATH: zero refusals, zero pending ────────────────────────────────────────────────────────
    const good = W.candidate('c-good', { copy: ['t/spec.test.js'] });
    const g1 = W.gate(good, 'T-1');
    arm('N1 must-PASS NORMAL PATH (register → auto-spawn → freeze → candidate): the gate answers exit 0, verdict gate, acceptance.ok, NO pending, NO refusal',
      g1.code === 0 && g1.json?.verdict === 'gate' && g1.json.acceptance?.ok === true && g1.json.acceptance.ran?.exit === 0 && !('pending' in (g1.json.acceptance ?? {})) && g1.json.reason === undefined, J(g1));
    W.patchGh((s) => s.ciGreen.push(good.head));
    const rc = W.receipt('good', g1.json);
    const d1 = W.deliver(good, 'T-1', ['--acceptance', rc]);
    arm('N2 must-PASS …and deliver merges it (acceptanceChecked), zero refusals', d1.code === 0 && d1.json?.verdict === 'merged' && d1.json.acceptanceChecked === true && W.count('pr merge') === 1, J(d1));

    // ── EARLY NOMINATION: the gate waits, never refuses ─────────────────────────────────────────────────
    const r7 = W.register('T-3'); W.writerTests('T-3', 't/spec3.test.js', 'g', 1);
    const early = W.candidate('c-early', {});
    const proc = spawn(process.execPath, [cliPath, 'fanout', 'gate', '--branch', early.branch, '--into', 'master', '--head', early.head, '--ticket', 'T-3', '--run', 'rig', '--cwd', W.cand, '--accept-wait', '60'], { env: W.env('verif-1'), cwd: W.work, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; proc.stdout.on('data', (c) => (out += c));
    const done = new Promise((r) => proc.on('close', (code) => r(code)));
    return { async: (async () => {
      await new Promise((r) => setTimeout(r, 2500));
      const waiting = tk('T-3').accept?.wait;
      arm('E1 must-PASS while the gate waits the bound + deadline are in the state (60s, deadline = since + 60s)', r7.code === 0 && waiting?.boundSec === 60 && Date.parse(waiting.deadline) - Date.parse(waiting.since) === 60_000 && /gate waits until/.test(W.cli('rig', ['fanout', 'state', 'show', '--run', 'rig']).stdout), JSON.stringify(waiting));
      const fz3 = W.freezeAs('writer-' + (spawns().findIndex((e) => e.name === 'accept-T-3') + 1), 'T-3', 't/spec3.test.js');
      const code = await Promise.race([done, new Promise((r) => setTimeout(() => r('timeout'), 30_000))]);
      let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* */ }
      arm('E2 must-PASS the freeze landing during the wait ends it: verdict pending exit 3 (copy the files, re-gate), NOT a refusal, the CI half answered in the same line',
        fz3.code === 0 && code === 3 && j?.verdict === 'pending' && j.reason === 'acceptance-pending' && j.acceptance?.pending === true && j.acceptance.frozen?.branch === 'acceptance/rig' && 'fullSuite' in j && !tk('T-3').accept?.wait, `${J(fz3)} code=${code} out=${out.slice(0, 400)}`);
      const copied = W.candidate('c-early2', { copy: ['t/spec3.test.js'] });
      const g3 = W.gate(copied, 'T-3');
      arm('E3 must-PASS …the implementer copies the frozen file (new head): the gate passes with zero refusals (ok, ran exit 0)', g3.code === 0 && g3.json?.acceptance?.ok === true, J(g3));
      // a candidate carrying ITS OWN different file at the frozen path is refused, early or not
      const r8 = W.register('T-8'); W.writerTests('T-8', 't/spec8.test.js', 'f', 1);
      const own = W.candidate('c-own', { code: 'exports.f = () => 1; exports.g = () => 1;\n' });
      fs.writeFileSync(path.join(W.cand, 't'), ''); // placeholder removed below
      fs.rmSync(path.join(W.cand, 't'), { force: true });
      fs.mkdirSync(path.join(W.cand, 't'), { recursive: true }); fs.writeFileSync(path.join(W.cand, 't/spec8.test.js'), SPEC('f', 1).replace('assert.equal(f(), 1)', 'assert.ok(true)'));
      W.gc(['add', '-A']); W.gc(['commit', '-q', '-m', 'own weaker test']);
      const ownHead = { branch: 'c-own', head: W.gc(['rev-parse', 'HEAD']) };
      W.freezeAs('writer-' + (spawns().findIndex((e) => e.name === 'accept-T-8') + 1), 'T-8', 't/spec8.test.js');
      const g8 = W.gate(ownHead, 'T-8');
      arm('E4 must-FAIL (hard refusal stays) a candidate whose file at the frozen path differs: exit 2 frozen-test-changed', r8.code === 0 && g8.code === 2 && g8.json?.reason === 'frozen-test-changed', J(g8));
      // the SAME hard refusal when the freeze lands DURING a wait: a present-but-different file is not "not copied yet"
      const r10 = W.register('T-10'); W.writerTests('T-10', 't/spec10.test.js', 'f', 1);
      W.gc(['fetch', '-q', 'origin']); W.gc(['checkout', '-q', '-B', 'c-own2', 'origin/master']);
      fs.mkdirSync(path.join(W.cand, 't'), { recursive: true }); fs.writeFileSync(path.join(W.cand, 't/spec10.test.js'), SPEC('f', 1).replace('assert.equal(f(), 1)', 'assert.ok(true)'));
      fs.writeFileSync(path.join(W.cand, 'src/impl.js'), 'exports.f = () => 1; exports.g = () => 1;\n');
      W.gc(['add', '-A']); W.gc(['commit', '-q', '-m', 'own weaker test']); W.gc(['push', '-q', '-f', 'origin', 'c-own2']);
      const own2 = { branch: 'c-own2', head: W.gc(['rev-parse', 'HEAD']) };
      const proc2 = spawn(process.execPath, [cliPath, 'fanout', 'gate', '--branch', own2.branch, '--into', 'master', '--head', own2.head, '--ticket', 'T-10', '--run', 'rig', '--cwd', W.cand, '--accept-wait', '60'], { env: W.env('verif-1'), cwd: W.work, stdio: ['ignore', 'pipe', 'pipe'] });
      let out2 = ''; proc2.stdout.on('data', (c) => (out2 += c));
      const done2 = new Promise((r) => proc2.on('close', (code) => r(code)));
      await new Promise((r) => setTimeout(r, 2500));
      const fz10 = W.freezeAs('writer-' + (spawns().findIndex((e) => e.name === 'accept-T-10') + 1), 'T-10', 't/spec10.test.js');
      const code2 = await Promise.race([done2, new Promise((r) => setTimeout(() => r('timeout'), 30_000))]);
      let j2 = null; try { j2 = JSON.parse(out2.trim().split('\n').pop()); } catch { /* */ }
      arm('E4b must-FAIL a candidate carrying a DIFFERENT file at the frozen path is refused (exit 2 frozen-test-changed) even when the freeze lands during the wait — only an ABSENT file is copy-pending', r10.code === 0 && fz10.code === 0 && code2 === 2 && j2?.reason === 'frozen-test-changed', `code=${code2} ${out2.slice(0, 300)}`);
      const red = W.candidate('c-red', { copy: ['t/spec3.test.js'], code: 'exports.f = () => 1; exports.g = () => 2;\n' });
      const g9 = W.gate(red, 'T-3');
      arm('E5 must-FAIL (hard refusal stays) a RED frozen test: exit 2 frozen-test-failed', g9.code === 2 && g9.json?.reason === 'frozen-test-failed', J(g9));

      // ── pending at the bound, deliver, the recorded escapes ───────────────────────────────────────────
      W.register('T-4');
      const c4 = W.candidate('c-4', {});
      const g4 = W.gate(c4, 'T-4', ['--cwd', W.cand, '--accept-wait', '0']);
      arm('P1 must-PASS an unfrozen ticket at the bound: verdict pending, exit 3 (NOT 2), reason acceptance-pending, the CI answer in the same line', g4.code === 3 && g4.json?.verdict === 'pending' && g4.json.reason === 'acceptance-pending' && 'fullSuite' in g4.json, J(g4));
      W.patchGh((s) => s.ciGreen.push(c4.head));
      const creates0 = W.count('pr create'), merges0 = W.count('pr merge');
      const d4 = W.deliver(c4, 'T-4');
      arm('P2 must-FAIL deliver of a ticket with no frozen tests: exit 2 acceptance-pending, no PR opened, nothing merged', d4.code === 2 && d4.json?.reason === 'acceptance-pending' && W.count('pr create') === creates0 && W.count('pr merge') === merges0, J(d4));
      const d5 = W.deliver(c4, 'T-4', ['--no-acceptance-gate']);
      arm('P3 must-PASS --no-acceptance-gate: merges, acceptanceGate:"bypassed" in the result AND the record in the state', d5.code === 0 && d5.json?.verdict === 'merged' && d5.json.acceptanceGate === 'bypassed' && tk('T-4').accept?.waived?.decision === 'deliver --no-acceptance-gate', J(d5));
      // a deliver that does NOT merge (CI never green, bounded timeout) must leave the ticket pending, not waived
      W.register('T-12'); const c12 = W.candidate('c-12', {});
      const dfail = W.deliver(c12, 'T-12', ['--no-acceptance-gate']);
      arm('P3b must-FAIL --no-acceptance-gate on a deliver that did NOT merge (CI never green): no merge, and NO waiver recorded on the ticket (a later plain deliver is still acceptance-pending)', dfail.code !== 0 && !tk('T-12').accept?.waived && W.deliver(c12, 'T-12').json?.reason === 'acceptance-pending', J(dfail));
      const strangerFreeze = W.freezeAs('stranger-9', 'T-2b', 't/spec.test.js');
      arm('F6 must-FAIL a workspace that is neither the ticket\'s recorded writer nor the run coordinator cannot freeze a forced ticket (exit 2, "only its test writer")', strangerFreeze.code === 2 && /only its test writer/.test(strangerFreeze.stderr) && !tk('T-2b').acceptance, J(strangerFreeze));
      W.register('T-5'); const c5 = W.candidate('c-5', {}); W.patchGh((s) => s.ciGreen.push(c5.head));
      const w0 = W.cli('rig', ['fanout', 'acceptance', 'waive', 'T-5', '--run', 'rig', '--decision', DECISION(901), '--reason', 'docs only']);
      const w0b = W.cli('rig', ['fanout', 'acceptance', 'waive', 'T-5', '--run', 'rig', '--decision', 'https://github.com/x/y/issues/511#issuecomment-900', '--reason', 'docs only']);
      arm('W1b must-FAIL a waiver whose decision is a comment of ANOTHER repo (not this vague\'s o/r): exit 2, nothing recorded', w0b.code === 2 && /not of this vague's repo o\/r/.test(w0b.stderr) && !tk('T-5').accept?.waived, J(w0b));
      const w1 = W.cli('rig', ['fanout', 'acceptance', 'waive', 'T-5', '--run', 'rig', '--decision', DECISION(900), '--reason', 'docs only']);
      const g5 = W.gate(c5, 'T-5', []);
      const d6 = W.deliver(c5, 'T-5');
      arm('W1 must-FAIL a waiver whose decision does not name the ticket: exit 2, nothing recorded', w0.code === 2 && /does not name ticket T-5/.test(w0.stderr), J(w0));
      arm('W2 must-PASS a waiver (decision naming the ticket + reason): recorded; the gate says waived; deliver proceeds (acceptanceGate waived)', w1.code === 0 && tk('T-5').accept?.waived?.reason === 'docs only' && g5.code === 0 && g5.json?.acceptance?.waived?.decision === DECISION(900) && d6.code === 0 && d6.json?.acceptanceGate === 'waived', `${J(w1)} | ${J(g5)} | ${J(d6)}`);
      // the host posts nothing on a stranger's word (direct request to the fake host)
      const before = posts().length;
      const reqHost = (body) => spawnSync(process.execPath, ['-e', `const http=require('http');const b=${JSON.stringify(JSON.stringify(body))};const r=http.request({socketPath:process.argv[1],method:'POST',path:'/fanoutAcceptance',headers:{'content-length':Buffer.byteLength(b)}},(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d))});r.end(b)`, path.join(W.dir, 'sock')], { encoding: 'utf8' });
      const stranger = JSON.parse(reqHost({ op: 'frozen', run: 'rig', ticket: 'T-1', from: 'someone-else' }).stdout.trim());
      arm('H1 must-FAIL the host refuses to post the freeze status on a stranger\'s word (neither the writer nor the run coordinator): ok:false, no new post', stranger.ok === false && posts().length === before, JSON.stringify(stranger));
      // stale / replace
      W.register('T-11');
      const st = JSON.parse(fs.readFileSync(path.join(W.dir, 'home', 'fanout', 'rig', 'state.json'), 'utf8'));
      const rp0 = W.cli('rig', ['fanout', 'acceptance', 'spawn', 'T-11', '--run', 'rig']);
      const n0 = spawns().length;
      const rp1 = W.cli('rig', ['fanout', 'acceptance', 'spawn', 'T-11', '--run', 'rig', '--replace']);
      arm('X1 must-FAIL spawn without --replace is refused while a live writer is recorded; must-PASS --replace respawns (a dead writer no longer strands the ticket)', rp0.code === 2 && rp1.code === 0 && spawns().length === n0 + 1 && tk('T-11').accept?.acceptor?.id === `writer-${n0 + 1}`, `${J(rp0)} | ${J(rp1)}`);
      const stuck = JSON.parse(JSON.stringify(st)); stuck.tickets['T-11'].accept = { acceptor: { id: null, name: 'accept-T-11', at: new Date(Date.now() - 3600_000).toISOString() }, wait: null, waived: null };
      fs.writeFileSync(path.join(W.dir, 'home', 'fanout', 'rig', 'state.json'), JSON.stringify(stuck, null, 2));
      const n1 = spawns().length;
      const rp2 = W.cli('rig', ['fanout', 'state', 'set', 'T-11', '--run', 'rig', '--status', 'started']);
      arm('X2 must-PASS a claim that never settled (app died mid-spawn, 1h old) is retaken by the next `state set`', rp2.code === 0 && spawns().length === n1 + 1, J(rp2));
      // ── review fix round: M1 (identity), M3 (unspecified), m4 (no --cwd), m7 (late recipient) ──
      W.cli('rig2', ['fanout', 'state', 'init', '--run', 'rig2']); W.cli('rig2', ['fanout', 'state', 'set', 'TX', '--run', 'rig2', '--status', 'started']);
      const stateRig2 = fs.readFileSync(path.join(W.dir, 'home', 'fanout', 'rig2', 'state.json'), 'utf8');
      const xrun = W.cli('writer-1', ['fanout', 'acceptance', 'freeze', 'TX', '--run', 'rig2', '--files', 't/spec.test.js', '--run-cmd', 'node --test t/spec.test.js'], W.wr);
      const xnew = W.cli('writer-1', ['fanout', 'acceptance', 'freeze', 'ZZ', '--run', 'rig2', '--files', 't/spec.test.js', '--run-cmd', 'node --test t/spec.test.js'], W.wr);
      arm('M1a must-FAIL (reviewer input A) a writer cannot freeze a ticket of ANOTHER run — neither an existing no-spec ticket nor a new one: exit 2 both, rig2\'s state byte-identical', xrun.code === 2 && xnew.code === 2 && /none recorded in this run/.test(xrun.stderr) && fs.readFileSync(path.join(W.dir, 'home', 'fanout', 'rig2', 'state.json'), 'utf8') === stateRig2, `${J(xrun)} | ${J(xnew)}`);
      const noId = W.cli('', ['fanout', 'acceptance', 'freeze', 'T-2b', '--run', 'rig', '--files', 't/spec.test.js', '--run-cmd', 'node --test t/spec.test.js'], W.wr);
      arm('M1b must-FAIL (reviewer input B) a freeze with NO workspace identity is refused (exit 2), not read as the coordinator', noId.code === 2 && /no workspace identity/.test(noId.stderr) && !tk('T-2b').acceptance, J(noId));
      const un = W.cli('rig', ['fanout', 'state', 'set', 'T-13', '--run', 'rig', '--status', 'started']);
      const c13 = W.candidate('c-13', {}); W.patchGh((x) => { x.ciGreen.push(c13.head); x.comments[902] = 'Ledger: T-13 is docs only, no testable promise.'; });
      const m0 = W.count('pr merge');
      const d13 = W.deliver(c13, 'T-13');
      arm('M3a must-FAIL a ticket with NO spec, nothing frozen, no waiver: `state set` says so up front; deliver = exit 2 acceptance-pending naming the three ways out, nothing merged', un.code === 0 && /T-13 has no --spec/.test(un.stderr) && d13.code === 2 && d13.json?.reason === 'acceptance-pending' && /register --spec[\s\S]*acceptance waive T-13[\s\S]*--no-acceptance-gate/.test(d13.json.detail) && W.count('pr merge') === m0, `${J(un)} | ${J(d13)}`);
      const wv13 = W.cli('rig', ['fanout', 'acceptance', 'waive', 'T-13', '--run', 'rig', '--decision', DECISION(902), '--reason', 'docs only']);
      const d13b = W.deliver(c13, 'T-13');
      arm('M3b must-PASS waive works WITHOUT a spec and deliver then proceeds (acceptanceGate waived)', wv13.code === 0 && d13b.code === 0 && d13b.json?.acceptanceGate === 'waived', `${J(wv13)} | ${J(d13b)}`);
      W.register('T-14'); const c14 = W.candidate('c-14', {});
      const t0 = Date.now();
      const g14 = W.gate(c14, 'T-14', ['--accept-wait', '60']);
      arm('M4 must-PASS a gate on an unfrozen ticket WITHOUT --cwd does not wait-then-refuse: pending exit 3 at once (< 20 s of a 60 s bound), detail says --cwd', g14.code === 3 && g14.json?.verdict === 'pending' && /no --cwd/.test(g14.json.detail) && Date.now() - t0 < 20_000, J(g14));
      W.cli('rig', ['fanout', 'state', 'set', 'T-15', '--run', 'rig', '--spec', 'docs/spec.md#T-15', '--verifier', 'verif-9']);
      W.writerTests('T-15', 't/spec15.test.js', 'f', 1);
      const w15 = 'writer-' + (spawns().findIndex((e) => e.name === 'accept-T-15') + 1);
      const fz15 = W.freezeAs(w15, 'T-15', 't/spec15.test.js');
      const p0 = posts().length;
      const late = W.cli('rig', ['fanout', 'state', 'set', 'T-15', '--run', 'rig', '--implementer', 'impl-9']);
      const np = posts().slice(p0);
      arm('M7 must-PASS an implementer recorded AFTER the freeze gets the frozen status (path + command) retroactively, ONLY it (the verifier told at the freeze is not told again)', fz15.code === 0 && p0 === posts().length - np.length && late.code === 0 && np.length === 1 && np[0].to === 'impl-9' && /t\/spec15\.test\.js/.test(np[0].body) && /Run: node --test t\/spec15\.test\.js/.test(np[0].body), `${J(fz15)} | ${J(late)} | ${JSON.stringify(np)}`);
      const sj = W.cli('rig', ['fanout', 'state', 'set', 'T-1', '--run', 'rig', '--json', JSON.stringify({ accept: { waived: { decision: 'x', reason: 'y', at: new Date().toISOString() } } })]);
      arm('S1 must-FAIL `state set --json` cannot write the code-owned `accept` field', sj.code === 1 && /unknown field/.test(sj.stderr), J(sj));
    })().catch((e) => arm('rig crashed: the arm sequence broke (a mutant that breaks the flow upstream lands here)', false, String(e?.message ?? e).slice(0, 300))).then(() => res).finally(() => { proc.kill(); W.kill(); }) };
  } catch (e) {
    arm('rig crashed', false, String(e?.stack ?? e).slice(0, 800));
    W.kill();
    return { async: Promise.resolve(res) };
  }
}

async function run(title, cliPath, sharedDir) {
  const s = scenarios(cliPath, sharedDir);
  const res = await s.async;
  console.log(`\n== ${title}`);
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
  const bad = res.filter((r) => !r.ok).length;
  console.log(`-- ${res.length - bad}/${res.length} PASS`);
  return bad;
}

// Each mutant breaks ONE clause (in the BUILT bundle, or in a scratch copy of src/shared for the host half); the anchor must occur exactly once.
const BUNDLE_MUTANTS = [
  { name: 'register: no spawn request is left for the host (needsAcceptor false)', find: 'return !a || !!a.error || claimIsStale(a, nowIso ?? (/* @__PURE__ */ new Date()).toISOString());', put: () => 'return false;' },
  { name: 'register: a writer is requested even without a spec / for a ticket that has one', find: 'if (!t || acceptancePhase(t) !== "pending") return false;', put: () => 'if (!t) return false;' },
  { name: 'freeze: the writer may freeze ANY ticket (own-ticket rule off)', find: 'if (own && own[0] !== ticket) throw new Refusal(', put: () => 'if (false) throw new Refusal(' },
  { name: 'freeze: not published to the shared branch (forced flow off)', find: 'const forced = !!had?.spec;', put: () => 'const forced = false;' },
  { name: 'freeze: a path with other bytes on the shared branch is overwritten', find: 'if (there && there !== blob) throw new Refusal(', put: () => 'if (false) throw new Refusal(' },
  { name: 'freeze: the host is not asked to post the status', find: 'const hostCalls = forced ? [{ route: "/fanoutAcceptance"', put: () => 'const hostCalls = false ? [{ route: "/fanoutAcceptance"' },
  { name: 'gate: an unfrozen ticket is not waited for (no pending branch)', find: 'const pendingRead = got && got.known && !got.acceptance && got.phase === "pending" ? got : null;', put: () => 'const pendingRead = null;' },
  { name: 'gate: the wait never ends on the freeze (polls to the bound)', find: 'if (cur.known && cur.acceptance) return { frozen: cur.acceptance, wait };', put: () => 'if (false) return { frozen: cur.acceptance, wait };' },
  { name: 'gate: pending answered as a REFUSAL (exit 2, consumes a round)', find: 'return { exit: DELIVER_EXIT.pending, result: { ...out, verdict: "pending", reason: "acceptance-pending", detail: `the frozen tests of ${opts.ticket} have not landed', put: () => 'return { exit: DELIVER_EXIT.refused, result: { ...out, verdict: "refused", reason: "acceptance-pending", detail: `the frozen tests of ${opts.ticket} have not landed' },
  { name: 'gate: the wait window is not recorded in the state', find: 'const wait = boundSec > 0 && deps.openWait && run ?', put: () => 'const wait = false ?' },
  { name: 'gate: a frozen file DIFFERENT (not only absent) is answered copy-pending instead of refused', find: '!acc.files.every((f) => f.status === "missing")', put: () => 'false' },
  { name: 'deliver: an unfrozen ticket with a spec merges (acceptance-pending off)', find: '} else if (got.phase === "pending" || got.phase === "unspecified") {', put: () => '} else if (false) {' },
  { name: 'deliver: --no-acceptance-gate is not recorded in the state', find: 'deps.recordBypass?.({ ticket: opts.ticket, run: bypassRec.run, head: bypassRec.head });', put: () => '' },
  { name: 'deliver: --no-acceptance-gate is ignored (still refuses)', find: 'if (!opts.noAcceptanceGate) {', put: () => 'if (true) {' },
  { name: 'deliver: the bypass is recorded BEFORE the merge landed (a failed merge leaves a false waiver)', find: 'if (bypassRec && (result.verdict === "merged" || result.verdict === "already-merged")) {', put: () => 'if (bypassRec) {' },
  { name: 'gate: a candidate older than the freeze with all files absent is REFUSED (early copy-pending off)', find: 'return Number.isFinite(ct) && ct < Math.floor(Date.parse(frozen.frozenAt) / 1e3);', put: () => 'return false;' },
  { name: 'freeze: a freeze with no workspace identity is accepted (M1b)', find: 'if (!caller) throw new Refusal(', put: () => 'if (false) throw new Refusal(' },
  { name: 'freeze: any caller may freeze in the run it addresses (M1a)', find: 'if (caller !== r.run && caller !== had?.accept?.acceptor?.id) throw new Refusal(', put: () => 'if (false) throw new Refusal(' },
  { name: 'deliver: an UNSPECIFIED ticket (no spec / frozen / waiver) merges (M3)', find: '} else if (got.phase === "pending" || got.phase === "unspecified") {', put: () => '} else if (got.phase === "pending") {' },
  { name: 'state set: no up-front notice for an unspecified ticket (M3)', find: 'const notice = accOn && acceptancePhase(t) === "unspecified" &&', put: () => 'const notice = false &&' },
  { name: 'waive: needs a spec again (M3)', find: 'if (t.accept?.waived) throw new FanoutStateError(`${id}: already waived', put: () => 'if (!t.spec) throw new FanoutStateError("no spec registered");\n  if (t.accept?.waived) throw new FanoutStateError(`${id}: already waived' },
  { name: 'gate: waits for a freeze it cannot run (no --cwd, m4)', find: 'if (!opts.cwd) {', put: () => 'if (false) {' },
  { name: 'state set: a recipient recorded after the freeze is not told (m7)', find: 'if (t.acceptance && t.spec && late.length)', put: () => 'if (false)' },
  { name: 'spawn: --replace is ignored (a recorded writer can never be replaced)', find: 'const replace = p.bools.has("--replace");', put: () => 'const replace = false;' },
  { name: 'waive: a decision from any repo accepted', find: 'if (st0.repo !== null && st0.repo.toLowerCase() !== decisionRepo.toLowerCase()) throw new Refusal(', put: () => 'if (false) throw new Refusal(' },
  { name: 'waive: the decision need not name the ticket', find: 'if (!body.toLowerCase().includes(ticket.toLowerCase())) throw new Refusal(', put: () => 'if (false) throw new Refusal(' },
  { name: 'state set: --json may write the code-owned accept field', find: 'refuseUnknown(patch, new Set(SETTABLE_KEYS), "patch");', put: () => 'refuseUnknown(patch, new Set([...SETTABLE_KEYS, "accept"]), "patch");', extra: [{ find: 'if ("spec" in patch) next.spec', put: (m) => `if ("accept" in patch) next.accept = patch.accept;\n  ${m}` }] },
];
const HOST_MUTANTS = [
  { file: 'fanout-acceptance-host.ts', name: 'host: the retroactive status goes to every recorded recipient again (m7)', find: '.filter((id) => !retro || retro.includes(id))', put: () => '' },
  { file: 'fanout-acceptance.ts', name: 'host: a stale in-flight claim is never retaken (ticket stuck after an app crash)', find: 'return a.id === null && !a.error && Date.parse(nowIso)', put: () => 'return false && Date.parse(nowIso)' },
  { file: 'fanout-acceptance-host.ts', name: 'host: the slot is not claimed under the lock (a second request spawns a second writer)', find: 'const next = claimAcceptor(cur, ticket, name, deps.now(), { replace: input.replace === true });', put: () => 'const next = cur;' },
  { file: 'fanout-acceptance-host.ts', name: 'host: the freeze status is posted on a stranger\'s word', find: 'if (!retro && from && from !== writer && from !== run) return', put: () => 'if (false) return' },
  { file: 'fanout-acceptance.ts', name: 'host: the freeze status goes to the implementer only', find: 'return [...new Set([t.implementer, t.verifier]', put: () => 'return [...new Set([t.implementer]' },
  { file: 'fanout-acceptance.ts', name: 'host: the writer\'s brief carries the ticket\'s implementer branch', find: 'Spec: ${o.spec}  (read the spec', put: () => 'Spec: ${o.spec} (impl-t1)  (read the spec' },
  { file: 'fleet-roles.ts', name: 'role table: the accept- role pins no model', find: "acceptor: { role: 'acceptor', model: ACCEPTOR_MODEL,", put: () => "acceptor: { role: 'acceptor', model: undefined," },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!orig.includes('/fanoutAcceptance')) { console.error('dist-electron/cli.js has no forced acceptance flow — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

// the host-side role-table arm: the spawn name resolves to Opus 5.5 through the table (read from the SHARED_DIR under test)
function roleArm(sharedDir) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', `import('${sharedDir}/fleet-roles.ts').then((m) => { const d = m.resolveSpawnRoleDefaults('accept-T-1', {}); const o = m.resolveSpawnRoleDefaults('impl-x', {}); console.log(JSON.stringify({ accept: d.model ?? null, impl: o.model ?? null, role: m.roleOfName('accept-T-1') })); })`], { encoding: 'utf8' });
  try { const j = JSON.parse(r.stdout.trim()); return j.accept === 'claude-opus-5-5' && j.impl === null && j.role === 'acceptor'; } catch { return false; }
}

const baselineBad = (await run('baseline (built bundle + src/shared)', CLI, SHARED)) + (roleArm(SHARED) ? 0 : (console.log('FAIL  T1 role table: accept- resolves to claude-opus-5-5, impl- to nothing'), 1));
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-forced-mut-'));
const only = process.env.MUT_ONLY?.split(',');
for (const [i, m] of BUNDLE_MUTANTS.entries()) {
  if (only && !only.includes(`b${i}`)) continue;
  let src = orig;
  for (const step of [m, ...(m.extra ?? [])]) {
    const n = src.split(step.find).length - 1;
    if (n !== 1) { console.error(`MUTANT b${i} "${m.name}": anchor found ${n}× (needs exactly 1) — the bundle shape changed, fix the rig`); process.exit(1); }
    src = src.replace(step.find, () => step.put(step.find));
  }
  const file = path.join(scratch, `mutant-b${i}.js`);
  fs.writeFileSync(file, src);
  const bad = await run(`MUTANT b${i}: ${m.name}`, file, SHARED);
  console.log(bad > 0 ? `   → KILLED (${bad} arm(s) red)` : '   → SURVIVED (no arm noticed it)');
  if (bad === 0) survived++;
}
for (const [i, m] of HOST_MUTANTS.entries()) {
  if (only && !only.includes(`h${i}`)) continue;
  const dst = path.join(scratch, `shared-h${i}`);
  fs.cpSync(SHARED, dst, { recursive: true, filter: (s) => !/\.test\.ts$/.test(s) });
  const f = path.join(dst, m.file);
  const text = fs.readFileSync(f, 'utf8');
  const n = text.split(m.find).length - 1;
  if (n !== 1) { console.error(`MUTANT h${i} "${m.name}": anchor found ${n}× in ${m.file} (needs exactly 1)`); process.exit(1); }
  fs.writeFileSync(f, text.replace(m.find, () => m.put()));
  const bad = (await run(`MUTANT h${i}: ${m.name}`, CLI, dst)) + (roleArm(dst) ? 0 : 1);
  console.log(bad > 0 ? `   → KILLED (${bad} arm(s) red)` : '   → SURVIVED (no arm noticed it)');
  if (bad === 0) survived++;
}
fs.rmSync(scratch, { recursive: true, force: true });
if (fs.readFileSync(CLI, 'utf8') !== orig) { console.error('the real bundle changed during the run'); process.exit(1); }
console.log(`\n${BUNDLE_MUTANTS.length + HOST_MUTANTS.length - survived}/${BUNDLE_MUTANTS.length + HOST_MUTANTS.length} mutants killed; real bundle byte-identical`);
process.exit(survived ? 1 : 0);

#!/usr/bin/env node
// #552 rig — a MINOR that breaks a sentence of the ticket's spec (`specSentence`) blocks the merge; `kind: process`; the spec capture. Through the BUILT CLI (dist-electron/cli.js):
// scratch ORCHESTRA_HOME + scratch bare repo + a fake `gh` on PATH, like scripts/e2e-fanout-followup.mjs (#514). Light: no Electron, no network, no tokens, scratch under $TMPDIR.
//   node scripts/e2e-spec-sentence.mjs            baseline: every arm must PASS (a must-PASS and a must-FAIL arm per clause)
//   node scripts/e2e-spec-sentence.mjs --mutants  each patched copy of the BUILT bundle must be KILLED (≥1 arm FAILs); the baseline is the control
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const tmpBase = process.env.TMPDIR || os.tmpdir();

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
  const m = /\\/commits\\/([0-9a-f]{7,40})$/.exec(args[args.length - 1]);
  if (m) { const r = git('rev-parse', m[1] + '^{tree}'); if (r.status === 0) out({ commit: { tree: { sha: r.stdout.trim() } } }); }
  fail('gh: Not Found (HTTP 404)'); // no workflows, no such commit
}
if (a === 'pr' && b === 'list') {
  const base = args.includes('--base') ? val('--base') : null, head = val('--head'), states = val('--state');
  out(st.prs.filter((p) => p.headRefName === head && (!base || p.base === base) && (states === 'all' || p.state.toLowerCase() === states)).map((p) => ({ number: p.number, url: p.url, state: p.state, baseRefName: p.base, headRefOid: headOf(p) })));
}
if (a === 'pr' && b === 'diff') out('src/impl.js\\n');
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
  if (want !== null && want !== held) fail('Pull request is not mergeable: the head branch was modified.');
  p.state = 'MERGED'; p.head = held; out('');
}
fail('unexpected gh call: ' + args.join(' '));
`;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

/** One scratch world: bare origin with 3 candidate branches, a state where T-1 is merged and carries findings F-MAJ (MAJOR), F-BLK (BLOCKING), F-MIN (MINOR). */
function world(cliPath) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'spec-sentence-rig-'));
  if (!path.resolve(dir).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
  const bare = path.join(dir, 'origin.git'), work = path.join(dir, 'work'), bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  for (const d of [bin, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const ghFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(ghFile, JSON.stringify({ prs: [], ciGreen: [], log: [] }));
  const gitEnv = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@x', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: home, PATH: process.env.PATH };
  const gw = (args) => sh('git', args, { cwd: work, env: gitEnv }).stdout.trim();
  sh('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: gitEnv });
  sh('git', ['clone', '-q', bare, work], { env: gitEnv });
  gw(['checkout', '-q', '-b', 'master']);
  fs.writeFileSync(path.join(work, 'f.txt'), 'base\n'); gw(['add', '.']); gw(['commit', '-q', '-m', 'base']); gw(['push', '-q', 'origin', 'master']);
  const heads = {};
  for (const b of ['t1', 'fu', 'plain']) { // t1 = what T-1 merged at; fu / plain = candidates
    gw(['checkout', '-q', '-B', b, 'master']); fs.writeFileSync(path.join(work, `${b}.txt`), `${b}\n`); gw(['add', '.']); gw(['commit', '-q', '-m', b]); gw(['push', '-q', '-f', 'origin', b]);
    heads[b] = gw(['rev-parse', 'HEAD']);
  }
  // t1b = the SAME tree as t1 on another sha (a rebase / author rewrite, #512)
  heads.t1b = gw(['commit-tree', `${heads.t1}^{tree}`, '-p', 'master', '-m', 'rewritten']);
  gw(['push', '-q', '-f', 'origin', `${heads.t1b}:refs/heads/t1b`]);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'rig', FAKE_GH_STATE: ghFile, FAKE_GH_BARE: bare, GIT_CONFIG_GLOBAL: '/dev/null' };
  const cli = (args, timeoutMs = 90_000) => {
    const r = spawnSync(process.execPath, [cliPath, 'fanout', ...args], { encoding: 'utf8', env, timeout: timeoutMs, cwd: work });
    let json = null; try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not a JSON verb */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  // a `--spec` registration asks the HOST (the app) to spawn the test writer; the rig has no app, so the verb answers rc 1 AFTER writing the state — the write is what is under test, so that rc is normalised to 0
  const set = (ticket, ...a) => { const r = cli(['state', 'set', ticket, '--run', 'rig', ...a]); return r.code === 1 && /test writer was NOT spawned/.test(r.stderr) && /^[^\n]+: (todo|started|nominated|gated|merged|dropped) verdict=/.test(r.stdout) ? { ...r, code: 0 } : r; };
  const statePath = path.join(home, 'fanout', 'rig', 'state.json');
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  /** Edit the state file directly: a hand-edit that bypasses `state set` (gate / deliver must still refuse). */
  const handEdit = (fn) => { const s = readState(); fn(s); fs.writeFileSync(statePath, JSON.stringify(s)); };
  const ghLog = () => JSON.parse(fs.readFileSync(ghFile, 'utf8')).log;
  const count = (verb) => ghLog().filter((l) => l.startsWith(verb)).length;
  const gate = (ticket, branch, head) => cli(['gate', '--branch', branch, '--into', 'master', '--head', head, '--ticket', ticket, '--run', 'rig']);
  const deliver = (ticket, branch, head) => cli(['deliver', '--branch', branch, '--into', 'master', '--ticket', ticket, '--run', 'rig', '--no-review-gate', '--verified-head', head, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1', '--no-acceptance-gate']); // #515 M3: unspecced rig tickets need the explicit escape
  const setCi = (h) => { const s = JSON.parse(fs.readFileSync(ghFile, 'utf8')); s.ciGreen.push(h); fs.writeFileSync(ghFile, JSON.stringify(s)); };
  cli(['state', 'init', '--run', 'rig', '--repo', 'o/r', '--switch', 'acceptance=on,minorPolicy=spec']);
  const SPEC = 'Write the list in the pull request.\nThe endpoint returns 404 for an unknown id.\nUse   two spaces here.\n';
  const SENT = 'The endpoint returns 404 for an unknown id.';
  const PROC = 'Write the list in the pull request.';
  fs.writeFileSync(path.join(work, 'spec.md'), SPEC);
  fs.writeFileSync(path.join(work, 'other-spec.md'), 'A different spec.\n');
  /** Register T-1 (a candidate on branch t1) with its spec; the acceptance flow is waived by a hand edit (it is not this rig's subject). `merged` = T-1 already merged. */
  const register = (merged = false) => {
    const r = set('T-1', '--status', 'nominated', '--branch', 't1', '--head', heads.t1, '--spec', 'spec.md');
    if (r.code !== 0) throw new Error(`rig setup failed: ${r.stdout}${r.stderr}`);
    handEdit((s) => { s.tickets['T-1'].accept = { acceptor: null, wait: null, waived: { decision: 'rig', reason: 'rig', at: '2026-11-23T10:00:00.000Z' } }; });
    set('T-2', '--status', 'started', '--branch', 'plain');
    handEdit((s) => { s.tickets['T-2'].accept = { acceptor: null, wait: null, waived: { decision: 'rig', reason: 'rig', at: '2026-11-23T10:00:00.000Z' } }; });
  };
  const finding = (id, rec) => set('T-1', '--finding-json', JSON.stringify({ [id]: rec }));
  const markMerged = () => { const m = set('T-1', '--status', 'merged'); if (m.code !== 0) throw new Error(`rig setup failed: ${m.stdout}${m.stderr}`); };
  return { heads, cli, set, readState, handEdit, count, gate, deliver, setCi, work, SPEC, SENT, PROC, register, finding, markMerged, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const crash = (arm) => (e) => arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false);

/** Every arm; returns [{name, ok, detail}]. `cliPath` is the bundle under test (baseline or a mutant). */
function scenarios(cliPath) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const T1 = (A) => A.readState().tickets['T-1'];

  // ── spec capture + the specSentence acceptance rule (state set) ──
  { const A = world(cliPath); try {
    A.register();
    arm('capture must-PASS: --spec <file> stores the text read at registration (specText = the file, byte for byte)', T1(A).specText === A.SPEC, JSON.stringify(T1(A).specText));
    const ok = A.finding('F-1', { severity: 'MINOR', specSentence: A.SENT });
    arm('sentence must-PASS: a literal substring of the captured spec is accepted and recorded (rc 0)', ok.code === 0 && T1(A).findings['F-1']?.specSentence === A.SENT, `${ok.code} ${ok.stderr}`);
    const multi = A.finding('F-2', { severity: 'MINOR', specSentence: 'Use   two spaces here.' });
    arm('sentence must-PASS: the match is verbatim (the spec\'s own double space is part of it)', multi.code === 0, `${multi.code} ${multi.stderr}`);
    const nf = A.finding('F-3', { severity: 'MINOR', specSentence: 'The endpoint returns 500.' });
    arm('sentence must-FAIL: a sentence NOT in the captured spec is refused (rc 1) and nothing is recorded', nf.code === 1 && /not a literal sentence/.test(nf.stderr) && !T1(A).findings['F-3'], `${nf.code} ${nf.stderr}`);
    for (const [label, sentence] of [['empty', ''], ['whitespace-only', '   \n '], ['case-folded', A.SENT.toUpperCase()], ['re-spaced (single space for the spec\'s two)', 'Use two spaces here.'], ['padded (no trim of the sentence)', ` ${A.SENT}`]]) {
      const r = A.finding('F-X', { severity: 'MINOR', specSentence: sentence });
      arm(`sentence must-FAIL: ${label} ⇒ refused (rc 1), nothing recorded`, r.code === 1 && !T1(A).findings['F-X'], `${r.code} ${r.stderr}`);
    }
    for (const [label, sentence] of [['one character', 'a'], ['one word', 'endpoint'], ['two words', 'The endpoint'], ['a rule line', '- - -']]) {
      const r = A.finding('F-X', { severity: 'MINOR', specSentence: sentence });
      arm(`sentence must-FAIL (D5 m2): ${label} is no sentence (fewer than 15 characters) ⇒ refused (rc 1), nothing recorded`, r.code === 1 && /at least 15 characters/.test(r.stderr) && !T1(A).findings['F-X'], `${r.code} ${r.stderr}`);
    }
    const fg = A.cli(['state', 'set', 'T-1', '--run', 'rig', '--json', JSON.stringify({ specText: 'forged' })]);
    arm('capture must-FAIL: specText is derived — `state set --json {specText}` is refused and the captured text is unchanged', fg.code === 1 && T1(A).specText === A.SPEC, `${fg.code} ${fg.stderr}`);
    const rs = A.set('T-1', '--spec', 'other-spec.md');
    arm('capture must-FAIL: re-capturing a spec that no longer holds an accepted unsettled sentence is refused (it must not silently un-block a merge), the text is unchanged', rs.code === 1 && /no longer contains the specSentence/.test(rs.stderr) && T1(A).specText === A.SPEC, `${rs.code} ${rs.stderr}`);
    A.set('T-2', '--spec', 'spec.md');
    const r2 = A.set('T-2', '--spec', 'other-spec.md');
    arm('capture must-PASS: re-registering a spec as another file re-captures it (the old text is not kept under a new reference)', r2.code === 0 && A.readState().tickets['T-2'].specText === 'A different spec.\n', `${r2.code} ${r2.stderr}`);
  } catch (e) { crash(arm)(e); } finally { A.cleanup(); } }
  { const A = world(cliPath); try {
    // a spec that is not a readable file (a URL / ledger section) is NOT captured: a sentence is refused until the text is given with --spec-text
    A.set('T-1', '--status', 'started', '--branch', 't1', '--spec', 'https://example.invalid/ticket/1');
    arm('capture must-FAIL: a URL spec is not read — no spec text is stored', (T1(A).specText ?? null) === null, JSON.stringify(T1(A).specText));
    const r = A.finding('F-1', { severity: 'MINOR', specSentence: A.SENT });
    arm('sentence must-FAIL: no captured spec text ⇒ any sentence is refused, naming how to capture it', r.code === 1 && /no spec text was captured/.test(r.stderr) && /--spec-text/.test(r.stderr), `${r.code} ${r.stderr}`);
    A.set('T-2', '--spec', 'spec.md');
    A.set('T-2', '--spec', 'https://example.invalid/ticket/2');
    arm('capture must-FAIL: a ticket re-registered under a URL spec does NOT keep the previous spec\'s text', (A.readState().tickets['T-2'].specText ?? null) === null, JSON.stringify(A.readState().tickets['T-2'].specText));
    const cap = A.set('T-1', '--spec-text', path.join(A.work, 'spec.md'));
    const r2 = A.finding('F-1', { severity: 'MINOR', specSentence: A.SENT });
    A.set('T-2', '--spec', 'https://example.invalid/ticket/3');
    A.set('T-2', '--spec-text', path.join(A.work, 'spec.md'));
    A.set('T-2', '--spec', 'https://example.invalid/ticket/3');
    arm('capture must-PASS (review): re-passing the SAME URL spec keeps the text a --spec-text gave it (nothing to re-read ⇒ nothing cleared)', A.readState().tickets['T-2'].specText === A.SPEC, JSON.stringify(A.readState().tickets['T-2'].specText));
    fs.writeFileSync(path.join(A.work, 'grow.md'), 'x'.repeat(200_001));
    const big = A.set('T-4', '--status', 'started', '--spec', 'grow.md', '--spec-text', path.join(A.work, 'spec.md'));
    const excerpt = A.readState().tickets['T-4'].specText === A.SPEC;
    const again = A.set('T-4', '--spec', 'grow.md');
    arm('capture must-PASS (review m2): re-passing the SAME too-big spec file keeps the --spec-text excerpt the note told the user to give', big.code === 0 && excerpt && again.code === 0 && A.readState().tickets['T-4'].specText === A.SPEC, `${big.code} ${again.code} ${again.stderr} ${JSON.stringify(A.readState().tickets['T-4'].specText)}`);
    const moved = A.set('T-4', '--spec', 'other-spec.md');
    arm('capture must-PASS (D5 m5): a CHANGED reference re-captures — the excerpt of the old reference is not kept', moved.code === 0 && A.readState().tickets['T-4'].specText === 'A different spec.\n', `${moved.code} ${moved.stderr}`);
    fs.writeFileSync(path.join(A.work, 'crlf-spec.md'), A.SPEC.replace(/\n/g, '\r\n'));
    A.set('T-3', '--status', 'started', '--spec', 'crlf-spec.md');
    arm('capture must-PASS (D5 m3): a CRLF spec is captured with LF line endings', A.readState().tickets['T-3'].specText === A.SPEC, JSON.stringify(A.readState().tickets['T-3'].specText).slice(0, 80));
    const crlf = A.set('T-3', '--finding-json', JSON.stringify({ 'F-9': { severity: 'MINOR', specSentence: 'pull request.\nThe endpoint returns 404' } }));
    arm('sentence must-PASS (D5 m3): a sentence spanning a line break matches a CRLF spec', crlf.code === 0, `${crlf.code} ${crlf.stderr}`);
    arm('capture must-PASS: --spec-text <file> captures the text of a URL spec; the sentence is then accepted', cap.code === 0 && T1(A).specText === A.SPEC && r2.code === 0, `${cap.code} ${cap.stderr} / ${r2.code} ${r2.stderr}`);
  } catch (e) { crash(arm)(e); } finally { A.cleanup(); } }

  // ── the merge block: gate + deliver ──
  { const A = world(cliPath); try {
    A.register(); A.setCi(A.heads.t1);
    A.finding('F-1', { severity: 'MINOR', specSentence: A.SENT });
    A.finding('F-2', { severity: 'MINOR', evidence: 'measured', report: { input: 'i', happens: 'h', where: 'w', proof: 'p' } });
    A.finding('F-3', { severity: 'MINOR', evidence: 'argued' });
    const rg = A.set('T-1', '--finding', 'F-1=MAJOR');
    arm('record must-FAIL: a recorded severity is never re-graded (rc 1, still MINOR)', rg.code === 1 && /not re-graded/.test(rg.stderr) && T1(A).findings['F-1'].severity === 'MINOR', `${rg.code} ${rg.stderr}`);
    const fs1 = A.finding('F-1', { severity: 'MINOR', specSentence: A.SENT, settled: { how: 'fixed', at: '2026-11-23T10:00:00.000Z', ref: 'forged' } });
    arm('record must-FAIL: a settlement cannot be forged through --finding-json (only --settle / --decide write it)', fs1.code === 1 && /--decide \/ --settle/.test(fs1.stderr) && !T1(A).findings['F-1'].settled, `${fs1.code} ${fs1.stderr}`);
    const g = A.gate('T-1', 't1', A.heads.t1);
    arm('gate must-FAIL: an unsettled MINOR with an accepted spec sentence ⇒ rc 2 finding-unsettled, the reason names the finding (and not the others)', g.code === 2 && g.json?.reason === 'finding-unsettled' && /F-1/.test(g.json?.detail ?? '') && !/F-2|F-3/.test(g.json?.detail ?? ''), `${g.code} ${g.stdout}`);
    const d = A.deliver('T-1', 't1', A.heads.t1);
    arm('deliver must-FAIL: the same ⇒ rc 2 finding-unsettled, no PR opened, nothing merged', d.code === 2 && d.json?.reason === 'finding-unsettled' && A.count('pr create') === 0 && A.count('pr merge') === 0, `${d.code} ${d.stdout}`);
    arm('limit: the refusal says code checks the sentence is IN the spec, not that it is really broken', /not that it is really broken/.test(d.json?.detail ?? ''), d.json?.detail);
    const sf = A.set('T-1', '--settle', `F-1=fixed:${A.heads.t1.slice(0, 8)}`);
    arm('settle must-PASS: --settle F-1=fixed:<ref> records it (rc 0, settled.how fixed)', sf.code === 0 && T1(A).findings['F-1']?.settled?.how === 'fixed', `${sf.code} ${sf.stderr}`);
    const g2 = A.gate('T-1', 't1', A.heads.t1);
    arm('gate must-PASS: once settled, the MINOR no longer blocks (MINOR without a sentence and an argued MINOR never did) — rc 0', g2.code === 0 && g2.json?.verdict === 'gate', `${g2.code} ${g2.stdout}`);
    const d2 = A.deliver('T-1', 't1', A.heads.t1);
    arm('deliver must-PASS: it merges (rc 0, verdict merged)', d2.code === 0 && d2.json?.verdict === 'merged' && A.count('pr merge') === 1, `${d2.code} ${d2.stdout}`);
  } catch (e) { crash(arm)(e); } finally { A.cleanup(); } }
  { const A = world(cliPath); try {
    A.register(); A.setCi(A.heads.t1);
    A.finding('F-1', { severity: 'MINOR', specSentence: A.SENT });
    const dc = A.set('T-1', '--decide', 'F-1=accepted as is, ledger c/9');
    arm('decide must-PASS: --decide F-1=<text> records the decision (by = the recording workspace)', dc.code === 0 && T1(A).findings['F-1']?.decision?.text === 'accepted as is, ledger c/9' && T1(A).findings['F-1']?.decision?.by === 'rig', `${dc.code} ${dc.stderr}`);
    const d = A.deliver('T-1', 't1', A.heads.t1);
    arm('deliver must-PASS: a decided MINOR no longer blocks (merges, rc 0)', d.code === 0 && d.json?.verdict === 'merged', `${d.code} ${d.stdout}`);
  } catch (e) { crash(arm)(e); } finally { A.cleanup(); } }
  { const A = world(cliPath); try {
    A.register(); A.setCi(A.heads.t1);
    A.finding('F-1', { severity: 'MINOR', evidence: 'measured', report: { input: 'i', happens: 'h', where: 'w', proof: 'p' } });
    A.handEdit((s) => { s.tickets['T-1'].findings['F-1'] = { severity: 'MINOR', specSentence: 'a sentence the spec never contained' }; });
    const g = A.gate('T-1', 't1', A.heads.t1);
    arm('gate must-PASS: a hand-edited sentence that is NOT in the captured spec does not block (the substring is re-checked where it is acted on)', g.code === 0 && g.json?.verdict === 'gate', `${g.code} ${g.stdout}`);
    A.handEdit((s) => { s.tickets['T-1'].specText = null; s.tickets['T-1'].findings['F-1'] = { severity: 'MINOR', specSentence: 'x y z x y z x y z' }; });
    const g2 = A.gate('T-1', 't1', A.heads.t1);
    arm('gate must-PASS: a sentence with NO captured spec text does not block', g2.code === 0, `${g2.code} ${g2.stdout}`);
  } catch (e) { crash(arm)(e); } finally { A.cleanup(); } }

  // ── kind: process ──
  { const A = world(cliPath); try {
    A.register(); A.setCi(A.heads.t1);
    A.finding('P-1', { severity: 'MINOR', kind: 'process', specSentence: A.PROC });
    const d = A.deliver('T-1', 't1', A.heads.t1);
    arm('process must-FAIL: an unsettled process finding with an accepted sentence blocks the merge (rc 2 finding-unsettled), the way out named: the PR body', d.code === 2 && d.json?.reason === 'finding-unsettled' && /edit the PR body/.test(d.json?.detail ?? '') && /--settle P-1=pr-body/.test(d.json?.detail ?? ''), `${d.code} ${d.stdout}`);
    const flip = A.finding('P-1', { severity: 'MINOR', kind: 'code' });
    arm('process must-FAIL: a recorded kind is not rewritten (process → code would dodge the PR-body way out) (rc 1)', flip.code === 1 && /already records kind/.test(flip.stderr) && T1(A).findings['P-1'].kind === 'process', `${flip.code} ${flip.stderr}`);
    const bad = A.set('T-1', '--settle', 'P-1=fixed:abc1234');
    arm('process must-FAIL: a process finding is never settled as a code fix (rc 1)', bad.code === 1 && /PR-body edit/.test(bad.stderr) && !T1(A).findings['P-1'].settled, `${bad.code} ${bad.stderr}`);
    const ok = A.set('T-1', '--settle', 'P-1=pr-body:PR #7 now carries the list');
    arm('process must-PASS: --settle P-1=pr-body:<ref> records the PR-body edit as such', ok.code === 0 && T1(A).findings['P-1']?.settled?.how === 'pr-body' && /PR #7/.test(T1(A).findings['P-1']?.settled?.ref ?? ''), `${ok.code} ${ok.stderr}`);
    const d2 = A.deliver('T-1', 't1', A.heads.t1);
    arm('process must-PASS: settled by the PR-body edit ⇒ the merge goes through (no code round happened)', d2.code === 0 && d2.json?.verdict === 'merged', `${d2.code} ${d2.stdout}`);
  } catch (e) { crash(arm)(e); } finally { A.cleanup(); } }
  { const A = world(cliPath); try {
    A.register();
    A.finding('C-1', { severity: 'MINOR', specSentence: A.SENT });
    const late = A.finding('C-1', { severity: 'MINOR', kind: 'process' });
    arm('process must-FAIL: a finding recorded with no kind (a code finding) cannot be turned into a process one later (it would dodge the fix) (rc 1)', late.code === 1 && /already records kind "code"/.test(late.stderr) && T1(A).findings['C-1'].kind === undefined, `${late.code} ${late.stderr}`);
    const bad = A.set('T-1', '--settle', 'C-1=pr-body:PR #7');
    arm('settle must-FAIL: a code finding is not settled by a PR-body edit (rc 1)', bad.code === 1 && /settled by a fix/.test(bad.stderr), `${bad.code} ${bad.stderr}`);
    const none = A.set('T-1', '--settle', 'C-1=fixed:');
    arm('settle must-FAIL: a settlement needs its reference', none.code === 1, `${none.code} ${none.stderr}`);
    const nof = A.set('T-1', '--settle', 'GHOST=fixed:abc');
    arm('settle must-FAIL: an unknown finding id is refused', nof.code === 1 && /no such finding/.test(nof.stderr), `${nof.code} ${nof.stderr}`);
  } catch (e) { crash(arm)(e); } finally { A.cleanup(); } }

  // ── the follow-up rule under minorPolicy spec ──
  { const A = world(cliPath); try {
    A.register();
    A.finding('F-S', { severity: 'MINOR', specSentence: A.SENT });
    A.finding('F-M', { severity: 'MINOR', evidence: 'measured', report: { input: 'i', happens: 'h', where: 'w', proof: 'p' } });
    A.finding('F-ARG', { severity: 'MINOR', evidence: 'argued' });
    A.finding('F-SARG', { severity: 'MINOR', evidence: 'argued', specSentence: A.SENT });
    A.finding('P-1', { severity: 'MINOR', kind: 'process', specSentence: A.PROC });
    A.finding('F-MAJ', 'MAJOR');
    A.markMerged();
    const fu = (fixes, id = 'T-1-fu') => A.set(id, '--status', 'started', '--branch', 'fu', '--follow-up-of', 'T-1', '--fixes', fixes);
    const ok = fu('F-S');
    arm('follow-up must-PASS: a follow-up naming a MINOR with an accepted spec sentence is accepted (rc 0, recorded)', ok.code === 0 && A.readState().tickets['T-1-fu']?.fixes?.[0] === 'F-S', `${ok.code} ${ok.stderr}`);
    const m = fu('F-M', 'T-1-fu2');
    arm('follow-up must-FAIL: a measured MINOR WITHOUT a sentence is refused (rc 1 followup-minor-only)', m.code === 1 && /only MINOR/.test(m.stderr) && !A.readState().tickets['T-1-fu2'], `${m.code} ${m.stderr}`);
    const a = fu('F-ARG', 'T-1-fu3');
    arm('follow-up must-FAIL: an argued MINOR is refused under spec', a.code === 1 && /only MINOR/.test(a.stderr) && /MINOR findings get no action/.test(a.stderr), `${a.code} ${a.stderr}`);
    const pin = fu('F-SARG', 'T-1-fu7');
    arm('follow-up must-PASS (D5 pin): an ARGUED MINOR whose sentence is accepted IS a valid --fixes target (the accepted sentence is the only criterion)', pin.code === 0 && A.readState().tickets['T-1'].findings['F-SARG'].evidence === 'argued', `${pin.code} ${pin.stderr}`);
    const mj = fu('F-MAJ', 'T-1-fu4');
    arm('follow-up must-PASS: a MAJOR is still enough (#514 unchanged)', mj.code === 0, `${mj.code} ${mj.stderr}`);
    const p = fu('P-1', 'T-1-fu5');
    arm('follow-up must-FAIL: a process finding never starts a code round (rc 1), the PR-body way named', p.code === 1 && /process finding/.test(p.stderr) && /pr-body/.test(p.stderr) && !A.readState().tickets['T-1-fu5'], `${p.code} ${p.stderr}`);
    const pm = fu('P-1,F-MAJ', 'T-1-fu6');
    arm('follow-up must-FAIL: …even beside a MAJOR', pm.code === 1, `${pm.code} ${pm.stderr}`);
    A.handEdit((s) => { s.tickets['T-1'].findings['F-M'] = { severity: 'MINOR', specSentence: 'not in the spec at all' }; });
    const gh = A.gate('T-1-fu', 'fu', A.heads.fu);
    arm('follow-up gate must-PASS: the accepted-sentence follow-up passes the gate clause (rc 0)', gh.code === 0 && gh.json?.verdict === 'gate', `${gh.code} ${gh.stdout}`);
    A.handEdit((s) => { s.tickets['T-1-fu'].fixes = ['F-M']; });
    const gm = A.gate('T-1-fu', 'fu', A.heads.fu);
    arm('follow-up gate must-FAIL: a hand-edited follow-up naming a MINOR whose sentence is not in the spec ⇒ rc 2 followup-minor-only', gm.code === 2 && gm.json?.reason === 'followup-minor-only', `${gm.code} ${gm.stdout}`);
    A.handEdit((s) => { s.tickets['T-1-fu'].fixes = ['P-1']; });
    const gp = A.gate('T-1-fu', 'fu', A.heads.fu);
    arm('follow-up gate must-FAIL: a hand-edited follow-up naming a process finding ⇒ rc 2 followup-process-finding', gp.code === 2 && gp.json?.reason === 'followup-process-finding', `${gp.code} ${gp.stdout}`);
    A.handEdit((s) => { s.tickets['T-1-fu'].fixes = ['F-S']; }); A.setCi(A.heads.fu);
    const dv = A.deliver('T-1-fu', 'fu', A.heads.fu);
    arm('follow-up deliver must-PASS: the accepted-sentence follow-up merges (rc 0)', dv.code === 0 && dv.json?.verdict === 'merged', `${dv.code} ${dv.stdout}`);
    // D5 m4: the follow-up candidate has no spec of its own — it inherits the base ticket's text, so it can carry (and be blocked by) a sentence MINOR
    const own = A.set('T-1-fu', '--finding-json', JSON.stringify({ 'N-1': { severity: 'MINOR', specSentence: A.SENT } }));
    arm('follow-up must-PASS (D5 m4): a follow-up candidate records a sentence MINOR against the base ticket\'s spec text (rc 0)', own.code === 0 && A.readState().tickets['T-1-fu'].findings['N-1']?.specSentence === A.SENT, `${own.code} ${own.stderr}`);
    A.handEdit((s) => { s.tickets['T-1-fu'].status = 'nominated'; s.tickets['T-1-fu'].mergedHead = null; s.tickets['T-1-fu'].mergedTree = null; });
    const blk = A.gate('T-1-fu', 'fu', A.heads.fu);
    arm('follow-up gate must-FAIL (D5 m4): …and, unsettled, it blocks the follow-up candidate ⇒ rc 2 finding-unsettled', blk.code === 2 && blk.json?.reason === 'finding-unsettled' && /N-1/.test(blk.json?.detail ?? ''), `${blk.code} ${blk.stdout}`);
    const own2 = A.set('T-1-fu', '--spec', 'other-spec.md');
    arm('follow-up must-FAIL (review): giving the candidate a spec of its own that lacks the inherited sentence is refused (it must not silently un-block), rc 1', own2.code === 1 && /no longer contains the specSentence of N-1/.test(own2.stderr), `${own2.code} ${own2.stderr}`);
    // review delta M1: a depth-2 chain — D follows the (merged) candidate T-1-fu which follows T-1; re-capturing / clearing T-1's spec must not silently un-block D
    A.handEdit((st) => { st.tickets['T-1-fu'].status = 'merged'; st.tickets['T-1-fu'].mergedHead = A.heads.fu; st.tickets['T-1-fu'].mergedTree = null; });
    const dd = A.set('T-1-fu-d', '--status', 'started', '--branch', 'dd', '--follow-up-of', 'T-1-fu', '--fixes', 'N-1', '--finding-json', JSON.stringify({ 'D-1': { severity: 'MINOR', specSentence: A.SENT } }));
    arm('follow-up must-PASS (review M1): a follow-up of a follow-up records a sentence MINOR against the text inherited two hops up (rc 0)', dd.code === 0, `${dd.code} ${dd.stderr}`);
    const rc2 = A.set('T-1', '--spec-text', path.join(A.work, 'other-spec.md'));
    arm('capture must-FAIL (review M1): re-capturing the base spec is refused while a depth-2 candidate holds an open accepted sentence (names T-1-fu-d/D-1)', rc2.code === 1 && /T-1-fu-d\/D-1/.test(rc2.stderr) && A.readState().tickets['T-1'].specText === A.SPEC, `${rc2.code} ${rc2.stderr}`);
    const nul = A.cli(['state', 'set', 'T-1', '--run', 'rig', '--json', JSON.stringify({ spec: null })]);
    arm('capture must-FAIL (review M1): clearing the base ticket\'s spec (`spec` null) is refused too, nothing changed', nul.code === 1 && /T-1-fu-d\/D-1/.test(nul.stderr) && A.readState().tickets['T-1'].spec === 'spec.md', `${nul.code} ${nul.stderr}`);
    arm('merged ticket must-PASS: a MINOR raised AFTER the merge does not block a retry of the merge at its own head (the follow-up is its way)', A.gate('T-1', 't1', A.heads.t1).code === 0);
  } catch (e) { crash(arm)(e); } finally { A.cleanup(); } }
  return res;
}

function report(title, results) {
  console.log(`\n== ${title}`);
  let bad = 0;
  for (const r of results) { if (!r.ok) bad++; console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : `\n        ${String(r.detail).slice(0, 400)}`}`); }
  console.log(`  → ${results.length - bad}/${results.length} arms pass`);
  return bad;
}

// Each mutant breaks ONE clause in the BUILT bundle; the anchor must occur exactly once. `extra` = a second edit of the same mutant.
const mutants = [
  { name: 'sentence: ANY quoted text is accepted (the substring test is off)', find: 'return f.specSentence !== void 0 && f.specSentence.trim() !== "" && t.specText !== null && t.specText.includes(f.specSentence);', put: () => 'return f.specSentence !== void 0;' },
  { name: 'sentence: the sentence is trimmed before the match', find: 't.specText.includes(f.specSentence);', put: () => 't.specText.includes(f.specSentence.trim());' },
  { name: 'sentence: the match is case-folded', find: 't.specText.includes(f.specSentence);', put: () => 't.specText.toLowerCase().includes(f.specSentence.toLowerCase());' },
  { name: 'sentence: whitespace-only is accepted (both the match guard and the parse guard off)', find: 'f.specSentence.trim() !== "" && ', put: () => '', extra: [{ find: 'if (typeof v !== "string" || !v.trim()) throw new FanoutStateError(`${where}: specSentence', put: () => 'if (typeof v !== "string") throw new FanoutStateError(`${where}: specSentence' }, { find: 'v.trim().length < SPEC_SENTENCE_MIN_CHARS', put: () => 'v.trim().length < 0' }] },
  { name: 'sentence: with NO captured spec text every sentence is accepted', find: 't.specText !== null && t.specText.includes(f.specSentence);', put: () => '(t.specText === null || t.specText.includes(f.specSentence));' },
  { name: 'record: the sentence is not checked against the spec at registration', find: 'if (f.specSentence !== void 0 && !sentenceAccepted(specNow, f)) {', put: () => 'if (false) {' },
  { name: 'record: a recorded severity may be re-graded', find: 'if (had && had.severity !== f.severity) throw', put: () => 'if (false) throw' },
  { name: 'record: a recorded kind / evidence / sentence may be rewritten', find: 'for (const field of ["evidence", "kind", "specSentence"]) if (had && f[field] !== void 0 && (field === "kind"', put: () => 'for (const field of ["evidence", "kind", "specSentence"]) if (false && (field === "kind"' },
  { name: 'record: a kind that was never set (a plain code finding) may be set to process later', find: '(field === "kind" ? had.kind ?? "code" : had[field]) !== void 0 && ', put: () => '(field === "kind" ? had.kind : had[field]) !== void 0 && ', extra: [{ find: '(field === "kind" ? had.kind ?? "code" : had[field]) !== f[field])', put: () => '(field === "kind" ? had.kind : had[field]) !== f[field])' }] },
  { name: 'record: a settlement / decision may be forged through --finding-json', find: 'if (f.decision || f.settled) throw', put: () => 'if (false) throw' },
  { name: 'capture: a readable --spec file is not read', find: '    return { isFile: true, text: read(ref), note: "" };', put: () => '    return { isFile: true, text: null, note: "" };' },
  { name: 'capture: the derived spec text is dropped', find: 'if (derived.specText !== void 0) next.specText =', put: () => 'if (false) next.specText =' },
  { name: 'capture: re-capturing may drop an accepted unsettled sentence (silent un-block)', find: 'if (lost.length) throw', put: () => 'if (false) throw' },
  { name: 'block: the merge block is not consulted by the reader (gate + deliver)', find: ' ?? mergeBlockRefusal(state, opts.ticket)', put: () => '' },
  { name: 'block: settled / decided findings still block', find: 'holds(f) && !findingClosed(f)).map(([k]) => k);', put: () => 'holds(f)).map(([k]) => k);' },
  { name: 'block: a decision does not close a finding', find: 'const findingClosed = (f) => !!f.settled || !!f.decision || f.onChoice !== void 0;', put: () => 'const findingClosed = (f) => !!f.settled || f.onChoice !== void 0;' },
  { name: 'block: a settlement does not close a finding', find: 'const findingClosed = (f) => !!f.settled || !!f.decision || f.onChoice !== void 0;', put: () => 'const findingClosed = (f) => !!f.decision || f.onChoice !== void 0;' },
  { name: 'block: a merged ticket is blocked too (a retry of its own merge)', find: ' || t.status === "merged" || t.mergedHead) return [];', put: () => ') return [];' },
  { name: 'block: a process finding does not block', find: 'f.severity === "MINOR" && sentenceAccepted(effectiveSpec(state, t), f);', put: () => 'f.severity === "MINOR" && f.kind !== "process" && sentenceAccepted(effectiveSpec(state, t), f);' },
  { name: 'block: a MINOR blocks on the sentence even when it is not in the spec (accepted ⇒ any sentence)', find: 'f.severity === "MINOR" && sentenceAccepted(effectiveSpec(state, t), f);', put: () => 'f.severity === "MINOR" && f.specSentence !== void 0;' },
  { name: 'block: every MINOR blocks (the sentence requirement is dropped)', find: 'f.severity === "MINOR" && sentenceAccepted(effectiveSpec(state, t), f);', put: () => 'f.severity === "MINOR";' },
  { name: 'process: a process finding may be settled as a code fix (and a code one as a PR-body edit)', find: 'const how = f.kind === "process" ? "pr-body" : "fixed";', put: () => 'const how = v.how;' },
  { name: 'follow-up: a process finding may be named in --fixes', find: 'const proc = t.fixes.filter((f) => base.findings[f]?.kind === "process");', put: () => 'const proc = t.fixes.filter(() => false);' },
  { name: 'follow-up: a MINOR with an accepted sentence is not enough', find: ' || policy === "spec" && sentenceAccepted(effectiveSpec(state, base), base.findings[f]);', put: () => ';' },
  { name: 'follow-up: every MINOR is enough', find: ' || policy === "spec" && sentenceAccepted(effectiveSpec(state, base), base.findings[f]);', put: () => ' || true;' },
  { name: 'follow-up: a MINOR\'s sentence is not re-checked against the spec', find: ' || policy === "spec" && sentenceAccepted(effectiveSpec(state, base), base.findings[f]);', put: () => ' || base.findings[f].specSentence !== void 0;' },
  { name: 'D5 m2/m3: a one-character / one-word / rule-line fragment is accepted as a sentence', find: 'const SPEC_SENTENCE_MIN_CHARS = 15;', put: () => 'const SPEC_SENTENCE_MIN_CHARS = 0;' },
  { name: 'D5 m3: a CRLF spec is captured as is (no LF normalisation)', find: 'derived.specText.replace(/\\r\\n/g, "\\n")', put: () => 'derived.specText' },
  { name: 'D5 m4: a follow-up candidate does not inherit the base ticket\'s spec text', find: 'let up = t.followUpOf;', put: () => 'let up = null;' },
  { name: 'D5 m5: a registration whose capture returned nothing keeps the stale text', find: 'if (specRead && (specRead.isFile && specRead.text !== null || p.vals["--spec-text"] !== void 0)) derived.specText = specRead.text;', put: () => 'if (specRead && (specRead.isFile || p.vals["--spec-text"] !== void 0)) derived.specText = specRead.text;' },
  { name: 'D5 pin: an ARGUED MINOR with an accepted sentence is refused as a follow-up target', find: ' || policy === "spec" && sentenceAccepted(effectiveSpec(state, base), base.findings[f]);', put: () => ' || policy === "spec" && base.findings[f].evidence !== "argued" && sentenceAccepted(effectiveSpec(state, base), base.findings[f]);' },
  { name: 'review: the lost-sentence guard ignores the text a follow-up candidate inherited', find: 'sentenceAccepted(effectiveSpec(state, before), f)', put: () => 'sentenceAccepted(before, f)' },
  { name: 'review M1: the lost-sentence guard ignores dependants more than one hop away (effective spec read from the BEFORE state)', find: 'effectiveSpec(after, after.tickets[tid])', put: () => 'effectiveSpec(state, after.tickets[tid])' },
  { name: 'limit: the refusal no longer states what code does NOT check', find: ' (Code checks the sentence is in the spec, not that it is really broken: the reviewer judges that.)', put: () => '' },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!orig.includes('mergeBlockRefusal')) { console.error('dist-electron/cli.js has no #552 merge block — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

const baselineBad = report('baseline (built bundle)', scenarios(CLI));
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'spec-sentence-mut-'));
for (const [i, m] of mutants.entries()) {
  if (process.env.MUT_ONLY && !process.env.MUT_ONLY.split(',').includes(String(i))) continue; // iterate on a few: MUT_ONLY=3,4
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

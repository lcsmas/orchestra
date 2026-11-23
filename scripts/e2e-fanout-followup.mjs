#!/usr/bin/env node
// #514 rig — the follow-up rule (a candidate on a merged ticket must name a BLOCKING|MAJOR finding it fixes) through the BUILT CLI (dist-electron/cli.js):
// scratch ORCHESTRA_HOME + scratch bare repo + a fake `gh` on PATH (PRs / CI in a json file). Light: no Electron, no network, no tokens, scratch under $TMPDIR.
//   node scripts/e2e-fanout-followup.mjs            baseline: every arm must PASS (must-PASS and must-FAIL arm per clause)
//   node scripts/e2e-fanout-followup.mjs --mutants  each patched copy of the BUILT bundle must be KILLED (≥1 arm FAILs); the baseline is the control
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
  const dir = fs.mkdtempSync(path.join(tmpBase, 'fanout-fu-rig-'));
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
  const set = (ticket, ...a) => cli(['state', 'set', ticket, '--run', 'rig', ...a]);
  const statePath = path.join(home, 'fanout', 'rig', 'state.json');
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  /** Edit the state file directly: a hand-edit that bypasses `state set` (gate / deliver must still refuse). */
  const handEdit = (fn) => { const s = readState(); fn(s); fs.writeFileSync(statePath, JSON.stringify(s)); };
  const ghLog = () => JSON.parse(fs.readFileSync(ghFile, 'utf8')).log;
  const count = (verb) => ghLog().filter((l) => l.startsWith(verb)).length;
  const gate = (ticket, branch, head) => cli(['gate', '--branch', branch, '--into', 'master', '--head', head, '--ticket', ticket, '--run', 'rig']);
  const deliver = (ticket, branch, head) => cli(['deliver', '--branch', branch, '--into', 'master', '--ticket', ticket, '--run', 'rig', '--no-review-gate', '--verified-head', head, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1', '--no-acceptance-gate']); // #515 M3: unspecced rig tickets need the explicit escape
  const setCi = (h) => { const s = JSON.parse(fs.readFileSync(ghFile, 'utf8')); s.ciGreen.push(h); fs.writeFileSync(ghFile, JSON.stringify(s)); };
  cli(['state', 'init', '--run', 'rig', '--repo', 'o/r']);
  const t1 = set('T-1', '--status', 'merged', '--branch', 't1', '--head', heads.t1, '--finding', 'F-MAJ=MAJOR,F-BLK=BLOCKING,F-MIN=minor');
  if (t1.code !== 0) throw new Error(`rig setup failed: ${t1.stdout}${t1.stderr}`);
  const t2 = set('T-2', '--status', 'started', '--branch', 'plain', '--finding', 'F-OTHER=BLOCKING');
  if (t2.code !== 0) throw new Error(`rig setup failed: ${t2.stdout}${t2.stderr}`);
  return { heads, cli, set, readState, handEdit, count, gate, deliver, setCi, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Every arm; returns [{name, ok, detail}]. `cliPath` is the bundle under test (baseline or a mutant). */
function scenarios(cliPath) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const fuSet = (A, fixes, extra = []) => A.set('T-1-fu', '--status', 'started', '--branch', 'fu', '--follow-up-of', 'T-1', ...(fixes === null ? [] : ['--fixes', fixes]), ...extra);

  // ── state set ──
  { const A = world(cliPath); try {
    const r = fuSet(A, 'F-MAJ');
    arm('state must-PASS: a follow-up naming a MAJOR is registered (rc 0, recorded)', r.code === 0 && A.readState().tickets['T-1-fu']?.fixes?.[0] === 'F-MAJ', `${r.code} ${r.stderr}`);
    const b = A.set('T-1-fu2', '--status', 'started', '--branch', 'fu', '--follow-up-of', 'T-1', '--fixes', 'F-MIN,F-BLK');
    arm('state must-PASS: a BLOCKING beside a MINOR is enough', b.code === 0, `${b.code} ${b.stderr}`);
    const rec = A.set('T-1', '--finding', 'F-NEW=MAJOR');
    arm('state must-PASS: recording another finding keeps the earlier ones (merge, not replace)', rec.code === 0 && Object.keys(A.readState().tickets['T-1'].findings).sort().join() === 'F-BLK,F-MAJ,F-MIN,F-NEW', `${rec.code} ${rec.stderr}`);
    const p = A.set('PLAIN', '--status', 'started', '--branch', 'plain');
    arm('state must-PASS: a plain (non-follow-up) ticket is unchanged', p.code === 0, `${p.code} ${p.stderr}`);
  } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } }
  { const A = world(cliPath); try {
    const r = fuSet(A, 'F-MIN');
    arm('state must-FAIL: a follow-up naming only a MINOR is refused (rc 1, rule in the message, nothing recorded)', r.code === 1 && /only MINOR/.test(r.stderr) && /MINOR findings get no action/.test(r.stderr) && !A.readState().tickets['T-1-fu'], `${r.code} ${r.stderr}`);
    const n = fuSet(A, null);
    arm('state must-FAIL: a follow-up naming no finding is refused', n.code === 1 && /names no finding/.test(n.stderr) && !A.readState().tickets['T-1-fu'], `${n.code} ${n.stderr}`);
    const u = fuSet(A, 'F-NOPE');
    arm('state must-FAIL: a finding id that does not exist is refused', u.code === 1 && /F-NOPE is not recorded on T-1/.test(u.stderr), `${u.code} ${u.stderr}`);
    const u2 = fuSet(A, 'F-MAJ,F-NOPE');
    arm('state must-FAIL: an unknown id beside a real MAJOR is still refused', u2.code === 1, `${u2.code} ${u2.stderr}`);
    const o = fuSet(A, 'F-OTHER');
    arm('state must-FAIL: a finding of ANOTHER ticket is refused', o.code === 1 && /F-OTHER is not recorded on T-1/.test(o.stderr), `${o.code} ${o.stderr}`);
    const nm = A.set('T-1-fu', '--status', 'started', '--branch', 'fu', '--follow-up-of', 'T-2', '--fixes', 'F-OTHER');
    arm('state must-FAIL: a follow-up of a ticket that is not merged is refused', nm.code === 1 && /not merged/.test(nm.stderr), `${nm.code} ${nm.stderr}`);
    const fx = A.set('T-2', '--fixes', 'F-MAJ');
    arm('state must-FAIL: --fixes without --follow-up-of is refused', fx.code === 1 && /only applies to a follow-up/.test(fx.stderr), `${fx.code} ${fx.stderr}`);
    const rg = A.set('T-1', '--finding', 'F-MIN=MAJOR');
    arm('state must-FAIL: a recorded MINOR cannot be re-graded to MAJOR', rg.code === 1 && /already recorded as MINOR/.test(rg.stderr) && A.readState().tickets['T-1'].findings['F-MIN'] === 'MINOR', `${rg.code} ${rg.stderr}`);
    const nom = A.set('T-1', '--status', 'nominated', '--head', A_head(A));
    arm('state must-FAIL: nominating the merged ticket itself is refused (a follow-up is its own ticket)', nom.code === 1 && /further candidate on it/.test(nom.stderr) && A.readState().tickets['T-1'].status === 'merged', `${nom.code} ${nom.stderr}`);
    const same = A.set('T-1', '--status', 'nominated', '--head', A.heads.t1);
    arm('state must-FAIL: re-nominating the merged ticket at its OWN merged head is refused too (it is still merged)', same.code === 1 && A.readState().tickets['T-1'].status === 'merged', `${same.code} ${same.stderr}`);
    const un = A.set('T-1', '--status', 'started');
    arm('state must-PASS: the explicit un-merge (merged → started) stays allowed', un.code === 0, `${un.code} ${un.stderr}`);
    const hf = A.set('T-1', '--status', 'merged', '--head', A.heads.fu, '--forget-merge', 'merged at the ungated head after re-gate');
    arm('state must-PASS: --forget-merge <reason> re-records the head a merged ticket really merged at', hf.code === 0 && A.readState().tickets['T-1'].mergedHead === A.heads.fu, `${hf.code} ${hf.stderr}`);
    A.set('T-1', '--status', 'merged', '--head', A.heads.t1, '--forget-merge', 'put it back');
    const hd = A.set('T-1', '--head', A.heads.fu);
    arm('state must-FAIL (review F3): a plain head change on a merged ticket is refused', hd.code === 1 && /further candidate/.test(hd.stderr), `${hd.code} ${hd.stderr}`);
  } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } }

  { const A = world(cliPath); try {
    // F2: un-merge then nominate does not launder; --forget-merge <reason> is the explicit way out
    A.set('T-1', '--status', 'started');
    const lau = A.set('T-1', '--status', 'nominated', '--head', A.heads.fu);
    arm('state must-FAIL (review F2): un-merge then nominate on another head is refused (the merged head outlives the un-merge)', lau.code === 1 && /--forget-merge/.test(lau.stderr) && A.readState().tickets['T-1'].status === 'started', `${lau.code} ${lau.stderr}`);
    const noReason = A.set('T-1', '--status', 'nominated', '--head', A.heads.fu, '--forget-merge', ' ');
    arm('state must-FAIL: --forget-merge needs a reason', noReason.code === 1, `${noReason.code} ${noReason.stderr}`);
    const fg = A.set('T-1', '--status', 'nominated', '--head', A.heads.fu, '--forget-merge', 'the merge was never real');
    arm('state must-PASS: --forget-merge <reason> clears the memory and the nomination goes through', fg.code === 0 && A.readState().tickets['T-1'].mergedHead === null, `${fg.code} ${fg.stderr}`);
  } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } }
  { const A = world(cliPath); try {
    // F1: a MERGED follow-up is a merged ticket too
    fuSet(A, 'F-MAJ'); A.setCi(A.heads.fu);
    const m = A.deliver('T-1-fu', 'fu', A.heads.fu);
    A.set('T-1-fu', '--status', 'merged', '--head', A.heads.fu);
    const again = A.set('T-1-fu', '--status', 'nominated', '--head', A.heads.plain);
    arm('state must-FAIL (review F1): a further candidate on a MERGED follow-up is refused', m.code === 0 && again.code === 1 && /further candidate/.test(again.stderr), `${m.code} ${again.code} ${again.stderr}`);
    const g = A.gate('T-1-fu', 'plain', A.heads.plain);
    arm('gate must-FAIL (review F1): a further head on the merged follow-up ⇒ rc 2 followup-undeclared', g.code === 2 && g.json?.reason === 'followup-undeclared', `${g.code} ${g.stdout}`);
    const own = A.gate('T-1-fu', 'fu', A.heads.fu);
    arm('gate must-PASS: the merged follow-up at its own head is a retry, not a further candidate', own.code === 0, `${own.code} ${own.stdout}`);
  } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } }

  { const A = world(cliPath); try {
    // review M1: --forget-merge keeps its reason in the state file
    const fg = A.set('T-1', '--status', 'merged', '--head', A.heads.fu, '--forget-merge', 'merged at the ungated head after re-gate');
    const rec = A.readState().tickets['T-1'].forgottenMerges ?? [];
    arm('state must-PASS (review M1): --forget-merge keeps its reason, the cleared merged head and a timestamp in the state file', fg.code === 0 && rec.length === 1 && rec[0].reason === 'merged at the ungated head after re-gate' && rec[0].was === A.heads.t1 && !!rec[0].at, `${fg.code} ${JSON.stringify(rec)}`);
    const blank = A.set('T-1', '--head', A.heads.plain, '--forget-merge', '  ');
    arm('state must-FAIL: a blank --forget-merge reason is refused and nothing is recorded', blank.code === 1 && (A.readState().tickets['T-1'].forgottenMerges ?? []).length === 1, `${blank.code} ${blank.stderr}`);
  } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } }
  { const A = world(cliPath); try {
    // review M2: the same branch / PR as a merged ticket under a FRESH id, no --follow-up-of
    const sb = A.set('T-1-b', '--status', 'nominated', '--branch', 't1', '--head', A.heads.fu);
    arm('state must-FAIL (review M2): a fresh ticket id on the merged ticket\'s branch at another head is refused', sb.code === 1 && /carries branch t1.*--follow-up-of T-1/s.test(sb.stderr) && !A.readState().tickets['T-1-b'], `${sb.code} ${sb.stderr}`);
    A.set('T-1', '--pr', '9');
    const sp = A.set('T-1-c', '--status', 'gated', '--branch', 'other', '--pr', '9', '--head', A.heads.fu);
    arm('state must-FAIL (review M2): a fresh ticket id on the merged ticket\'s PR is refused', sp.code === 1 && /carries PR #9/.test(sp.stderr), `${sp.code} ${sp.stderr}`);
    const js = A.cli(['state', 'set', 'T-1-d', '--run', 'rig', '--json', JSON.stringify({ status: 'nominated', branch: 't1', head: A.heads.fu, followUpOf: null, fixes: [] })]);
    arm('state must-FAIL (review M2): the --json {followUpOf:null} spelling is refused too', js.code === 1 && /carries branch t1/.test(js.stderr), `${js.code} ${js.stderr}`);
    A.set('T-1-e', '--status', 'started', '--branch', 'elsewhere');
    const gt = A.gate('T-1-e', 't1', A.heads.fu);
    arm('gate must-FAIL (review M2): gating a fresh id on the merged ticket\'s branch (--branch) ⇒ rc 2 followup-undeclared', gt.code === 2 && gt.json?.reason === 'followup-undeclared', `${gt.code} ${gt.stdout}`);
    A.setCi(A.heads.fu);
    const dv = A.deliver('T-1-e', 't1', A.heads.fu);
    arm('deliver must-FAIL (review M2): delivering it ⇒ rc 2 followup-undeclared, nothing merged', dv.code === 2 && dv.json?.reason === 'followup-undeclared' && A.count('pr merge') === 0, `${dv.code} ${dv.stdout}`);
    const ok1 = A.set('T-3', '--status', 'nominated', '--branch', 'brand-new', '--head', A.heads.plain);
    arm('state must-PASS (review M2): a brand-new branch under a fresh id is a normal ticket (unchanged)', ok1.code === 0, `${ok1.code} ${ok1.stderr}`);
    const dup = A.set('T-4', '--status', 'nominated', '--branch', 't1', '--head', A.heads.t1);
    arm('state must-PASS (review M2): a duplicate record at the merged ticket\'s OWN head is not a further candidate', dup.code === 0, `${dup.code} ${dup.stderr}`);
    const ok2 = A.set('T-1-fu', '--status', 'nominated', '--branch', 't1', '--head', A.heads.fu, '--follow-up-of', 'T-1', '--fixes', 'F-MAJ');
    arm('state must-PASS (review M2): the same branch WITH --follow-up-of naming a MAJOR is accepted', ok2.code === 0, `${ok2.code} ${ok2.stderr}`);
  } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } }
  { const A = world(cliPath); try {
    // #512 compat: the SAME git tree on another sha is the same content, not a further candidate
    const g1 = A.gate('T-1', 't1b', A.heads.t1b);
    arm('gate must-PASS (#512 compat): the merged ticket\'s tree on another sha (rebase) is not a further candidate (rc 0)', g1.code === 0 && g1.json?.verdict === 'gate', `${g1.code} ${g1.stdout}`);
    const g2 = A.gate('T-1', 'fu', A.heads.fu);
    arm('gate must-FAIL (#512 compat): another tree on another sha is still undeclared (rc 2)', g2.code === 2 && g2.json?.reason === 'followup-undeclared', `${g2.code} ${g2.stdout}`);
    const s1 = A.set('T-3', '--status', 'nominated', '--branch', 't1', '--head', A.heads.t1b);
    arm('state must-PASS (#512 compat): same branch, same tree on another sha = not a further candidate', s1.code === 0, `${s1.code} ${s1.stderr}`);
    A.setCi(A.heads.t1b);
    const d1 = A.deliver('T-1', 't1b', A.heads.t1b);
    arm('deliver must-PASS (#512 compat): the same-tree retry is not refused by the follow-up rule', !/^followup-/.test(String(d1.json?.reason ?? '')), `${d1.code} ${d1.stdout}`);
  } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } }
  { const A = world(cliPath); try {
    // review minor 3: a normal ticket merged WITHOUT a head is not consulted
    A.set('T-9', '--status', 'merged', '--branch', 'plain');
    A.setCi(A.heads.plain);
    const g = A.gate('T-9', 'plain', A.heads.plain);
    arm('gate must-PASS (review minor 3): a normal ticket recorded merged without a head is unchanged (rc 0)', g.code === 0 && g.json?.verdict === 'gate', `${g.code} ${g.stdout}`);
    const d = A.deliver('T-9', 'plain', A.heads.plain);
    arm('deliver must-PASS (review minor 3): and deliver is not refused by the follow-up rule', d.code === 0 && d.json?.verdict === 'merged', `${d.code} ${d.stdout}`);
  } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } }

  // ── gate ──
  { const A = world(cliPath); try {
    fuSet(A, 'F-MAJ'); A.set('PLAIN', '--status', 'started', '--branch', 'plain');
    const g = A.gate('T-1-fu', 'fu', A.heads.fu);
    arm('gate must-PASS: a follow-up naming a MAJOR is answered (rc 0, verdict gate)', g.code === 0 && g.json?.verdict === 'gate', `${g.code} ${g.stdout}${g.stderr}`);
    const p = A.gate('PLAIN', 'plain', A.heads.plain);
    arm('gate must-PASS: a plain ticket is unchanged (rc 0, verdict gate)', p.code === 0 && p.json?.verdict === 'gate', `${p.code} ${p.stdout}`);
    const own = A.gate('T-1', 't1', A.heads.t1);
    arm('gate must-PASS: the merged ticket at its OWN merged head is not a follow-up', own.code === 0, `${own.code} ${own.stdout}`);
    const und = A.gate('T-1', 'fu', A.heads.fu);
    arm('gate must-FAIL: a further candidate head on the merged ticket, undeclared ⇒ rc 2 followup-undeclared', und.code === 2 && und.json?.reason === 'followup-undeclared', `${und.code} ${und.stdout}`);
    A.handEdit((s) => { s.tickets['T-1-fu'].fixes = ['F-MIN']; });
    const mi = A.gate('T-1-fu', 'fu', A.heads.fu);
    arm('gate must-FAIL: a hand-edited MINOR-only follow-up ⇒ rc 2 followup-minor-only', mi.code === 2 && mi.json?.reason === 'followup-minor-only' && /MINOR findings get no action/.test(mi.json?.detail ?? ''), `${mi.code} ${mi.stdout}`);
    A.handEdit((s) => { s.tickets['T-1-fu'].fixes = []; });
    const no = A.gate('T-1-fu', 'fu', A.heads.fu);
    arm('gate must-FAIL: a hand-edited follow-up naming none ⇒ rc 2 followup-no-finding', no.code === 2 && no.json?.reason === 'followup-no-finding', `${no.code} ${no.stdout}`);
    A.handEdit((s) => { s.tickets['T-1-fu'].fixes = ['F-GHOST']; });
    const gh = A.gate('T-1-fu', 'fu', A.heads.fu);
    arm('gate must-FAIL: a hand-edited unknown finding id ⇒ rc 2 followup-unknown-finding', gh.code === 2 && gh.json?.reason === 'followup-unknown-finding', `${gh.code} ${gh.stdout}`);
    A.handEdit((s) => { s.tickets['T-1-fu'].fixes = ['F-MAJ']; s.tickets['T-1'].status = 'started'; });
    const nb = A.gate('T-1-fu', 'fu', A.heads.fu);
    arm('gate must-FAIL: a follow-up whose base is not merged ⇒ rc 2 followup-base-not-merged', nb.code === 2 && nb.json?.reason === 'followup-base-not-merged', `${nb.code} ${nb.stdout}`);
  } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } }

  // ── deliver ──
  { const A = world(cliPath); try {
    fuSet(A, 'F-MAJ'); A.set('PLAIN', '--status', 'started', '--branch', 'plain');
    A.setCi(A.heads.fu); A.setCi(A.heads.plain);
    const d = A.deliver('T-1-fu', 'fu', A.heads.fu);
    arm('deliver must-PASS: a follow-up naming a MAJOR merges (rc 0, verdict merged)', d.code === 0 && d.json?.verdict === 'merged', `${d.code} ${d.stdout}${d.stderr}`);
    const p = A.deliver('PLAIN', 'plain', A.heads.plain);
    arm('deliver must-PASS: a plain ticket merges unchanged', p.code === 0 && p.json?.verdict === 'merged', `${p.code} ${p.stdout}`);
  } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } }
  for (const [label, edit, reason, ticket] of [
    ['MINOR-only follow-up', (s) => { s.tickets['T-1-fu'].fixes = ['F-MIN']; }, 'followup-minor-only', 'T-1-fu'],
    ['follow-up naming none', (s) => { s.tickets['T-1-fu'].fixes = []; }, 'followup-no-finding', 'T-1-fu'],
    ['follow-up naming an unknown finding id', (s) => { s.tickets['T-1-fu'].fixes = ['F-GHOST']; }, 'followup-unknown-finding', 'T-1-fu'],
    ['follow-up of a ticket that is not merged', (s) => { s.tickets['T-1'].status = 'started'; }, 'followup-base-not-merged', 'T-1-fu'],
    ['undeclared further candidate on the merged ticket', () => {}, 'followup-undeclared', 'T-1'],
  ]) {
    const A = world(cliPath); try {
      fuSet(A, 'F-MAJ'); A.setCi(A.heads.fu); A.handEdit(edit);
      const d = A.deliver(ticket, 'fu', A.heads.fu);
      arm(`deliver must-FAIL: ${label} ⇒ rc 2 ${reason}, no PR opened, nothing merged`, d.code === 2 && d.json?.reason === reason && A.count('pr create') === 0 && A.count('pr merge') === 0, `${d.code} ${d.stdout}${d.stderr}`);
    } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); }
  }
  return res;
}
function A_head(A) { return A.heads.fu; }

function report(title, results) {
  console.log(`\n== ${title}`);
  let bad = 0;
  for (const r of results) { if (!r.ok) bad++; console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : `\n        ${String(r.detail).slice(0, 400)}`}`); }
  console.log(`  → ${results.length - bad}/${results.length} arms pass`);
  return bad;
}

// Each mutant breaks ONE clause in the BUILT bundle; the anchor must occur exactly once. `extra` = a second edit of the same mutant.
const mutants = [
  { name: 'rule: MINOR counts as enough (BLOCKING|MAJOR test off)', find: 'if (!t.fixes.some(qualifies)) {', put: () => 'if (false) {' },
  { name: 'rule: MINOR alone passes only by promoting MINOR to MAJOR in the test', find: 'base.findings[f].severity === "MAJOR" ||', put: () => 'base.findings[f].severity === "MAJOR" || base.findings[f].severity === "MINOR" ||' },
  { name: 'rule: a follow-up naming no finding is accepted', find: 'if (t.fixes.length === 0) return refuse(', put: () => 'if (false) return refuse(' },
  { name: 'rule: an unknown finding id is accepted', find: 'if (unknown.length) return refuse(', put: () => 'if (false) return refuse(' },
  { name: 'rule: unknown id checked against ANY ticket (not the merged one)', find: 'const unknown = t.fixes.filter((f) => !base.findings[f]);', put: () => 'const unknown = t.fixes.filter((f) => !Object.values(state.tickets).some((x) => x.findings[f]));' },
  { name: 'rule: a follow-up of a ticket that is not merged is accepted', find: 'if (base.status !== "merged") return refuse(', put: () => 'if (false) return refuse(' },
  { name: 'rule: an undeclared candidate on a merged ticket is accepted (gate/deliver)', find: 'if (head && merged && (t.mergedHead || t.status === "merged") && !sameMerge(merged, t.mergedHead ? t.mergedTree : t.tree)) {', put: () => 'if (false) {' },
  { name: 'rule: the merged ticket\'s own head is treated as a further candidate', find: '(t.mergedHead || t.status === "merged") && !sameMerge(merged, t.mergedHead ? t.mergedTree : t.tree)) {', put: () => '(t.mergedHead || t.status === "merged")) {' },
  { name: 'state: the registration check is skipped', find: 'if (fu) throw new FanoutStateError(fu.detail);', put: () => '' },
  { name: 'state: the merged ticket can be nominated/gated as itself', find: 'if (prev.status === "merged" && (next.status === "nominated" || next.status === "gated")) {', put: () => 'if (false) {' },
  { name: 'state: the explicit un-merge is refused too', find: 'if (prev.status === "merged" && (next.status === "nominated" || next.status === "gated")) {', put: () => 'if (prev.status === "merged" && next.status !== "merged") {' },
  { name: 'state: a recorded severity may be re-graded', find: 'if (had && had.severity !== f.severity) throw', put: () => 'if (false) throw' },
  { name: 'state: a re-recorded finding set REPLACES the earlier one', find: 'next.findings = { ...prev.findings };', put: () => 'next.findings = {};' },
  { name: 'state: --fixes without --follow-up-of is accepted', find: 'if (t.fixes.length) return refuse(', put: () => 'if (false) return refuse(' },
  { name: 'reader: the --branch of gate/deliver is not passed (only the state\'s own branch)', find: 'refusal: followUpRefusal(state, opts.ticket, opts.head, opts.branch, opts.headTree)', put: () => 'refusal: followUpRefusal(state, opts.ticket, opts.head, void 0, opts.headTree)' },
  { name: 'review F2: the merged head is forgotten on un-merge', find: '(t.mergedHead || t.status === "merged")', put: () => 't.status === "merged"' },
  { name: 'review F2: the merged head is never recorded', find: '    next.mergedHead = next.head;\n    next.mergedTree = next.tree;', put: () => '    next.mergedTree = next.tree;' },
  { name: 'review F2: state set does not pass the candidate head to the rule', find: 'next.status === "nominated" || next.status === "gated" ? next.head : void 0', put: () => 'void 0' },
  { name: 'review F1: a merged follow-up is exempt from the further-candidate check', find: 'if (head && merged && (t.mergedHead', put: () => 'if (!t.followUpOf && head && merged && (t.mergedHead' },
  { name: 'review F3: a plain head change on a merged ticket is accepted', find: 'if (prev.status === "merged" && next.status === "merged" && "head" in patch', put: () => 'if (false && "head" in patch' },
  { name: 'review F3: --forget-merge does not lift the head-change guard', find: '!("forgetMerge" in patch) &&', put: () => '' },
  { name: '--forget-merge needs no reason (patch check AND the parse backstop off)', find: 'if (typeof patch.forgetMerge !== "string" || !patch.forgetMerge.trim()) throw', put: () => 'if (false) throw', extra: [{ find: '!e.reason.trim()', put: () => 'false' }] },
  { name: '--forget-merge does not clear the merged head', find: '    next.mergedHead = null;\n    next.mergedTree = null;\n  }', put: () => '    next.mergedTree = null;\n  }' },
  { name: 'review M1: --forget-merge does not keep its reason', find: 'next.forgottenMerges = [...prev.forgottenMerges, { at: now, reason: patch.forgetMerge.trim(), was: prev.mergedHead }];', put: () => '' },
  { name: 'review M2: the same-branch/PR check is off', find: 'if (mid !== id && mh && shared && !sameMerge(mh, m.mergedHead ? m.mergedTree : m.tree)) {', put: () => 'if (false) {' },
  { name: 'review M2: only the branch counts (the PR is ignored)', find: '(m.pr && m.pr === t.pr ? `PR #${m.pr}` : null)', put: () => 'null' },
  { name: 'review M2: gate/deliver --branch is ignored (only the state\'s branch)', find: 'm.branch === branch || m.branch === t.branch', put: () => 'm.branch === t.branch' },
  { name: 'review M2: a duplicate record at the merged head is refused (head ignored)', find: 'if (mid !== id && mh && shared && !sameMerge(mh, m.mergedHead ? m.mergedTree : m.tree))', put: () => 'if (mid !== id && mh && shared)' },
  { name: 'review minor 3: a merged ticket without a head is consulted (refused forever)', find: 'if (head && merged && (t.mergedHead || t.status === "merged") && !sameMerge(merged, t.mergedHead ? t.mergedTree : t.tree)) {', put: () => 'if (head && (t.mergedHead || t.status === "merged") && !(merged && sameMerge(merged, t.mergedHead ? t.mergedTree : t.tree))) {' },
  { name: '#512 compat: the rule never retries with the candidate\'s git tree', find: 'return headTree ? read({ ...o, headTree }) : first;', put: () => 'return first;' },
  { name: '#512 compat: the merged tree is not recorded', find: '    next.mergedTree = next.tree;\n  }', put: () => '  }' },
  { name: '#512 compat: a same-tree candidate counts as another head (tree ignored)', find: '(sameSha(mh, head) || !!mt && !!headTree && mt === headTree)', put: () => 'sameSha(mh, head)' },
  { name: 'rule text: the refusal does not name the rule', find: '; other MINOR findings get no action (no follow-up PR, no extra list).', put: () => '', extra: [{ find: '; MINOR findings get no action (no follow-up PR, no extra list).', put: () => '' }] },
  { name: 'gate: the clause is not consulted', find: 'if (opts.ticket !== void 0 && deps.followUp) {', put: () => 'if (false) {' },
  { name: 'gate: a refusal is ignored', find: 'if (fu.refusal) return { exit: DELIVER_EXIT.refused,', put: () => 'if (false) return { exit: DELIVER_EXIT.refused,' },
  { name: 'deliver: the clause is not consulted', find: 'if (deps.followUp) {', put: () => 'if (false) {' },
  { name: 'deliver: a refusal is ignored', find: 'if (fu.refusal) return done(', put: () => 'if (false) return done(' },
  { name: 'deliver: the production reader is not wired', find: 'followUp: (o) => followUpFromState(o),\n', put: () => 'followUp: void 0,\n' },
  { name: 'reader: the verified head is not passed (undeclared candidate invisible)', find: 'refusal: followUpRefusal(state, opts.ticket, opts.head, opts.branch, opts.headTree)', put: () => 'refusal: followUpRefusal(state, opts.ticket, void 0, opts.branch, opts.headTree)' },
  { name: 'state: findings are not parsed (a recorded finding is lost on re-read)', find: 'findings: findingsOf(t.findings),', put: () => 'findings: {},' },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!orig.includes('followUpRefusal')) { console.error('dist-electron/cli.js has no follow-up rule — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

const baselineBad = report('baseline (built bundle)', scenarios(CLI));
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-fu-mut-'));
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

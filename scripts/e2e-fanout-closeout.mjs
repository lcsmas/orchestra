#!/usr/bin/env node
// #553 rig — the close-out: one ready-to-file ticket text per MEASURED, non-process MINOR, through the BUILT CLI (dist-electron/cli.js):
// scratch ORCHESTRA_HOME + a fake `gh` on PATH that LOGS every call (the default close-out must make none). Light: no Electron, no network, no tokens, scratch under $TMPDIR.
//   node scripts/e2e-fanout-closeout.mjs            baseline: every arm must PASS (a must-PASS and a must-FAIL arm per clause)
//   node scripts/e2e-fanout-closeout.mjs --mutants  each patched copy of the BUILT bundle must be KILLED (≥1 arm FAILs); the baseline is the control
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const tmpBase = process.env.TMPDIR || os.tmpdir();

// `gh issue list` answers from st.issues (matching the marker token in a body); `issue create` appends; every call is logged; FAKE_GH_FAIL=1 makes every call fail.
const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs');
const S = process.env.FAKE_GH_STATE; const st = JSON.parse(fs.readFileSync(S, 'utf8'));
const args = process.argv.slice(2); st.log.push(args.join(' ')); const save = () => fs.writeFileSync(S, JSON.stringify(st));
const val = (f) => args[args.indexOf(f) + 1];
if (process.env.FAKE_GH_FAIL === '1') { save(); process.stderr.write('gh: boom\\n'); process.exit(1); }
if (args[0] === 'issue' && args[1] === 'list') {
  const q = val('--search').replace(/ in:body$/, '');
  save(); process.stdout.write(JSON.stringify(st.issues.filter((i) => i.body.includes(q)).map((i) => ({ number: i.number, url: i.url })))); process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'create') {
  const n = 700 + st.issues.length; const url = 'https://github.com/o/r/issues/' + n;
  st.issues.push({ number: n, url, title: val('--title'), body: val('--body') }); save(); process.stdout.write(url + '\\n'); process.exit(0);
}
save(); process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n'); process.exit(1);
`;

const REP = (n) => ({ input: `input ${n}: POST /x with an empty list`, happens: `happens ${n}: 500 instead of 400`, where: `where ${n}: src/api/x.ts:42`, proof: `proof ${n}: curl -i … → HTTP/1.1 500` });
const mea = (n, over = {}) => ({ severity: 'MINOR', evidence: 'measured', kind: 'code', report: REP(n), ...over });

function world(cliPath) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'fanout-closeout-rig-'));
  if (!path.resolve(dir).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
  const bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  for (const d of [bin, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const ghFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(ghFile, JSON.stringify({ log: [], issues: [] }));
  const baseEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'rig', FAKE_GH_STATE: ghFile, GIT_CONFIG_GLOBAL: '/dev/null' };
  const cli = (args, env = {}) => {
    const r = spawnSync(process.execPath, [cliPath, 'fanout', ...args], { encoding: 'utf8', env: { ...baseEnv, ...env }, timeout: 60_000, cwd: dir });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const statePath = path.join(home, 'fanout', 'rig', 'state.json');
  const setFindings = (ticket, findings) => cli(['state', 'set', ticket, '--run', 'rig', '--json', JSON.stringify({ findings })]);
  const closeout = (...a) => cli(['closeout', '--run', 'rig', ...a]);
  const readGh = () => JSON.parse(fs.readFileSync(ghFile, 'utf8'));
  const stateBytes = () => fs.readFileSync(statePath, 'utf8');
  const handEdit = (fn) => { const st = JSON.parse(fs.readFileSync(statePath, 'utf8')); fn(st); fs.writeFileSync(statePath, JSON.stringify(st)); };
  const stateFindings = (t) => JSON.parse(stateBytes()).tickets[t]?.findings ?? {};
  cli(['state', 'init', '--run', 'rig', '--repo', 'o/r']);
  const t = cli(['state', 'set', 'T-1', '--run', 'rig', '--status', 'started', '--branch', 'b1']);
  if (t.code !== 0) throw new Error(`rig setup failed: ${t.stdout}${t.stderr}`);
  return { cli, setFindings, closeout, readGh, stateBytes, stateFindings, handEdit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const nTexts = (out) => (out.match(/^--- ticket text /gm) ?? []).length;

function scenarios(cliPath) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const block = (fn) => { const A = world(cliPath); try { fn(A); } catch (e) { arm(`arm block crashed (a crash is a FAIL, never a skip): ${String(e.message).slice(0, 160)}`, false); } finally { A.cleanup(); } };

  block((A) => { // must-PASS: one measured MINOR → exactly one text with all four parts
    const s = A.setFindings('T-1', { 'F-1': mea(1) });
    const c = A.closeout();
    const o = c.stdout;
    arm('must-PASS: one measured MINOR recorded (rc 0)', s.code === 0, `${s.stdout}${s.stderr}`);
    arm('must-PASS: one measured MINOR → exactly ONE ticket text, rc 0', c.code === 0 && nTexts(o) === 1 && /1 ticket text\(s\)/.test(o), `${c.code} ${o}${c.stderr}`);
    arm('must-PASS: the text carries input, what happens, where and proof (each value verbatim, each under its heading)',
      /\*\*Input\*\*\ninput 1: POST \/x with an empty list/.test(o) && /\*\*What happens\*\*\nhappens 1: 500 instead of 400/.test(o) && /\*\*Where\*\*\nwhere 1: src\/api\/x\.ts:42/.test(o) && /\*\*Proof\*\*\nproof 1: curl -i … → HTTP\/1\.1 500/.test(o), o);
    arm('must-PASS: the text names its origin (run, ticket, finding)', /ticket T-1/.test(o) && /finding F-1/.test(o) && /run rig/.test(o), o);
    const j = JSON.parse(A.closeout('--json').stdout);
    arm('must-PASS: --json = the same single text, four parts, a marker', j.texts.length === 1 && Object.keys(j.texts[0].report).sort().join() === 'happens,input,proof,where' && /^fanoutcloseout[0-9a-f]{12}$/.test(j.texts[0].marker), JSON.stringify(j));
  });

  block((A) => { // must-PASS: default close-out files NOTHING and writes nothing
    A.setFindings('T-1', { 'F-1': mea(1), 'F-2': mea(2) });
    const before = A.stateBytes();
    const c = A.closeout();
    arm('must-PASS: the default close-out makes NO tracker call (fake gh log empty) and prints both texts', c.code === 0 && nTexts(c.stdout) === 2 && A.readGh().log.length === 0, `${c.code} gh log: ${JSON.stringify(A.readGh().log)}`);
    arm('must-PASS: read-only — the state file is byte-identical after the close-out', A.stateBytes() === before);
  });

  block((A) => { // must-FAIL: a measured MINOR missing a part is refused at recording
    for (const part of ['input', 'happens', 'where', 'proof']) {
      const rep = REP(1); delete rep[part];
      const s = A.setFindings('T-1', { 'F-M': mea(1, { report: rep }) });
      arm(`must-FAIL: a measured MINOR with no ${part} → refused at recording (rc 1 naming ${part}), nothing recorded`, s.code === 1 && s.stderr.includes(part) && !('F-M' in A.stateFindings('T-1')), `${s.code} ${s.stderr}`);
    }
    const blank = A.setFindings('T-1', { 'F-B': mea(1, { report: { ...REP(1), proof: '   ' } }) });
    arm('must-FAIL: a whitespace-only part counts as missing', blank.code === 1 && !('F-B' in A.stateFindings('T-1')), `${blank.code} ${blank.stderr}`);
    const none = A.setFindings('T-1', { 'F-N': { severity: 'MINOR', evidence: 'measured' } });
    arm('must-FAIL: a measured MINOR with no report at all → refused', none.code === 1 && !('F-N' in A.stateFindings('T-1')), `${none.code} ${none.stderr}`);
    const noEv = A.setFindings('T-1', { 'F-E': { severity: 'MINOR', report: REP(1) } });
    arm('must-FAIL: a MINOR with a full report but NO evidence is refused (it would count as argued and, never re-graded, lose its text)', noEv.code === 1 && /needs evidence/.test(noEv.stderr) && !('F-E' in A.stateFindings('T-1')), `${noEv.code} ${noEv.stderr}`);
    arm('must-FAIL: after the refusals the close-out lists nothing', nTexts(A.closeout().stdout) === 0);
  });

  block((A) => { // must-FAIL: argued / process / BLOCKING / MAJOR / legacy-string / fixed → no text
    const s = A.setFindings('T-1', {
      'F-ARG': { severity: 'MINOR', evidence: 'argued' },
      'F-ARG2': { severity: 'MINOR', evidence: 'argued', report: REP(9) }, // an argued MINOR with a full report still creates nothing
      'F-PROC': { severity: 'MINOR', evidence: 'measured', kind: 'process' },
      'F-BLK': { severity: 'BLOCKING', evidence: 'measured', report: REP(3) },
      'F-MAJ': 'MAJOR',
      'F-OLD': 'MINOR',
      'F-FIX': mea(4),
    });
    const settle = A.cli(['state', 'set', 'T-1', '--run', 'rig', '--settle', 'F-FIX=fixed:abc1234']);
    arm('setup: the mixed findings record (argued/process need no report) and F-FIX settled by a fix', s.code === 0 && settle.code === 0, `${s.stdout}${s.stderr}${settle.stdout}${settle.stderr}`);
    const c = A.closeout();
    arm('must-FAIL: argued MINOR (with or without report), process finding, BLOCKING, MAJOR, legacy bare MINOR and an already-fixed one → NO ticket text', c.code === 0 && nTexts(c.stdout) === 0 && /0 ticket text\(s\)/.test(c.stdout), c.stdout);
    arm('must-FAIL: the skipped ones are counted, never silent (2 argued declared, 1 no evidence, 1 process, 1 settled fixed, +2 BLOCKING/MAJOR)', /2 argued MINOR \(declared\), 1 MINOR with no evidence recorded, 1 process finding\(s\), 1 measured MINOR settled fixed \(\+2 BLOCKING\/MAJOR/.test(c.stdout), c.stdout.split('\n')[0]);
    arm('m1: the bare `--finding`-style MINOR is NAMED (T-1/F-OLD under NO EVIDENCE RECORDED), not folded into argued', /NO EVIDENCE RECORDED[^\n]*T-1\/F-OLD/.test(c.stdout) && !/T-1\/F-ARG\b[^\n]*NO EVIDENCE/.test(c.stdout), c.stdout);
    arm('m2: the settled-fixed one is LISTED with its ref (T-1/F-FIX settled:abc1234), still no text', /T-1\/F-FIX settled:abc1234/.test(c.stdout) && !c.stdout.includes('ticket text 1/'), c.stdout);
    A.setFindings('T-1', { 'F-OK': mea(7) });
    const c2 = A.closeout();
    arm('must-PASS: beside all of those, ONE measured MINOR → exactly one text (F-OK)', nTexts(c2.stdout) === 1 && c2.stdout.includes('finding F-OK'), c2.stdout.split('\n')[0]);
  });

  block((A) => { // m3: no head in the text, said to be an earlier round
    A.setFindings('T-1', { 'F-1': mea(1) });
    A.cli(['state', 'set', 'T-1', '--run', 'rig', '--head', 'deadbeefcafe0123456789abcdef0123456789ab']);
    const o = A.closeout().stdout;
    arm('m3: the origin line prints NO head (the close-out head is not the one the MINOR was measured on) and says « earlier round … re-check »', nTexts(o) === 1 && !/deadbeef/.test(o) && /earlier round[^\n]*re-check before acting/.test(o), o);
  });
  block((A) => { // m4: one malformed record does not void the list
    A.setFindings('T-1', { 'F-GOOD': mea(1), 'F-BAD': mea(2) });
    A.handEdit((s) => { delete s.tickets['T-1'].findings['F-BAD'].report; });
    const c = A.closeout();
    arm('m4: a malformed measured MINOR is listed (NOT a ticket text: malformed … F-BAD) and the valid text STILL comes out, rc 0', c.code === 0 && nTexts(c.stdout) === 1 && c.stdout.includes('finding F-GOOD') && /NOT a ticket text: malformed[^\n]*T-1\/F-BAD/.test(c.stdout), `${c.code} ${c.stdout}${c.stderr}`);
  });

  block((A) => { // two tickets / two findings → two texts, ticket order
    A.cli(['state', 'set', 'T-2', '--run', 'rig', '--status', 'started', '--branch', 'b2']);
    A.setFindings('T-1', { 'F-1': mea(1) }); A.setFindings('T-2', { 'F-2': mea(2), 'F-3': mea(3) });
    const o = A.closeout().stdout;
    arm('must-PASS: three measured MINORs on two tickets → exactly three texts, one per finding, in ticket order', nTexts(o) === 3 && o.indexOf('T-1/F-1') < o.indexOf('T-2/F-2') && o.indexOf('T-2/F-2') < o.indexOf('T-2/F-3'), o);
  });

  block((A) => { // recorded grade is not rewritten
    A.setFindings('T-1', { 'F-1': mea(1) });
    const flip = A.setFindings('T-1', { 'F-1': { severity: 'MINOR', evidence: 'argued' } });
    arm('must-FAIL: a measured MINOR cannot be flipped to argued afterwards (its text would vanish)', flip.code === 1 && nTexts(A.closeout().stdout) === 1, `${flip.code} ${flip.stderr}`);
    const proc = A.setFindings('T-1', { 'F-1': { ...mea(1), kind: 'process' } });
    arm('must-FAIL: nor re-kinded to process', proc.code === 1 && nTexts(A.closeout().stdout) === 1, `${proc.code} ${proc.stderr}`);
    A.setFindings('T-1', { 'F-U': mea(5, { kind: undefined }) });
    const unset = A.setFindings('T-1', { 'F-U': { severity: 'MINOR', evidence: 'measured', kind: 'process' } });
    arm('must-FAIL: a measured MINOR recorded with no kind cannot be re-kinded to process either', unset.code === 1 && /re-kinded/.test(unset.stderr) && nTexts(A.closeout().stdout) === 2, `${unset.code} ${unset.stderr}`);
    const bare = A.cli(['state', 'set', 'T-1', '--run', 'rig', '--finding', 'F-1=MINOR']);
    arm('must-PASS: the bare `--finding F-1=MINOR` repeat keeps the recorded report', bare.code === 0 && nTexts(A.closeout().stdout) === 2, `${bare.code} ${bare.stderr}`);
    const up = A.cli(['state', 'set', 'T-1', '--run', 'rig', '--finding', 'F-2=MINOR']);
    const up2 = A.setFindings('T-1', { 'F-2': mea(2) });
    arm('must-PASS: a legacy bare MINOR may be upgraded to a measured record of the same severity', up.code === 0 && up2.code === 0 && nTexts(A.closeout().stdout) === 3, `${up2.code} ${up2.stderr}`);
  });

  block((A) => { // --file: opt-in filing
    A.setFindings('T-1', { 'F-1': mea(1), 'F-2': mea(2) });
    const c = A.closeout('--file');
    const g = A.readGh();
    const creates = g.log.filter((l) => l.startsWith('issue create'));
    arm('must-PASS: --file files exactly one issue per text (2 creates, bodies carry the four parts)', c.code === 0 && creates.length === 2 && g.issues.length === 2 && g.issues.every((i) => /\*\*Input\*\*/.test(i.body) && /\*\*Proof\*\*/.test(i.body)), `${c.code} ${JSON.stringify(g.log)}`);
    arm('must-PASS: --file still prints the list and reports each filing', nTexts(c.stdout) === 2 && /filed https:\/\/github\.com\/o\/r\/issues\/70[01]/.test(c.stderr), c.stderr);
    const again = A.closeout('--file');
    arm('must-FAIL: running --file again files NOTHING more (deduped by the hidden marker)', again.code === 0 && A.readGh().issues.length === 2 && /already filed/.test(again.stderr), `${again.stderr}`);
  });
  block((A) => { // a tracker that fails never fails the close-out
    A.setFindings('T-1', { 'F-1': mea(1) });
    const c = A.cli(['closeout', '--run', 'rig', '--file'], { FAKE_GH_FAIL: '1' });
    arm('must-PASS: --file against a failing tracker → rc 0, the list still printed, the failure said (never waited on, never fatal)', c.code === 0 && nTexts(c.stdout) === 1 && /NOT filed/.test(c.stderr), `${c.code} ${c.stdout}${c.stderr}`);
    const r = A.closeout('--repo', 'o/r');
    arm('must-FAIL: --repo without --file is refused (no half-armed filing)', r.code === 1, `${r.code} ${r.stderr}`);
  });
  return res;
}

function report(title, results) {
  console.log(`\n== ${title}`);
  let bad = 0;
  for (const r of results) { if (!r.ok) bad++; console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : `\n        ${String(r.detail).slice(0, 400)}`}`); }
  console.log(`  → ${results.length - bad}/${results.length} arms pass`);
  return bad;
}

// Each mutant breaks ONE clause in the BUILT bundle; the anchor must occur exactly once. `extra` = further edits of the same mutant.
const mutants = [
  { name: 'close-out: an argued MINOR becomes a ticket text', find: 'if (r.evidence !== "measured") return "argued";', put: () => '' },
  { name: 'close-out: a process finding becomes a ticket text', find: 'if (r.kind === "process") return "process";', put: () => '' },
  { name: 'close-out: a BLOCKING/MAJOR becomes a ticket text', find: 'if (r.severity !== "MINOR") return "not-minor";', put: () => '' },
  { name: 'close-out: an already-fixed measured MINOR still becomes a ticket text', find: 'if (r.settled?.how === "fixed") return "settled-fixed";', put: () => '' },
  { name: 'close-out: a MINOR with no evidence (legacy bare) counts as measured', find: 'if (r.evidence === void 0) return "no-evidence";', put: () => '', extra: [{ find: 'if (r.evidence !== "measured") return "argued";', put: () => 'if (r.evidence === "argued") return "argued";' }] },
  { name: 'close-out: only the first measured MINOR of the vague is listed', find: 'texts.push({ run: state.run,', put: () => 'if (texts.length === 0) texts.push({ run: state.run,' },
  { name: 'close-out: every text is emitted twice', find: 'texts.push({ run: state.run,', put: () => 'texts.push({ dup: 1 }); texts.push({ run: state.run,' },
  { name: 'm1: a no-evidence MINOR is folded into « argued » (not named)', find: 'if (r.evidence === void 0) return "no-evidence";', put: () => '' },
  { name: 'm1: the no-evidence ids are not listed', find: 'if (why === "no-evidence") noEvidence.push(id);', put: () => '' },
  { name: 'm2: settled-fixed ids / refs are not listed', find: 'if (why === "settled-fixed") settledFixed.push({ id, ref: f.settled.ref });', put: () => '' },
  { name: 'm3: the text says nothing of an earlier round', find: 're-check before acting. Filed from', put: () => 'Filed from' },
  { name: 'm3: the origin line prints the close-out head again', find: 'ctx.branch ? `branch ${ctx.branch}` : "",', put: () => 'ctx.branch ? `branch ${ctx.branch}` : "", ctx.head ? `head ${ctx.head.slice(0, 12)}` : "",' },
  { name: 'm4: a malformed record voids the whole list (throws)', find: 'malformed.push({ id, why: `no ${missing.join(", ")}` });', put: () => 'throw new Error("malformed " + id);' },
  { name: 'm4: a malformed record is listed but its good siblings are dropped', find: 'texts.push({ run: state.run,', put: () => 'if (malformed.length === 0 && state.tickets[ticket] && !Object.values(state.tickets[ticket].findings).some((x) => x.severity === "MINOR" && x.evidence === "measured" && !x.report)) texts.push({ run: state.run,' },
  { name: 'text: the input part is missing', find: '`**Input**\n${report.input.trim()}`,', put: () => '' },
  { name: 'text: the what-happens part is missing', find: '`**What happens**\n${report.happens.trim()}`,', put: () => '' },
  { name: 'text: the where part is missing', find: '`**Where**\n${report.where.trim()}`,', put: () => '' },
  { name: 'text: the proof part is missing', find: '`**Proof**\n${report.proof.trim()}`,', put: () => '' },
  { name: 'text: the hidden dedupe marker is missing', find: '`<!-- ${markerOf(run, ticket, finding)} -->`', put: () => '`<!-- -->`' },
  { name: 'text: the origin (ticket / finding) is dropped', find: 'const origin = [`run ${run}`, `ticket ${ticket}`, `finding ${finding}`,', put: () => 'const origin = [`run ${run}`,' },
  { name: 'recording: a measured MINOR with no report is accepted (check off)', find: 'if (f.evidence === "measured" && !f.report) return', put: () => 'if (false) return' },
  { name: 'recording: the report is required of an argued MINOR too (evidence not consulted)', find: 'if (f.evidence === "measured" && !f.report) return', put: () => 'if (!f.report) return' },
  { name: 'recording: a process finding needs the report too', find: 'if (f.severity !== "MINOR" || f.kind === "process") return null;', put: () => 'if (f.severity !== "MINOR") return null;' },
  { name: 'recording: a report with no evidence is accepted', find: 'if (f.report && f.evidence === void 0) return', put: () => 'if (false) return' },
  { name: 'recording: the input part is not required (accepted missing / blank)', find: 'input: lineOf(v.report.input, `${where}.report.input`)', put: () => 'input: String(v.report.input ?? "x")' },
  { name: 'recording: the happens part is not required', find: 'happens: lineOf(v.report.happens, `${where}.report.happens`)', put: () => 'happens: String(v.report.happens ?? "x")' },
  { name: 'recording: the where part is not required', find: 'where: lineOf(v.report.where, `${where}.report.where`)', put: () => 'where: String(v.report.where ?? "x")' },
  { name: 'recording: the proof part is not required', find: 'proof: lineOf(v.report.proof, `${where}.report.proof`)', put: () => 'proof: String(v.report.proof ?? "x")' },
  { name: 'recording: evidence / kind may be re-graded', find: 'for (const field of ["evidence", "kind", "specSentence"]) if (had && had[field] !== void 0 && f[field] !== void 0 && had[field] !== f[field]) throw', put: () => 'for (const field of ["specSentence"]) if (had && had[field] !== void 0 && f[field] !== void 0 && had[field] !== f[field]) throw' },
  { name: 'recording: a measured MINOR may be re-kinded to process', find: 'if (had?.severity === "MINOR" && had.evidence === "measured" && had.kind !== "process" && f.kind === "process") throw', put: () => 'if (false) throw' },
  { name: 'recording: a repeat record erases the recorded report', find: 'next.findings[k] = { ...had ?? {}, ...f };', put: () => 'next.findings[k] = { ...f };' },
  { name: 'filing: --file is ON by default', find: 'if (!p.bools.has("--file")) return { code: 0, stdout: out, stderr: r.note };', put: () => '' },
  { name: 'filing: --file ignored (never files)', find: 'if (!p.bools.has("--file")) return { code: 0, stdout: out, stderr: r.note };', put: () => 'if (true) return { code: 0, stdout: out, stderr: r.note };' },
  { name: 'filing: a re-run files duplicates (dedupe off)', find: 'if (hit) return `  ${t.ticket}/${t.finding}: already filed', put: () => 'if (false) return `  ${t.ticket}/${t.finding}: already filed' },
  { name: 'filing: a tracker failure fails the close-out', find: 'return { code: 0, stdout: out, stderr: `${r.note}${lines.length', put: () => 'return { code: lines.some((l) => l.includes("NOT filed")) ? 2 : 0, stdout: out, stderr: `${r.note}${lines.length' },
  { name: 'filing: the list is withheld when a filing fails', find: 'return { code: 0, stdout: out, stderr: `${r.note}${lines.length', put: () => 'return { code: 0, stdout: lines.some((l) => l.includes("NOT filed")) ? "" : out, stderr: `${r.note}${lines.length' },
  { name: 'filing: --repo accepted without --file', find: 'if (p.vals["--repo"] !== void 0 && !p.bools.has("--file")) throw', put: () => 'if (false) throw' },
  { name: 'read-only: the close-out writes the state back', find: 'const res = closeoutTexts(state);', put: () => 'const res = closeoutTexts(state); fs.appendFileSync(stateFile(homeOf(deps.env), r.run), " ");' },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!orig.includes('closeoutTexts')) { console.error('dist-electron/cli.js has no fanout closeout — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

const baselineBad = report('baseline (built bundle)', scenarios(CLI));
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-closeout-mut-'));
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

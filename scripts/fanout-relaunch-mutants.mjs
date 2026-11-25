#!/usr/bin/env node
// #608 mutants: the relaunch (`stepReconcile`), the end (`stepEnd`) and the closing report of `orchestra fanout run`.
// Each mutant edits a COPY of src/shared (nothing in the repo) and must turn src/shared/fanout-relaunch.test.ts or fanout-report.test.ts red.
// Controls: the unmutated copy passes with 0 skipped; every anchor matches EXACTLY once (a drifted anchor throws, it does not "survive"); one provably equivalent edit must SURVIVE.
// Run: node scripts/fanout-relaunch-mutants.mjs   (exit 0 = every mutant killed)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = ['src/shared/fanout-relaunch.test.ts', 'src/shared/fanout-report.test.ts'];
const RL = 'src/shared/fanout-relaunch.ts';
const RP = 'src/shared/fanout-report.ts';

/** [id, file, [[from, to], …], 'equivalent'?] — `from` must occur exactly once in `file`. */
const MUTANTS = [
  ['unreadable-read-is-gone', RL, [["errors.push(`git ${t.branch}: ${msg(e)}`); delete r.branchHead; delete r.branchTree; delete r.mergedIntoTarget;", "errors.push(`git ${t.branch}: ${msg(e)}`); r.branchHead = null;"], ["if (errors.length) r.error = errors.join('; ');", '']]],
  ['pr-base-not-target', RL, [["baseRefName: state.target };", "baseRefName: 'elsewhere' };"]]],
  ['closed-pr-not-parked', RL, [["if (d.kind === 'pr-closed-unmerged') return", "if (false) return"]]],
  ['branch-gone-not-parked', RL, [["if (d.kind === 'branch-gone') return", "if (false) return"]]],
  ['ungated-hand-merge-not-parked', RL, [["if (d.kind === 'merged-at-ungated-head') return", "if (false) return"]]],
  ['park-a-merged-ticket', RL, [[" && !isParked(state0.tickets[x.d.ticket]) && !TERMINAL.has(state0.tickets[x.d.ticket].status));", " && !isParked(state0.tickets[x.d.ticket]));"]]],
  ['park-twice-writes-again', RL, [[" x.why !== null && !isParked(state0.tickets[x.d.ticket]) &&", " x.why !== null &&"]]],
  ['always-write', RL, [["if (!plan.writeBack.length && !toPark.length) {", "if (false) {"]]],
  ['writeback-dropped', RL, [["let s = plan.writeBack.length ? applyWriteBack(cur, plan.writeBack, now) : cur;", "let s = cur;"]]],
  ['adopted-always-empty', RL, [["out.adopted = Object.keys(s.tickets).filter((id) => s.tickets[id].status === 'merged' && before.tickets[id].status !== 'merged');", "out.adopted = [];"]]],
  ['end-ignores-pause', RL, [["if (!paused && unfinished) return", "if (unfinished) return"]]],
  ['end-done-while-unfinished', RL, [["if (!paused && unfinished) return", "if (false) return"]]],
  ['dropped-upstream-not-parked', RL, [["if (blocked) state = ctx.state.update", "if (false) state = ctx.state.update"]]],
  ['exit-ignores-parked', RP, [["  if (r.parked.length) return 3;", ""]]],
  ['exit-pause-not-4', RP, [["  if (r.paused) return 4;", ""]]],
  ['exit-unfinished-is-0', RP, [["  if (r.unfinished.length) return 1;\n", ""]]],
  ['parked-reason-lost', RP, [["reason: p?.reason ?? '(no reason recorded)'", "reason: ''"]]],
  ['unfinished-counted-merged', RP, [["    } else unfinished.push(id);", "    } else merged.push(id);"]]],
  ['fixed-finding-listed', RP, [["    if (f.settled?.how === 'fixed') continue;\n", ""]]],
  ['decision-flattened-to-open', RP, [["if (f.decision) out.push(", "if (false) out.push("]]],
  ['cost-unmeasured-is-zero', RP, [["costPerTicket: Object.fromEntries(ids.map((id) => [id, costs[id] ?? null])),", "costPerTicket: Object.fromEntries(ids.map((id) => [id, costs[id] ?? { tokens: 0 }])),"]]],
  ['cost-throw-fails-report', RP, [["try { out[id] = await costOf(id); } catch { out[id] = null; }", "out[id] = await costOf(id);"]]],
  ['choice-pointer-lost', RP, [["pr: state.tickets[c.ticket]?.pr ?? null, branch: state.tickets[c.ticket]?.branch ?? null }));", "pr: null, branch: null }));"]]],
  ['tokens-no-dedupe', RP, [["byId.set(typeof e.message.id === 'string' ? e.message.id : `anon-${anon++}`,", "byId.set(`anon-${anon++}`,"]]],
  ['tokens-unreadable-is-zero', RP, [["  return any ? sum : null;", "  return sum;"]]],
  ['tokens-skips-cache', RP, [["tokens: input + output + cacheRead + cacheCreate,", "tokens: input + output,"]]],
  ['reviewers-not-costed', RP, [["const ids = [t.implementer, t.review?.reviewer?.id, ...(t.review?.briefs ?? []).map((b) => b.reviewer)];", "const ids = [t.implementer];"]]],
  ['plan-order-lost', RP, [["return [...planned, ...all.filter((id) => !planned.includes(id))];", "return all.slice().reverse();"]]],
  // INSTRUMENT CHECK: provably EQUIVALENT (the sort in transcriptFilesIn only fixes the read order; a sum does not depend on it). It MUST survive.
  ['equiv-transcript-order', RP, [[".filter((n) => n.endsWith('.jsonl')).sort().map(", ".filter((n) => n.endsWith('.jsonl')).map("]], 'equivalent'],
];

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyTree(s, d); else fs.copyFileSync(s, d);
  }
}
function runTests(dir) {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', ...TESTS], { cwd: dir, encoding: 'utf8' });
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? NaN);
  return { rc: r.status, pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests'), tail: (r.stderr || '').slice(-300) };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-mutants-'));
const fresh = (id) => { const dir = path.join(work, id); copyTree(path.join(REPO, 'src', 'shared'), path.join(dir, 'src', 'shared')); return dir; };

let bad = 0;
try {
  const base = runTests(fresh('control'));
  const baseOk = base.fail === 0 && base.skipped === 0 && base.pass > 0 && base.pass === base.tests;
  console.log(`CONTROL unmutated: pass=${base.pass} fail=${base.fail} skipped=${base.skipped} -> ${baseOk ? 'CLEAN' : 'DIRTY'}`);
  if (!baseOk) { console.log(base.tail); process.exit(2); }
  for (const [id, file, edits, kind] of MUTANTS) {
    const dir = fresh(id);
    const target = path.join(dir, file);
    let src = fs.readFileSync(target, 'utf8');
    for (const [from, to] of edits) {
      const n = src.split(from).length - 1;
      if (n !== 1) throw new Error(`PATTERN-GONE ${id}: anchor matched ${n}x in ${file}: ${JSON.stringify(from.slice(0, 70))}`);
      src = src.replace(from, () => to);
    }
    fs.writeFileSync(target, src);
    const r = runTests(dir);
    const killed = r.fail > 0 || r.rc !== 0;
    if (kind === 'equivalent') {
      if (killed) bad++;
      console.log(`${killed ? 'UNEXPECTED-KILL' : 'SURVIVED (equivalent, expected)'} ${id.padEnd(34)} fail=${r.fail}/${r.tests}`);
      continue;
    }
    if (!killed) bad++;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${id.padEnd(34)} fail=${r.fail}/${r.tests}`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
const real = MUTANTS.filter((m) => m[3] !== 'equivalent').length;
console.log(bad === 0 ? `MUTANTS: ${real}/${real} killed (+${MUTANTS.length - real} equivalent survived as predicted)` : `MUTANTS: ${bad} BAD of ${MUTANTS.length}`);
process.exit(bad === 0 ? 0 : 1);

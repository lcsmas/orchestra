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
  ['branch-gone-not-parked', RL, [["if (d.kind === 'branch-gone' && (t.pr !== null || t.head)) return", "if (false) return"]]],
  ['branch-gone-fresh-ticket-parked', RL, [["if (d.kind === 'branch-gone' && (t.pr !== null || t.head)) return", "if (d.kind === 'branch-gone') return"]]],
  ['parked-adopted-by-ancestry', RL, [["const kept = wb.filter((w) => !isParked(state.tickets[w.ticket]));", "const kept = wb.slice();"]]],
  ['parked-adopted-ungated', RL, [["if (sameContent(pr.headRefOid, reality[id]?.prTree, t.head, t.tree)) kept.push", "if (true) kept.push"]]],
  ['parked-adopted-other-base', RL, [["pr?.state !== 'MERGED' || pr.baseRefName !== state.target || !pr.headRefOid) continue;", "pr?.state !== 'MERGED' || !pr.headRefOid) continue;"]]],
  ['release-behind-dropped', RL, [["state.tickets[p.blockedBy]?.status === 'merged' ? p.blockedBy : null; };", "state.tickets[p.blockedBy] ? p.blockedBy : null; };"]]],
  ['release-no-repoint', RL, [["    if (stillParked) { tickets[id]", "    if (false) { tickets[id]"]]],
  ['release-state-dropped-when-no-release', RL, [["freeing.size ? { ...state, tickets, updatedAt: now } : state", "released.length ? { ...state, tickets, updatedAt: now } : state"]]],
  ['merged-ungated-divergence-hidden', RL, [["    out.diverged = plan.divergences.filter((d) => d.kind !== 'reality-unreadable' && !(parkReason(d, state0.tickets[d.ticket]) && isParked(state0.tickets[d.ticket])));", "    out.diverged = plan.divergences.filter((d) => d.kind !== 'reality-unreadable' && !parkReason(d, state0.tickets[d.ticket]));"]]],
  ['empty-run-exit-0', RP, [["if (r.unfinished.length || !r.merged.length) return 1;", "if (r.unfinished.length) return 1;"]]],
  ['tokens-dedupe-per-file', RP, [["    collect(text, byId, anon);\n  }\n  return any ? tokenTotal(byId) : null;", "    const own = new Map(); collect(text, own, anon); for (const [k, v] of own) byId.set(`${f}:${k}`, v);\n  }\n  return any ? tokenTotal(byId) : null;"]]],
  ['ungated-hand-merge-not-parked', RL, [["if (d.kind === 'merged-at-ungated-head') return", "if (false) return"]]],
  ['park-a-merged-ticket', RL, [[" && !isParked(state0.tickets[x.d.ticket]) && !TERMINAL.has(state0.tickets[x.d.ticket].status));", " && !isParked(state0.tickets[x.d.ticket]));"]]],
  ['equiv-park-twice-writes-again', RL, [[" x.why !== null && !isParked(state0.tickets[x.d.ticket]) &&", " x.why !== null &&"]], 'equivalent'],  // since #603 (stack C) reconcile adds no divergence for a parked ticket (`claimsWork` is false), so the `!isParked` filter here is redundant
  ['always-write', RL, [["if (!writeBack.length && !toPark.length) {", "if (false) {"]]],
  ['writeback-dropped', RL, [["let s = writeBack.length ? applyWriteBack(cur, writeBack, now) : cur;", "let s = cur;"]]],
  ['adopted-always-empty', RL, [["out.adopted = Object.keys(s.tickets).filter((id) => s.tickets[id].status === 'merged' && before.tickets[id].status !== 'merged');", "out.adopted = [];"]]],
  ['end-ignores-pause', RL, [["if (!paused && unfinished) return", "if (unfinished) return"]]],
  ['end-done-while-unfinished', RL, [["if (!paused && unfinished) return", "if (false) return"]]],
  ['dropped-upstream-not-parked', RL, [["if (blocked) state = ctx.state.update", "if (false) state = ctx.state.update"]]],
  ['exit-ignores-parked', RP, [["  if (r.parked.length) return 3;", ""]]],
  ['exit-finished-run-paused-is-4', RP, [["  if (r.paused && r.unfinished.length) return 4;", "  if (r.paused) return 4;"]]],
  ['exit-pause-not-4', RP, [["  if (r.paused && r.unfinished.length) return 4;", ""]]],
  ['exit-unfinished-is-0', RP, [["  if (r.unfinished.length || !r.merged.length) return 1; // nothing merged and nothing parked (an empty run, or only dropped tickets) did not deliver\n", ""]]],
  ['parked-reason-lost', RP, [["reason: p?.reason ?? '(no reason recorded)'", "reason: ''"]]],
  ['unfinished-counted-merged', RP, [["    } else unfinished.push(id);", "    } else merged.push(id);"]]],
  ['fixed-finding-listed', RP, [["    if (f.settled?.how === 'fixed') continue;\n", ""]]],
  ['decision-flattened-to-open', RP, [["if (f.decision) out.push(", "if (false) out.push("]]],
  ['cost-unmeasured-is-zero', RP, [["costPerTicket: Object.fromEntries(ids.map((id) => [id, costs[id] ?? null])),", "costPerTicket: Object.fromEntries(ids.map((id) => [id, costs[id] ?? { tokens: 0 }])),"]]],
  ['cost-throw-fails-report', RP, [["try { out[id] = await costOf(id); } catch { out[id] = null; }", "out[id] = await costOf(id);"]]],
  ['flaky-not-read', RP, [["flaky: ids.flatMap((id) => flakyOf(state.tickets[id]).map((c) => `${id}/${c}`)),", 'flaky: [],']]],
  ['choice-pointer-lost', RP, [["pr: state.tickets[c.ticket]?.pr ?? null, branch: state.tickets[c.ticket]?.branch ?? null }));", "pr: null, branch: null }));"]]],
  ['tokens-no-dedupe', RP, [["const key = typeof e.message.id === 'string' ? e.message.id : `anon-${anon.n++}`;", "const key = `anon-${anon.n++}`;"]]],
  ['tokens-unreadable-is-zero', RP, [["  return any ? tokenTotal(byId) : null;\n}\n\n/** Every", "  return tokenTotal(byId);\n}\n\n/** Every"]]],
  ['tokens-last-line-wins', RP, [["byId.set(key, prev ? { i: Math.max(prev.i, cur.i), o: Math.max(prev.o, cur.o), r: Math.max(prev.r, cur.r), c: Math.max(prev.c, cur.c) } : cur);", "byId.set(key, cur);"]]],
  ['subagent-transcripts-skipped', RP, [["if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); }", "if (e.isDirectory()) { /* skipped */ }"]]],
  ['dropped-dependent-parked-upstream', RL, [["{ cause: 'situation', reason: `blocked by ${dropped} (dropped, never merged)` }", "{ cause: 'upstream', reason: `blocked by ${dropped} (dropped, never merged)` }"]]],
  ['tokens-skips-cache', RP, [["return { tokens: input + output + cacheRead + cacheCreate, input,", "return { tokens: input + output, input,"]]],
  ['reviewers-not-costed', RP, [["const ids = [t.implementer, t.review?.reviewer?.id, ...(t.review?.briefs ?? []).map((b) => b.reviewer)];", "const ids = [t.implementer];"]]],
  ['plan-order-lost', RP, [["return [...planned, ...all.filter((id) => !planned.includes(id))];", "return all.slice().reverse();"]]],
  // INSTRUMENT CHECK: provably EQUIVALENT (the sort in transcriptFilesIn only fixes the read order; a sum does not depend on it). It MUST survive.
  ['equiv-transcript-order', RP, [["for (const e of entries.sort((x, y) => (x.name < y.name ? -1 : 1))) {", "for (const e of entries) {"]], 'equivalent'],
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

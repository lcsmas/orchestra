#!/usr/bin/env node
// #605 rig (ledger #613) — `orchestra fanout run`, the Boucle, through the BUILT CLI (dist-electron/cli.js) on the DUMMY fleet (scripted agents, git, PR host and CI on a virtual clock): every rule of #601 has a must-pass
// arm (the scenario ends as expected AND the judge finds nothing) and a must-fail arm (a scenario that breaks the rule must be NAMED by the judge: an instrument that cannot fail measures nothing).
// Light: no Electron, no network, no tokens, no real workspace — the world is in memory, the state lives under a scratch ORCHESTRA_HOME in $TMPDIR.
//   node scripts/e2e-fanout-run.mjs            the arms through the built CLI (run `pnpm run build:cli` first — `pnpm run test:fanout-run` does)
//   node scripts/e2e-fanout-run.mjs --mutants  each mutant of the loop / judge / dummy (exact string, must occur ONCE — else REFUSED as stale), in a scratch copy of src/, must be KILLED by
//                                              src/shared/fanout-loop.test.ts + src/cli/fanout-run.test.ts (≥1 test FAILs); the unpatched copy is the control and must be GREEN (0 fail, 0 skipped)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_SURVIVED, exitAfterFlush, runMutantChildren } from './lib/mutant-pool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const SCEN = path.join(ROOT, 'src', 'shared', 'fanout-loop-scenarios');
const MUTANTS = process.argv.includes('--mutants');
const PART = process.argv.includes('--part') ? process.argv[process.argv.indexOf('--part') + 1] : null; // --part i/n: every n-th mutant starting at i (the rig is split in two CI slots: each fits the 10-min limit)
const [PART_I, PART_N] = PART ? PART.split('/').map(Number) : [1, 1];
if (PART && !(Number.isInteger(PART_I) && Number.isInteger(PART_N) && PART_I >= 1 && PART_I <= PART_N)) { console.error('--part must be i/n with 1 <= i <= n'); process.exit(2); }
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null; // iterate on one mutant: --mutants --only <substring of its name>

// ── arms through the built CLI ───────────────────────────────────────────────────────────────────────────────
function cli(scenario, env = {}, extra = []) {
  const home = fs.mkdtempSync(path.join(tmpBase, 'fanout-run-rig-'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'dist-electron', 'cli.js'), 'fanout', 'run', '--scenario', path.join(SCEN, `${scenario}.json`), ...extra], { encoding: 'utf8', timeout: 120_000, env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: home, ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* refusal: no report */ }
  const events = (() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'fanout-dummy', `${json?.dummy?.run ?? scenario}.events.json`), 'utf8')).events; } catch { return []; } })();
  fs.rmSync(home, { recursive: true, force: true });
  return { code: r.status, json, events, stderr: r.stderr };
}
const D = { ORCHESTRA_FANOUT_DUMMY: '1' };
const rules = (r) => (r.json?.dummy?.violations ?? []).map((v) => v.rule);
const order = (r) => r.events.filter((e) => e.ev === 'merge').map((e) => e.ticket);
const ALL7 = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// [name, () => run, (run) => failure string | null]
const ARMS = [
  ['PASS  7-ticket RTS-shaped scenario: every ticket merged, exit 0, judge clean', () => cli('rts7', D), (r) => r.code !== 0 ? `exit ${r.code}` : !same(r.json.report.merged, ALL7) ? `merged ${r.json.report.merged}` : rules(r).length ? `violations ${rules(r)}` : null],
  ['PASS  decision 3: all 7 spawned before the first merge, none twice', () => cli('rts7', D), (r) => { const sp = r.events.filter((e) => e.ev === 'spawn'); const fm = r.events.findIndex((e) => e.ev === 'merge'); return sp.length !== 7 || sp.some((e) => r.events.indexOf(e) > fm) ? `spawns ${sp.length}, first merge at event ${fm}` : null; }],
  ['FAIL  decision 3: an implementer that waits for its upstream is NAMED (implementer-waited)', () => cli('implementer-waits', D), (r) => rules(r).includes('implementer-waited') ? null : `judge said ${JSON.stringify(rules(r))}`],
  ['PASS  decision 4: 7 connect asks (one per dependency edge), none before an approval or after a merge', () => cli('rts7', D), (r) => r.events.filter((e) => e.ev === 'connect-ask').length === 7 && !rules(r).some((x) => x.startsWith('connect')) ? null : `asks ${r.events.filter((e) => e.ev === 'connect-ask').length}, rules ${rules(r)}`],
  ['PASS  decision 5: a question gets the fixed answer and is listed (1 choice), the run still merges 7', () => cli('question', D), (r) => r.code === 0 && r.json.report.choices.length === 1 && r.json.report.choices[0].rule === 'reversible-default' && r.json.report.merged.length === 7 ? null : `exit ${r.code} choices ${r.json?.report?.choices?.length}`],
  ['PASS  decision 5: "NO SAFE OPTION" parks the ticket (question) + its dependents (upstream), exit 3, the others merge', () => cli('nosafe', D), (r) => r.code === 3 && same(r.json.report.merged, ['T1', 'T2', 'T4', 'T6']) && same(r.json.report.parked.map((p) => `${p.ticket}:${p.cause}`), ['T3:question', 'T5:upstream', 'T7:upstream']) ? null : `exit ${r.code} ${JSON.stringify(r.json?.report?.parked)}`],
  ['PASS  decision 11 / Admission: a start held 3 ticks is a wait — exit 0, 7 merged, nothing parked', () => cli('held', D), (r) => r.code === 0 && r.json.report.merged.length === 7 && r.json.report.parked.length === 0 ? null : `exit ${r.code} parked ${JSON.stringify(r.json?.report?.parked)}`],
  ['PASS  decision 10: two ready tickets merge in READINESS order (B before A)', () => cli('readiness', D), (r) => r.code === 0 && same(order(r), ['B', 'A']) && !rules(r).length ? null : `order ${order(r)} rules ${rules(r)}`],
  ['PASS  decision 10: a red CI is never merged — ticket parked (situation), dependent parked (upstream), exit 3', () => cli('red-ci', D), (r) => r.code === 3 && same(r.json.report.merged, ['T2']) && r.events.every((e) => e.ev !== 'merge' || e.ci === 'green') ? null : `exit ${r.code} merged ${r.json?.report?.merged}`],
  ['PASS  decision 10: a CI still running is a wait (merge after 4 + 15 min, on green)', () => cli('slow-ci', D), (r) => r.code === 0 && r.events.filter((e) => e.ev === 'merge').every((e) => e.ci === 'green' && e.t >= Date.parse('2026-01-01T00:19:00Z')) ? null : `exit ${r.code}`],
  ['PASS  decision 10: no merge without a recorded approval (changes requested ⇒ parked, never merged)', () => cli('changes-requested', D), (r) => r.code === 3 && same(r.json.report.merged, ['T2']) && !rules(r).length ? null : `exit ${r.code} merged ${r.json?.report?.merged}`],
  ['PASS  decision 10: an approval of an old head does not merge the new head', () => cli('stale-approval', D, []), (r) => r.code !== 0 ? `exit ${r.code}` : r.events.filter((e) => e.ev === 'merge').length === 1 && r.events.filter((e) => e.ev === 'merge').every((e) => r.events.some((x) => x.ev === 'review-record' && x.verdict === 'approve' && x.head === e.head)) ? null : 'merged a head with no approval'],
  ['PASS  an upstream that moves after its approval: the dependent is asked again at the new head, no crash, merged in order', () => cli('upstream-moves', D), (r) => r.code === 0 && same(order(r), ['T1', 'T2']) && r.events.filter((e) => e.ev === 'connect-ask' && e.ticket === 'T2').length === 2 && !rules(r).length ? null : `exit ${r.code} order ${order(r)} rules ${rules(r)}`],
  ['PASS  #629: a ticket whose author never records --follows is nominated and merged — the loop records the follows itself and says so (T1 T2 T3 merged, nothing parked, exit 0)', () => cli('follows-missing', D), (r) => r.code === 0 && same(r.json.report.merged, ['T1', 'T2', 'T3']) && !r.json.report.parked.length && !r.events.some((e) => e.ev === 'send' && /could not nominate/.test(String(e.text))) && !rules(r).length ? null : `exit ${r.code} ${JSON.stringify(r.json?.report?.parked)}`],
  ['PASS  #628: a merge-conflict at delivery → ONE SYNC order to the implementer, its merge commit, the reviewer reads the new head, delivery retries: T1 T2 merged, nothing parked, nobody replaced', () => cli('merge-conflict-sync', D), (r) => r.code === 0 && same(order(r), ['T1', 'T2']) && r.events.filter((e) => e.ev === 'sync-order').length === 1 && r.events.filter((e) => e.ev === 'spawn' && e.ticket === 'T2').length === 1 && !rules(r).length ? null : `exit ${r.code} orders ${r.events.filter((e) => e.ev === 'sync-order').length}`],
  ['PASS  #628: 2 orders and no new head → the implementer is replaced on the same branch and the order sent again; merged, nothing parked', () => cli('merge-conflict-replace', D), (r) => r.code === 0 && same(order(r), ['T1', 'T2']) && r.events.filter((e) => e.ev === 'sync-order').length === 3 && r.events.filter((e) => e.ev === 'impl-replaced').length === 1 && !r.json.report.parked.length ? null : `exit ${r.code} orders ${r.events.filter((e) => e.ev === 'sync-order').length}`],
  ['PASS  #625: --tickets and no plan → the plan agent is asked, its plan accepted, then released; both tickets merged', () => cli('plan-agent', D), (r) => r.code === 0 && same(order(r), ['T1', 'T2']) && ['plan-agent-spawn', 'plan-accepted', 'plan-agent-released'].every((x, k, a) => r.events.findIndex((e) => e.ev === x) >= 0 && (k === 0 || r.events.findIndex((e) => e.ev === x) > r.events.findIndex((e) => e.ev === a[k - 1]))) ? null : `exit ${r.code}`],
  ['PASS  decision 10: a check set not identical on two polls is not green (late-registering workflow): merged only on a green CI', () => cli('late-check', D), (r) => r.code === 0 && r.events.filter((e) => e.ev === 'merge').every((e) => e.ci === 'green') && !rules(r).length ? null : `exit ${r.code} rules ${rules(r)}`],
  ['PASS  decision 10: a green that ran 0 steps is refused (A never merged, B merged, exit 3)', () => cli('zero-step-ci', D), (r) => r.code === 3 && same(r.json.report.merged, ['B']) && !r.events.some((e) => e.ev === 'merge' && e.ticket === 'A') ? null : `exit ${r.code} merged ${r.json?.report?.merged}`],
  ['PASS  decision 3/4/5 agent side: every brief the loop launched carries the loop section', () => cli('rts7', D), (r) => r.events.filter((e) => e.ev === 'spawn').every((e) => e.briefHasLoop === true) ? null : 'a brief without the loop section'],
  ['FAIL  r3: a reviewer that dies every time is replaced twice, then T1 is parked (reviewer died 2 times) — 3 spawns, T2 merged, exit 3', () => cli('reviewer-dies', D), (r) => r.code === 3 && r.events.filter((e) => e.ev === 'review-spawn' && e.ticket === 'T1').length === 3 && /^reviewer died 2 times/.test(r.json.report.parked[0]?.reason ?? '') && same(r.json.report.merged, ['T2']) ? null : `exit ${r.code} spawns ${r.events.filter((e) => e.ev === 'review-spawn').length} ${JSON.stringify(r.json?.report?.parked)}`],
  ['FAIL  r3: an implementer that dies at once is respawned twice, then T1 is parked (implementer died 2 times) — 3 spawns, T2 merged, exit 3', () => cli('implementer-dies', D), (r) => r.code === 3 && r.events.filter((e) => e.ev === 'spawn' && e.ticket === 'T1').length === 3 && /^implementer died 2 times/.test(r.json.report.parked[0]?.reason ?? '') && same(r.json.report.merged, ['T2']) ? null : `exit ${r.code} spawns ${r.events.filter((e) => e.ev === 'spawn' && e.ticket === 'T1').length}`],
  ['PASS  swap: a HAND-planned run (complete plan, no loopPlan marker) — every brief the loop launched carries the loop section (7/7)', () => cli('pre-planned', D), (r) => r.code === 0 && r.events.filter((e) => e.ev === 'spawn' && e.briefHasLoop === true).length === 7 ? null : `exit ${r.code} briefs with the loop section ${r.events.filter((e) => e.ev === 'spawn' && e.briefHasLoop === true).length}`],
  ['FAIL  one reader: a message read by someone else is NAMED (mail-read-by-other) and the question it carried is never answered', () => cli('steal-mail', D), (r) => rules(r).includes('mail-read-by-other') && rules(r).includes('question-unanswered') ? null : `judge said ${JSON.stringify(rules(r))}`],
  ['FAIL  the dummy gate: --scenario without ORCHESTRA_FANOUT_DUMMY=1 is refused, nothing runs', () => cli('rts7', {}), (r) => r.code === 2 && /\[run-scenario-gated\]/.test(r.stderr) && r.events.length === 0 ? null : `exit ${r.code}`],
  ['FAIL  the built verb without a scenario and without a host that vouches the caller refuses to run (#614): exit 1', () => { const r = spawnSync(process.execPath, [path.join(ROOT, 'dist-electron', 'cli.js'), 'fanout', 'run', '--tickets', 'A,B'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...D } }); return { code: r.status, json: null, events: [], stderr: r.stderr }; }, (r) => r.code === 1 && /refusing to run|run-live-ports/.test(r.stderr) ? null : `exit ${r.code} ${r.stderr.slice(0, 120)}`],
];

if (!MUTANTS) {
  if (!fs.existsSync(path.join(ROOT, 'dist-electron', 'cli.js'))) { console.error('dist-electron/cli.js is missing: run `pnpm run build:cli` first'); process.exit(1); }
  let bad = 0;
  for (const [name, run, check] of ARMS) {
    const why = check(run());
    console.log(`${why === null ? 'ok     ' : 'FAILED '} ${name}${why ? `  — ${why}` : ''}`);
    if (why !== null) bad++;
  }
  console.log(`\n${ARMS.length - bad}/${ARMS.length} arms as expected`);
  process.exit(bad ? 1 : 0);
}

// ── mutants ──────────────────────────────────────────────────────────────────────────────────────────────────
const CHILD = process.env.MUT_CHILD; // #623: set by the parent — run this ONE mutant (its index) in its OWN scratch copy of src/; the parent runs the control
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-run-mut-'));
fs.cpSync(path.join(ROOT, 'src'), path.join(scratch, 'src'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ type: 'module' }));
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
const TESTS = ['src/shared/fanout-loop.test.ts', 'src/cli/fanout-run.test.ts', 'src/shared/fanout-loop-ci.test.ts', 'src/shared/fanout-loop-corrections.test.ts'].map((f) => path.join(scratch, f));
function run(timeout = 180_000) { // a mutant that runs away (an infinite loop) is KILLED by the timeout (printed as such); mutants run 4 at a time (#623), so it is longer than the 90 s of the serial rig; the control gets the long one
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...TESTS], { cwd: scratch, encoding: 'utf8', timeout, env: { ...process.env, TMPDIR: tmpBase } });
  const out = `${r.stdout}\n${r.stderr}`;
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return { pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests') };
}
const BR = 'src/shared/fanout-implementer-brief.ts', ST = 'src/shared/fanout-start.ts';
const L = 'src/shared/fanout-loop.ts', J = 'src/shared/fanout-loop-judge.ts', S = 'src/shared/fanout-state.ts', DM = 'src/shared/fanout-loop-dummy.ts';
// [name, [[file, from, to], …]] — every `from` must occur exactly once in its file
const mutants = [
  ['decision 3 (the fleet): every dependent\'s implementer waits for its upstream to merge before it codes', [[DM, "return [{ do: 'code' }, { do: 'nominate' }, ...deps.map", "return [...(deps.length ? [{ do: 'wait' } as Step] : []), { do: 'code' }, { do: 'nominate' }, ...deps.map"]]],
  ['decision 4: connect at NOMINATION (the upstream head, before any approval)', [[L, "const a = ctx.approved.get(up);\n      if (!u || ticketMerged(s, up) || !a) continue;", "const a = ctx.approved.get(up) ?? (u?.head ? { head: u.head, at: '', round: 0 } : undefined);\n      if (!u || ticketMerged(s, up) || !a) continue;"]]],
  ['#628: a delivery refusal is never ordered to the implementer', [[L, "if (RULED_REFUSALS.has(reason)) return;", "return;"]]],
  ['#628: an implementer that ignores 2 orders is never replaced', [[L, "if (o.n < 2) return send(o.n + 1);", "return send(o.n + 1);"]]],
  ['decision 4: connect AFTER the merge (the step runs after deliver)', [[L, "'approvals', 'connect', 'ci', 'corrections', 'deliver', 'end'] as const", "'approvals', 'ci', 'corrections', 'deliver', 'connect', 'end'] as const"]]],
  ['decision 4: the ask is repeated every pass', [[L, "if (asked && loopSameSha(asked, a.head) && s.loop.askedTo[id]?.[up] === t.implementer) continue;", "/* ask every pass */"], [L, "      if (t.builtOn[up] && loopSameSha(t.builtOn[up], a.head)) continue;\n", ""]]],
  ['decision 4: the ask carries no exact head', [[L, "`CONNECT ${i.upstream} ${i.head}`,", "`CONNECT ${i.upstream} ${i.head.slice(0, 7)}`,"]]],
  ['decision 5: a question gets no answer', [[L, "        await deps.fleet.send(m.sender, FIXED_ANSWER, 'answer');\n", ""]]],
  ['decision 5: a question is not listed (no choice recorded)', [[L, "        if (!h) ctx.update((x) => { const y = listChoice(x,", "        if (false as boolean) ctx.update((x) => { const y = recordChoice(x,"]]],
  ['decision 5: "NO SAFE OPTION" is read as a plain question', [[L, "        if (nso) {", "        if (false as boolean && nso) {"]]],
  ['decision 5: "NO SAFE OPTION" records a choice but parks nothing', [[L, "listChoice(parkTicket(x, ticket, { cause: 'question', reason: nso.reason }, deps.now()), {", "listChoice(x, {"]]],
  ['decision 5 (the real #603 transition): a parked ticket does not park its dependents', [[S, "for (const d of dependentsOf(state, id)) {", "for (const d of [] as string[]) {"]]],
  ['one reader: the loop reads the mail and acks it unprocessed (a read-and-drop)', [[L, "  const mails = [...(await deps.fleet.mail())].sort(", "  const dropped = await deps.fleet.mail(); if (dropped.length) await deps.fleet.ack(dropped[dropped.length - 1].seq);\n  const mails = [...(await deps.fleet.mail())].sort("]]],
  ['a dependent is nominated on the mere presence of builtOn (an upstream that moved crashes the run)', [[L, "const clear = unmergedUpstreams(s, id).every((u) => upstreamBlocker(view, view.tickets[id], u) === null);", "const clear = unmergedUpstreams(s, id).every((u) => builtOn[u]);"]]],
  ['a nomination the state refuses ends the run', [[L, "      if (!(e instanceof FanoutStateError)) throw e;\n      // the state refuses", "      throw e;\n      // the state refuses"]]],
  ['the judge: a later changes-requested does not void an earlier approve', [[J, "records[records.length - 1].verdict === 'approve' ?", "records.some((x) => x.verdict === 'approve') ?"]]],
  ['MAJOR-1: the mail is acked BEFORE its batch is processed', [[L, "  const failed: number[] = [];\n  const markDone", "  const failed: number[] = [];\n  if (mails.length) await deps.fleet.ack(mails[mails.length - 1].seq);\n  const markDone"]]],
  ['MAJOR-1: the question\'s choice is written AFTER the answer is sent', [[L, "        if (!h) ctx.update((x) => { const y = listChoice(x,", "        if (false as boolean) ctx.update((x) => { const y = recordChoice(x,"], [L, "        markDone(m.seq);\n        ctx.did(`answered", "        ctx.update((x) => recordChoice(x, { ticket: ticket ?? m.sender, question: first, rule: 'reversible-default', answer: FIXED_ANSWER }, deps.now()));\n        markDone(m.seq);\n        ctx.did(`answered"]]],
  ['MAJOR-1: a handled message is handled again (no idempotency)', [[L, "      if (h === 'done') return;\n", ""]]],
  ['MINOR-5: a port error on one ticket ends the run', [[L, "if (e instanceof LoopKilled || e instanceof SeatRefusal) throw e;", "throw e;"]]],
  ['MAJOR-2: the check set is never compared across polls (stable is a constant)', [[L, "const stable = s0.loop.checksSeen[t.head] === names;", "const stable = true;"]]],
  ['MAJOR-2: every green check counts as having run a step', [[L, "steps: c.steps ?? null }));", "steps: 1 }));"]]],
  ['MAJOR-2: the merge is a squash', [[L, "deps.forge.merge(r.pr, r.head, 'merge')", "deps.forge.merge(r.pr, r.head, 'squash')"]]],
  ['MINOR-1: NO SAFE OPTION must open the first line, exactly (fails open on a near-miss)', [[L, "const m = /^[ \\t\\W_]*no[ \\t_-]*safe[ \\t_-]*option\\b/im.exec(body);", "const m = /^NO SAFE OPTION: /.exec(body);"]]],
  ['r2 MINOR-1: a question that merely CONTAINS the words parks (the marker is matched anywhere)', [[L, "const m = /^[ \\t\\W_]*no[ \\t_-]*safe[ \\t_-]*option\\b/im.exec(body);", "const m = /no[\\s_-]*safe[\\s_-]*option/i.exec(body);"]]],
  ['MINOR-2: a held start is a stall', [[L, "for (const x of r.waiting) { ctx.waitOn(`held:${x.ticket}`, holdMs); ctx.note(", "for (const x of r.waiting) { ctx.note("], [L, "for (const id of heldNow) ctx.waitOn(`held:${id}`, holdMs);", ""]]],
  ['MINOR-2: a CI still running is a stall', [[L, "if (dec.action === 'wait') { ctx.waitOn(`ci:${id}:${t.head}`, deps.options.stallMs); return; }", "if (dec.action === 'wait') return;"]]],
  ['MINOR-2: a reviewer reading is a stall', [[L, "{ ctx.waitOn(`review:${id}:${t.head}`, deps.options.stallMs); return; } // briefed", "return; // briefed"]]],
  ['r2 MAJOR-1: a wait is unbounded (it counts as progress for ever)', [[L, "if (loopMs(deps.now()) - loopMs(since) <= boundMs) {", "if (true as boolean) {"]]],
  ['r2 MAJOR-1: a dead reviewer is not replaced (waited on like a live one)', [[L, "&& (!rv || deps.fleet.live(rv))) {", ") {"]]],
  ['MINOR-3: the loop section is never added to the implementer brief', [[BR, "...((input.loop ?? !!(state as { loopPlan?: unknown }).loopPlan) ? ['', LOOP_BRIEF] : [])", "...[]"]]],
  ['MINOR-3: the loop section is always added (a non-loop brief changes)', [[BR, "...((input.loop ?? !!(state as { loopPlan?: unknown }).loopPlan) ? ['', LOOP_BRIEF] : [])", "...['', LOOP_BRIEF]"]]],
  ['MINOR-3: the #604 marker (state.loopPlan) does not turn the loop section on', [[BR, "input.loop ?? !!(state as { loopPlan?: unknown }).loopPlan", "input.loop ?? false"]]],
  ['round 2: an ask is listed uncut (recordChoice refuses it, the run ends)', [[L, "loopClean(m.body.split('\\n')[0]).slice(0, ASK_MAX);", "loopClean(m.body.split('\\n')[0]);"]]],
  ['round 2: a respawned author is not asked again (the ask is keyed by head alone)', [[L, " && s.loop.askedTo[id]?.[up] === t.implementer) continue;", ") continue;"]]],
  ['round 2: the dummy forge close() closes nothing', [[DM, "async close(n) { w.closePr(n); },", "async close(_n) { /* nothing */ },"]]],
  ['round 2: the dummy forge merges a closed PR', [[DM, "if (p.state !== 'open') return { ok: false,", "if (p.state === 'merged') return { ok: false,"]]],
  ['r3: a dead reviewer is replaced for ever (no cap)', [[L, "      if (died >= cap) {", "      if (false as boolean) {"]]],
  ['r3 OPS: the replacement is charged BEFORE the spawn (a failed spawn burns the cap)', [[L, "    const r = await deps.fleet.spawnReviewer(id, t.head);\n    if (last && loopSameSha(last.head, t.head)) ctx.update((x) => ({ ...x, loop: { ...x.loop, replaced: { ...x.loop.replaced, [key]: died + 1 } } }));", "    if (last && loopSameSha(last.head, t.head)) ctx.update((x) => ({ ...x, loop: { ...x.loop, replaced: { ...x.loop.replaced, [key]: died + 1 } } }));\n    const r = await deps.fleet.spawnReviewer(id, t.head);"]]],
  ['r3: the reviewer replacements are not counted', [[L, "[key]: died + 1 } } }));", "[key]: died } } }));"]]],
  ['r3: a dead implementer is respawned for ever (no cap)', [[L, "    if (n >= cap) {", "    if (false as boolean) {"]]],
  ['r3: the implementer respawns are not counted', [[L, "replaced: { ...y.loop.replaced, [key]: (y.loop.replaced[key] ?? 0) + 1 } } }));\n    ctx.did(`restarted", "replaced: y.loop.replaced } }));\n    ctx.did(`restarted"]]],
  ['r3: a second hold inherits the first hold\'s age', [[L, "busySince: Object.fromEntries(Object.entries(y.loop.busySince).filter(([k]) => !fresh.some((x) => k === `held:${x.ticket}`))) } }));", "busySince: y.loop.busySince } }));"]]],
  ['swap: a parked ticket still counts as active (the loop reads no status)', [[L, "t.status !== 'merged' && t.status !== 'dropped' && t.status !== 'parked';", "t.status !== 'merged' && t.status !== 'dropped';"]]],
  ['swap: the loop does not park through the state (no status change: startRun would respawn it)', [[L, "ctx.update((x) => (ticketParked(x, id) ? x : parkTicket(x, id, { cause: 'situation', reason }, deps.now())));\n        ctx.did(`parked ${id}: ${reason}`);\n        return;", "ctx.did(`parked ${id}: ${reason}`);\n        return;"]]],
  ['swap: an ask is listed with its control characters (the state refuses it, the message is retried for ever)', [[L, "const loopClean = (t: string): string => t.replace(/[\\x00-\\x08\\x0b-\\x1f\\x7f]/g, ' ').trim() || '(empty)';", "const loopClean = (t: string): string => t.trim() || '(empty)';"]]],
  ['swap: startRun does not pass the loop flag (a hand-planned run gets no loop section)', [[ST, "...(deps.loop !== undefined ? { loop: deps.loop } : {}), ", ""]]],
  ['swap: a full choices list is still written to (the state refuses: [choice-bad] on every restart)', [[L, "if ((x.choices?.length ?? 0) >= CHOICES_MAX) {", "if (false as boolean) {"]]],
  ['decision 12: the nomination signal is not durable (a kill between the mail and the nomination loses it)', [[L, "if (ctx.signals.has(id) || s.loop.signalled[id]) {", "if (ctx.signals.has(id)) {"]]],
  ['decision 11: a start held by Admission parks the ticket (read as a fault)', [[L, "for (const x of r.waiting) { ctx.waitOn(`held:${x.ticket}`, holdMs); ctx.note(`waiting: ${x.ticket} — ${x.why}`); }", "for (const x of r.waiting) ctx.update((y) => parkTicket(y, x.ticket, { cause: 'situation', reason: x.why }, deps.now()));"]]],
  ['decision 10: a merge with NO recorded approval (any nominated ticket counts as approved)', [[L, "if (!r.ok || r.recorded.verdict !== 'approve' || r.recorded.blocking > 0 || r.recorded.major > 0) continue;", "if (false as boolean) continue;"], [L, "if (entry) ctx.approved.set(id, { head: t.head, at: entry.at, round: r.recorded.round });", "ctx.approved.set(id, { head: t.head, at: entry?.at ?? s.updatedAt, round: 0 });"], [L, "    if (!rec) return; // no recorded verdict on this content: nothing to merge on (defence in depth: `ctx.approved` already says so)\n", ""], [L, "      verdict: { round: rec.round, blocking: rec.blocking, major: rec.major, minor: rec.minor, head: rec.head },", "      verdict: rec ? { round: rec.round, blocking: rec.blocking, major: rec.major, minor: rec.minor, head: rec.head } : undefined,"]]],
  ['decision 10: the approval of an OLD head merges a new head', [[L, "const r = recordedVerdictOf(s, id, t.head, t.tree);\n    if (!r.ok ||", "const r = recordedVerdictOf(s, id, s.tickets[id].reviews?.at(-1)?.head ?? t.head, null);\n    if (!r.ok ||"], [L, "const entry = reviewOn(t, t.head, t.tree);", "const entry = t.reviews?.at(-1);"], [L, "    const verdict = recordedVerdictOf(s0, id, t.head, t.tree);", "    const verdict = recordedVerdictOf(s0, id, s0.tickets[id].reviews?.at(-1)?.head ?? t.head, null);"], [L, "      waitedMs: 0, noChecksGraceMs:", "      verdictSameTree: true, waitedMs: 0, noChecksGraceMs:"]]],
  ['decision 10: a red CI is merged', [[L, "state: c.status === 'green' ? 'success' : c.status === 'red' ? 'failure' : 'pending'", "state: c.status === 'pending' ? 'pending' : 'success'"]]],
  ['decision 10: a CI still running is merged', [[L, "state: c.status === 'green' ? 'success' : c.status === 'red' ? 'failure' : 'pending'", "state: c.status === 'red' ? 'failure' : 'success'"]]],
  ['decision 10: a ticket merges before its upstream', [[L, "    if (t.dependsOn.some((u) => !ticketMerged(s0, u))) return; // an unmerged upstream: never first\n", ""], [L, "if (!upDecision.ok) {", "if (false as boolean && !upDecision.ok) {"]]],
  ['decision 10: merges in DECLARATION order', [[L, "ready.sort((x, y) => x.readyAt - y.readyAt || x.order - y.order);", "ready.sort((x, y) => x.order - y.order);"]]],
  ['exit codes: a run with parked tickets exits 0', [[L, "return await finish(parkedTickets(s).length ? 3 : 0);", "return await finish(0);"]]],
  ['exit codes: a pause is ignored', [[L, "if (pausedOf(s)) return await finish(4,", "if (false as boolean && pausedOf(s)) return await finish(4,"]]],
  ['the judge: a merge on a red CI is not a violation', [[J, "if (m.ci !== 'green') v(", "if (false as boolean) v("]]],
  ['the judge: a merge with no approval is not a violation', [[J, "if (!approvals.length) v(", "if (false as boolean) v("]]],
  ['the judge: readiness order is not checked', [[J, "if (readiness[b].at < readiness[a].at) v(", "if (false as boolean) v("]]],
  ['the judge: a read by someone else is fine', [[J, "x.ev === 'mail-read' && x.reader !== 'loop'", "x.ev === 'mail-read' && false"]]],
  ['the judge: a connect before the approval is fine', [[J, "if (!approved) v('connected-before-approval'", "if (false as boolean) v('connected-before-approval'"]]],
  ['the judge: a connect after the merge is fine', [[J, "if (m && idx(m) < idx(e)) v(", "if (false as boolean) v("]]],
  ['the dummy: a second openPr for the same branch opens a second PR', [[DM, "for (const p of this.prs.values()) if (p.branch === branch) return p.n;\n", ""]]],
  ['the dummy: a re-run creates no new run (the jobId does not change)', [[DM, "rerun(n: number): void { const p = this.prs.get(n)!; this.runFor(p, this.branches.get(p.branch)!, true); }", "rerun(_n: number): void { /* nothing re-runs */ }"]]],
  ['the dummy: the world answers the question with anything (the fixed answer is not what unblocks)', [[DM, "this.ev('send', a?.ticket, { to: ws, kind: 'answer', text });", "this.ev('send', a?.ticket, { to: ws, kind: 'answer', text: 'whatever' });"]]],
  ['stack C connect (#607): stepCi does nothing (red CI is never re-run, told, parked or paused)', [[L, "const r = await runCi(ciCtxOf(ctx));", "const r = { reran: [], told: [], parked: [], flaky: [], paused: false } as Awaited<ReturnType<typeof runCi>>;"]]],
  ['stack C connect (#607): a red or missing start check does not refuse the start', [[L, "if (!r.ok) throw new LoopRefusal(`run-${r.code}`, r.detail);", "if (false as boolean) throw new LoopRefusal(`run-${r.code}`, r.detail);"]]],
  ['stack C connect (#608): a paused run goes on through the steps', [[L, "if (step === 'reconcile' || step === 'ci') { const cur", "if (false as boolean) { const cur"]]],
  ['stack C connect (#608): reconcile adopts nothing (git does not overrule the state)', [[L, "  if (!readLoopState(deps.home, deps.run)) return;\n  // `readReality`", "  return;\n  // `readReality`"]]],
  ['stack C connect (#608, story 21): the report costs are not read from the fleet', [[L, "await collectCosts(s, (t) => deps.fleet.costOf(t))", "{}"]]],
  ['stack C connect (#606): stepCorrections does nothing', [[L, "const out = await runCorrections({ deps: ctx.deps, guard: ctx.guard });", "const out = [] as Awaited<ReturnType<typeof runCorrections>>;"]]],
  ['connect fix (#606 MAJOR-1): a dead author with an unanswered batch is never replaced', [['src/shared/fanout-loop-corrections.ts', "      if (!author || !deps.fleet.live(author) || startedAfter) {\n        const a2", "      if (false as boolean) {\n        const a2"]]],
  ['connect fix (#606 MAJOR-2): the corrections step is not guarded (one port error ends the run)', [[L, "runCorrections({ deps: ctx.deps, guard: ctx.guard })", "runCorrections({ deps: ctx.deps })"]]],
  ['connect fix (#606 m1): the stall reason of a ticket waiting for corrections says "approved"', [[L, "if (lastRev?.verdict === 'changes-requested' && (loopSameSha(lastRev.head, t.head) || (!!lastRev.tree && lastRev.tree === t.tree))) return", "if (false as boolean) return"]]],
  ['connect fix (#606 m2): a kill at the batch wake is swallowed as a failed wake', [['src/shared/fanout-loop-corrections.ts', "if (e instanceof LoopKilled) throw e; deps.log(", "deps.log("]]],
  ['connect fix (#608 m1-A): reconcile does not re-throw a kill that its reads swallowed', [[L, "  if (killed) throw killed;", ""]]],
  ['connect fix (#608 m1-B): reconcile\'s port trap does not see the kill', [[L, "if (e instanceof LoopKilled) killed = e; throw e;", "throw e;"]]],
  ['connect fix (#608 m2): a finished run with nothing merged exits 0', [[L, "exit: exit === 0 ? reportExit(report) === 1 ? 1 : 0 : exit,", "exit,"]]],
  ['connect fix (#608 m2): the end step does not park behind a dropped upstream', [[L, "  await runEnd({ now: deps.now,", "  void ({ now: deps.now,"]]],
  ['connect fix (#607 c2): the environment mark skips a dependent whose red was carried', [['src/shared/fanout-loop-ci.ts', "        const c = r.checks.find((x) => x.status === 'red' && x.name === cn);\n        if (!c) continue;", "        const c = r.checks.find((x) => x.status === 'red' && x.name === cn);\n        if (!c || !shared.find(([n]) => n === cn)?.[1].some((h) => h.id === r.id)) continue;"]]],
  ['connect fix (#607 c1): the pause break is only checked after reconcile (a ready ticket merges in the pausing pass)', [[L, "if (step === 'reconcile' || step === 'ci') { const cur", "if (step === 'reconcile') { const cur"]]],
  ['connect fix 2 (#606 MAJOR-3): an author respawned by the start step never gets the batch', [['src/shared/fanout-loop-corrections.ts', "if (!author || !deps.fleet.live(author) || startedAfter) {", "if (!author || !deps.fleet.live(author)) {"]]],
  ['connect fix 2 (#606 minor): the stall reason says "no fix yet" although the fix is pushed', [[L, "(loopSameSha(lastRev.head, t.head) || (!!lastRev.tree && lastRev.tree === t.tree))) return", "true) return"]]],
  ['connect fix 2: a silent reviewer feeds the stall clock for ever (the wake outcome counts as progress)', [[L, "else if (o.action === 'reviewer-woken') ctx.note(", "else if (o.action === 'reviewer-woken') ctx.did("]]],
];
if (CHILD === undefined) {
  const control = run(240_000);
  console.log(`control (unpatched copy): ${control.pass} pass / ${control.fail} fail / ${control.skipped} skipped`);
  if (control.fail !== 0 || control.skipped !== 0 || !(control.pass > 0)) { console.error('the unpatched copy is not green: refusing to mutate'); process.exit(1); }
  fs.rmSync(scratch, { recursive: true, force: true });
  // #623: the mutants run in parallel, each in its own child process with its own scratch copy; output printed in mutant order. Child exit: 0 killed, 3 survived, 4 refused (stale).
  const ids = mutants.map((_, mi) => mi).filter((mi) => mi % PART_N === PART_I - 1 && (!ONLY || mutants[mi][0].includes(ONLY)));
  const { survived, broken, codes } = await runMutantChildren(ids, 'MUT_CHILD', [4]);
  const refused = codes.filter((c) => c === 4).length, ran = ids.length;
  console.log(`\n${PART ? `part ${PART}: ` : ''}${ran - survived - refused - broken}/${ran} killed, ${survived} survived, ${refused} refused`);
  exitAfterFlush(survived || refused || broken ? 1 : 0);
}
let survived = 0, refused = 0;
for (const [mi, [name, edits]] of mutants.entries()) {
  if (String(mi) !== CHILD) continue;
  const saved = new Map();
  let stale = null;
  for (const [file, from, to] of edits) {
    const fp = path.join(scratch, file);
    const text = fs.readFileSync(fp, 'utf8');
    if (!saved.has(fp)) saved.set(fp, text);
    const n = text.split(from).length - 1;
    if (n !== 1) { stale = `"${from.slice(0, 60)}…" occurs ${n}×`; break; }
    fs.writeFileSync(fp, text.replace(from, () => to));
  }
  if (stale) { console.log(`REFUSED  ${name} — stale mutant: ${stale}`); refused++; }
  else {
    const r = run();
    const killed = r.fail > 0 || !(r.pass > 0) || Number.isNaN(r.fail);
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${name}${killed ? (Number.isNaN(r.fail) ? ' (the test run crashed or timed out: no TAP summary)' : ` (${r.fail} fail)`) : ` (${r.pass} pass / ${r.fail} fail)`}`);
    if (!killed) survived++;
  }
  for (const [fp, text] of saved) fs.writeFileSync(fp, text);
}
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(survived ? EXIT_SURVIVED : refused ? 4 : 0);

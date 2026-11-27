#!/usr/bin/env node
// #589 rig — the reviewer records its verdict and findings (switch seatRecords=on): every clause of the record verb, the derived counts, the closed exits (`--review-verdict`, `--no-review-gate`,
// `--finding`, `--finding-json`, `--settle`, a blank `--decide`), what `deliver` / `gate` read, the bus-side refusal of a recorded reviewer's worker_done, `resume`, the close-out and the wiring is MUTATED in a scratch copy of src/
// and src/cli/fanout-record.test.ts must go red. Light: no Electron, no network, no tokens; the scratch copy lives under $TMPDIR (node_modules symlinked for the bus test); the repo is never written.
//   node scripts/e2e-fanout-record.mjs            control: the unpatched copy must be GREEN (0 fail, 0 skipped)
//   node scripts/e2e-fanout-record.mjs --mutants  each mutant (exact string, must occur ONCE in its file — else REFUSED as stale) must be KILLED (≥1 test FAILs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-rec-rig-'));
if (!path.resolve(scratch).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
fs.cpSync(path.join(ROOT, 'src'), path.join(scratch, 'src'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ type: 'module' }));
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules')); // the bus test opens a real SQLite file
if (fs.existsSync(path.join(ROOT, 'build', 'bus-abi'))) fs.symlinkSync(path.join(ROOT, 'build'), path.join(scratch, 'build')); // CI leaves node_modules on the ELECTRON build: under node the per-ABI binding of build/bus-abi (src/main/bus-binding.ts, probed from cwd) is the only one that opens (the 39/41 of PR #596)
const TESTS = ['src/cli/fanout-record.test.ts'].map((f) => path.join(scratch, f));

function run() {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...TESTS], { cwd: scratch, encoding: 'utf8', timeout: 240_000, env: { ...process.env, TMPDIR: tmpBase } });
  const out = `${r.stdout}\n${r.stderr}`;
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return { pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests'), out };
}

// [name, file, from, to] — `from` must occur exactly once in `file`.
const S = 'src/shared/fanout-state.ts';
const R = 'src/shared/fanout-record.ts';
const K = 'src/cli/fanout-record.ts';
const D = 'src/cli/fanout-deliver.ts';
const G = 'src/cli/fanout-gate.ts';
const B = 'src/cli/bus-verbs.ts';
const C = 'src/cli/fanout-state.ts';
const CO = 'src/cli/fanout-closeout.ts';
const I = 'src/cli/index.ts';
const F = 'false as boolean';
const mutants = [
  // the record: who, which ticket, which head
  ['record-final: a second record by the same reviewer on the same head is accepted (#672)', R, "if (prior) return recordRefuse('record-final'", `if (${F} && prior) return recordRefuse('record-final'`],
  ['record: the switch is not checked (off records)', R, "if (!seatRecordsOn(state)) return recordRefuse('record-off'", `if (${F}) return recordRefuse('record-off'`],
  ['record: a ticket with no recorded reviewer is not refused', R, "if (!t || !reviewer) {", `if (${F}) {`],
  ['record: an id the host did not vouch records (env-asserted identity accepted)', R, "|| a.callerVouched !== true) {\n    if (a.callerId === reviewer", "|| false as boolean) {\n    if (a.callerId === reviewer"],
  ['record-json: the finding id alphabet is not checked', R, "const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._#:-]{0,63}$/;", "const FINDING_ID = /^.*$/;"],
  ['record-json: a finding text over 2000 characters is accepted', R, "|| rec.text.length > 2000 ||", "||"],
  ['resume: a merged / dropped ticket still owes its reviewer\'s record', R, "    if (!r?.id || t.status === 'merged' || t.status === 'dropped') continue;", "    if (!r?.id) continue;"],
  ['deliver: the recorded head is not required to be a full 40-hex sha', D, "if (!recordedHead || !/^[0-9a-f]{40}$/.test(recordedHead)) return done(", "if (!recordedHead) return done("],
  ['gate: the tree of --head is not read (a rebase loses the verdict at the gate)', G, "recordedVerdictOf(rs, opts.ticket, opts.head, await readTree(deps.gh, opts.repo, opts.head))", "recordedVerdictOf(rs, opts.ticket, opts.head, null)"],
  ['wiring: `--as <other handle>` sheds the recorded-reviewer nudge (own workspace not asked)', I, " ?? (selfWorkspaceId() && selfWorkspaceId() !== sender ? fanoutCompletionRefusal(selfWorkspaceId()!, runId) : null)", ""],
  ['record: any caller records (the identity is not compared with the recorded reviewer)', R, "if (a.callerId === null || a.callerId !== reviewer || a.callerVouched !== true) {", `if (${F}) {`],
  ['record: the head is not compared with the briefed head', R, "if (!/^[0-9a-f]{7,40}$/.test(a.head) || !sameSha(expected, a.head)) {", `if (${F}) {`],
  ['record: the briefed head is the ticket\'s head, not the reviewer\'s latest brief', R, "return b.length ? b[b.length - 1].head : t.review?.head ?? t.head ?? null;", "return t.head ?? null;"],
  ['record: any verdict word is accepted', R, "if (a.verdict !== 'approve' && a.verdict !== 'changes-requested') return recordRefuse('record-verdict'", `if (${F}) return recordRefuse('record-verdict'`],
  ['record: a finding id already recorded is rewritten', R, "if (t.findings[id]) recordRefuse('finding-exists'", `if (${F}) recordRefuse('finding-exists'`],
  // fixed
  ['fixed: an unknown finding id is accepted', R, "if (!f) recordRefuse('fixed-not-open'", `if (${F}) recordRefuse('fixed-not-open'`],
  ['fixed: a finding already closed can be closed again', R, "if (findingClosed(f) || (t.reviews ?? []).some((r) => r.closed.includes(id))) recordRefuse('fixed-not-open'", `if (${F}) recordRefuse('fixed-not-open'`],
  ['fixed: a finding no reviewer raised is closed by a reviewer', R, "if (!f.by || !reviewers.has(f.by)) recordRefuse(", `if (${F}) recordRefuse(`],
  ['fixed: closed on the head it was raised on', R, "if (f.raisedOn && sameSha(f.raisedOn, head)) recordRefuse(", `if (${F}) recordRefuse(`],
  ['fixed: a replacement reviewer cannot close the dead reviewer\'s findings (reviewersOf forgets the earlier ones)', R, "  for (const b of t.review?.briefs ?? []) if (b.reviewer) out.add(b.reviewer);\n  for (const r of t.reviews ?? []) out.add(r.reviewer);\n", ""],
  // the verdict vs the open findings
  ['approve accepted with an open BLOCKING / MAJOR', R, "if (a.verdict === 'approve' && heldIds.length) recordRefuse(", `if (${F}) recordRefuse(`],
  ['changes-requested accepted with nothing open', R, "if (a.verdict === 'changes-requested' && heldIds.length === 0) recordRefuse(", `if (${F}) recordRefuse(`],
  ['approve blocked by an open MINOR (the severity filter is gone)', R, "c.open.filter((id) => nt.findings[id].severity !== 'MINOR')", "c.open"],
  ['approve ignores a blocking MINOR of minorPolicy', R, ", ...blockingMinors(out, ticketId).filter((id) => c.open.includes(id))", ""],
  // derived counts
  ['counts: a "fixed" by the reviewer does not close the finding', R, "for (const id of r.closed) closed.add(id);", ""],
  ['counts: a decided finding still counts', R, " && !t.findings[id].decision && t.findings[id].onChoice === undefined); //", " && t.findings[id].onChoice === undefined); //"],
  ['counts: not as of review n (a later fix rewrites an earlier verdict)', R, ".filter((x) => x.n <= n)", ""],
  ['deliver: the verdict of the latest review on the head is the FIRST one', R, "return [...(t.reviews ?? [])].reverse().find((r) => sameContent(r.head, r.tree, head, tree)) ?? null;", "return (t.reviews ?? []).find((r) => sameContent(r.head, r.tree, head, tree)) ?? null;"],
  ['deliver: a rebase that keeps the tree loses the verdict (sha only)', R, "sameContent(r.head, r.tree, head, tree))", "sameSha(r.head, head))"],
  ['deliver: record-missing says nothing of the reviewer to wake', R, "reviewer ${who.name} (${who.id}) has not recorded it: wake it (", "has not recorded it: ("],
  // the bus-side refusal
  ['worker_done: the switch is not checked', R, "if (!seatRecordsOn(state) || !senderId) return null;", "if (!senderId) return null;"],
  ['worker_done: a merged / dropped ticket still holds its reviewer', R, "if (t.review?.reviewer?.id !== senderId || t.status === 'merged' || t.status === 'dropped') continue;", "if (t.review?.reviewer?.id !== senderId) continue;"],
  ['worker_done: ANY record of the reviewer releases it (not the one of its head)', R, "(t.reviews ?? []).some((r) => r.reviewer === senderId && sameSha(r.head, head))) continue;\n    return `[record-missing] orchestra send", "(t.reviews ?? []).length > 0) continue;\n    return `[record-missing] orchestra send"],
  ['worker_done: the refusal does not print the command', R, "run: ${recordCommand(id, head)}", "run: (record your verdict)"],
  ['worker_done: the send verb never asks', B, "    if (unrecorded) ctx.fail(unrecorded);", ""],
  ['resume: the switch is not checked', R, "export function unrecordedReviewers(state: FanoutState): Array<{ ticket: string; reviewer: string; name: string; head: string; line: string }> {\n  if (!seatRecordsOn(state)) return [];", "export function unrecordedReviewers(state: FanoutState): Array<{ ticket: string; reviewer: string; name: string; head: string; line: string }> {"],
  ['resume: prints no reviewer without a record', C, "for (const u of unrec) out.push(", "for (const u of [] as typeof unrec) out.push("],
  ['resume: --json carries the key off the switch', C, "...(seatRecordsOn(state) ? { reviewersWithoutRecord: unrec } : {})", "...({ reviewersWithoutRecord: unrec })"],
  ['state show: the records block is printed off the switch', C, "  if (!seatRecordsOn(s)) return '';\n  const rows = Object.entries(s.tickets).filter(", "  const rows = Object.entries(s.tickets).filter("],
  // the closed exits
  ['state set: --finding / --finding-json / --json findings accepted from the coordinator', S, "if (findings.length || ('findings' in patch && patch.findings !== undefined && !isObj(patch.findings))) throw", `if (${F}) throw`],
  ['state set: the coordinator\'s --settle accepted', S, "if (isObj(patch.settle) && Object.keys(patch.settle).length) throw", `if (${F}) throw`],
  ['state set: a decision with a blank reason accepted', S, "if (!isObj(v) || typeof v.text !== 'string' || !v.text.trim()) throw new SeatRefusal('decision-reason-blank'", `if (${F}) throw new SeatRefusal('decision-reason-blank'`],
  ['state set: the patch source is not asserted at all', S, "  assertPatchSource(stampDefaults(state0), id, patch); // #589\n", ""],
  ['state set: the switch-off branch is skipped (off behaves as on)', S, "  if (!seatRecordsOn(state)) {\n    for (const [k, f] of findings)", `  if (${F}) {\n    for (const [k, f] of findings)`],
  ['state set: a blank --decide reason gets the new refusal off the switch', C, "if (blankDecide !== null && !seatRecordsOn(before)) decideArg(blankDecide);", ""],
  ['state file: the record-only finding fields are unknown on read', S, "for (const k of ['by', 'text', 'raisedOn', 'fixedBy', 'onChoice']) FINDING_KEYS.add(k); // #589 (I4), #641", "for (const k of ['onChoice']) FINDING_KEYS.add(k); // #641"],
  ['state file: `reviews` is an unknown ticket field', S, "TICKET_KEYS.add('reviews'); // #589 (I4)", ""],
  ['state file: a hand-edited review number is accepted', S, "(e.n as number) !== i + 1", F],
  ['state file: a hand-typed verdict word is accepted in reviews', S, "enumOf(e.verdict, ['approve', 'changes-requested'] as const", "enumOf(e.verdict, ['approve', 'changes-requested', 'pass'] as const"],
  ['decide: any caller may record "not fixed" (the caller is not checked)', C, "      assertDecideCaller(before, caller);\n", ""],
  ['decide: `by` is taken from the --json patch, not the vouched id', C, "[k, { ...v, by: caller.id }]", "[k, { by: caller.id, ...v }]"],
  ['decide: an id the host did not vouch may decide', R, "if (caller.proof !== 'host-vouched') recordRefuse('decide-caller'", `if (${F}) recordRefuse('decide-caller'`],
  ['decide: a non-coordinator may decide', R, "if (caller.role !== 'coordinator') recordRefuse('decide-caller'", `if (${F}) recordRefuse('decide-caller'`],
  ['state set: the typed approve / changes-requested word is accepted from the coordinator', S, "if (patch.verdict === 'approve' || patch.verdict === 'changes-requested') throw", `if (${F}) throw`],
  ['deliver: a decoy run with the switch off skips the recorded-verdict rule', D, "if (ownState && seatRecordsOn(ownState)) throw", `if (${F}) throw`],
  ['wiring: a `state set --decide` never asks the host who the caller is', I, "if (stateSetNeedsHost(args, process.env)) {", `if (${F}) {`],
  // deliver / gate
  ['deliver: a typed --review-verdict is accepted under the switch', D, "if (opts.reviewVerdict) return done({ verdict: 'refused', reason: 'typed-verdict'", `if (${F}) return done({ verdict: 'refused', reason: 'typed-verdict'`],
  ['deliver: --no-review-gate is accepted under the switch', D, "if (opts.noReviewGate) return done({ verdict: 'refused', reason: 'ungated-merge'", `if (${F}) return done({ verdict: 'refused', reason: 'ungated-merge'`],
  ['deliver: a missing record is not a refusal', D, "if (!rd.ok) return done({ verdict: 'refused', reason: rd.reason, detail: rd.detail, head: recordedHead }", `if (${F}) return done({ verdict: 'refused', reason: rd.reason, detail: rd.detail, head: recordedHead }`],
  ['deliver: the recorded counts are typed zero (a MAJOR does not stop the merge)', D, "blocking: rd.recorded.blocking, major: rd.recorded.major, minor: rd.recorded.minor, head: rd.recorded.head };", "blocking: 0, major: 0, minor: rd.recorded.minor, head: rd.recorded.head };"],
  ['deliver: the delivered head is not read from the state', D, "recordedHead = opts.verifiedHead ?? recState.tickets[opts.ticket]?.head ?? undefined;", "recordedHead = opts.verifiedHead;"],
  ['deliver: the state is never consulted for the switch', D, "  recorded: (o) => recordedStateFor(o),\n", ""],
  ['deliver: the switch is not checked when reading the state', D, "return seatRecordsOn(state) ? state : null;", "return state;"],
  ['deliver: the tree of the delivered head is not read (a rebase loses the verdict)', D, "recordedVerdictOf(recState, opts.ticket, recordedHead, await treeOf(recordedHead))", "recordedVerdictOf(recState, opts.ticket, recordedHead, null)"],
  ['gate: no refusal without a recorded verdict', G, "if (!rd.ok) return { exit: DELIVER_EXIT.refused, result: { verdict: 'refused', reason: rd.reason", `if (${F}) return { exit: DELIVER_EXIT.refused, result: { verdict: 'refused', reason: rd.reason`],
  ['gate: open BLOCKING / MAJOR of the recorded verdict do not refuse', G, "if (r.blocking > 0 || r.major > 0) return", `if (${F}) return`],
  // the verb
  ['record verb: the caller is the one named by the ticket (identity not resolved)', K, "const caller = resolveCaller(cur, deps.env, deps.identity);", "const caller = { id: cur.tickets[ticket]?.review?.reviewer?.id ?? null, role: 'reviewer', proof: 'host-vouched' } as ReturnType<typeof resolveCaller>;"],
  ['record verb: the host answer is not passed (every caller is env-asserted)', K, "resolveCaller(cur, deps.env, deps.identity)", "resolveCaller(cur, deps.env)"],
  ['record verb: the tree of the head is not derived', K, "const tree = /^[0-9a-f]{7,40}$/.test(head) ? treeOfSha(deps.runner, head, deps.cwd, repo) : null;", "const tree = null as string | null;"],
  // close-out
  ['closeout: the decided list is printed off the switch', CO, "const decided = seatRecordsOn(state) ? decidedCloseout(state) : null;", "const decided = decidedCloseout(state);"],
  ['closeout: the decided list drops the written reason', 'src/shared/fanout-closeout.ts', "decided by ${x.by} at ${x.at}: ${oneLine(x.text, 300)}", "decided by ${x.by} at ${x.at}"],
  // wiring
  ['brief: "How to end" does not name `fanout record`', 'src/shared/fanout-review-brief.ts', "`  orchestra fanout record ${i.ticket} --run ${i.run} --head ${i.head} --verdict approve|changes-requested --json <file|->`", "`  (record your verdict)`"],
  ['brief: the json shape (findings / fixed) is not given', 'src/shared/fanout-review-brief.ts', "\"fixed\":[\"<id of an open finding you raised on an earlier head and have now read FIXED on this head>\"]${criteria.length", "\"fixed\":[]${criteria.length"],
  ['wiring: `fanout record` is not routed', I, "args[0] === 'record' ? runRecord(args.slice(1), fanoutDeps) :", ""],
  ['wiring: the send verb gets no completionRefusal', I, "completionRefusal: (sender, runId) => fanoutCompletionRefusal(sender, runId)", "completionRefusalOff: (sender, runId) => fanoutCompletionRefusal(sender, runId)"],
];

// --only <substring>: run just the mutants whose name contains it (a light local loop); the control still runs.
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const base = run();
const baseOk = base.fail === 0 && base.skipped === 0 && base.pass >= 25 && base.pass === base.tests;
console.log(`control (unpatched copy): ${base.pass} pass / ${base.fail} fail / ${base.skipped} skipped → ${baseOk ? 'GREEN' : 'RED'}`);
if (!baseOk) { // name every failing subtest + its message (a CI log that only says 39/41 cannot be acted on)
  const lines = base.out.split('\n');
  lines.forEach((l, i) => { if (/^\s*not ok \d+ - /.test(l)) console.log(`FAILING SUBTEST: ${l.trim()}\n${lines.slice(i + 1, i + 40).filter((x) => /^\s*(error:|code:|actual:|expected:|stack:)|^\s{4,}\S/.test(x)).slice(0, 8).join('\n')}`); });
  console.log(base.out.slice(-3000)); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(1);
}
if (!process.argv.includes('--mutants')) { fs.rmSync(scratch, { recursive: true, force: true }); process.exit(0); }

let survived = 0, refused = 0;
for (const [i, [name, file, from, to]] of mutants.entries()) {
  if (only && !name.includes(only)) continue;
  const f = path.join(scratch, file);
  const orig = fs.readFileSync(f, 'utf8');
  const n = orig.split(from).length - 1;
  if (n !== 1) { console.log(`M${String(i + 1).padStart(2, '0')} REFUSED (stale: the string occurs ${n}×, need exactly 1) — ${name}`); refused++; continue; }
  fs.writeFileSync(f, orig.replace(from, () => to));
  const r = run();
  fs.writeFileSync(f, orig);
  const killed = r.fail > 0 || Number.isNaN(r.pass); // a mutant that breaks the module graph (no tests ran) is also dead
  if (!killed) survived++;
  console.log(`M${String(i + 1).padStart(2, '0')} ${killed ? 'KILLED' : 'SURVIVED'} (${r.pass} pass / ${r.fail} fail) — ${name}`);
}
const after = run(); // the restore is real: the copy is green again
const same = after.fail === 0 && after.pass === base.pass;
console.log(`\n${mutants.length - survived - refused}/${mutants.length} mutants killed, ${survived} survived, ${refused} refused; scratch restored → ${same ? 'GREEN' : 'RED'}`);

fs.rmSync(scratch, { recursive: true, force: true });
process.exit(survived || refused || !same ? 1 : 0);

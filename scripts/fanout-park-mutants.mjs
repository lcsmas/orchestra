#!/usr/bin/env node
// #603 self-gate — IN-PLACE mutation sweep of the parked / rounds / choices / pause state (ledger #613 FROZEN NAMES v1). Each mutant removes ONE clause in the real source and must turn
// src/shared/fanout-park.test.ts or src/cli/fanout-park.test.ts red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree. CONTROL first: both files GREEN, skipped 0
// (the built-CLI test must RUN, not skip). The CLI is rebuilt after every mutant (the built-CLI arm reads dist-electron/cli.js) and once more at the end.
// Run: node scripts/fanout-park-mutants.mjs [--only P01,P07] [--check-anchors]   (pnpm run test:fanout-park-mutants)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const ST = 'src/shared/fanout-state.ts', CO = 'src/shared/fanout-closeout.ts', CS = 'src/cli/fanout-state.ts', CC = 'src/cli/fanout-closeout.ts';
const T = ['src/shared/fanout-park.test.ts', 'src/cli/fanout-park.test.ts'];

/** One mutant = exact-once edits [file, find, replacement]; the named tests must go red. */

/** One mutant = exact-once edits [file, find, replacement]; the named tests must go red. */
const F = 'if (false as boolean)';
const MUTANTS = [
  { id: 'P01', name: 'parked is not a ticket status', edits: [[ST, "'dropped', 'parked'] as const;", "'dropped'] as const;"]] },
  { id: 'P02', name: 'a stored parked record with a blank reason is read', edits: [[ST, "if (typeof v.reason !== 'string' || !v.reason.trim()) throw parkRefusal('park-no-reason'", `${F} throw parkRefusal('park-no-reason'`]] },
  { id: 'P03', name: 'parkTicket accepts a blank reason', edits: [[ST, "if (typeof input.reason !== 'string' || !input.reason.trim()) throw parkRefusal('park-no-reason'", `${F} throw parkRefusal('park-no-reason'`]] },
  { id: 'P04', name: 'status parked with no record is read', edits: [[ST, "if (t.status === 'parked' && !t.parked) throw", `${F} throw`]] },
  { id: 'P05', name: 'a parked record on a ticket that is not parked is read', edits: [[ST, "if (t.status !== 'parked' && t.parked) throw", `${F} throw`]] },
  { id: 'P06', name: 'any cause string is accepted', edits: [[ST, "|| !(PARK_CAUSES as readonly string[]).includes(input.cause) || input.cause === 'upstream')", ')']] },
  { id: 'P07', name: 'a ticket may be parked "upstream" by hand', edits: [[ST, " || input.cause === 'upstream') throw parkRefusal('park-bad-cause'", ") throw parkRefusal('park-bad-cause'"]] },
  { id: 'P08', name: 'an unknown ticket is not refused', edits: [[ST, "if (!t) throw parkRefusal('park-unknown-ticket'", `${F} throw parkRefusal('park-unknown-ticket'`]] },
  { id: 'P09', name: 'a merged ticket can be parked', edits: [[ST, "if (t.status === 'merged') throw parkRefusal('park-merged'", `${F} throw parkRefusal('park-merged'`]] },
  { id: 'P10', name: 'a dropped ticket can be parked', edits: [[ST, "if (t.status === 'dropped') throw parkRefusal('park-dropped'", `${F} throw parkRefusal('park-dropped'`]] },
  { id: 'P11', name: 'parking does not park the dependents', edits: [[ST, 'for (const d of dependentsOf(state, id)) {', 'for (const d of [] as string[]) {']] },
  { id: 'P12', name: 'only DIRECT dependents are parked (not transitive)', edits: [[ST, 'upstreamClosure(state, x).has(id));', "(state.tickets[x]?.dependsOn ?? []).includes(id));"]] },
  { id: 'P13', name: 'every other ticket is parked with it', edits: [[ST, 'x !== id && upstreamClosure(state, x).has(id)', 'x !== id']] },
  { id: 'P14', name: 'a dependent\'s reason is not "blocked by <ticket>"', edits: [[ST, "parked: { cause: 'upstream', reason: `blocked by ${id}`, at: now, blockedBy: id }", "parked: { cause: 'upstream', reason: 'blocked', at: now, blockedBy: id }"]] },
  { id: 'P15', name: 'a dependent does not say which ticket blocks it', edits: [[ST, "parked: { cause: 'upstream', reason: `blocked by ${id}`, at: now, blockedBy: id }", "parked: { cause: 'upstream', reason: `blocked by ${id}`, at: now, blockedBy: 'A' }"]] },
  { id: 'P16', name: 'parking again rewrites the first record', edits: [[ST, "if (!(t.status === 'parked' && t.parked && t.parked.cause !== 'upstream')) tickets[id]", 'if (true as boolean) tickets[id]']] },
  { id: 'P17', name: 'a ticket held only by an upstream cannot be parked for its own reason', edits: [[ST, "t.parked && t.parked.cause !== 'upstream')) tickets[id]", 't.parked)) tickets[id]']] },
  { id: 'P18', name: 'a dependent already merged / dropped / parked is parked again', edits: [[ST, "if (dt.status === 'merged' || dt.status === 'dropped' || dt.status === 'parked') continue;", 'if (false as boolean) continue;']] },
  { id: 'P19', name: 'unpark does not release the dependents', edits: [[ST, 'const freed = releaseUpstreamParks({ ...state, tickets: { ...state.tickets, [id]: withoutPark(t, now) }, updatedAt: now }, now);', 'const freed = { ...state, tickets: { ...state.tickets, [id]: withoutPark(t, now) }, updatedAt: now } as FanoutState;']] },
  { id: 'P20', name: 'a dependent still held by another parked ticket is released', edits: [[ST, 'if (still.length === 0) tickets', 'if (true as boolean) tickets']] },
  { id: 'P21', name: 'a dependent still held keeps pointing at the ticket that was unparked', edits: [[ST, "else if (!still.includes(t.parked.blockedBy ?? ''))", 'else if (false as boolean)']] },
  { id: 'P22', name: 'a ticket parked only upstream can be unparked by itself', edits: [[ST, "if (t.parked.cause === 'upstream') throw new FanoutStateError(", `${F} throw new FanoutStateError(`]] },
  { id: 'P23', name: 'an unparked ticket never goes back to started', edits: [[ST, "(t.branch || t.head || t.implementer || t.start ? 'started' : 'todo')", "'todo'"]] },
  { id: 'P24', name: 'a parked ticket\'s status can be moved without unparking', edits: [[ST, "if (prev.status === 'parked' && 'status' in patch) throw", `${F} throw`]] },
  { id: 'P25', name: 'a park patch may carry other keys', edits: [[ST, "if (Object.keys(patch).some((k) => k !== 'park' && k !== 'status')) throw", `${F} throw`]] },
  { id: 'P26', name: '--status parked with no park is accepted', edits: [[ST, "if (!park) throw parkRefusal('park-no-reason'", `${F} throw parkRefusal('park-no-reason'`]] },
  { id: 'P27', name: 'the patch path is not routed to the parking transition', edits: [[ST, "if ('park' in patch || 'unpark' in patch || patch.status === 'parked') return applyParkPatch", `${F} return applyParkPatch`]] },
  { id: 'P28', name: 'reconcile counts a parked branch contained in the target as MERGED', edits: [[ST, "status !== 'started' && status !== 'parked') return true;", "status !== 'started') return true;"]] },
  { id: 'P29', name: 'a parked ticket is classified as in-progress', edits: [[ST, "case 'parked': return { class: 'parked',", "case 'parked': return { class: 'in-progress',"]] },
  { id: 'P30', name: 'a parked ticket whose branch is gone is a divergence', edits: [[ST, "&& t.status !== 'dropped' && t.status !== 'parked'; // #603", "&& t.status !== 'dropped'; // #603"]] },
  { id: 'P31', name: 'a parked ticket whose PR was closed is a divergence', edits: [[ST, "r?.pr?.state === 'CLOSED' && t.status !== 'merged' && t.status !== 'dropped' && t.status !== 'parked'", "r?.pr?.state === 'CLOSED' && t.status !== 'merged' && t.status !== 'dropped'"]] },
  { id: 'P32', name: 'a parked ticket merged by hand keeps its parking record', edits: [[ST, '...(w.patch.status ? curRest : cur)', '...cur']] },
  { id: 'P33', name: 'a hand-merge does not release the dependents it was holding', edits: [[ST, 'parseState(releaseUpstreamParks({ ...state, tickets, updatedAt: now, reconciledAt: now }, now))', 'parseState({ ...state, tickets, updatedAt: now, reconciledAt: now })']] },
  { id: 'P34', name: 'the fingerprint depends on the order of the findings', edits: [[ST, '[...input.openFindings].sort().join(\',\')', '[...input.openFindings].join(\',\')']] },
  { id: 'P35', name: 'the fingerprint ignores the tree', edits: [[ST, '\\ntree:${input.tree}', '\\ntree:']] },
  { id: 'P36', name: 'the fingerprint is not the frozen formula', edits: [[ST, '`findings:${[...input.openFindings]', '`finding:${[...input.openFindings]']] },
  { id: 'P37', name: 'a repeated situation is never reported as a repeat', edits: [[ST, 'const repeat = rounds.some((r) => r.fingerprint === fingerprint);', 'const repeat = false;']] },
  { id: 'P38', name: 'every round after the first is a repeat', edits: [[ST, 'const repeat = rounds.some((r) => r.fingerprint === fingerprint);', 'const repeat = rounds.length > 0;']] },
  { id: 'P39', name: 'a round fingerprint need not be hex', edits: [[ST, "if (typeof fingerprint !== 'string' || !HEX_FP.test(fingerprint)) throw", `${F} throw`]] },
  { id: 'P40', name: 'a round on an unknown ticket is silently dropped', edits: [[ST, 'if (!t) throw new FanoutStateError(`${id}: no such ticket in run ${state.run} — no round to record`);', 'if (!t) return { state, repeat: false };']] },
  { id: 'P41', name: 'a choice with an unknown rule is recorded', edits: [[ST, "if (typeof e.rule !== 'string' || !(CHOICE_RULES as readonly string[]).includes(e.rule)) throw", `${F} throw`]] },
  { id: 'P42', name: 'a choice with a blank question / answer is recorded', edits: [[ST, "if (typeof v !== 'string' || !v.trim()) throw parkRefusal('choice-bad'", `${F} throw parkRefusal('choice-bad'`]] },
  { id: 'P43', name: 'every choice is numbered 1', edits: [[ST, 'answer: entry.answer }, list.length + 1, now,', 'answer: entry.answer }, 1, now,']] },
  { id: 'P44', name: 'the number of choices is unbounded', edits: [[ST, 'if (list.length >= CHOICES_MAX) throw', `${F} throw`]] },
  { id: 'P45', name: 'a pause with no reason is accepted', edits: [[ST, "if (typeof input.reason !== 'string' || !input.reason.trim()) throw parkRefusal('pause-no-reason'", `${F} throw parkRefusal('pause-no-reason'`]] },
  { id: 'P46', name: 'a second pause overwrites the first record', edits: [[ST, 'if (state.pause) return { ...state, pause: { ...state.pause, prs:', `${F} return { ...state, pause: { ...state.pause, prs:`]] },
  { id: 'P47', name: 'a second pause forgets the new pull requests', edits: [[ST, 'prs: [...new Set([...state.pause.prs, ...next.prs])].sort((a, b) => a - b) }, updatedAt: now };', 'prs: state.pause.prs }, updatedAt: now };']] },
  { id: 'P48', name: 'resumeRun does not lift the pause', edits: [[ST, 'const { pause: _p, ...rest } = state;', 'const rest = state;']] },
  { id: 'P49', name: 'pausedOf never sees the pause', edits: [[ST, 'export const pausedOf = (state: FanoutState): PauseRecord | null => state.pause ?? null;', 'export const pausedOf = (state: FanoutState): PauseRecord | null => null;']] },
  { id: 'P50', name: 'the pause is not read back from disk', edits: [[ST, '...(raw.pause !== undefined ? { pause: pauseOf(raw.pause) } : {}), // #603', '']] },
  { id: 'P51', name: 'the choices are not read back from disk', edits: [[ST, '...(raw.choices !== undefined ? { choices: choicesOf(raw.choices) } : {}), // #603', '']] },
  { id: 'P52', name: 'a ticket\'s parked record is not read back from disk', edits: [[ST, '...(t.parked !== undefined ? { parked: parkOf(t.parked, `ticket ${id}`) } : {}), // #603', '']] },
  { id: 'P53', name: 'a ticket\'s rounds are not read back from disk', edits: [[ST, '...(t.rounds !== undefined ? { rounds: roundsOf(t.rounds, `ticket ${id}`) } : {}), // #603', '']] },
  { id: 'P54', name: 'the parked / status coherence is not checked', edits: [[ST, 'assertParkedCoherent(state); // #603', '']] },
  { id: 'P55', name: 'an unknown field in `parked` is accepted', edits: [[ST, "refuseUnknown(v, new Set(['cause', 'reason', 'at', 'blockedBy']), `${where} parked`);", '']] },
  { id: 'P56', name: 'an unknown field in a round is accepted', edits: [[ST, 'refuseUnknown(r, new Set([\'n\', \'fingerprint\', \'at\']), `${where} rounds[${i}]`);', '']] },
  { id: 'P57', name: 'an unknown field in a choice is accepted', edits: [[ST, "refuseUnknown(e, new Set(['n', 'ticket', 'question', 'rule', 'answer', 'at']), where);", '']] },
  { id: 'P58', name: 'an unknown field in the pause is accepted', edits: [[ST, "refuseUnknown(v, new Set(['at', 'reason', 'check', 'prs']), 'pause');", '']] },
  { id: 'P59', name: 'the top-level `pause` key is unknown (v1 readers\' view)', edits: [[ST, "TOP_KEYS.add('pause'); // #603", '']] },
  { id: 'P60', name: 'unparking a ticket under a still-parked upstream leaves it live', edits: [[ST, 'if (held.length === 0) return freed;', 'if (true as boolean) return freed;']] },
  { id: 'P61', name: 'unpark keeps the old verdict', edits: [[ST, "status: restoredStatus(t), verdict: 'none', updatedAt: now };", 'status: restoredStatus(t), updatedAt: now };']] },
  { id: 'P62', name: 'a parked ticket whose open PR head moved is a divergence', edits: [[ST, "&& t.status !== 'merged' && t.status !== 'parked' && r.pr.state === 'OPEN') {", "&& t.status !== 'merged' && r.pr.state === 'OPEN') {"]] },
  { id: 'P63', name: 'rounds must be numbered 1..n (the review number is refused: the run is bricked)', edits: [[ST, 'if (!Number.isInteger(r.n) || (r.n as number) <= last) throw', 'if (r.n !== last + 1) throw']] },
  { id: 'P64', name: 'round numbers need not increase', edits: [[ST, 'if (!Number.isInteger(r.n) || (r.n as number) <= last) throw', 'if (!Number.isInteger(r.n)) throw']] },
  { id: 'P65', name: 'recordRound ignores the number it is given', edits: [[ST, 'rounds: [...rounds, { n: n ?? last + 1, fingerprint, at: now }]', 'rounds: [...rounds, { n: last + 1, fingerprint, at: now }]']] },
  { id: 'P66', name: 'recordRound accepts a number that does not exceed the last', edits: [[ST, 'if (n !== undefined && (!Number.isInteger(n) || n <= last)) throw', 'if (false as boolean) throw']] },
  { id: 'P67', name: 'the default round number is the length + 1 (collides after a gap)', edits: [[ST, 'n: n ?? last + 1, fingerprint', 'n: n ?? rounds.length + 1, fingerprint']] },
  { id: 'P68', name: 'a park reason over the bound is refused instead of cut', edits: [[ST, 'lineOf(clip(input.reason.trim(), PARK_REASON_MAX), `${id}: park reason`', 'lineOf(input.reason.trim(), `${id}: park reason`']] },
  { id: 'P69', name: 'a pause check name over the bound is refused instead of cut', edits: [[ST, 'clip(input.check, PAUSE_CHECK_MAX)', 'input.check']] },
  { id: 'P70', name: 'a pause reason over the bound is refused instead of cut', edits: [[ST, 'reason: clip(input.reason.trim(), PARK_REASON_MAX), check:', 'reason: input.reason.trim(), check:']] },
  { id: 'P71', name: 'a cut reason is not marked (…)', edits: [[ST, '`${s.slice(0, max - 1)}…`', '`${s.slice(0, max)}`']] },
  { id: 'P72', name: 'a park hides the merged-at-ungated-head alarm', edits: [[ST, "(t.status !== 'gated' && t.status !== 'merged' && t.status !== 'parked') ||", "(t.status !== 'gated' && t.status !== 'merged') ||"]] },
  { id: 'P73', name: 'a parked ticket merged by hand at another head is not adopted', edits: [[ST, "else if (t.status === 'parked') writeBack.push(", "else if (false as boolean) writeBack.push("]] },
  { id: 'P74', name: 'an adopted hand-merge records the head the verdict covered, not the merged one', edits: [[ST, 'mergedHead: cur.mergedHead ?? w.patch.head ?? cur.head,', 'mergedHead: cur.mergedHead ?? cur.head,']] },
  { id: 'P75', name: 'an adopted hand-merge keeps the stale verdict', edits: [[ST, "tree: (r?.pr?.state === 'MERGED' ? r.prTree : r?.branchTree) ?? null, verdict: 'none' }", "tree: (r?.pr?.state === 'MERGED' ? r.prTree : r?.branchTree) ?? null }"]] },
  { id: 'C01', name: 'cli: --round-fingerprint always prints repeat=false', edits: [[CS, 'repeat=${repeat}', 'repeat=false']] },
  { id: 'C02', name: 'cli: --round-fingerprint records nothing', edits: [[CS, '        return r.state;\n      });\n      return { code: 0, stdout: `repeat', '        return cur;\n      });\n      return { code: 0, stdout: `repeat']] },
  { id: 'C03', name: 'cli: --unpark is ignored', edits: [[CS, "if (p.bools.has('--unpark')) patch.unpark = true;", '']] },
  { id: 'C04', name: 'cli: --park-reason without --park is accepted', edits: [[CS, "if (p.vals['--park'] === undefined) throw new FanoutStateError('--park-reason needs", `${F} throw new FanoutStateError('--park-reason needs`]] },
  { id: 'C05', name: 'cli: a parked ticket still gets its acceptance writer', edits: [[CS, "if (!t || t.status === 'parked' || acceptancePhase(t) !== 'pending') return false;", "if (!t || acceptancePhase(t) !== 'pending') return false;"]] },
  { id: 'C06', name: 'cli: state show does not print the parked / choices / pause block', edits: [[CS, '${recordsShow(s)}${renderHold(s)}`', '${recordsShow(s)}`']] },
  { id: 'C07', name: 'cli: the run-level pause flags may carry a ticket / another flag', edits: [[CS, 'if (which.length !== 1 || ticket ||', 'if (false as boolean ||']] },
  { id: 'C08', name: 'cli: park-help is not a verb', edits: [[CS, "if (sub === 'park-help')", "if (sub === 'park-help-x')"]] },
  { id: 'C09', name: 'cli: --choice-json does not record the choice', edits: [[CS, 'const n = recordChoice(cur, entry as { ticket: string; question: string; rule: string; answer: string }, deps.now());', 'const n = cur;']] },
  { id: 'C10', name: 'cli: a parking does not say which dependents it took', edits: [[CS, '${parkMoved.length ? ` parked-with-it=${parkMoved.join(\',\')}` : \'\'}', '']] },
  { id: 'K01', name: 'closeout: the text does not list the parked tickets, choices and pause', edits: [[CC, "+ (hold ? `\\n${renderHold(state)}` : '')", "+ ''"]] },
  { id: 'K02', name: 'closeout: the JSON omits them', edits: [[CC, '...(hold ? { parked: hold.parked,', '...(false as boolean ? { parked: hold.parked,']] },
  { id: 'K03', name: 'closeout: a run with nothing parked prints the keys / block anyway (not byte-identical)', edits: [[CC, 'const hold = holdEmpty(holdAll) ? null : holdAll;', 'const hold = holdAll;']] },
  { id: 'K04', name: 'renderHold prints something for an empty hold', edits: [[CO, "if (holdEmpty(h)) return '';", "if (holdEmpty(h)) return '\\n';"]] },
  { id: 'K05', name: 'renderHold omits the parked rows', edits: [[CO, 'if (h.parked.length) out.push(', 'if (false as boolean) out.push(']] },
  { id: 'K06', name: 'renderHold omits the choices', edits: [[CO, 'if (h.choices.length) out.push(', 'if (false as boolean) out.push(']] },
  { id: 'K07', name: 'renderHold omits the pause', edits: [[CO, 'if (h.pause) out.push(', 'if (false as boolean) out.push(']] },
  { id: 'K08', name: 'renderHold omits the cause of a parked ticket', edits: [[CO, '`  ${p.ticket}  ${p.cause}${p.blockedBy', '`  ${p.ticket}  ${p.blockedBy']] },
  { id: 'K09', name: 'renderHold never says a situation came twice', edits: [[CO, 'new Set(t.rounds!.map((r) => r.fingerprint)).size < t.rounds!.length', 'false']] },
].map((m) => ({ ...m, tests: T, cli: true })); // every mutant rebuilds the CLI: the built-CLI arm of fanout-park.test.ts reads dist-electron/cli.js

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const count = (src, s) => src.split(s).length - 1;
function anchorsOk() {
  let bad = 0, total = 0;
  for (const m of MUTANTS) for (const [f, find] of m.edits) {
    total++;
    const n = count(fs.readFileSync(path.join(REPO, f), 'utf8'), find);
    if (n !== 1) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${f} matches ${n}× (need exactly 1): ${JSON.stringify(find.slice(0, 80))}`); }
  }
  console.log(`ANCHORS: ${total - bad}/${total} resolve exactly once`);
  return bad === 0;
}
if (args.includes('--check-anchors')) process.exit(anchorsOk() ? 0 : 1);
if (!anchorsOk()) process.exit(2);
const touched = [...new Set(MUTANTS.flatMap((m) => m.edits.map(([f]) => f)))];
if (spawnSync('git', ['-C', REPO, 'diff', '--quiet', '--', ...touched]).status !== 0) { console.error('ABORT: a file a mutant edits has uncommitted changes — commit first (the restore proof is `git diff` empty)'); process.exit(2); }

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanoutpark603-mutants-'));
const unit = (files) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: REPO, encoding: 'utf8', timeout: 600000 });
const failedNames = (out) => [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
const buildCli = () => execFileSync('pnpm', ['run', 'build:cli'], { cwd: REPO, stdio: 'ignore', timeout: 300000 });

{
  buildCli();
  const files = [...new Set(MUTANTS.flatMap((m) => m.tests))];
  const u = unit(files); const red = failedNames(u.stdout);
  const skipped = /^# skipped (\d+)/m.exec(u.stdout)?.[1];
  console.log(`CONTROL unmutated unit files (${files.length}): ${u.status === 0 && red.length === 0 && skipped === '0' ? 'GREEN, skipped 0 (instrument can pass)' : `RED ${JSON.stringify(red)} skipped=${skipped} — INSTRUMENT BROKEN`}`);
  if (u.status !== 0 || skipped !== '0') process.exit(4);
}

const results = [];
let cliDirty = false;
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const files = [...new Set(m.edits.map(([f]) => f))];
  const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
  files.forEach((f, i) => fs.copyFileSync(path.join(REPO, f), path.join(BACKUP, `${m.id}-${i}.bak`)));
  let killedBy = [];
  let restored = false;
  try {
    for (const [f, find, to] of m.edits) {
      const p = path.join(REPO, f);
      const src = fs.readFileSync(p, 'utf8');
      if (count(src, find) !== 1) throw new Error(`PATTERN-GONE ${m.id} ${f}`);
      fs.writeFileSync(p, src.replace(find, () => to));
    }
    if (m.cli) { buildCli(); cliDirty = true; }
    const u = unit(m.tests);
    const red = failedNames(u.stdout);
    if (u.status !== 0 || red.length) killedBy.push(`unit: ${red.length ? red.slice(0, 2).join(' | ') : `rc=${u.status}`}`);
  } finally {
    files.forEach((f, i) => fs.copyFileSync(path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)));
    restored = files.every((f, i) => sha(f) === before[f] && spawnSync('cmp', ['-s', path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)]).status === 0);
  }
  results.push({ id: m.id, name: m.name, killed: killedBy.length > 0, killedBy, restored });
  console.log(`${killedBy.length ? 'KILLED ' : 'SURVIVED'} ${m.id} ${m.name}${killedBy.length ? `\n         ← ${killedBy.join('\n         ← ')}` : ''}${restored ? '' : '\n         !! RESTORE FAILED'}`);
}
if (cliDirty) buildCli();
const survivors = results.filter((r) => !r.killed);
const unrestored = results.filter((r) => !r.restored);
const diff = spawnSync('git', ['-C', REPO, 'diff', '--stat', '--', ...touched], { encoding: 'utf8' }).stdout.trim();
console.log(`\nMUTANTS: ${results.length - survivors.length}/${results.length} killed; survivors: ${survivors.map((s) => s.id).join(', ') || 'none'}; restore: ${unrestored.length ? 'FAILED ' + unrestored.map((s) => s.id).join(',') : 'all byte-exact'}; git diff on touched files: ${diff || 'empty'}`);
process.exit(survivors.length === 0 && unrestored.length === 0 && !diff ? 0 : 1);

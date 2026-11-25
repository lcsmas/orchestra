#!/usr/bin/env node
// #588 self-gate — IN-PLACE mutation sweep of `orchestra fanout review` (the brief, the caller proof, the spawn / wake / replace decision, the run decisions). Each mutant removes ONE clause in the
// real source and must turn src/cli/fanout-review.test.ts red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree. CONTROL first: the test file must be GREEN, skipped 0.
// Run: node scripts/fanout-review-mutants.mjs [--only R01,R07] [--check-anchors]   (pnpm run test:fanout-review-mutants)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const STATE0 = 'src/shared/fanout-state.ts', COMMON = 'src/shared/fanout-brief-common.ts', REV = 'src/shared/fanout-review.ts', BRIEF = 'src/shared/fanout-review-brief.ts', CALLER = 'src/shared/fanout-caller.ts', HOSTF = 'src/shared/fanout-review-host.ts';
const WIRING = 'src/main/fanout-acceptance-wiring.ts', CLI = 'src/cli/fanout-review.ts', STATE = 'src/cli/fanout-state.ts', INDEX = 'src/cli/index.ts';
const T = ['src/cli/fanout-review.test.ts'];

/** One mutant = exact-once edits [file, find, replacement]; the named tests must go red. */
const MUTANTS = [
  { id: 'R01', name: 'seatRecords=off no longer refuses the review ([review-off])', edits: [[REV, "if (!seatRecordsOn(state)) refuse('review-off'", "if (false as boolean) refuse('review-off'"]] },
  { id: 'R02', name: 'a ticket with no head is reviewed ([review-no-head])', edits: [[REV, 'if (!t.head) refuse(', 'if (false as boolean) refuse(']] },
  { id: 'R03', name: 'an incomplete plan no longer refuses ([review-plan])', edits: [[REV, 'if (missing.length) refuse(', 'if (false as boolean) refuse(']] },
  { id: 'R04', name: 'a non-coordinator caller is accepted ([review-caller] role)', edits: [[REV, "if (caller.role !== 'coordinator') refuse(name,", "if (false as boolean) refuse(name,"]] },
  { id: 'R05', name: 'the host vouch is not required (a forged ORCHESTRA_WS_ID passes)', edits: [[REV, 'if (!isVouched(caller)) refuse(name,', 'if (false as boolean) refuse(name,']] },
  { id: 'R06', name: 'resolveCaller treats an env-asserted id as host-vouched', edits: [[CALLER, ": resolution?.source === 'host' ? HOST_VOUCHED", ': id ? HOST_VOUCHED']] },
  { id: 'R07', name: 'the ticket\'s implementer may be its reviewer ([review-role])', edits: [[REV, "if (reviewerId === t.implementer) refuse(", "if (false as boolean) refuse("]] },
  { id: 'R08', name: 'the coordinator may be the reviewer ([review-role])', edits: [[REV, "if (reviewerId === state.run) refuse(", "if (false as boolean) refuse("]] },
  { id: 'R09', name: 'a second call on the same head wakes the reviewer again (no noop)', edits: [[REV, 'if (t.review?.head && sameSha(t.review.head, head)) return', 'if (false as boolean) return']] },
  { id: 'R10', name: 'a LIVE reviewer is replaced on a new head instead of woken', edits: [[REV, "return { action: 'wake', kind: 'wake' };", "return { action: 'replace', kind: 'replace' };"]] },
  { id: 'R11', name: 'a dead reviewer is not replaced', edits: [[REV, "if (!isLive(rv.id)) return { action: 'replace', kind: 'replace' };", '']] },
  { id: 'R12', name: 'the open findings are not in the wake / replacement brief', edits: [[REV, "openFindings: o.kind === 'spawn' ? [] : openFindingsOf(t),", 'openFindings: [],']] },
  { id: 'R13', name: 'a spawn in flight does not block a second spawn (two reviewers)', edits: [[REV, 'return claimIsStale(rv, nowIso) ? again', 'return true ? again']] },
  { id: 'R14', name: 'the run decisions are not in the brief', edits: [[REV, 'decisionsText: renderDecisions(state),', "decisionsText: '',"]] },
  { id: 'R16', name: 'the base is not in the brief', edits: [[BRIEF, "`base: ${i.base ?? 'unknown (merge-base not computed)'}", '`base: unknown']] },
  { id: 'R17', name: 'the head in the brief is abbreviated (not the exact head)', edits: [[BRIEF, '`head: ${i.head}`,', '`head: ${i.head.slice(0, 7)}`,']] },
  { id: 'R18', name: 'a switch that is OFF still leaves its sentence', edits: [[BRIEF, 'SWITCH_NAMES.map((n) => SWITCH_SENTENCES[`${n}=${sw[n]}`]).filter((x): x is string => !!x)', 'Object.values(SWITCH_SENTENCES)']] },
  { id: 'R20', name: 'the stored brief is not what the reviewer was given', edits: [[HOSTF, 'head: t.head!, base, text: b.text, now });', "head: t.head!, base, text: b.text + ' ', now });"]] },
  { id: 'R21', name: 'a flag taking free text is accepted by the verb', edits: [[CLI, "parseArgs(args, ['--run'], ['--print'])", "parseArgs(args, ['--run', '--note'], ['--print'])"]] },
  { id: 'R22', name: '--print goes on to spawn (hostCalls returned)', edits: [[CLI, 'if (print) {', 'if (false as boolean) {']] },
  { id: 'R23', name: 'the reviewer is not nested under the coordinator', edits: [[HOSTF, 'res = await deps.spawn({ ...(parent ? { from: parent } : {}), name, task, repoPath });', 'res = await deps.spawn({ name, task, repoPath });']] },
  { id: 'R24', name: 'a wake that could not be delivered stays recorded', edits: [[HOSTF, 'updateState(file, (cur) => (cur ? undoWake(cur, ticket, prev, deps.now()) : (cur as never)));', 'void prev;']] },
  { id: 'R25', name: 'a failed spawn leaves no error on the slot', edits: [[HOSTF, "const error = res.error ?? 'spawn failed'; settle({ error });", "const error = res.error ?? 'spawn failed';"]] },
  { id: 'R29', name: 'a retried spawn piles another unsent brief', edits: [[REV, 'const kept = r.reviewer && (r.reviewer.error || r.reviewer.id === null) ? r.briefs.filter((b, i) => !(i === r.briefs.length - 1 && b.reviewer === null)) : r.briefs;', 'const kept = r.briefs;']] },
  { id: 'R30', name: 'the reviewer is not named with the `review-` role prefix', edits: [[REV, 'return `review-${slug', 'return `rev-${slug']] },
  { id: 'R31', name: 'the base is never computed (merge-base ignored)', edits: [[CLI, "const sha = r.code === 0 ? r.stdout.trim().split('\\n')[0] : '';", "const sha = '';"]] },
  { id: 'R32', name: 'the host does not re-check the head the CLI named', edits: [[HOSTF, 'if (!t0.head || !(t0.head.startsWith(head) || head.startsWith(t0.head))) return', 'if (false as boolean) return']] },
  { id: 'R33', name: 'index.ts does not hand the host\'s identity answer to the verb', edits: [[INDEX, '...(needsCaller ? { identity: hostIdentity } : {})', '']] },
  { id: 'R34', name: 'index.ts does not ask the host who the caller is', edits: [[INDEX, 'if (needsCaller) await settleHostIdentity();', '']] },
  { id: 'R35', name: 'a failed replacement retried is a NEW-reviewer brief (the open findings are lost)', edits: [[REV, "const again: ReviewAction = hadReviewer(t) ?", "const again: ReviewAction = false ?"]] },
  { id: 'R36', name: 'the host does not re-prove the caller of op review', edits: [[HOSTF, 'if (deps.verifyCaller) {', 'if (false as boolean) {']] },
  { id: 'R37', name: 'production wiring drops the host-side caller check', edits: [[WIRING, "verifyCaller: (id, key) => sessionKeys().verify(id, key),", '']] },
  { id: 'R38', name: 'a run decision from a non-coordinator / unvouched caller is accepted', edits: [[STATE, "assertReviewCaller(cur, resolveCaller(cur, deps.env, deps.identity), 'decision-caller');", '']] },
  { id: 'R45', name: 'the brief hash is not the sha256 of the brief stored', edits: [[REV, 'hash: briefHash(o.text), text: o.text, reviewer: null', 'hash: briefHash(o.text.slice(1)), text: o.text, reviewer: null']] },
  { id: 'R46', name: 'the switches line is not in the brief', edits: [[REV, 'switchesLine: renderSwitchesLine(state),', "switchesLine: '',"]] },
  { id: 'R47', name: 'a stale followed interface is not flagged STALE', edits: [[BRIEF, 'f.followed === f.current ?', 'true ?']] },
  { id: 'R48', name: 'the frozen interfaces are not in the brief', edits: [[REV, 'interfacesText: renderInterfaces(state, [...(own ? [ticket] : []), ...t.dependsOn]),', "interfacesText: '',"]] },
  { id: 'R49', name: 'the merge rule is a constant (ignores minorPolicy)', edits: [[BRIEF, 'MERGE_RULES[i.switches.minorPolicy]', 'MERGE_RULES.spec']] },
  { id: 'R50', name: 'the demonstrated merge rule is the spec one', edits: [[BRIEF, "demonstrated: 'Merge rule you work under: a review round with 0 BLOCKING, 0 MAJOR and no unsettled demonstrated finding", "demonstrated: 'Merge rule you work under: a review round with 0 BLOCKING, 0 MAJOR and no unsettled spec-sentence MINOR merges; a demonstrated finding"]] },
  { id: 'R51', name: 'verifier=off adds a sentence again', edits: [[BRIEF, "  'preNominationChecks=on':", "  'verifier=off': 'verifier=off: no verifier seat.',\n  'preNominationChecks=on':"]] },
  { id: 'R52', name: 'a stacked ticket\'s base is merge-base, not the head it was built on', edits: [[CLI, 'stackedBase(state, ticket) ?? baseOf(', 'baseOf(']] },
  { id: 'R53', name: 'a merged upstream still counts as built-on (an exclusion that is already in the target)', edits: [[REV, "state.tickets[up]?.status !== 'merged').map(", "true).map("]] },
  { id: 'R54', name: 'the recorded reviewer can be recorded as implementer / verifier', edits: [[STATE0, "if (rid && (('implementer' in patch", "if (false as boolean && rid && (('implementer' in patch"]] },
  { id: 'R55', name: 'wiring: an archived reviewer counts as live', edits: [[WIRING, 'return !!w && !w.archived;', 'return !!w;']] },
].map((m) => ({ ...m, tests: T }));

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

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanoutrev588-mutants-'));
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

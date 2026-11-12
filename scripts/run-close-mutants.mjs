#!/usr/bin/env node
// #437 self-gate — IN-PLACE mutation sweep of "a run closes with its coordinator". Each mutant removes ONE guard in the real source and must turn
// src/main/bus-run-close.test.ts red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree. CONTROL first: the unit file must
// be GREEN unmutated (skipped 0). CLI mutants rebuild dist-electron/cli.js (the tests drive the BUILT bundle); rebuilt again after.
// Run: node scripts/run-close-mutants.mjs [--only M01,M07] [--check-anchors]   (pnpm run test:run-close-mutants)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const RC = 'src/main/bus-run-close.ts', VERBS = 'src/cli/bus-verbs.ts', CLIX = 'src/cli/index.ts', WS = 'src/main/workspaces.ts', SDK = 'src/main/agent-sdk.ts', IDX = 'src/main/index.ts';
const PM = 'src/main/pause-memory.ts', PA = 'src/main/pause-auto.ts', PD = 'src/main/pause-douce.ts', PR = 'src/main/bus-pause-records.ts', WAKE = 'src/main/bus-wake.ts', LIV = 'src/main/bus-liveness.ts', RUNS = 'src/main/bus-runs.ts';
const T = { close: 'src/main/bus-run-close.test.ts' };
const F = 'false as boolean';

/** One mutant = exact-once edits [file, find, replacement]. `cli` = rebuild the CLI bundle first. Every mutant must turn T.close red. */
const MUTANTS = [
  // ── the refusals (each verb, each side) ──
  { id: 'M01', name: 'send: the closed-run guard is gone (mail to a closed run lands)', cli: true, edits: [[VERBS, "  assertRunsOpen(ctx, 'send', ctx.id.runId, a.toRunId, a.to); // #437: a closed run is refused, not parked\n", '']] },
  { id: 'M02', name: 'send: the RECIPIENT\'s run is not checked (mail from an open run to a member of a closed one lands)', cli: true, edits: [[VERBS, "assertRunsOpen(ctx, 'send', ctx.id.runId, a.toRunId, a.to);", "assertRunsOpen(ctx, 'send', ctx.id.runId);"]] },
  { id: 'M03', name: 'send: the SENDER\'s own run is not checked (a member of a closed run keeps writing into it)', cli: true, edits: [[VERBS, "assertRunsOpen(ctx, 'send', ctx.id.runId, a.toRunId, a.to);", "assertRunsOpen(ctx, 'send', a.toRunId, a.to);"]] },
  { id: 'M04', name: 'ask: the closed-run guard is gone', cli: true, edits: [[VERBS, "  assertRunsOpen(ctx, 'ask', ctx.id.runId, toRunId, to); // #437\n", '']] },
  { id: 'M05', name: 'ask: the recipient\'s run is not checked', cli: true, edits: [[VERBS, "assertRunsOpen(ctx, 'ask', ctx.id.runId, toRunId, to);", "assertRunsOpen(ctx, 'ask', ctx.id.runId);"]] },
  { id: 'M06', name: 'gate open: the closed-run guard is gone', cli: true, edits: [[VERBS, "    assertRunsOpen(ctx, 'gate open', ctx.id.runId, toRunId, to.value?.trim()); // #437\n", '']] },
  { id: 'M07', name: 'gate open: the recipient\'s run is not checked', cli: true, edits: [[VERBS, "assertRunsOpen(ctx, 'gate open', ctx.id.runId, toRunId, to.value?.trim());", "assertRunsOpen(ctx, 'gate open', ctx.id.runId);"]] },
  { id: 'M08', name: 'gate resolve: a ruling into a closed run is accepted (the re-wake is parked there)', cli: true, edits: [[VERBS, "    if (gateBefore) assertRunsOpen(ctx, 'gate resolve', gateBefore.run_id);", `    if (${F}) assertRunsOpen(ctx, 'gate resolve', gateBefore!.run_id);`]] },
  { id: 'M09', name: 'the guard\'s predicate never fires (every verb lets a closed run through)', cli: true, edits: [[VERBS, 'if (row && row.closed_at !== null && row.closed_at !== undefined) ctx.fail(', `if (${F}) ctx.fail(`]] },
  { id: 'M10', name: 'the refusal does not NAME the closed run', cli: true, edits: [[VERBS, 'refused — run ${JSON.stringify(runId)} is CLOSED (since', 'refused — the run is CLOSED (since']] },
  // ── archive / delete / unarchive / app start ──
  { id: 'M11', name: 'archive does not close the run its coordinator owns', edits: [[WS, "    closeRunsOf([ws.id]); // #437: the run this agent coordinates closes with it (every archived descendant's too — the loop covers the subtree)\n", '']] },
  { id: 'M12', name: 'unarchive does not reopen it', edits: [[WS, "    reopenRunsOf([ws.id]); // #437: unarchive REOPENS the same run (its id is the coordinator's workspace id); history, unread mail and switches kept\n", '']] },
  { id: 'M13', name: 'delete (UI + CLI route) does not close it', edits: [[WS, '  const closedRuns = closeRunsOf([id]); // #437: first — mail to a coordinator being deleted is refused for the whole (slow) teardown\n', '  const closedRuns: string[] = [];\n']] },
  { id: 'M14', name: 'bulk delete does not close them', edits: [[WS, '  for (const w of targets) closedByCall.set(w.id, closeRunsOf([w.id])); // #437: every run these coordinate closes before the first (slow) teardown\n', '']] },
  { id: 'M15', name: 'an out-of-band removal (orphan prune) does not close it', edits: [[WS, '      closeRunsOf([ws.id]); // #437: an out-of-band removal (worktree gone) is a delete too\n', '']] },
  { id: 'M16', name: 'the close wrapper reopens instead of closing', edits: [[WS, 'const closed = closeRunsCoordinatedBy(db, ids);', 'const closed = reopenRunsCoordinatedBy(db, ids);']] },
  { id: 'M17', name: 'a session start no longer repairs a dropped reopen', edits: [[SDK, '  ensureRunOpen(ws); // #437: a live coordinator never sits on a closed run (an unarchive whose reopen was dropped is repaired at its next start)\n', '']] },
  { id: 'M18', name: 'app start never reconciles run closure', edits: [[IDX, 'if (store.loadedFromDisk) try { reconcileRunClosureAtStart();', `if (${F}) try { reconcileRunClosureAtStart();`]] },
  { id: 'M34', name: 'a failed single delete leaves the coordinator\'s run closed (no reopen)', edits: [[WS, '    reopenRunIds(closedRuns); // #437: the delete failed — the workspace stays, so do the runs THIS call closed\n', '']] },
  { id: 'M35', name: 'a failed bulk delete leaves the survivors\' runs closed', edits: [[WS, "    reopenRunIds(targets.filter((w) => !removed.includes(w.id)).flatMap((w) => closedByCall.get(w.id) ?? [])); // #437: the ones not torn down keep the runs THIS call closed\n", '']] },
  { id: 'M36', name: 'delete closes the run only AFTER the slow teardown (mail lands during it)', edits: [[WS, "  const closedRuns = closeRunsOf([id]); // #437: first — mail to a coordinator being deleted is refused for the whole (slow) teardown\n  try {\n    await teardownWorkspace(ws);\n  } catch (e) {", "  const closedRuns: string[] = [];\n  try {\n    await teardownWorkspace(ws);\n    closeRunsOf([id]);\n  } catch (e) {"]] },
  { id: 'M37', name: 'a session start reopens even for an ARCHIVED workspace (undoes a concurrent archive)', edits: [[WS, 'if (!(store.getWorkspace(ws.id) ?? ws).archived) reopenRunsOf([ws.id]);', 'reopenRunsOf([ws.id]);']] },
  { id: 'M41', name: 'the app-start reconcile mapping is flipped (live → archived, archived → live)', edits: [[RC, "return !w ? 'gone' : w.archived ? 'archived' : 'live';", "return !w ? 'gone' : w.archived ? 'live' : 'archived';"]] },
  { id: 'M42', name: 'the app-start reconcile has no floor (an empty / restored store closes every run)', edits: [[RC, 'if (workspaceCount === 0 && (db.prepare', 'if (false as boolean && (db.prepare']] },
  { id: 'M43', name: 'a failed delete reopens EVERY run of the coordinator, even one an earlier archive closed', edits: [[RC, "const upd = db.prepare('UPDATE runs SET closed_at = NULL WHERE id = ? AND closed_at IS NOT NULL');\n  db.transaction(() => {\n    for (const id of runIds)", "const upd = db.prepare('UPDATE runs SET closed_at = NULL WHERE id IN (SELECT id FROM runs WHERE coordinator = (SELECT coordinator FROM runs WHERE id = ?)) AND closed_at IS NOT NULL');\n  db.transaction(() => {\n    for (const id of runIds)"]] },
  { id: 'M44', name: 'the single-delete rollback reopens by coordinator again (not the runs this call closed)', edits: [[WS, 'reopenRunIds(closedRuns); // #437', 'reopenRunsOf([id]); // #437']] },
  { id: 'M45', name: 'the app-start reconcile is fed no workspace count (floor never sees 0)', edits: [[WS, 'store.workspaces.length);\n  if (r.skipped)', '1);\n  if (r.skipped)']] },
  // ── the human Asks tray ──
  { id: 'M38', name: 'the human Asks tray lists a closed run\'s gate', edits: [['src/main/bus.ts', '          AND run_id NOT IN (SELECT id FROM runs WHERE closed_at IS NOT NULL)\n', '']] },
  { id: 'M39', name: 'the human resolve writes a ruling + re-wake into a closed run', edits: [['src/main/human-gates.ts', "  if (gateBefore && isGateRunClosed(db, gateBefore)) return { ok: false, reason: 'not-open', gateId }; // #437: a closed run takes no ruling (the re-wake would be parked in it)\n", '']] },
  { id: 'M40', name: 'isGateRunClosed never says closed', edits: [[RC, "?.c != null;", "?.c == 12345;"]] },
  // ── the close / reopen / reconcile primitives ──
  { id: 'M19', name: 'closeRunsCoordinatedBy closes nothing', edits: [[RC, "const upd = db.prepare('UPDATE runs SET closed_at = ? WHERE id = ? AND closed_at IS NULL');", "const upd = db.prepare('UPDATE runs SET closed_at = ? WHERE id = ? AND closed_at IS NOT NULL');"]] },
  { id: 'M20', name: 'reopenRunsCoordinatedBy leaves the run closed', edits: [[RC, "return out;\n  const upd = db.prepare('UPDATE runs SET closed_at = NULL WHERE id = ? AND closed_at IS NOT NULL');", "return out;\n  const upd = db.prepare('UPDATE runs SET closed_at = closed_at WHERE id = ? AND closed_at IS NOT NULL');"]] },
  { id: 'M21', name: 'reconcile does not close the run of an archived / deleted coordinator', edits: [[RC, 'if (!live && r.closed_at === null) {', `if (${F}) {`]] },
  { id: 'M22', name: 'reconcile does not reopen the run of a live coordinator', edits: [[RC, '} else if (live && r.closed_at !== null) {', `} else if (${F}) {`]] },
  { id: 'M23', name: 'reconcile treats an ARCHIVED coordinator as live', edits: [[RC, "const live = stateOf(r.coordinator) === 'live';", "const live = stateOf(r.coordinator) !== 'gone';"]] },
  // ── the enumerators ──
  { id: 'M24', name: 'liveFleetRuns lists a closed run (memory Pause / alert / container window)', edits: [[PM, 'LEFT JOIN run_flags f ON f.run_id = r.id WHERE r.closed_at IS NULL ORDER BY r.created_at, r.id', 'LEFT JOIN run_flags f ON f.run_id = r.id ORDER BY r.created_at, r.id']] },
  { id: 'M25', name: 'the wake sweep wakes a reader for mail in a closed run', edits: [[WAKE, 'const openIds = related.ids.filter((id) => !closedRuns.has(id));', 'const openIds = related.ids;']] },
  { id: 'M26', name: 'the wake sweep wakes a reader for a gate in a closed run', edits: [[WAKE, 'openGatesForRecipientInRuns(db, openIds, reader); // #437: open runs only', 'openGatesForRecipientInRuns(db, related.ids, reader); // #437: open runs only']] },
  { id: 'M27', name: 'the liveness sweep escalates a member of a closed run', edits: [[LIV, 'const members = readMembers().filter((m) => !closedRuns.has(m.runId));', 'const members = readMembers();']] },
  { id: 'M28', name: 'the Pause re-arm pass still reads a closed run\'s carrier', edits: [[PR, 'WHERE r.paused_at IS NOT NULL AND r.closed_at IS NULL`', 'WHERE r.paused_at IS NOT NULL`']] },
  { id: 'M29', name: 'the Pause douce escalation still reads a closed run\'s carrier', edits: [[PD, 'AND r.resume_started_at IS NULL AND r.closed_at IS NULL`', 'AND r.resume_started_at IS NULL`']] },
  { id: 'M30', name: 'the usage-limit auto-lift still reads a closed run', edits: [[PA, 'AND r.resume_started_at IS NULL AND r.closed_at IS NULL`', 'AND r.resume_started_at IS NULL`']] },
  { id: 'M31', name: 'the memory auto-lift still reads a closed run', edits: [[PM, 'AND r.resume_started_at IS NULL AND r.closed_at IS NULL`', 'AND r.resume_started_at IS NULL`']] },
  { id: 'M32', name: 'bus-status never says a run is closed (the wire field)', cli: true, edits: [[RUNS, 'closedAt: row?.closed_at ?? null, // #437', 'closedAt: null, // #437']] },
  { id: 'M33', name: 'bus-status never prints the closed line', cli: true, edits: [[CLIX, "if (typeof res.closedAt === 'number') {", `if (${F}) {`]] },
];
for (const m of MUTANTS) m.tests = [T.close];

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

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'runclose437-mutants-'));
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
    if (u.status !== 0 || red.length) killedBy.push(`unit: ${red.length ? red.map((n) => n.replace(/^\\?#437 /, '').slice(0, 60)).join(' | ') : `rc=${u.status}`}`);
  } finally {
    files.forEach((f, i) => fs.copyFileSync(path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)));
    restored = files.every((f, i) => sha(f) === before[f] && spawnSync('cmp', ['-s', path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)]).status === 0);
    if (m.cli) buildCli(); // the bundle must never stay built from a mutant: a later (non-CLI) mutant would be "killed" by the stale binary
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

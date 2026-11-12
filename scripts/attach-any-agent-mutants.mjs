#!/usr/bin/env node
// #439 self-gate — IN-PLACE mutation sweep of "attach and detach under any agent". Each mutant removes ONE clause in the real source and must turn its
// NAMED unit file(s) red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree. CONTROL first: every named unit file must be
// GREEN unmutated (skipped 0). The CLI bundle is rebuilt once up front (the tests drive the BUILT CLI; no mutant edits the CLI).
// Run: node scripts/attach-any-agent-mutants.mjs [--only M01,M07] [--check-anchors]   (pnpm run test:attach-any-agent-mutants)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const AT = 'src/shared/attach-target.ts', BR = 'src/main/bus-reparent-run.ts', WS = 'src/main/workspaces.ts', SB = 'src/renderer/components/Sidebar.tsx', DZ = 'src/shared/dnd-attach-zone.ts';
const T = { main: 'src/main/bus-reparent-run.test.ts', target: 'src/shared/attach-target.test.ts', dnd: 'src/shared/dnd-attach-zone.test.ts' };
const NOOP_LINE = "      if (action.kind === 'noop') continue;";
const CALL_LINE = "      await rederiveBusRunAfterReparent(ws, relatedRunSnapshots.get(oldAnchors)?.get(wsId)); // #439: BEFORE the noop decision — a live agent that stayed on the same run id still needs its row / pointer / mail\n";

/** One mutant = exact-once edits [file, find, replacement]. `tests` must go red. */
const MUTANTS = [
  { id: 'M01', name: 'attach refuses no archived target', edits: [[AT, "  if (parent.archived === true) return { ok: false, error: `cannot attach under an archived workspace (${parentId}) — unarchive it first` };\n", '']], tests: [T.target, T.main] },
  { id: 'M02', name: 'attach refuses no target whose run is closed', edits: [[AT, "  if (input.targetRunClosed) return { ok: false, error: `the run of ${parentId} is closed (its coordinator was archived or deleted) — nothing can join it` };\n", '']], tests: [T.target, T.main] },
  { id: 'M03', name: 'attach refuses no parent cycle', edits: [[AT, "    if (seen.has(cur.id)) return { ok: false, error: 'that would create a parent cycle' };\n", '']], tests: [T.target, T.main] },
  { id: 'M04', name: 'attach refuses no self-parent', edits: [[AT, "  if (parentId === id) return { ok: false, error: 'a workspace cannot be its own parent' };\n", '']], tests: [T.target, T.main] },
  { id: 'M05', name: 'attach refuses no unknown target', edits: [[AT, "  if (!parent) return { ok: false, error: `unknown parent workspace: ${parentId}` };", '  if (!parent) return { ok: true };']], tests: [T.target, T.main] },
  { id: 'M06', name: 'forwarded mail leaves the cursor in the run left (the agent coming back / a re-check re-delivers it)', edits: [[BR, '      bump.run(from, reader, rows[rows.length - 1].sequence);\n', '']], tests: [T.main] },
  { id: 'M07', name: 'the outstanding lot in the run left is not closed (a replay of the old lot)', edits: [[BR, '      closeLots.run(Date.now(), from, reader);\n', '']], tests: [T.main] },
  { id: 'M08', name: 'mail already acknowledged is forwarded again (cursor ignored)', edits: [[BR, 'unread.all(from, reader, cur)', 'unread.all(from, reader, 0)']], tests: [T.main] },
  { id: 'M09', name: 'a run-wide broadcast of the run left follows the agent', edits: [[BR, "'SELECT * FROM messages WHERE run_id = ? AND recipient = ? AND sequence > ? ORDER BY sequence'", "'SELECT * FROM messages WHERE run_id = ? AND (recipient = ? OR recipient IS NULL) AND sequence > ? ORDER BY sequence'"]], tests: [T.main] },
  { id: 'M10', name: 'mail is copied into a CLOSED run', edits: [[BR, '  if (runClosedAt(db, toRunId) != null) return { ...out, refusedClosed: true };\n', '']], tests: [T.main] },
  { id: 'M11', name: 'a followed dispatch loses its capability', edits: [[BR, '            insertCap.run(toRunId, newSeq, c.token_hash, c.recipient, c.state, c.minted_at, c.resolved_at);\n', '']], tests: [T.main] },
  { id: 'M12', name: 'the owned run is never re-pointed (parent_run_id stays write-once)', edits: [[BR, "  db.prepare('UPDATE runs SET parent_run_id = ?, kind = ? WHERE id = ?').run(newParentRunId, kind, runId);\n", '']], tests: [T.main] },
  { id: 'M13', name: 'a run is re-pointed at a CLOSED run', edits: [[BR, "    if (closed !== null) return 'refused-closed';\n", '']], tests: [T.main] },
  { id: 'M14', name: 'a run is re-pointed under its own descendant (run-tree cycle)', edits: [[BR, "      if (cur === runId) return 'refused-cycle';\n", '']], tests: [T.main] },
  { id: 'M15', name: 'the moved agent\'s own run row is not started (the noop-branch gap: a live agent that cannot send)', edits: [[BR, '  maybeStartRunAtAnchor(deps, anchor);\n', '']], tests: [T.main] },
  { id: 'M16', name: 'the run the agent now belongs to has no row started first (a pointer to a missing run)', edits: [[BR, '  if (parent) maybeStartRunAtAnchor(deps, computeAnchorInfo(parent, lookup, probe));\n', '']], tests: [T.main] },
  { id: 'M17', name: 'unread mail never follows the agent', edits: [[BR, '    report.mail = forwardUnreadMail(db, ws.id, relatedBefore.filter((r) => !after.has(r)), report.home);\n', '']], tests: [T.main] },
  { id: 'M18', name: 'mail is forwarded out of runs that are STILL related (the filter on the new related set is gone)', edits: [[BR, 'relatedBefore.filter((r) => !after.has(r))', 'relatedBefore']], tests: [T.main] },
  { id: 'M19', name: 'the reconcile never re-derives the bus run of a moved agent', edits: [[WS, CALL_LINE, '']], tests: [T.main] },
  { id: 'M20', name: 'the re-derivation moves AFTER the noop decision (#433 M1 reintroduced) — source pin', edits: [[WS, CALL_LINE, ''], [WS, NOOP_LINE, NOOP_LINE + '\n' + CALL_LINE.replace(/\n$/, '')]], tests: [T.main] },
  { id: 'M21', name: 'attach asks for a coordinator target again — source pin', edits: [[WS, '  const parent = store.getWorkspace(rawParent)!;\n', "  const parent = store.getWorkspace(rawParent)!;\n  if (!coordinates(parent)) return { ok: false, error: 'parent must be an orchestrator (promote it first)' };\n"]], tests: [T.main] },
  { id: 'M22', name: 'attach no longer reads the target run\'s closure off the bus — source pin', edits: [[WS, 'return !!db && runClosedAt(db, rawParent) != null;', 'return false;']], tests: [T.main] },
  { id: 'M23', name: 'the snapshot forgets the pre-move related runs — source pin', edits: [[WS, '      if (db) related.set(ws.id, relatedRunsOf(db, anchor));\n', '']], tests: [T.main] },
  { id: 'M24', name: 'the sidebar drop rule asks for a coordinator again — source pin', edits: [[SB, '    target.archived !== true &&\n', '    coordinates(target) &&\n']], tests: [T.main] },
  { id: 'M25', name: 'the repo-section rows stop using dropIntent (attach vs reorder) — source pin', edits: [[SB, 'const intent = dropIntent({ canAttach: canAttachTo(w), canReorder: canReorderOnto(w, isChild), yFraction: yFractionOf(e) });', 'const intent = (dropIntent as unknown as (x: unknown) => never)(0);']], tests: [T.main] },
  { id: 'M26', name: 'a row that can only be attached to no longer attaches over its whole height', edits: [[DZ, "  if (canAttach && !canReorder) return 'attach';\n", '']], tests: [T.dnd] },
  { id: 'M27', name: 'no reorder edge on a row that is both (the middle swallows the whole row)', edits: [[DZ, 'export const REORDER_EDGE = 0.25;', 'export const REORDER_EDGE = 0;']], tests: [T.dnd] },
];

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

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'attach439-mutants-'));
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

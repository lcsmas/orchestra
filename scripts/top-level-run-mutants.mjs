#!/usr/bin/env node
// #433 self-gate — IN-PLACE mutation sweep of "every top-level workspace has its mission from birth". Each mutant removes ONE guard in the real
// source and must turn its NAMED unit file(s) red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree. CONTROL first:
// every named unit file must be GREEN unmutated. CLI mutants rebuild dist-electron/cli.js (the CLI tests drive the BUILT bundle); rebuilt again after.
// Run: node scripts/top-level-run-mutants.mjs [--only M01,M07] [--check-anchors]   (pnpm run test:top-level-run-mutants)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const ANCHOR = 'src/main/bus-run-anchor.ts', WS = 'src/main/workspaces.ts', IDX = 'src/main/index.ts', SW = 'src/shared/bus-switches.ts', CLIX = 'src/cli/index.ts', VERBS = 'src/cli/bus-verbs.ts';
const T = {
  top: 'src/main/bus-top-level-run.test.ts', anchor: 'src/main/bus-run-anchor.test.ts', sw: 'src/shared/bus-switches.test.ts', wire: 'src/main/wave-run-anchor-wiring.test.ts',
  unk: 'src/cli/send-unknown-run.test.ts', hold: 'src/cli/run-hold.test.ts', refreeze: 'src/cli/run-refreeze-args.test.ts', verbs: 'src/cli/bus-verbs.test.ts', rrb: 'src/main/reparent-run-binding.test.ts',
};

/** One mutant = exact-once edits [file, find, replacement]. `tests` must go red; `cli` = rebuild the CLI bundle first. */
const MUTANTS = [
  { id: 'M01', name: 'a top-level workspace owns no run (anchorOwnsRun loses the parentless clause)', edits: [[ANCHOR, 'anchorIsOrchestrator || (anchorId === ws.id && isParentless(ws, lookup))', 'anchorIsOrchestrator']], tests: [T.top, T.anchor] },
  { id: 'M02', name: 'a plain child ALSO gets a run row (the parentless gate is dropped)', edits: [[ANCHOR, 'anchorIsOrchestrator || (anchorId === ws.id && isParentless(ws, lookup))', 'anchorIsOrchestrator || anchorId === ws.id']], tests: [T.top, T.anchor] },
  { id: 'M03', name: 'the sweep re-starts / re-reports a workspace that already has its run', edits: [[ANCHOR, 'if (!isParentless(ws, lookup) || probe(ws.id)) continue;', 'if (!isParentless(ws, lookup)) continue;']], tests: [T.top, T.anchor] },
  { id: 'M04', name: 'a dangling parent link is not top-level (an orphan gets no mission)', edits: [['src/shared/run-position.ts', 'return !ws.parentId || !lookup(ws.parentId);', 'return !ws.parentId;']], tests: [T.top, T.anchor] },
  { id: 'M05', name: 'the app-start migration is never called', edits: [[IDX, "if (store.loadedFromDisk) await startRunsForParentlessWorkspaces()", "if (false as boolean) await startRunsForParentlessWorkspaces()"]], tests: [T.wire] },
  { id: 'M06', name: 'the migration also takes archived and sandbox workspaces', edits: [[WS, "store.workspaces.filter((w) => !w.archived && w.host?.kind !== 'sandbox')", 'store.workspaces.filter(() => true)']], tests: [T.wire] },
  { id: 'M07', name: 'a row-less workspace gets seven false =OFF "frozen" lines (the notice gate is gone)', edits: [[SW, 'if (!args.runExists) return null;\n  return busSwitchNotice', 'return busSwitchNotice']], tests: [T.sw] },
  { id: 'M08', name: 'the reparent/adopt notice is written BEFORE the row is started (a transient row-less notice)', edits: [[WS, "      maybeStartRunAtAnchor(busRunAnchorDeps, reparentAnchor);\n      await writeBusSwitchState(ws.worktreePath, newAnchorId);", "      await writeBusSwitchState(ws.worktreePath, newAnchorId);\n      maybeStartRunAtAnchor(busRunAnchorDeps, reparentAnchor);"]], tests: [T.rrb] },
  { id: 'M13', name: 'a session start never ensures a top-level run (a detached / unarchived workspace stays run-less)', edits: [['src/main/agent-sdk.ts', 'await ensureTopLevelRun(ws); // #433: a workspace that became top-level after creation gets its mission before this env names it\n', '']], tests: [T.wire] },
  { id: 'M14', name: 'the launch-time start uses the wave-boundary starter (would refreeze a parent mission)', edits: [[WS, 'startRunsForParentless(busRunAnchorDeps, [ws], (id) => store.getWorkspace(id))', 'maybeStartRunAtAnchor(busRunAnchorDeps, resolveAnchorInfo(ws)) ? [ws.id] : []']], tests: [T.wire] },
  { id: 'M15', name: 'a new scratch / orchestrator workspace is created without its run row (creation chokepoint unwired)', edits: [[WS, '  await startBusRunAndWriteNotice(ws);\n  return ws;', '  return ws;']], tests: [T.wire] },
  { id: 'M09', name: 'a bus verb with no run named falls back to a made-up run id', cli: true, edits: [[VERBS, 'return flag?.trim() || env.ORCHESTRA_RUN_ID?.trim() || null;', "return flag?.trim() || env.ORCHESTRA_RUN_ID?.trim() || 'default';"]], tests: [T.verbs, T.unk, T.top, T.hold, T.refreeze] },
  { id: 'M10', name: 'send names no run and the refusal is gone (bus verbs go straight to the generic identity error)', cli: true, edits: [[CLIX, 'if (!resolveRunId(flags.run, liveEnv())) fail(NO_RUN_MESSAGE);\n', '']], tests: [T.unk, T.top] },
  { id: 'M11', name: 'the `default` run is exempt from the unknown-run gate again', cli: true, edits: [[CLIX, 'if (!runExists(db, id.runId)) {', "if (id.runId !== 'default' && !runExists(db, id.runId)) {"]], tests: [T.unk, T.top] },
  { id: 'M12', name: 'an admin verb (hold / refreeze / run status / bus-status) with no run acts on nothing instead of refusing', cli: true, edits: [[CLIX, 'if (!r) fail(NO_RUN_MESSAGE);\n  return r;', 'return r as string;']], tests: [T.hold, T.refreeze, T.top] },
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

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'toplevel433-mutants-'));
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

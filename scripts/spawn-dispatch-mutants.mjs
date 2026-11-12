#!/usr/bin/env node
// #435 self-gate — IN-PLACE mutation sweep of "the task given to spawn is the dispatch". Each mutant removes ONE clause in the real source and must turn
// src/main/spawn-dispatch.test.ts red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree. CONTROL first: the unit file must be
// GREEN unmutated, skipped 0. The CLI bundle is rebuilt before the control (the tests drive dist-electron/cli.js).
// Run: node scripts/spawn-dispatch-mutants.mjs [--only M01,M07] [--check-anchors]   (pnpm run test:spawn-dispatch-mutants)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const SD = 'src/main/spawn-dispatch.ts', WS = 'src/main/workspaces.ts', CLI = 'src/cli/index.ts';
const T = 'src/main/spawn-dispatch.test.ts';

/** One mutant = exact-once edits [file, find, replacement]. `tests` must go red. */
const MUTANTS = [
  { id: 'M01', name: 'the dispatch row is never written (a capability with no message)', edits: [[SD, "const s = send(db, { runId, sender: spawner.id, kind: 'dispatch', body: a.task, recipient: a.child.id });", 'const s = 0;']], tests: [T] },
  { id: 'M02', name: 'no capability is minted (every worker_done is rejected)', edits: [[SD, '      mintCapability(db, runId, s, a.child.id);\n', '']], tests: [T] },
  { id: 'M03', name: 'send + mint are not one transaction (a failed mint leaves an orphan dispatch)', edits: [[SD, 'const seq = db.transaction((): number => {', 'const seq = ((f: () => number) => f)((): number => {']], tests: [T] },
  { id: 'M04', name: 'a failed dispatch write no longer stops the spawn (the agent starts without its dispatch)', edits: [[SD, "if (dispatch.kind === 'failed') {", 'if (false as boolean) {']], tests: [T] },
  { id: 'M05', name: 'the agent starts BEFORE the dispatch is written', edits: [[SD, 'const dispatch = a.record();', "const dispatch: SpawnDispatchOutcome = { kind: 'none', reason: 'detached' };"], [SD, 'return { ran: true, result: await a.start(), dispatch };', 'const result = await a.start(); return { ran: true, result, dispatch: a.record() };']], tests: [T] },
  { id: 'M06', name: 'a refused spawn leaves its workspace behind (teardown never called)', edits: [[SD, '      await a.teardown();\n', '']], tests: [T] },
  { id: 'M07', name: 'a --detached / non-child spawn is dispatched across runs (guard removed)', edits: [[SD, 'if (a.detached || a.child.parentId !== a.from) return', 'if (false as boolean) return']], tests: [T] },
  { id: 'M08', name: 'a spawner that does not own the child\'s run is dispatched from anyway (run-mismatch guard removed)', edits: [[SD, 'if (runIdOf(spawner, deps.lookup) !== runId) {', 'if (false as boolean) {']], tests: [T] },
  { id: 'M09', name: 'a closed run still receives the dispatch (closed guard removed)', edits: [[SD, 'if (run.closed_at !== null) return', 'if (false as boolean) return']], tests: [T] },
  { id: 'M10', name: 'a run with no row still receives the dispatch (missing-row guard removed)', edits: [[SD, 'if (!run) return {', 'if (false as boolean) return {']], tests: [T] },
  { id: 'M11', name: 'a bus that is not open silently skips the dispatch', edits: [[SD, "if (!db) return { kind: 'failed', error: 'the bus is not open' };", "if (!db) return { kind: 'none', reason: 'no-spawner' };"]], tests: [T] },
  { id: 'M12', name: 'a thrown bus error is swallowed as "no dispatch" (the agent starts without one)', edits: [[SD, "return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };", "return { kind: 'none', reason: 'no-spawner' };"]], tests: [T] },
  { id: 'M13', name: 'a spawner missing from the store is dispatched from anyway', edits: [[SD, "if (!spawner) return { kind: 'failed', error: `the spawner ${a.from} is not in the store` };", "if (!spawner) return { kind: 'none', reason: 'no-spawner' };"]], tests: [T] },
  { id: 'M14', name: 'a sandbox child is dispatched on the host bus (guard removed)', edits: [[SD, 'if (a.remote) return', 'if (false as boolean) return']], tests: [T] },
  { id: 'M15', name: 'a blank task is recorded as a dispatch (guard removed)', edits: [[SD, 'if (!a.task.trim()) return', 'if (false as boolean) return']], tests: [T] },
  { id: 'M16', name: 'a human click (no spawner) is dispatched from nobody (guard removed)', edits: [[SD, 'if (!a.from) return', 'if (false as boolean) return']], tests: [T] },
  { id: 'M17', name: 'dispatchSpawnRequest tears nothing down on a failed write (wiring)', edits: [[WS, 'teardown: () => deleteWorkspace(ws.id),', 'teardown: async () => {},']], tests: [T] },
  { id: 'M18', name: 'dispatchSpawnRequest goes on with the spawn after a refused dispatch (wiring)', edits: [[WS, 'if (!after.ran) return { ok: false, error:', 'if (false as boolean) return { ok: false, error:']], tests: [T] },
  { id: 'M19', name: 'dispatchSpawnRequest starts the agent outside the dispatch seam (wiring)', edits: [[WS, 'start: () => startWorkspaceAgentHeadless(ws.id, input.origin, false, input.images),', 'start: async () => ({ ok: true } as never),']], tests: [T] },
  { id: 'M20', name: 'the CLI stops printing the recorded dispatch', edits: [[CLI, 'Task recorded as your dispatch #${dispatched.seq} to ${res.id}', 'Spawned ${res.id}']], tests: [T] },
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

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'spawndispatch435-mutants-'));
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

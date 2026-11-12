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

const SD = 'src/main/spawn-dispatch.ts', WS = 'src/main/workspaces.ts', CLI = 'src/cli/index.ts', BV = 'src/cli/bus-verbs.ts';
const T = 'src/main/spawn-dispatch.test.ts';

/** One mutant = exact-once edits [file, find, replacement]. `tests` must go red. */
const MUTANTS = [
  { id: 'M01', name: 'the dispatch row is never written (a capability with no message)', edits: [[SD, "const s = send(db, { runId, sender: spawner.id, kind: 'dispatch', body: a.task, recipient: a.child.id });", 'const s = 0;']], tests: [T] },
  { id: 'M02', name: 'no capability is minted (every worker_done is rejected)', edits: [[SD, '      mintCapability(db, runId, s, a.child.id);\n', '']], tests: [T] },
  { id: 'M03', name: 'send + mint are not one transaction (a failed mint leaves an orphan dispatch)', edits: [[SD, 'const seq = db.transaction((): number => {', 'const seq = ((f: () => number) => f)((): number => {']], tests: [T] },
  { id: 'M04', name: 'a failed dispatch write no longer stops the spawn (the agent starts without its dispatch)', edits: [[SD, "if (dispatch.kind === 'failed') {", 'if (false as boolean) {']], tests: [T] },
  { id: 'M05', name: 'the agent starts BEFORE the dispatch is written', edits: [[SD, '    dispatch = a.record();\n  } catch (e) {', "    dispatch = { kind: 'none', reason: 'detached' };\n  } catch (e) {"], [SD, 'return { ran: true, result: await a.start(), dispatch };', 'const result = await a.start(); return { ran: true, result, dispatch: a.record() };']], tests: [T] },
  { id: 'M06', name: 'a refused spawn leaves its workspace behind (teardown never called)', edits: [[SD, '      await a.teardown();\n', '']], tests: [T] },
  { id: 'M07', name: 'a --detached / non-child spawn is dispatched across runs (guard removed)', edits: [[SD, 'if (a.detached || a.child.parentId !== a.spawner) return', 'if (false as boolean) return']], tests: [T] },
  { id: 'M08', name: 'a spawner that does not own the child\'s run is dispatched from anyway (run-mismatch guard removed)', edits: [[SD, 'if (memberRunOf(a.child, deps.lookup) !== runId) {', 'if (false as boolean) {']], tests: [T] },
  { id: 'M09', name: 'a closed run still receives the dispatch (closed guard removed)', edits: [[SD, 'if (run.closed_at !== null) return', 'if (false as boolean) return']], tests: [T] },
  { id: 'M10', name: 'a run with no row still receives the dispatch (missing-row guard removed)', edits: [[SD, 'if (!run) return {', 'if (false as boolean) return {'], [SD, 'if (run.closed_at !== null) return', 'if (run?.closed_at != null) return']], tests: [T] },
  { id: 'M11', name: 'a bus that is not open silently skips the dispatch', edits: [[SD, "if (!db) return { kind: 'failed', error: 'the bus is not open' };", "if (!db) return { kind: 'none', reason: 'no-spawner' };"]], tests: [T] },
  { id: 'M12', name: 'a thrown bus error is swallowed as "no dispatch" (the agent starts without one)', edits: [[SD, "return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };", "return { kind: 'none', reason: 'no-spawner' };"]], tests: [T] },
  { id: 'M13', name: 'a spawner missing from the store is dispatched from anyway', edits: [[SD, "if (!spawner) return { kind: 'failed', error: `the spawner ${a.spawner} is not in the store` };", "if (!spawner) return { kind: 'none', reason: 'no-spawner' };"]], tests: [T] },
  { id: 'M14', name: 'a sandbox child is dispatched on the host bus (guard removed)', edits: [[SD, 'if (a.remote) return', 'if (false as boolean) return']], tests: [T] },
  { id: 'M15', name: 'a blank task is recorded as a dispatch (guard removed)', edits: [[SD, 'if (!a.task.trim()) return', 'if (false as boolean) return']], tests: [T] },
  { id: 'M16', name: 'a human click (no spawner) is dispatched from nobody (guard removed)', edits: [[SD, 'if (!a.spawner) return', 'if (false as boolean) return']], tests: [T] },
  { id: 'M17', name: 'dispatchSpawnRequest tears nothing down on a failed write (wiring)', edits: [[WS, 'teardown: () => deleteWorkspace(ws.id),', 'teardown: async () => {},']], tests: [T] },
  { id: 'M18', name: 'dispatchSpawnRequest goes on with the spawn after a refused dispatch (wiring)', edits: [[WS, 'if (!after.ran) return { ok: false, error:', 'if (false as boolean) return { ok: false, error:']], tests: [T] },
  { id: 'M19', name: 'dispatchSpawnRequest starts the agent outside the dispatch seam (wiring)', edits: [[WS, 'start: () => startWorkspaceAgentHeadless(ws.id, input.origin, false, input.images),', 'start: async () => ({ ok: true } as never),']], tests: [T] },
  { id: 'M21', name: 'a throw while gathering the dispatch inputs escapes (the spawn falls through to the catch with a kept child, no teardown)', edits: [[SD, "dispatch = { kind: 'failed', error: e instanceof Error ? e.message : String(e) }; // a throw while GATHERING", 'throw e; // a throw while GATHERING']], tests: [T] },
  { id: 'M22', name: 'the sandbox test of the spawner is always true (every spawn silently gets no dispatch)', edits: [[WS, "remote: !!input.from && store.getWorkspace(input.from)?.host?.kind === 'sandbox'", 'remote: true']], tests: [T] },
  { id: 'M23', name: 'the reply never carries the recorded dispatch (a start that throws loses it)', edits: [[WS, "if (outcome.kind === 'recorded') recorded =", 'if (false as boolean) recorded =']], tests: [T] },
  { id: 'M24', name: 'a kept child with no dispatch is no longer told not to be restarted', edits: [[SD, ' The workspace was kept STOPPED with no dispatch: do NOT restart it', ' The workspace was kept STOPPED']], tests: [T] },
  { id: 'M25', name: 'a report to the direct coordinator is no longer filed in its run (owner-child status lands in its own run)', cli: true, edits: [[BV, 'if (!m || !a.to || a.to !== m || m === ctx.id.runId) return ctx;', 'if (true as boolean) return ctx;']], tests: [T] },
  { id: 'M26', name: 'the capability is verified in the sender\'s own run, not the filing run (owner-child worker_done rejected)', cli: true, edits: [[BV, 'ctx.bus.verifyCapability(ctx.db, wctx.id.runId, cap)', 'ctx.bus.verifyCapability(ctx.db, ctx.id.runId, cap)']], tests: [T] },
  { id: 'M27', name: 'token no longer looks in the coordinator\'s run (an owner-child finds none)', cli: true, edits: [[BV, 'if (token === null && ctx.memberRunId &&', 'if (false as boolean && ctx.memberRunId &&']], tests: [T] },
  { id: 'M28', name: 'send never learns its coordinator run (index.ts drops memberRunId on send)', cli: true, edits: [[CLI, 'memberRunId: memberRunForCaller(id.handle) }, {', 'memberRunId: undefined }, {']], tests: [T] },
  { id: 'M29', name: 'token never learns its coordinator run (index.ts drops memberRunId on token)', cli: true, edits: [[CLI, 'memberRunId: memberRunForCaller(id.handle) });', 'memberRunId: undefined });']], tests: [T] },
  { id: 'M30', name: 'the spawn dispatch is not pre-acked (the fresh child is woken for its own task)', edits: [[SD, 'if (a.preAck && earlierUnread === 0) db.prepare(', 'if (false as boolean) db.prepare(']], tests: [T] },
  { id: 'M31', name: 'a start of a child with no dispatch row writes nothing (ensureOwedDispatch thinks it is present)', edits: [[SD, "if (has) return { kind: 'present' };", "if (true as boolean) return { kind: 'present' };"]], tests: [T] },
  { id: 'M32', name: 'a failed owed-dispatch write no longer refuses the start', edits: [[WS, "if (owedDispatch.kind === 'failed') return", "if (false as boolean) return"]], tests: [T] },
  { id: 'M33', name: 'the spawn route no longer pre-acks (wiring)', edits: [[WS, 'child: ws, task, preAck: true })', 'child: ws, task })']], tests: [T] },
  { id: 'M34', name: 'a child whose parent is gone is blocked from starting (missing-parent exemption removed)', edits: [[SD, '|| !deps.lookup(child.parentId)) return', '|| false as boolean) return']], tests: [T] },
  { id: 'M35', name: 'the owed-dispatch lookup ignores the parent\'s run (a held spawn that became an owner is refused at release)', edits: [[SD, 'const runs = [runIdOf(child, deps.lookup), memberRunOf(child, deps.lookup)]', 'const runs = [runIdOf(child, deps.lookup)]']], tests: [T] },
  { id: 'M36', name: 'the pre-ack ignores earlier unread mail (a run broadcast before the spawn is hidden)', edits: [[SD, 'if (a.preAck && earlierUnread === 0) db.prepare(', 'if (a.preAck) db.prepare(']], tests: [T] },
  { id: 'M37', name: 'the dispatch run is the child\'s own run again (an owner-child\'s spawn dispatch lands in the wrong run)', edits: [[SD, 'const runId = runIdOf(spawner, deps.lookup);\n    if (memberRunOf', 'const runId = runIdOf(a.child, deps.lookup);\n    if (memberRunOf']], tests: [T] },
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

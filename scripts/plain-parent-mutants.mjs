#!/usr/bin/env node
// #434 self-gate — IN-PLACE mutation sweep of "a plain parent and its child talk over the bus". Each mutant removes ONE clause in the real source and must
// turn its NAMED unit file(s) red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree. CONTROL first: every named unit file must
// be GREEN unmutated. CLI-bundle mutants rebuild dist-electron/cli.js (the CLI tests drive the BUILT bundle); rebuilt again after.
// M19 / M23 (the plain-own-anchor exemption from the `message` refusal) are RETIRED with the exemption itself (#441: `message` is refused for every target; its mutants are scripts/old-channel-closed-mutants.mjs).
// Run: node scripts/plain-parent-mutants.mjs [--only M01,M07] [--check-anchors]   (pnpm run test:plain-parent-mutants)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const RP = 'src/shared/run-position.ts', ANCHOR = 'src/main/bus-run-anchor.ts', WS = 'src/main/workspaces.ts', IDX = 'src/main/index.ts', SDK = 'src/main/agent-sdk.ts', STORE = 'src/main/store.ts', LIVE = 'src/main/bus-liveness-roster.ts';
const T = {
  plain: 'src/main/bus-plain-parent.test.ts', rp: 'src/shared/run-position.test.ts', pause: 'src/main/pause-reprise.test.ts', parent: 'src/main/bus-parent-run.test.ts',
  anchor: 'src/main/bus-run-anchor.test.ts', gate: 'src/main/message-channel-gate.test.ts', liveness: 'src/main/bus-liveness-roster.test.ts',
};

/** One mutant = exact-once edits [file, find, replacement]. `tests` must go red; `cli` = rebuild the CLI bundle first. */
const MUTANTS = [
  { id: 'M01', name: 'owning a run no longer makes a workspace a coordinator (coordinates loses ownsRun)', cli: true, edits: [[RP, 'return isCoordinatorKind(ws) || ws.ownsRun === true || !ws.parentId;', 'return isCoordinatorKind(ws) || !ws.parentId;']], tests: [T.plain, T.rp, T.pause] },
  { id: 'M02', name: 'a child is no longer a member of its DIRECT parent\'s run (runIdOf gives every member its own run)', cli: true, edits: [[RP, 'return parent && parent.id !== ws.id ? parent.id : ws.id;', 'return ws.id;']], tests: [T.plain, T.rp] },
  { id: 'M03', name: 'the first spawn never records the parent as an owner (ownerToMark returns nobody)', edits: [[ANCHOR, 'return parent && parent.ownsRun !== true && !isCoordinatorKind(parent) ? parent : null;', 'return null;']], tests: [T.plain] },
  { id: 'M04', name: 'createWorkspace never makes the parent an owner before the child\'s anchor resolves', edits: [[WS, '  if (!remote) await ensureParentOwnsRun(ws);\n', '']], tests: [T.plain] },
  { id: 'M05', name: 'a session start no longer gives its parent a run (attach / pre-#434 data self-heal gone)', edits: [[SDK, 'await ensureMemberRun(ws); // #434: a member launched under a parent that owns no run yet (attach, pre-#434 data) gives it one before this env names it\n', '']], tests: [T.plain] },
  { id: 'M06', name: 'the app-start owner migration is never called', edits: [[IDX, "if (store.loadedFromDisk) await startRunsForOwnerWorkspaces()", "if (false as boolean) await startRunsForOwnerWorkspaces()"]], tests: [T.plain] },
  { id: 'M07', name: 'a missing run above the anchor is not started (parent_run_id dangles)', edits: [[ANCHOR, 'if (missing) missingParentRuns.unshift(', 'if (false as boolean) missingParentRuns.unshift(']], tests: [T.parent, T.plain] },
  { id: 'M08', name: 'a first-spawn vague is not nested under the run its owner is a member of (parent_run_id null)', edits: [[ANCHOR, '    parentRunId: parent.id,\n', '    parentRunId: null,\n']], tests: [T.plain, T.parent] },
  { id: 'M09', name: 'coordinatorOf answers nobody (every escalation / roster pick loses its coordinator)', edits: [[RP, 'return parent && parent.id !== ws.id ? parent : undefined;', 'return undefined;']], tests: [T.rp] },
  { id: 'M10', name: 'the liveness roster picks its coordinator from parentId again (a second reader)', edits: [[LIVE, 'const parent = coordinatorOf(ws, (id) => store.getWorkspace(id));', 'const parent = ws.parentId ? store.getWorkspace(ws.parentId) : undefined;']], tests: [T.rp] },
  { id: 'M11', name: 'the store load stops migrating the flag / existing parents into ownsRun', edits: [[STORE, 'ws.canOrchestrate === true || parentsOfSomeone.has(ws.id)', 'false']], tests: [T.plain] },
  { id: 'M12', name: 'promote no longer records ownership (the flag alone would not make an OPS)', edits: [[WS, 'const updated: Workspace = { ...ws, canOrchestrate: true, ownsRun: true };', 'const updated: Workspace = { ...ws, canOrchestrate: true };']], tests: [T.plain] },
  { id: 'M13', name: 'the standing-role wording is never "dual" (a worktree owner would be told never to implement)', edits: [[RP, "return ws.repoPath ? 'dual' : 'pure';", "return 'pure';"]], tests: [T.rp] },
  { id: 'M16', name: 'promote of a top-level workspace is a silent no-op again (idempotence keyed on coordinates)', edits: [[WS, 'if (ws.ownsRun === true || isCoordinatorKind(ws)) return { ok: true, id, branch: ws.branch, kind: ws.kind };', 'if (coordinates(ws)) return { ok: true, id, branch: ws.branch, kind: ws.kind };']], tests: [T.plain] },
  { id: 'M17', name: 'demote leaves ownsRun set (the demoted OPS keeps its own run)', edits: [[WS, ': { ...ws, canOrchestrate: undefined, ownsRun: undefined };', ': { ...ws, canOrchestrate: undefined };']], tests: [T.plain] },
  { id: 'M18', name: 'attach does not mark the new parent as an owner', edits: [[WS, '  await ensureParentOwnsRun(updated); // #434: the new parent owns a run now (ownsRun + sentinel), not only at the child\'s next session start\n', '']], tests: [T.plain] },
  { id: 'M20', name: 'a top-level workspace no longer owns its mission in coordinates (`!parentId` dropped)', cli: true, edits: [[RP, 'return isCoordinatorKind(ws) || ws.ownsRun === true || !ws.parentId;', 'return isCoordinatorKind(ws) || ws.ownsRun === true;']], tests: [T.rp, T.plain] },
  { id: 'M21', name: 'a dangling-parent workspace is not recorded as an owner at app start / launch', edits: [[WS, '  await recordDanglingOwners(started);\n  for (const ws of live)', '  for (const ws of live)']], tests: [T.plain] },
  { id: 'M22', name: 'attach leaves a link-only ownership set (a re-attached orphan stays its own mission)', edits: [[WS, '...(ownedByLinkOnly ? { ownsRun: undefined } : {})', '...{}']], tests: [T.plain] },
  { id: 'M15', name: 'a sentinel writer hard-codes the dual wording again (a second reader of the role)', edits: [[WS, "await markOrchestratorWorktree(newWorktreePath, coordinatorRoleOf({ repoPath }) === 'dual');", 'await markOrchestratorWorktree(newWorktreePath, true);']], tests: [T.plain] },
  { id: 'M14', name: 'the first-spawn owner gets no standing-role sentinel', edits: [[WS, "await markOrchestratorWorktree(updated.worktreePath, coordinatorRoleOf(updated) === 'dual');", '']], tests: [T.plain] },
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

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'plainparent434-mutants-'));
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

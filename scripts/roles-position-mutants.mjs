#!/usr/bin/env node
// #440 self-gate — IN-PLACE mutation sweep of "promote/demote are gone; a role follows position". Each mutant re-introduces ONE removed thing (a promote
// verb, a /promote route, a flag read, a promote step in the skills) or breaks ONE new clause (roleOf, the whoami fields, the store migration) in the real
// source and must turn EVERY named killer red: `unit` = node --test files, `rig` = scripts/verify-roles-follow-position.mjs (built CLI + real store + real
// hooks socket + real generated files), `gate` = scripts/check-run-position-single-reader.mjs. Byte-exact backup + `cmp` restore after every mutant; run it
// on a COMMITTED tree. CONTROL first: every killer must be GREEN unmutated (and skipped 0). CLI-bundle mutants rebuild dist-electron/cli.js, rebuilt again after.
// Run: node scripts/roles-position-mutants.mjs [--only M01,M07] [--check-anchors]   (pnpm run test:roles-position-mutants)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const CLI = 'src/cli/index.ts', HELP = 'src/cli/help.ts', RP = 'src/shared/run-position.ts', WS = 'src/main/workspaces.ts', STORE = 'src/main/store.ts', HOOKS = 'src/main/hooks-server.ts', PRELOAD = 'src/preload/index.ts';
const U = { roles: 'src/cli/roles-follow-position.test.ts', rp: 'src/shared/run-position.test.ts', help: 'src/cli/help.test.ts' };
const RIG = { rig: true }, GATE = { gate: true };

/** One mutant = exact-once edits [file, find, replacement]. `unit` files, `rig`, `gate` must each go red; `cli` = rebuild the CLI bundle first. */
const MUTANTS = [
  { id: 'M01', name: '`orchestra promote` works again (answers a success line instead of the refusal)', cli: true, edits: [[CLI, '      fail(roleFollowsPositionMessage(command));', "      process.stdout.write(`Promoted ${args[0] ?? ''} to orchestrator\\n`);\n      return;"]], unit: [U.roles], ...RIG },
  { id: 'M02', name: '`orchestra demote` works again (only the demote verb answers success)', cli: true, edits: [[CLI, "    case 'promote':\n    case 'demote': {\n", "    case 'promote':\n    case 'demote': {\n      if (command === 'demote') { process.stdout.write('Demoted\\n'); return; }\n"]], unit: [U.roles], ...RIG },
  { id: 'M03', name: 'the refusal reaches the host first (a socket call before the refusal: "answered before any socket call" — the rig checks EFFECTS, a read-only call changes none, so the recording-socket unit arm is the only killer)', cli: true, edits: [[CLI, '      fail(roleFollowsPositionMessage(command));', "      await request('/whoami', { id: 'x' });\n      fail(roleFollowsPositionMessage(command));"]], unit: [U.roles] },
  { id: 'M04', name: 'the refusal no longer names whoami', cli: true, edits: [[HELP, 'Run `orchestra whoami` to see your role and run; ', '']], unit: [U.roles], ...RIG },
  { id: 'M05', name: 'the refusal no longer names spawn', cli: true, edits: [[HELP, '`orchestra spawn` to give an agent children of its own (spawning is what makes it an OPS), ', '']], unit: [U.roles], ...RIG },
  { id: 'M06', name: 'the demote help entry is gone (a dispatched verb without help)', cli: true, edits: [[HELP, "    name: 'demote',", "    name: 'demote-gone',"]], unit: [U.help, U.roles] },
  { id: 'M07', name: 'roleOf never answers OPS (an owner with a parent reads as a worker)', cli: false, edits: [[RP, "return coordinates(ws) ? 'OPS' : 'worker';", "return 'worker';"]], unit: [U.rp], ...RIG },
  { id: 'M08', name: 'roleOf decides LEAD by KIND, not by position (a top-level plain workspace is not a LEAD)', cli: false, edits: [[RP, "if (isTopLevel(ws, lookup)) return 'LEAD';", "if (isCoordinatorKind(ws)) return 'LEAD';"]], unit: [U.rp], ...RIG },
  { id: 'M09', name: 'whoami drops the run an OPS is a member of', cli: false, edits: [[WS, '    ...(coordinates(ws) && memberRunOf(ws, lookup) ? { memberOfRunId: memberRunOf(ws, lookup)! } : {}),\n', '']], unit: [U.roles], ...RIG },
  { id: 'M10', name: 'whoami gives a worker its OWN id as its run (not the parent run it is a member of)', cli: false, edits: [[WS, '    runId: runIdOf(ws, lookup),', '    runId: ws.id,']], unit: [U.roles], ...RIG },
  { id: 'M11', name: 'the store load no longer maps a flagged record onto ownsRun', cli: false, edits: [[STORE, 'legacy.canOrchestrate === true || parentsOfSomeone.has(ws.id)', 'parentsOfSomeone.has(ws.id)']], unit: [U.roles], ...RIG },
  { id: 'M12', name: 'the store load keeps the retired flag key on the record', cli: false, edits: [[STORE, '        delete legacy.canOrchestrate; // run-position: non-run — the retired flag is dropped from the record\n', '']], unit: [U.roles], ...RIG },
  { id: 'M13', name: 'the `/promote` socket route is back', cli: false, edits: [[HOOKS, "          } else if (route === '/whoami') {", "          } else if (route === '/promote') {\n            send(200, { ok: true });\n          } else if (route === '/whoami') {"]], unit: [U.roles], ...RIG },
  { id: 'M14', name: 'the generated workspace-admin skill carries a promote step again', cli: false, edits: [[WS, "## Roles follow position\n\nAn agent's role is its place", "## Promote a workspace into an orchestrator\n\nRun orchestra promote <id>. An agent's role is its place"]], unit: [U.roles], ...RIG },
  { id: 'M15', name: 'the orchestrator brief (embedded in the skills and the reminder) teaches `orchestra promote <child-id>` again', cli: false, edits: [[WS, '(a role follows position in the tree, nothing to switch on), its branch', '(then run orchestra promote <child-id>), its branch']], unit: [U.roles], ...RIG },
  { id: 'M16', name: 'the promoteWorkspace IPC bridge is back in the preload', cli: false, edits: [[PRELOAD, "  setWorkspaceParent: (id, parentId) =>", "  promoteWorkspace: (id) => ipcRenderer.invoke('workspaces:promote', id),\n  setWorkspaceParent: (id, parentId) =>"]], unit: [U.roles] },
  { id: 'M17', name: 'coordinates() reads the retired capability flag again (a second reader of the flag)', cli: false, edits: [[RP, 'return isCoordinatorKind(ws) || ws.ownsRun === true || !ws.parentId;', 'return isCoordinatorKind(ws) || ws.ownsRun === true || (ws as { canOrchestrate?: boolean }).canOrchestrate === true || !ws.parentId;']], unit: [U.rp, U.roles], ...GATE },
  { id: 'M18', name: 'the CLI offline store reader reads the flag again', cli: true, edits: [[CLI, 'ownsRun: w.ownsRun === true, // run-position', 'ownsRun: w.ownsRun === true || (w as { canOrchestrate?: unknown }).canOrchestrate === true, // run-position']], unit: [U.roles], ...GATE },
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
if (spawnSync('git', ['-C', REPO, 'diff', '--quiet', '--', ...touched]).status !== 0) { console.error('ABORT: a file a mutant edits has uncommitted changes — commit first (the restore proof is `git diff` empty)'); process.exit(3); }

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'roles440-mutants-'));
const unit = (files) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: REPO, encoding: 'utf8', timeout: 600000 });
const failedNames = (out) => [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
const buildCli = () => execFileSync('pnpm', ['run', 'build:cli'], { cwd: REPO, stdio: 'ignore', timeout: 300000 });
const rig = () => spawnSync(process.execPath, ['scripts/verify-roles-follow-position.mjs'], { cwd: REPO, encoding: 'utf8', timeout: 300000 });
const gate = () => spawnSync(process.execPath, ['scripts/check-run-position-single-reader.mjs'], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
const rigFails = (out) => [...out.matchAll(/^\s+FAIL (.*)$/gm)].map((m) => m[1].slice(0, 90));

{ // CONTROL: every killer is GREEN on the unmutated tree
  buildCli();
  const files = [...new Set(MUTANTS.flatMap((m) => m.unit))];
  const u = unit(files); const red = failedNames(u.stdout); const skipped = /^# skipped (\d+)/m.exec(u.stdout)?.[1];
  const ok1 = u.status === 0 && red.length === 0 && skipped === '0';
  console.log(`CONTROL unit files (${files.length}): ${ok1 ? 'GREEN, skipped 0' : `RED ${JSON.stringify(red)} skipped=${skipped}`}`);
  const r = rig(); const ok2 = r.status === 0 && /ALL ARMS PASS/.test(r.stdout);
  console.log(`CONTROL rig: ${ok2 ? 'GREEN (all arms)' : `RED ${JSON.stringify(rigFails(r.stdout))}`}`);
  const g = gate(); const ok3 = g.status === 0 && /CLEAN/.test(g.stdout);
  console.log(`CONTROL gate: ${ok3 ? 'CLEAN' : 'DIRTY ' + g.stdout.slice(-200)}`);
  if (!ok1 || !ok2 || !ok3) process.exit(4);
}

const results = [];
let cliDirty = false;
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const files = [...new Set(m.edits.map(([f]) => f))];
  const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
  files.forEach((f, i) => fs.copyFileSync(path.join(REPO, f), path.join(BACKUP, `${m.id}-${i}.bak`)));
  const killers = {}; // killer → red? (each named killer must be red on its own)
  let restored = false;
  try {
    for (const [f, find, to] of m.edits) {
      const p = path.join(REPO, f);
      const src = fs.readFileSync(p, 'utf8');
      if (count(src, find) !== 1) throw new Error(`PATTERN-GONE ${m.id} ${f}`);
      fs.writeFileSync(p, src.replace(find, () => to));
    }
    if (m.cli) { buildCli(); cliDirty = true; }
    if (m.unit?.length) { const u = unit(m.unit); const red = failedNames(u.stdout); killers.unit = u.status !== 0 || red.length ? `red: ${red.slice(0, 2).join(' | ') || `rc=${u.status}`}` : null; }
    if (m.rig) { const r = rig(); killers.rig = r.status !== 0 ? `red: ${rigFails(r.stdout).slice(0, 2).join(' | ') || `rc=${r.status}`}` : null; }
    if (m.gate) { const g = gate(); killers.gate = g.status !== 0 ? `DIRTY: ${g.stdout.trim().split('\n').pop().slice(0, 100)}` : null; }
  } finally {
    files.forEach((f, i) => fs.copyFileSync(path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)));
    restored = files.every((f, i) => sha(f) === before[f] && spawnSync('cmp', ['-s', path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)]).status === 0);
  }
  const survivors = Object.entries(killers).filter(([, v]) => v === null).map(([k]) => k);
  const killed = Object.keys(killers).length > 0 && survivors.length === 0;
  results.push({ id: m.id, name: m.name, killed, restored });
  console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${m.id} ${m.name}${Object.entries(killers).map(([k, v]) => `\n         ${v === null ? '!! NOT red:' : '←'} ${k}${v ? ` ${v}` : ''}`).join('')}${restored ? '' : '\n         !! RESTORE FAILED'}`);
}
if (cliDirty) buildCli();
const survivors = results.filter((r) => !r.killed);
const unrestored = results.filter((r) => !r.restored);
const diff = spawnSync('git', ['-C', REPO, 'diff', '--stat', '--', ...touched], { encoding: 'utf8' }).stdout.trim();
console.log(`\nMUTANTS: ${results.length - survivors.length}/${results.length} killed (every named killer red); survivors: ${survivors.map((s) => s.id).join(', ') || 'none'}; restore: ${unrestored.length ? 'FAILED ' + unrestored.map((u) => u.id).join(',') : 'byte-exact (cmp) for all'}; git diff of touched files: ${diff || 'empty'}`);
process.exit(survivors.length === 0 && unrestored.length === 0 && !diff ? 0 : 1);

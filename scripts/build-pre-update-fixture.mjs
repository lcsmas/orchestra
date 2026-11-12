#!/usr/bin/env node
// #442 prep (C) — build a SYNTHETIC pre-update ORCHESTRA_HOME: the data directory as master-before-
// #431 leaves it, so the packaged app can be started on it and the "every workspace gets a run" migration
// observed. Never a copy of the live dir (secrets, transcripts): every row is made here.
//
//   node scripts/build-pre-update-fixture.mjs --out <dir under $TMPDIR> [--base origin/master]
//
// The store is written by MASTER's own `Store` (src/main/store.ts) and the bus by master's own
// `openBus` / `startRun` / `send` (src/main/bus*.ts), extracted with `git archive <base>` into <out>/_master —
// so the shapes are the ones the pre-update app wrote, not ours. Refuses a base that already carries ADR 0012.
//
// Shape (see MANIFEST.json written next to home/):
//   run-less  P (top-level plain) + P1,P2 (plain children) + S (top-level scratch)      — no runs row at all
//   fleet     L (LEAD, mission run, delivery ON) → O (OPS, vague run ON) → W1,W2        — the unchanged-fleet arm
//   archived  Ar (archived LEAD, its mission run still open — closed by #437's app-start reconcile)
//   off       L → Z (OPS, vague run with ALL switches OFF) → Z1,Z2 + unread mail         — the delivery-OFF shape
//             (live: 2 of 42 runs, both `vague` rows with parent_run_id = a mission, every flag false, no
//              deliveries rows, senders = member ids + 'host' + 'humain'; plus 4 rows in the `default` run
//              whose recipient is an 8-char short id) — fields read read-only from ~/.orchestra/bus.sqlite
//              and ~/.config/orchestra/orchestra/store.json on 2026-11-12; only the SHAPE is reproduced.
// All workspaces carry `hibernatedAt` (Veille): the app starts no agent, spends no token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire, register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { censusHome, loadSqlite } from './pre-update-fixture-census.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

// ── scratch-prefix guard (never write outside $TMPDIR; never under a live config/data dir) ──
export function assertScratch(p) {
  const prefix = fs.realpathSync(process.env.ORCHESTRA_AGENT_TMPDIR || process.env.TMPDIR || os.tmpdir());
  // Resolve through the nearest EXISTING ancestor (symlinks included) — a refused path must not create a single directory.
  let anc = p; const tail = [];
  while (!fs.existsSync(anc)) { tail.unshift(path.basename(anc)); anc = path.dirname(anc); }
  const real = path.join(fs.realpathSync(anc), ...tail);
  const live = [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.claude-mc'), path.join(os.homedir(), '.orchestra'), path.join(os.homedir(), '.config')];
  if (!(real + path.sep).startsWith(prefix + path.sep) || live.some((l) => (real + path.sep).startsWith(l))) {
    throw new Error(`refusing ${real}: outside the scratch prefix ${prefix} (or under a live dir)`);
  }
  return real;
}

const out = assertScratch(path.resolve(arg('out', '')) || '/nonexistent');
if (!arg('out')) { console.error('usage: build-pre-update-fixture.mjs --out <dir under $TMPDIR> [--base origin/master]'); process.exit(2); }
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`);
const base = arg('base', 'origin/master');
const home = path.join(out, 'home');
const src = path.join(out, '_master');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(src, { recursive: true });

// ── master's code, by archive (no checkout, no repo mutation) ──
const baseSha = execFileSync('git', ['-C', REPO, 'rev-parse', `${base}^{commit}`], { encoding: 'utf8' }).trim();
const tar = execFileSync('git', ['-C', REPO, 'archive', baseSha, 'src', 'package.json', 'docs/adr'], { maxBuffer: 1 << 28 });
execFileSync('tar', ['-x', '-C', src], { input: tar });
if (fs.readdirSync(path.join(src, 'docs', 'adr')).some((f) => f.startsWith('0012-')) || fs.existsSync(path.join(src, 'src/shared/run-position.ts'))) {
  throw new Error(`base ${baseSha} already carries ADR 0012 / run-position.ts — a pre-update fixture needs master BEFORE this vague`);
}
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(src, 'node_modules'));
if (fs.existsSync(path.join(REPO, 'build', 'bus-abi'))) { fs.mkdirSync(path.join(src, 'build'), { recursive: true }); fs.symlinkSync(path.join(REPO, 'build', 'bus-abi'), path.join(src, 'build', 'bus-abi')); } // per-ABI better-sqlite3 (node_modules may hold the Electron one after a package build)

// ── load master's modules under plain node: extensionless relative imports → .ts ──
const hook = path.join(out, '_resolve-hook.mjs');
fs.writeFileSync(hook, `import fs from 'node:fs'; import {fileURLToPath} from 'node:url';
export async function resolve(s, c, next){ if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z]+$/.test(s)&&c.parentURL?.startsWith('file:')){ const b=new URL(s,c.parentURL); for(const x of ['.ts','/index.ts']){ const u=new URL(b.href+x); if(fs.existsSync(fileURLToPath(u))) return next(u.href,c);} } return next(s,c); }
`);
register(pathToFileURL(hook).href);
process.env.ORCHESTRA_HOME = home; // before any master module reads it
const imp = (rel) => import(pathToFileURL(path.join(src, 'src', rel)).href);
const { initPlatform } = await imp('main/platform/index.ts');
initPlatform({ getUserDataDir: () => path.join(home, 'userData'), getLogsDir: () => path.join(home, 'logs'), getAppVersion: () => '0.0.0-fixture' });
const { store } = await imp('main/store.ts');
const bus = await imp('main/bus.ts');
const runs = await imp('main/bus-runs.ts');
const { nearestOrchestratorId } = await imp('main/wave-run-id.ts');
const { DEFAULT_BUS_SWITCHES, LIVE_SWITCH_DEFAULTS } = await imp('shared/bus-switches.ts');

// ── scratch git repo + worktrees ──
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'f@x' } });
const repo = path.join(out, 'repo');
fs.mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'README.md'), 'pre-update fixture repo\n');
git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'fixture base');

const id = (n) => `${n.toString(16).padStart(8, '0')}-f1f1-4e57-8a00-${n.toString(16).padStart(12, '0')}`;
const SPEC = [ // name, n, parent name, kind, canOrchestrate
  ['P', 1], ['P1', 2, 'P'], ['P2', 3, 'P'], ['S', 4, null, 'scratch'],
  ['L', 5, null, 'orchestrator'], ['O', 6, 'L', undefined, true], ['W1', 7, 'O'], ['W2', 8, 'O'],
  ['Z', 9, 'L', undefined, true], ['Z1', 10, 'Z'], ['Z2', 11, 'Z'],
  ['Ar', 12, null, 'orchestrator'], // an ARCHIVED top-level coordinator whose run is still open: #437's app-start reconcile must close it
];
const ids = Object.fromEntries(SPEC.map(([name, n]) => [name, id(n)]));
await store.load();
await store.addRepo({ path: repo, name: 'fixture', defaultBranch: 'main' });
const t0 = Date.now() - 3600_000;
for (const [name, n, parent, kind, canOrch] of SPEC) {
  const wid = ids[name];
  let worktreePath, branch = `fixture-${name.toLowerCase()}`;
  if (kind === 'scratch') { worktreePath = path.join(home, 'scratch', wid.slice(0, 8)); fs.mkdirSync(worktreePath, { recursive: true }); }
  else { worktreePath = path.join(home, 'worktrees', `fixture-${name.toLowerCase()}-${wid.slice(0, 8)}`); git(repo, 'worktree', 'add', '-q', '-b', branch, worktreePath, 'main'); }
  await store.upsertWorkspace({
    id: wid, name: `fixture · ${name}`, repoPath: repo, worktreePath, branch, baseBranch: 'main',
    createdAt: t0 + n * 1000, status: 'idle', agent: 'claude', branchManuallySet: false,
    port: store.allocatePort(), setupStatus: 'ok', model: 'sonnet', sdkEffort: 'high',
    lastTurnStartAt: t0 + n * 1000, hibernatedAt: Date.now(), archived: name === 'Ar', ...(name === 'Ar' ? { archivedAt: Date.now() } : {}),
    ...(kind ? { kind } : {}), ...(parent ? { parentId: ids[parent] } : {}), ...(canOrch ? { canOrchestrate: true } : {}),
  });
}
await store.setBusSwitches({ delivery: true, wake: true, askGate: true, liveness: true, fencing: true, capability: true, receipts: true, pause: true, dockerRelay: true });
await store.save();

// ── bus: master's schema + its own startRun/send ──
const db = bus.openBus(path.join(home, 'bus.sqlite'));
const ON = { ...LIVE_SWITCH_DEFAULTS, delivery: true, wake: true, askGate: true, liveness: true, fencing: true, capability: true, receipts: true };
// Run membership by MASTER's own rule (wave-run-id.nearestOrchestratorId): only anchors get a row; the run-less stay run-less.
const lookup = (i) => { const w = store.getWorkspace(i); return w && { id: w.id, parentId: w.parentId, kind: w.kind, canOrchestrate: w.canOrchestrate }; };
const runOf = (name) => nearestOrchestratorId(lookup(ids[name]), lookup);
runs.startRun(db, { id: ids.L, kind: 'mission', coordinator: ids.L }, ON);
runs.startRun(db, { id: ids.O, kind: 'vague', coordinator: ids.O, parentRunId: ids.L }, ON);
runs.startRun(db, { id: ids.Ar, kind: 'mission', coordinator: ids.Ar }, ON);
runs.startRun(db, { id: ids.Z, kind: 'vague', coordinator: ids.Z, parentRunId: ids.L }, DEFAULT_BUS_SWITCHES); // delivery OFF: every flag false, as live
const say = (run, sender, recipient, kind, body) => bus.send(db, { runId: run, sender, recipient, kind, body });
// fleet arm (delivery ON): mail the unchanged-fleet arm must keep delivering
say(ids.O, ids.O, ids.W1, 'status', 'fixture: fleet task for W1');
say(ids.O, ids.W1, ids.O, 'status', 'fixture: W1 progress');
say(ids.L, ids.L, ids.O, 'status', 'fixture: L → O');
// delivery-OFF arm: unread mail addressed to members, no deliveries/cursors rows (what the old channel left behind)
for (const m of ['Z1', 'Z2']) say(ids.Z, ids.Z, ids[m], 'status', `fixture: unread for ${m}`);
say(ids.Z, ids.Z1, ids.Z, 'status', 'fixture: Z1 report');
say(ids.Z, 'humain', ids.Z, 'status', 'fixture: from the human');
say(ids.Z, 'host', ids.Z, 'status', 'fixture: host notice');
// the `default` run sentinel: rows with an 8-char short recipient (live shape, bus-status "SHORT/invalid recipient")
say('default', ids.Z1, ids.L.slice(0, 8), 'status', 'fixture: default-run row 1');
say('default', ids.Z1, ids.L.slice(0, 8), 'status', 'fixture: default-run row 2');
db.close();

const census = censusHome(home, { betterSqlite: loadSqlite() });
const manifest = {
  baseRef: base, baseSha, out, home, ids,
  expectBefore: { // what the PRE-update shape must show; the rig's "before" arm asserts it
    runlessOwn: ['fixture · P', 'fixture · P1', 'fixture · P2', 'fixture · S', 'fixture · W1', 'fixture · W2', 'fixture · Z1', 'fixture · Z2'],
    runlessIn: ['fixture · P', 'fixture · P1', 'fixture · P2', 'fixture · S'],
    deliveryOffRuns: [ids.Z], runs: 4,
  },
  runMembership: Object.fromEntries(SPEC.map(([name]) => [name, runOf(name)])),
  census,
};
fs.writeFileSync(path.join(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
const sortEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const ok = sortEq(census.runlessOwn, manifest.expectBefore.runlessOwn) && sortEq(census.runlessIn, manifest.expectBefore.runlessIn)
  && sortEq(census.deliveryOffRuns, [ids.Z]) && census.runs === 4;
console.log(JSON.stringify({ out, home, baseSha, workspaces: census.workspaces, runs: census.runs, runlessOwn: census.runlessOwn.length, runlessIn: census.runlessIn.length, deliveryOffRuns: census.deliveryOffRuns.length, unread: census.unreadByRun }));
console.log(ok ? 'FIXTURE_OK (shape matches expectBefore)' : 'FIXTURE_MISMATCH');
process.exit(ok ? 0 : 1);

#!/usr/bin/env node
// #440 rig — `orchestra promote` / `demote` are gone; a role follows POSITION. Drives the BUILT CLI (dist-electron/cli.js) against the REAL
// hooks socket server, the REAL workspace store (loaded off a LEGACY store.json written with `canOrchestrate: true`) and the REAL generated
// hook/skill files — all under a scratch ORCHESTRA_HOME. Never the live bus / store / ~/.claude*.   Run: pnpm run test:roles-position
// ARMS (each is killed by a mutant in scripts/roles-position-mutants.mjs):
//   S1  a store written WITH the flag loads: the flagged record owns a run (ownsRun), the key is gone in memory AND on disk after the save
//   S2  `orchestra whoami` by position — LEAD (no parent) / OPS (parent + owns a run) / worker (parent, no run): role, run, member-of
//   S3  `orchestra promote <id>` and `orchestra demote <id>`: rc≠0, text names whoami + spawn, store.json + bus UNTOUCHED
//   S4  the socket route `/promote` is gone (not `ok:true`) and changes nothing
//   S6  (#440-fu) the standing-role sentinel follows ownership: an older store's plain parent gets the file at app start; attach of a childless link-only owner CLEARS it (an owner with children keeps it)
//   S5  the generated skills + hook scripts (the REAL installOrchestraHooks output) carry NO promote / demote step
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { build } = (() => {
  try { return require_('esbuild'); } catch {
    const g = fs.globSync?.(repoRoot + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
    if (g.length) return require_(g[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
})();

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ── scratch home (the scratch guard: nothing is ever written outside $TMPDIR) ──
const scratchBase = fs.realpathSync(process.env.TMPDIR || os.tmpdir());
const tmp = fs.mkdtempSync(path.join(scratchBase, 'roles-position-440-'));
for (const live of ['.claude', '.claude-mc', '.orchestra', '.config']) {
  if ((tmp + path.sep).startsWith(path.join(os.homedir(), live) + path.sep)) throw new Error(`refusing a scratch dir under live ~/${live}`);
}
process.env.ORCHESTRA_HOME = tmp;
process.env.HOME = tmp;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ── the REAL host modules, bundled with an electron stub (workspaces.ts cannot load under node --test) ──
const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const bundle = path.join(cacheDir, 'roles-position-440.mjs');
const electronStub = path.join(cacheDir, 'roles-position-440-electron-stub.mjs');
const entry = path.join(tmp, 'entry.ts');
const rel = (p) => JSON.stringify(path.join(repoRoot, p));
fs.writeFileSync(entry, `
export { installOrchestraHooks, startRunsForOwnerWorkspaces } from ${rel('src/main/workspaces.ts')};
export { store } from ${rel('src/main/store.ts')};
export { initPlatform } from ${rel('src/main/platform/index.ts')};
export { initBus, getBus } from ${rel('src/main/bus.ts')};
export { startHooksServer, stopHooksServer, getHookSocketPath } from ${rel('src/main/hooks-server.ts')};
`);
fs.writeFileSync(electronStub, `
const noop = () => {};
class Stub { static getAllWindows() { return []; } constructor() {} on() {} }
export const app = { getPath: () => ${JSON.stringify(tmp)}, getVersion: () => '0.0.0-rig', getName: () => 'orchestra', on: noop, whenReady: () => Promise.resolve(), setPath: noop, quit: noop };
export const ipcMain = { handle: noop, on: noop, removeHandler: noop };
export const ipcRenderer = { invoke: noop, on: noop };
export const BrowserWindow = Stub; export const WebContentsView = Stub; export const BrowserView = Stub;
export const shell = { openExternal: noop, showItemInFolder: noop };
export const dialog = { showOpenDialog: noop, showMessageBox: noop };
export const Menu = { setApplicationMenu: noop, buildFromTemplate: () => ({}) };
export const MenuItem = Stub;
export const nativeTheme = { on: noop, shouldUseDarkColors: false };
export const nativeImage = { createFromPath: () => ({}) };
export const clipboard = { writeText: noop, readText: () => '' };
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }), on: noop };
export const session = { defaultSession: { webRequest: { onBeforeSendHeaders: noop } }, fromPartition: () => ({}) };
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: noop, decryptString: noop };
export const globalShortcut = { register: noop, unregisterAll: noop };
export const powerMonitor = { on: noop };
export const Notification = Stub;
export const protocol = { handle: noop, registerSchemesAsPrivileged: noop };
export const net = { fetch: () => Promise.reject(new Error('stub')) };
export const contextBridge = { exposeInMainWorld: noop };
export default { app, ipcMain, BrowserWindow, WebContentsView, shell, dialog, Menu, screen, session };
`);
await build({
  entryPoints: [entry], outfile: bundle, bundle: true, format: 'esm', platform: 'node',
  external: ['better-sqlite3', 'node-pty', 'node:*', 'simple-git', 'ws', '@anthropic-ai/*'],
  alias: { electron: electronStub }, logLevel: 'silent',
});
const mod = await import(`${bundle}?t=${Date.now()}`);
mod.initPlatform({ kind: 'rig', broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => false, isFocused: () => false, getUserDataDir: () => tmp });
const storeFile = path.join(tmp, 'orchestra', 'store.json');
fs.mkdirSync(path.dirname(storeFile), { recursive: true });

// ── the cast, written the way an OLDER build wrote them: the OPS carries the retired `canOrchestrate` flag ──
const LEAD = 'a4400000-0000-4000-8000-000000000001';
const OPS = 'a4400000-0000-4000-8000-000000000002';
const WORKER = 'a4400000-0000-4000-8000-000000000003';
const PLAIN = 'a4400000-0000-4000-8000-000000000004'; // top-level plain workspace that never spawned
const FLAGGED = 'a4400000-0000-4000-8000-000000000005'; // childless OPS written with the retired flag: ONLY the flag can make it own a run
const OLDPARENT = 'a4400000-0000-4000-8000-000000000006'; // pre-#434 plain parent: has a child, no ownsRun, no sentinel file
const OLDKID = 'a4400000-0000-4000-8000-000000000007';
const LINKONLY = 'a4400000-0000-4000-8000-000000000008'; // top-level owner, childless, sentinel present (it once spawned)
const KEEPER = 'a4400000-0000-4000-8000-000000000009'; // top-level owner WITH a child, sentinel present
const KEEPKID = 'a4400000-0000-4000-8000-00000000000a';
const LONELY = 'a4400000-0000-4000-8000-00000000000b'; // top-level, ownsRun, childless, NO file: the sync must not write one (an owner with no child yet)
const wt = (id) => { const d = path.join(tmp, id); fs.mkdirSync(path.join(d, '.orchestra'), { recursive: true }); return d; };
const rec = (id, over = {}) => ({ id, name: `ws-${id.slice(-1)}`, branch: `b-${id.slice(-1)}`, kind: 'worktree', worktreePath: wt(id), repoPath: path.join(tmp, 'repo'), baseBranch: 'main', status: 'idle', createdAt: 1, agent: 'claude', ...over });
fs.writeFileSync(storeFile, JSON.stringify({
  workspaces: [
    rec(LEAD, { kind: 'orchestrator', repoPath: '', baseBranch: '' }),
    rec(OPS, { parentId: LEAD, canOrchestrate: true }),
    rec(WORKER, { parentId: OPS }),
    rec(PLAIN),
    rec(FLAGGED, { parentId: LEAD, canOrchestrate: true }),
    rec(OLDPARENT), rec(OLDKID, { parentId: OLDPARENT }),
    rec(LINKONLY, { ownsRun: true }),
    rec(KEEPER, { ownsRun: true }), rec(KEEPKID, { parentId: KEEPER }), rec(LONELY, { ownsRun: true }),
  ],
}));

console.log('\nS1 — a store written WITH the retired flag loads:');
let loadError = null;
try { await mod.store.load(); } catch (e) { loadError = e; }
check('store.load() did not throw on a record carrying canOrchestrate:true', !loadError, String(loadError));
check('the flagged OPS records ownership (ownsRun) — the migration', mod.store.getWorkspace(OPS)?.ownsRun === true);
check('the flag is not kept in memory', !('canOrchestrate' in (mod.store.getWorkspace(OPS) ?? {})));
check('the unflagged worker owns nothing', mod.store.getWorkspace(WORKER)?.ownsRun !== true);
check('a CHILDLESS flagged record owns a run too (only the flag can have caused it)', mod.store.getWorkspace(FLAGGED)?.ownsRun === true);
await mod.store.save();
const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8')).workspaces;
check('the flag is gone from store.json after the save', !JSON.stringify(onDisk).includes('canOrchestrate'), JSON.stringify(onDisk.map((w) => Object.keys(w).filter((k) => /canOrch/.test(k)))));
check('the OPS record on disk says ownsRun:true', onDisk.find((w) => w.id === OPS)?.ownsRun === true);

// ── the REAL hooks socket + the BUILT CLI ──
const schema = mod.initBus();
check('the scratch bus opened', schema >= 2, `schema v${schema}`);
await mod.startHooksServer();
const sock = mod.getHookSocketPath();
check('the hooks socket is up', !!sock && fs.existsSync(sock), String(sock));
execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.cli.config.ts'], { cwd: repoRoot, stdio: 'ignore' });
const CLI = path.join(repoRoot, 'dist-electron', 'cli.js');
// ASYNC spawn on purpose: the hooks server lives in THIS process — a spawnSync would block the event loop and deadlock the CLI's socket call.
const cli = (ws, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], {
    env: { PATH: process.env.PATH, HOME: tmp, ORCHESTRA_HOME: tmp, ORCHESTRA_SOCK: sock, ORCHESTRA_WS_ID: ws, ORCHESTRA_WORKTREE: path.join(tmp, ws) },
    cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
  const t = setTimeout(() => p.kill('SIGKILL'), 60000);
  p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
});
const row = (out, key) => new RegExp(`^${key} {2,}(.*)$`, 'm').exec(out)?.[1];

console.log('\nS2 — `orchestra whoami` prints the role BY POSITION and the run:');
const [wl, wo, ww, wp, wf] = await Promise.all([LEAD, OPS, WORKER, PLAIN, FLAGGED].map((w) => cli(w, ['whoami'])));
check('whoami rc 0 for all four', [wl, wo, ww, wp].every((r) => r.code === 0), JSON.stringify([wl, wo, ww, wp].map((r) => [r.code, r.err.slice(0, 80)])));
check('LEAD (no parent, the orchestrator kind): role LEAD, owns its own run', row(wl.out, 'role') === 'LEAD' && row(wl.out, 'run') === `${LEAD} (owns it)` && row(wl.out, 'member of') === undefined, wl.out);
check('OPS (a parent + owns a run): role OPS, owns its run, a member of the LEAD\'s', row(wo.out, 'role') === 'OPS' && row(wo.out, 'run') === `${OPS} (owns it)` && row(wo.out, 'member of') === LEAD, wo.out);
check('worker (a parent, owns no run): role worker, its run is the OPS\'s', row(ww.out, 'role') === 'worker' && row(ww.out, 'run') === `${OPS} (member: owned by its parent)` && row(ww.out, 'member of') === undefined, ww.out);
check('a top-level plain workspace is a LEAD too (position, not kind)', row(wp.out, 'role') === 'LEAD' && row(wp.out, 'run') === `${PLAIN} (owns it)`, wp.out);
check('a childless record written with the retired flag is an OPS (the migration, seen by the agent)', row(wf.out, 'role') === 'OPS' && row(wf.out, 'member of') === LEAD, wf.out);
check('no `orchestrator` yes/no row and the `parent` row the field guide reads is kept', row(wl.out, 'orchestrator') === undefined && row(wo.out, 'parent') === LEAD && row(wl.out, 'parent')?.startsWith('none'), wo.out);

console.log('\nS3 — `orchestra promote` / `demote` refuse and touch nothing:');
const storeBefore = sha(storeFile);
const busFile = path.join(tmp, 'bus.sqlite');
const busStat = () => (fs.existsSync(busFile) ? fs.statSync(busFile).mtimeMs : 0) + ':' + [LEAD, OPS, WORKER, PLAIN, FLAGGED].map((i) => mod.getBus().prepare('SELECT count(*) c FROM runs WHERE id = ?').get(i).c).join('');
const busBefore = busStat();
for (const verb of ['promote', 'demote']) {
  for (const target of [PLAIN, WORKER, OPS]) {
    const r = await cli(WORKER, [verb, target]);
    const text = r.err + r.out;
    check(`${verb} ${target.slice(-1)}: rc≠0 and the text says roles follow position, naming whoami + spawn`, r.code !== 0 && /follows its position in the tree/.test(text) && /orchestra whoami/.test(text) && /orchestra spawn/.test(text), JSON.stringify(r).slice(0, 240));
    check(`${verb} ${target.slice(-1)}: no success line`, !/Promoted|Demoted/.test(text));
  }
}
check('store.json is byte-identical after the six refusals', sha(storeFile) === storeBefore);
const afterWho = await cli(PLAIN, ['whoami']);
check('PLAIN is still LEAD and WORKER still a worker (nothing was promoted)', row(afterWho.out, 'role') === 'LEAD' && row((await cli(WORKER, ['whoami'])).out, 'role') === 'worker');
check('the bus holds the same run rows (nothing started)', busStat() === busBefore, `${busBefore} → ${busStat()}`);
check('`orchestra promote --help` says it is removed', /removed/i.test((await cli(WORKER, ['promote', '--help'])).out));

console.log('\nS4 — the `/promote` socket route is gone:');
const post = (route, body) => new Promise((resolve) => {
  const req = http.request({ socketPath: sock, path: route, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.on('error', (e) => resolve({ status: 0, body: String(e) }));
  req.end(JSON.stringify(body));
});
const pr = await post('/promote', { id: PLAIN });
const parsed = (() => { try { return JSON.parse(pr.body); } catch { return {}; } })();
const unk = await post('/no-such-route-440', { id: PLAIN });
check('POST /promote is not an ok:true answer', parsed.ok !== true, `${pr.status} ${pr.body.slice(0, 120)}`);
check('POST /promote answers exactly what an unknown route answers (no handler left)', pr.body === unk.body && pr.body === '{}', `${pr.body} vs ${unk.body}`);
check('control: POST /whoami on the same socket IS ok:true (the instrument can say yes)', JSON.parse((await post('/whoami', { id: PLAIN })).body).ok === true);
check('store.json still byte-identical, PLAIN still owns nothing recorded', sha(storeFile) === storeBefore && mod.store.getWorkspace(PLAIN)?.ownsRun !== true);

console.log('\nS5 — the REAL generated skills + hook scripts carry no promote / demote step:');
const genWt = path.join(tmp, 'generated-worktree');
fs.mkdirSync(genWt, { recursive: true });
await mod.installOrchestraHooks(genWt);
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
walk(genWt);
const skills = files.filter((f) => /\.claude\/skills\/orchestra-[^/]+\/SKILL\.md$/.test(f));
check('control: the generator wrote the skills (comms, spawn, workspace-admin) and hook scripts', ['orchestra-comms', 'orchestra-spawn', 'orchestra-workspace-admin'].every((n) => skills.some((f) => f.includes(`/${n}/`))) && files.some((f) => /\.orchestra\/.*\.sh$/.test(f)), files.length + ' files');
const offenders = files.filter((f) => /promot|demot/i.test(fs.readFileSync(f, 'utf8')));
check('no generated file mentions promote / demote', offenders.length === 0, offenders.map((f) => path.relative(genWt, f)).join(', '));
check('the standing-role reminder script is present and has no promote step', files.some((f) => /orchestrator-instruction|orchestrator.*\.sh$/.test(f)) && offenders.length === 0);

console.log('\nS6 — the standing-role sentinel follows ownership (#440-fu):');
const sentinel = (id) => path.join(tmp, id, '.orchestra', '.orchestrator');
for (const id of [LINKONLY, KEEPER]) fs.writeFileSync(sentinel(id), '1'); // what the first spawn wrote
check('control: OLDPARENT has children, owns a run after the load migration, and has NO sentinel file yet', mod.store.getWorkspace(OLDPARENT)?.ownsRun === true && !fs.existsSync(sentinel(OLDPARENT)));
check('control: a worker and a childless non-owner have no sentinel (the sync must not spray the file)', !fs.existsSync(sentinel(WORKER)) && !fs.existsSync(sentinel(PLAIN)));
await mod.startRunsForOwnerWorkspaces();
check('the app-start sync WRITES the file for the older store\'s plain parent (dual wording: it has a repo)', fs.existsSync(sentinel(OLDPARENT)) && fs.readFileSync(sentinel(OLDPARENT), 'utf8') === 'dual');
check('…and only for it: no file appeared for a worker, a top-level non-owner or a childless owner', !fs.existsSync(sentinel(WORKER)) && !fs.existsSync(sentinel(PLAIN)) && !fs.existsSync(sentinel(OLDKID)) && !fs.existsSync(sentinel(LONELY)));
const at1 = await cli(LINKONLY, ['attach', LINKONLY, LEAD]);
check('attach of the childless link-only owner under the LEAD succeeds', at1.code === 0, JSON.stringify(at1).slice(0, 240));
check('…it is a worker by whoami and its sentinel is CLEARED (no stale "you are an ORCHESTRATOR" reminder)', row((await cli(LINKONLY, ['whoami'])).out, 'role') === 'worker' && !fs.existsSync(sentinel(LINKONLY)), `exists=${fs.existsSync(sentinel(LINKONLY))}`);
const at2 = await cli(KEEPER, ['attach', KEEPER, LEAD]);
check('attach of an owner WITH a child keeps its ownership and its sentinel (control: the clear is not unconditional)', at2.code === 0 && row((await cli(KEEPER, ['whoami'])).out, 'role') === 'OPS' && fs.existsSync(sentinel(KEEPER)), JSON.stringify(at2).slice(0, 200));

await mod.stopHooksServer();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nROLES-POSITION RIG: ALL ARMS PASS' : `\nROLES-POSITION RIG: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

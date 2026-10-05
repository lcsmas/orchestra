// #257 — the production WIRING of the Pause UI data layer, pinned structurally (pause-ui-host.ts / index.ts / preload import Electron, so they cannot run under `node --test`;
// the behaviour is proven by pause-ui.test.ts over a real bus and by the built-app drive scripts/pause-ui/). Each assertion is a relationship over comment-stripped source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = raw.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
  assert.ok(code.length > 500, `comment-stripping ${rel} returned too little`);
  return code;
}
const at = (code: string, needle: string): number => {
  const i = code.indexOf(needle);
  assert.notEqual(i, -1, `not found: ${needle}`);
  return i;
};

test('NO SECOND WRITE PATH: pause-ui.ts and pause-ui-host.ts contain no SQL write — every bus write is a shipped writer', () => {
  for (const f of ['src/main/pause-ui.ts', 'src/main/pause-ui-host.ts']) {
    const code = codeOf(f);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|REPLACE)\b\s+(INTO|OR|FROM)?/.test(code.replace(/SELECT[\s\S]*?`/g, '')), `${f}: a SQL write`);
    assert.ok(!/\.run\(/.test(code), `${f}: a prepared-statement write`);
  }
  const ui = codeOf('src/main/pause-ui.ts');
  for (const w of ['setRunPause(db, t.runId, true, actor, req.mode)', "beginReprise(db, t.runId, actor, { reason: 'manual' })", 'releaseMembers(db, carrier, actor, req.targets)']) assert.ok(ui.includes(w), `the shipped writer call: ${w}`);
});

test('the Pause channels are enumerated with their read/write marks, and ONLY the overview is a read', () => {
  const host = codeOf('src/main/pause-ui-host.ts');
  const enumerated = [...host.matchAll(/\{ channel: '(pause:[a-zA-Z]+)', writes: (true|false)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(enumerated, [['pause:overview', 'false'], ['pause:pause', 'true'], ['pause:resume', 'true'], ['pause:release', 'true']]);
  const handled = [...host.matchAll(/ipcMain\.handle\('(pause:[a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(handled, enumerated.map((e) => e[0]), 'every enumerated channel has exactly one handler, none unlisted');
});

test('the Pause writes are NOT registered through the read-only bus pane registrar', () => {
  const pane = codeOf('src/main/bus-pane.ts');
  assert.ok(!pane.includes("'pause:"), 'bus-pane.ts knows no pause channel');
  const api = codeOf('src/main/api-handlers.ts');
  for (const m of ['pauseOverview', 'pausePause', 'pauseResume', 'pauseRelease']) assert.ok(api.includes(`| '${m}'`), `${m} is excluded from the generic served table`);
});

test('preload maps every OrchestraAPI Pause member to its channel and the push channel matches the host', () => {
  const pre = codeOf('src/preload/index.ts');
  for (const [m, ch] of [['pauseOverview', 'pause:overview'], ['pausePause', 'pause:pause'], ['pauseResume', 'pause:resume'], ['pauseRelease', 'pause:release']]) {
    assert.ok(pre.includes(`ipcRenderer.invoke('${ch}'`), `${m} → ${ch}`);
  }
  const host = codeOf('src/main/pause-ui-host.ts');
  assert.ok(host.includes("PAUSE_UI_PUSH_CHANNEL = 'pause:update'") && pre.includes("ipcRenderer.on('pause:update'"), 'push channel in lockstep');
  const ipc = codeOf('src/shared/ipc.ts');
  for (const m of ['pauseOverview', 'onPauseOverviewUpdate', 'pausePause', 'pauseResume', 'pauseRelease']) assert.ok(ipc.includes(`${m}:`), `OrchestraAPI.${m}`);
});

test('index.ts registers the channels at MODULE scope (a second registration throws on darwin), starts the watcher + boot publish after the bus opens and stops it at quit', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
  assert.ok(/^registerPauseUiIpc\(\);$/m.test(raw), 'registerPauseUiIpc() sits at column 0 — module scope, never inside createMainWindow');
  const idx = codeOf('src/main/index.ts');
  assert.ok(at(idx, 'startPauseUiWatcher();') > at(idx, 'initBus();'), 'the watcher starts after the bus open attempt');
  assert.ok(at(idx, 'reconcilePauseUi();') > at(idx, 'startPauseUiWatcher();'), 'the boot publish follows the watcher');
  assert.ok(idx.includes('stopPauseUiWatcher();'), 'stopped at quit');
});

test('every write re-publishes (forced) and the push is skipped while neither the bus fingerprint nor the live tree moved', () => {
  const host = codeOf('src/main/pause-ui-host.ts');
  for (const c of ['pause:pause', 'pause:resume', 'pause:release']) {
    const start = at(host, `ipcMain.handle('${c}'`);
    const next = host.indexOf('ipcMain.handle(', start + 10);
    const body = host.slice(start, next === -1 ? start + 1500 : next); // THIS handler only (the next one carries the same call)
    assert.ok(body.includes('broadcastPauseOverview(true)') && body.includes('invalidatePauseOverviewBroadcast()'), `${c} forces a publish`);
  }
  const fn = host.slice(at(host, 'export function broadcastPauseOverview('));
  assert.ok(fn.slice(0, 700).includes('if (!force && key === lastKey) return null;'), 'unchanged fingerprint = no rebuild');
});

test('SIDEBAR: both row render paths (the pinned spawn trees AND the repo sections) carry every Pause part; the menu host is mounted once', () => {
  const sb = codeOf('src/renderer/components/Sidebar.tsx');
  const count = (needle: string) => sb.split(needle).length - 1;
  for (const part of ['<PauseAwareGlyph wsId={w.id}>', '<PauseRowBadge wsId={w.id} />', '<PauseRowNote wsId={w.id}>', '<PauseRowBar wsId={w.id} />', '<PauseRowActions wsId={w.id} rect={{ top: r.top, bottom: r.bottom, right: r.right }} />', "pauseStateOf(pauseOverview, w.id) ? ' pause-dim' : ''"]) {
    assert.equal(count(part), 2, `${part} — once per render path (they must change together or the two kinds of orchestrator drift apart)`);
  }
  assert.equal(count('<PauseMenuHost />'), 1, 'one floating panel host');
  assert.ok(sb.includes('const pauseOverview = useStore((s) => s.pauseOverview);'), 'the row class reads the store slice');
});

test('BUS PAGE: the section is injected from App.tsx (BusPane.tsx stays store-free — the render smokes import it), and sits right after the live-switch summary', () => {
  const app = codeOf('src/renderer/App.tsx');
  assert.ok(app.includes("<BusPane pauseSlot={<BusPauseSection />} />"), 'App passes the section');
  const pane = codeOf('src/renderer/components/BusPane.tsx');
  assert.ok(!/from '\.\.\/store'|from '\.\/pause\//.test(pane), 'BusPane.tsx imports neither the store nor the pause components');
  assert.ok(at(pane, '<BusSwitchSummary live={snapshot.liveSwitches} />') < at(pane, '{pauseSlot}') && at(pane, '{pauseSlot}') < at(pane, 'data-section="runs"'), 'order: switches, Pause, runs');
});

test('RENDERER: the overview slice is filled at load and replaced WHOLESALE by the push; the actions take the reply\'s overview', () => {
  const st = codeOf('src/renderer/store.ts');
  assert.ok(st.includes("window.orchestra.pauseOverview()"), 'initial paint');
  assert.ok(/window\.orchestra\.onPauseOverviewUpdate\(\(overview\) => \{\s*useStore\.setState\(\{ pauseOverview: overview \}\);/.test(st), 'wholesale replace on push');
  for (const a of ['pausePause', 'pauseResume', 'pauseRelease']) assert.ok(new RegExp(`${a}: async \\([^)]*\\) => \\{[^}]*set\\(\\{ pauseOverview: res\\.overview \\}\\)`).test(st), `${a} stores the reply's overview`);
  const css = codeOf('src/renderer/main.tsx');
  assert.ok(css.includes("import './pause-ui.css';"), 'the sheet is imported');
});

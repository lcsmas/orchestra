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
  // drop ONLY the string literals that are SELECT queries (up to THEIR own closing quote — a non-greedy "from the first SELECT to the next backtick" would swallow the code after it)
  const stripSelects = (code: string): string => code.replace(/(['"`])\s*SELECT\b[^]*?\1/g, '""');
  for (const f of ['src/main/pause-ui.ts', 'src/main/pause-ui-host.ts']) {
    const code = stripSelects(codeOf(f));
    assert.ok(!/\b(INSERT|UPDATE|DELETE|REPLACE)\b\s+(INTO|OR|FROM)?|\bUPDATE\s+\w/.test(code), `${f}: a SQL write`);
    assert.ok(!/\.run\(|\.exec\(/.test(code), `${f}: a prepared-statement / exec write`);
  }
  // self-test of the guard: a write placed AFTER a SELECT literal (the case the previous regex could not see) is caught
  const planted = stripSelects('const a = db.prepare(`SELECT 1 FROM runs`).get();\n db.exec("UPDATE runs SET paused_at = NULL");');
  assert.ok(/\bUPDATE\s+\w/.test(planted) && /\.exec\(/.test(planted), 'the guard sees a write that follows a SELECT');
  const ui = codeOf('src/main/pause-ui.ts');
  for (const w of [
    'setRunPause(db, t.runId, true, actor, req.mode, { human: true })',
    "beginReprise(db, t.runId, actor, { reason: 'manual', human: true })",
    'setRunHold(db, t.runId, false, actor, { human: true })',
    'releaseMembers(db, carrier ?? t.runId, actor, req.targets, Date.now(), { human: true, ownRuns: [t.runId] })',
    'recordPauseOrigin(db, t.runId, made.pausedAt, [])',
  ]) assert.ok(ui.includes(w), `the shipped writer call: ${w}`);
  assert.equal((ui.match(/const actor = PAUSE_HUMAN_BY;/g) ?? []).length, 3, 'the actor of every UI write is the HUMAN (PAUSE_HUMAN_BY), never a workspace row (D-pick Q1)');
  assert.ok(!ui.includes('uiActor'), 'no per-row actor decision is left');
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
    assert.ok(body.includes('return afterWrite(res)'), `${c} answers through afterWrite (the forced publish)`);
  }
  const aw = host.slice(at(host, 'function afterWrite'), at(host, 'export function registerPauseUiIpc'));
  assert.ok(aw.includes('broadcastPauseOverview(true)') && aw.includes('invalidatePauseOverviewBroadcast()'), 'afterWrite forces a publish');
  const fn = host.slice(at(host, 'export function broadcastPauseOverview('));
  assert.ok(fn.slice(0, 700).includes('if (!force && key === lastKey) return null;'), 'unchanged fingerprint = no rebuild');
});

test('SIDEBAR: both row render paths (the pinned spawn trees AND the repo sections) carry every Pause part; the menu host is mounted once', () => {
  const sb = codeOf('src/renderer/components/Sidebar.tsx');
  const count = (needle: string) => sb.split(needle).length - 1;
  for (const part of ['<PauseAwareGlyph wsId={w.id}>', '<PauseRowBadge wsId={w.id} />', '<PauseRowNote wsId={w.id}>', '<PauseRowBar wsId={w.id} />', '<PauseRowActions wsId={w.id} rect={{ top: r.top, bottom: r.bottom, right: r.right }} />', '${pauseDimClass(pauseOverview, w.id)}']) {
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
  assert.ok(/window\.orchestra\.onPauseOverviewUpdate\(\(overview\) => \{\s*useStore\.setState\(\(st\) => \(\{ pauseOverview: newerOverview\(st\.pauseOverview, overview\) \}\)\);/.test(st), 'replace on push (unless older)');
  for (const a of ['pausePause', 'pauseResume', 'pauseRelease']) assert.ok(new RegExp(`${a}: async \\([^)]*\\) => \\{[^}]*set\\(\\(st\\) => \\(\\{ pauseOverview: newerOverview\\(st\\.pauseOverview, res\\.overview\\) \\}\\)\\)`).test(st), `${a} stores the reply's overview`);
  const css = codeOf('src/renderer/main.tsx');
  assert.ok(css.includes("import './pause-ui.css';"), 'the sheet is imported');
});

test('the floating panel: Escape closes the PANEL only (capture phase, swallowed — other Escape handlers must not also fire), outside click closes it', () => {
  const m = codeOf('src/renderer/components/pause/PauseMenu.tsx');
  assert.ok(m.includes("window.addEventListener('keydown', onKey, true);") && m.includes('e.stopImmediatePropagation();'), 'capture + stopImmediatePropagation');
  assert.ok(m.includes("window.addEventListener('mousedown', onDown, true);") && m.includes("closest('[data-pause-panel]')"), 'outside mousedown closes');
  assert.ok(m.includes("window.removeEventListener('keydown', onKey, true);") && m.includes("window.removeEventListener('mousedown', onDown, true);"), 'both listeners removed on close/unmount');
});

test('the bus-directory watch feeds the push through the max-wait coalescer (a plain trailing debounce starved under sustained writes — R1-5)', () => {
  const host = codeOf('src/main/pause-ui-host.ts');
  assert.ok(host.includes('createCoalescer('), 'the coalescer is built');
  assert.ok(/WATCH_MAX_WAIT_MS = 1000/.test(host) && host.includes('maxWaitMs: WATCH_MAX_WAIT_MS'), 'with a 1 s max-wait');
  const watch = host.slice(at(host, "name: 'pause-ui'"));
  assert.ok(watch.slice(0, 700).includes('onChange: () => coalescer.poke()'), 'every bus write pokes it');
  assert.ok(!watch.slice(0, 700).includes('setTimeout('), 'no second, private debounce in the watch callback');
  assert.ok(watch.slice(0, 700).includes('onRecover: reconcilePauseUi'), '#330: one forced overview push on recovery');
  assert.ok(!host.includes('fs.watch('), '#330: no hand-rolled directory watch — the shared resilient watcher');
  assert.ok(host.includes('coalescer.cancel();'), 'cancelled at quit');
});

test('a write reply can never be OLDER than the push it triggered: every overview is host-stamped with a monotonic rev, the write handlers answer with the PUSHED one, the store drops older ones (R1b-2)', () => {
  const host = codeOf('src/main/pause-ui-host.ts');
  assert.ok(host.includes('rev: ++overviewRev'), 'the rev is a strictly increasing counter');
  assert.ok(host.includes("ipcMain.handle('pause:overview', (): PauseUiOverview => stamped("), 'the boot read is stamped too');
  assert.ok(host.includes('platform.broadcast(PAUSE_UI_PUSH_CHANNEL, overview)') && host.includes('const overview = stamped(built);'), 'the push carries a stamped overview');
  const after = host.slice(at(host, 'function afterWrite'), at(host, 'export function registerPauseUiIpc'));
  assert.ok(after.includes('broadcastPauseOverview(true)') && after.includes('overview: pushed'), 'afterWrite answers with the overview it just pushed');
  const reg = host.slice(at(host, 'export function registerPauseUiIpc'), at(host, 'let watcher'));
  assert.equal((reg.match(/return afterWrite\(res\)/g) ?? []).length, 3, 'pause, resume and release all go through afterWrite');
  assert.ok(!/return res;/.test(reg), 'no write handler answers with the pre-push overview');
  assert.ok(!reg.includes("'soft' : 'hard'"), 'an unknown mode is not defaulted to the destructive one');
  const st = codeOf('src/renderer/store.ts');
  assert.equal((st.match(/newerOverview\(/g) ?? []).length, 5, 'the three write replies, the push subscription and the boot read all go through newerOverview');
  assert.ok(!/set\(\{ pauseOverview: res\.overview \}\)/.test(st) && !/setState\(\{ pauseOverview: overview \}\)/.test(st), 'no site replaces the slice unconditionally');
  assert.ok(st.includes('pauseOverview: pauseOverview ? newerOverview(get().pauseOverview, pauseOverview) : pauseOverview'), 'the boot read keeps a push that landed while it was in flight');
});

test('the coalescer runs on a MONOTONIC clock (a wall-clock step must not push the max-wait deadline out)', () => {
  const host = codeOf('src/main/pause-ui-host.ts');
  const c = host.slice(at(host, 'const coalescer = createCoalescer('), at(host, 'export function startPauseUiWatcher'));
  assert.ok(c.includes('now: () => performance.now()') && !c.includes('Date.now()'), 'performance.now(), not Date.now()');
});

test('an UNREADABLE overview is said out loud: a sidebar strip + the Bus section render it (never an empty "nothing is paused") (R1b-1)', () => {
  const sb = codeOf('src/renderer/components/Sidebar.tsx');
  assert.ok(sb.includes('<PauseUnreadableStrip />'), 'the sidebar mounts the strip');
  const row = codeOf('src/renderer/components/pause/PauseRow.tsx');
  assert.ok(/o && !o\.available \? <PauseUnreadable error=\{o\.error\} \/> : null/.test(row), 'it renders only when available is false');
  const bus = codeOf('src/renderer/components/pause/BusPauseSection.tsx');
  assert.ok(/if \(!o\.available\) return <section[^]*<PauseUnreadable error=\{o\.error\} \/>/.test(bus), 'the Bus section too');
});

test('an explanation that carries « Libérer aussi ces N » is closed when its Reprise epoch changes (a re-pause / a finished Reprise) (R1b)', () => {
  const m = codeOf('src/renderer/components/pause/PauseMenu.tsx');
  assert.ok(m.includes('${id}:${r.phase}@${r.pausedAt}') && m.includes('seen.current.epoch !== epoch') && /seen\.current = null; close\(\);/.test(m), 'the panel compares the carrier run phase@epoch it opened with, and closes on a change');
});

test('« Libérer tout » sends \'all\' (the acting row\'s OWN run) — pinned in the RELEASE gate (`pnpm test`), not only in the render smoke (R2-3)', () => {
  const a = codeOf('src/renderer/components/pause/pause-actions.ts');
  const all = a.slice(at(a, 'export async function runReleaseAll'), at(a, 'export async function runReleaseMany'));
  assert.deepEqual([...all.matchAll(/pauseRelease\(wsId, ([^,]+),/g)].map((m) => m[1]), ["'all'"], "runReleaseAll hands the writer 'all' — never every blocked id in one click");
  assert.ok(all.includes("pauseRelease(wsId, 'all', run.carrierRunId)"), 'with the carrier it acts on');
  const many = a.slice(at(a, 'export async function runReleaseMany'));
  assert.deepEqual([...many.matchAll(/pauseRelease\(wsId, ([^,]+(?:\(\))?),/g)].map((m) => m[1]), ['ids.slice()'], 'the second gesture / a per-member « Libérer » send explicit ids (and only those)');
  assert.ok(codeOf('src/renderer/components/pause/PauseRow.tsx').includes('runReleaseAll(wsId, run, rect)'), 'the sidebar row button is « tout libérer »');
  assert.ok(codeOf('src/renderer/components/pause/BusPauseSection.tsx').includes('runReleaseAll(actor, run, null)'), 'so is the Bus card button');
  assert.ok(codeOf('src/main/pause-ui-host.ts').includes("targets: targets === 'all' ? 'all' :"), "the host forwards 'all' as is (never expands it)");
});

test('an explanation action is routed by KIND: « Libérer aussi » → the explicit release; the orchestrator LINK → navigation only (spec Q5) — in the floating panel AND on the Bus card', () => {
  for (const f of ['src/renderer/components/pause/PauseMenu.tsx', 'src/renderer/components/pause/BusPauseSection.tsx']) {
    const code = codeOf(f);
    assert.ok(/a\.kind === 'release' \? [^]*?runReleaseMany\(a\.wsId, a\.ids, a\.carrierRunId, [^)]*\)[^]*? : gotoWorkspace\(a\.wsId\)/.test(code), `${f}: release → runReleaseMany, anything else → gotoWorkspace`);
  }
  assert.ok(codeOf('src/renderer/components/pause/BusPauseSection.tsx').includes('gotoWorkspace(a.wsId) || setExplains([GONE_ROW])'), 'the Bus card says so when the linked row is gone — never a silent dead link');
  const a = codeOf('src/renderer/components/pause/pause-actions.ts');
  const g = a.slice(at(a, 'export function gotoWorkspace'));
  assert.ok(g.includes('!w.archived') && g.includes('usePausePanel.getState().close();') && g.includes('st.setActive(wsId);') && g.includes('explains: [GONE_ROW]'), 'the link selects a LIVE workspace row and closes the panel; a vanished one is said in the panel');
  assert.ok(!/pauseRelease|pausePause|pauseResume/.test(g), 'and writes nothing: no IPC write call in the navigation path');
});

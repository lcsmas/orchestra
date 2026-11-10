// #415 — the Bloc HTML navigation guard, pinned structurally (index.ts needs Electron): a sub-frame navigation is refused in main, the one seam #416 extends is exported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { onBlocNavigationAttempt } from './bloc-html-guard.ts';

const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('onBlocNavigationAttempt reports the full target (truncated at 200) and the frame', () => {
  const line = onBlocNavigationAttempt('https://evil.example/x?s=1', { processId: 7, routingId: 3 });
  assert.match(line, /https:\/\/evil\.example\/x\?s=1/);
  assert.match(line, /process 7, frame 3/);
  assert.ok(onBlocNavigationAttempt('http://a/' + 'x'.repeat(500), { processId: 1, routingId: 1 }).length < 330);
});

test('index.ts refuses a SUB-frame navigation on the app window and reports it through the guard; the main frame and about:srcdoc are untouched', () => {
  const s = code('src/main/index.ts');
  const i = s.indexOf("mainWindow.webContents.on('will-frame-navigate'");
  assert.ok(i > 0, 'the will-frame-navigate listener is registered on the app window');
  const body = s.slice(i, s.indexOf('});', i));
  assert.ok(/if \(event\.isMainFrame \|\| event\.url === 'about:srcdoc'\) return;/.test(body), 'main frame + srcdoc load pass');
  assert.ok(body.includes('onBlocNavigationAttempt(event.url, blocFrameInfo(event))'), 'the frame is read through the throw-safe helper, never `event.frame.x` directly');
  assert.ok(body.indexOf('event.preventDefault()') > 0 && body.indexOf('event.preventDefault()') < body.indexOf('onBlocNavigationAttempt('), 'refuse first, then report');
});

test('D5: the app window has its network back — no proxy, no WebRTC policy anywhere in main (a remote image in a reply loads, the spellcheck dictionary downloads)', () => {
  for (const f of fs.readdirSync(path.join(process.cwd(), 'src/main'), { recursive: true }).map(String).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    const s = code(`src/main/${f}`);
    assert.ok(!/BLOC_BLACKHOLE|blocProxyBypass/.test(s), `${f}: no black-hole proxy`);
    assert.ok(!/defaultSession\.setProxy|setWebRTCIPHandlingPolicy/.test(s), `${f}: no proxy / WebRTC policy on the app window's session`);
  }
});

// ── #416 — a navigation from a bloc asks for confirmation with the full URL ──────────────────────────
import {
  createBlocNavigationGate, installBlocNavigationGate, registerBlocNavigationIpc, BLOC_NAV_ANSWER_CHANNEL, BLOC_NAV_PULL_CHANNEL,
  blocFrameInfo, BLOC_NAV_EXPIRY_MS, BLOC_NAV_MUTE_CONFIRM_MS, BLOC_NAV_MUTE_DISMISS_MS, BLOC_NAV_MUTE_MAX_MS, BLOC_NAV_MAX_URL_CHARS,
} from './bloc-html-guard.ts';

function rig() {
  let t = 1000; let n = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const log = { shown: [] as any[], cleared: 0, opened: [] as any[] };
  const gate = createBlocNavigationGate({
    showConfirmation: (r) => log.shown.push(r), clearConfirmation: () => { log.cleared++; }, open: (r) => log.opened.push(r),
    now: () => t, newId: () => `id${++n}`,
    schedule: (fn, ms) => { const e = { at: t + ms, fn, live: true }; timers.push(e); return () => { e.live = false; }; },
  });
  const advance = (ms: number) => { t += ms; for (const e of timers) if (e.live && e.at <= t) { e.live = false; e.fn(); } };
  return { gate, log, advance };
}
const F1 = { processId: 1, routingId: 1 };
const F2 = { processId: 1, routingId: 2 };

test('an attempt surfaces the COMPLETE url and opens nothing', () => {
  const { gate, log } = rig();
  const url = 'https://example.com/a?' + 'q=x&'.repeat(300) + 'end=1';
  assert.equal(gate.attempt(url, F1), 'surfaced');
  assert.deepEqual(log.shown, [{ id: 'id1', url }], 'the url is carried whole, untruncated');
  assert.deepEqual(log.opened, [], 'nothing leaves before the human answers');
});

test('only a confirmed id opens; the open carries the surfaced url; dismiss, stale id and unknown id open nothing', () => {
  const a = rig(); a.gate.attempt('https://a.example/', F1);
  assert.equal(a.gate.answer('id1', true), 'opened');
  assert.deepEqual(a.log.opened, [{ id: 'id1', url: 'https://a.example/' }]);
  assert.equal(a.gate.answer('id1', true), 'stale', 'a second answer to the same id does nothing');
  assert.equal(a.log.opened.length, 1);
  const b = rig(); b.gate.attempt('https://b.example/', F1);
  assert.equal(b.gate.answer('id1', false), 'dismissed');
  assert.equal(b.gate.answer('nope', true), 'stale');
  assert.equal(b.gate.answer('id1', true), 'stale', 'a dismissed id cannot be confirmed afterwards');
  assert.deepEqual(b.log.opened, []);
  const c = rig(); c.gate.attempt('https://c.example/', F1);
  assert.equal(c.gate.answer('id1', 'true' as unknown as boolean), 'dismissed', 'only boolean true confirms');
  assert.deepEqual(c.log.opened, []);
});

test('repeated attempts coalesce into the ONE pending confirmation (the first url stays — no swap under the cursor)', () => {
  const { gate, log } = rig();
  assert.equal(gate.attempt('https://first.example/', F1), 'surfaced');
  for (let i = 0; i < 50; i++) assert.equal(gate.attempt(`https://spam.example/${i}`, i % 2 ? F1 : F2), 'coalesced');
  assert.equal(log.shown.length, 1);
  assert.equal(gate.pending()?.url, 'https://first.example/');
});

test('a dismissed frame is silent, with doubling silence (5s, 10s, … capped); another frame is not muted; a confirm mutes only briefly', () => {
  const { gate, log, advance } = rig();
  gate.attempt('https://x.example/', F1); gate.answer('id1', false);
  assert.equal(gate.attempt('https://x.example/', F1), 'muted');
  assert.equal(gate.attempt('https://x.example/', F2), 'surfaced', 'a different frame is its own bloc'); gate.answer('id2', false);
  advance(BLOC_NAV_MUTE_DISMISS_MS + 1);
  assert.equal(gate.attempt('https://x.example/', F1), 'surfaced'); gate.answer('id3', false);
  advance(BLOC_NAV_MUTE_DISMISS_MS + 1);
  assert.equal(gate.attempt('https://x.example/', F1), 'muted', 'the 2nd dismissal doubled the silence');
  advance(BLOC_NAV_MUTE_DISMISS_MS + 1);
  assert.equal(gate.attempt('https://x.example/', F1), 'surfaced'); gate.answer('id4', true);
  assert.equal(gate.attempt('https://x.example/', F1), 'muted');
  advance(BLOC_NAV_MUTE_CONFIRM_MS + 1);
  assert.equal(gate.attempt('https://x.example/', F1), 'surfaced', 'a confirm resets the escalation');
  assert.ok(BLOC_NAV_MUTE_DISMISS_MS * 2 ** 20 > BLOC_NAV_MUTE_MAX_MS && BLOC_NAV_MUTE_MAX_MS <= 300_000);
  assert.deepEqual(log.opened.length, 1);
});

test('an unanswered confirmation expires as a dismissal (nothing opens, the slot frees)', () => {
  const { gate, log, advance } = rig();
  gate.attempt('https://slow.example/', F1);
  advance(BLOC_NAV_EXPIRY_MS + 1);
  assert.equal(gate.pending(), null); assert.equal(log.cleared, 1); assert.deepEqual(log.opened, []);
  assert.equal(gate.attempt('https://other.example/', F2), 'surfaced');
});

test('only a web url is offered: javascript:/data:/file:/blob:/garbage and an url too long to show whole are refused with nothing surfaced', () => {
  const { gate, log } = rig();
  for (const u of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'blob:https://a/b', 'not a url', '', 'ftp://a.example/', 'https://a.example/' + 'x'.repeat(BLOC_NAV_MAX_URL_CHARS)]) assert.equal(gate.attempt(u, F1), 'not-offered', u.slice(0, 30));
  assert.deepEqual(log.shown, []);
  assert.equal(gate.attempt('http://ok.example/' + 'x'.repeat(1000), F1), 'surfaced');
});

test('onBlocNavigationAttempt routes through the installed gate and reports its verdict; it never opens by itself', () => {
  const { gate, log } = rig();
  installBlocNavigationGate(gate);
  try {
    assert.match(onBlocNavigationAttempt('https://v.example/p', F1), /refused a frame navigation.*https:\/\/v\.example\/p → surfaced/);
    assert.match(onBlocNavigationAttempt('https://v.example/p', F1), /→ coalesced/);
    assert.deepEqual(log.opened, []);
  } finally { installBlocNavigationGate(null); }
});

test('the IPC answer + pull are refused for any sender that is not the window\'s top frame (a sub-frame cannot answer for the human)', () => {
  const { gate, log } = rig();
  const handlers = new Map<string, (e: any, ...a: any[]) => unknown>();
  registerBlocNavigationIpc({ handle: (c, f) => handlers.set(c, f) }, gate);
  gate.attempt('https://ipc.example/', F1);
  const top = {}; const sub = {};
  const fromTop = { sender: { mainFrame: top }, senderFrame: top };
  const fromSub = { sender: { mainFrame: top }, senderFrame: sub };
  assert.equal(handlers.get(BLOC_NAV_ANSWER_CHANNEL)!(fromSub, 'id1', true), 'stale');
  assert.equal(handlers.get(BLOC_NAV_ANSWER_CHANNEL)!({ sender: { mainFrame: top }, senderFrame: null }, 'id1', true), 'stale');
  assert.equal(handlers.get(BLOC_NAV_PULL_CHANNEL)!(fromSub), null);
  assert.deepEqual(log.opened, []);
  assert.deepEqual(handlers.get(BLOC_NAV_PULL_CHANNEL)!(fromTop), { id: 'id1', url: 'https://ipc.example/' });
  assert.equal(handlers.get(BLOC_NAV_ANSWER_CHANNEL)!(fromTop, 'id1', true), 'opened');
  assert.equal(log.opened.length, 1);
});

test('index.ts opens a confirmed navigation through openUrlExternally (the path of a link in a reply) and nothing else reaches it', () => {
  const s = code('src/main/index.ts');
  assert.ok(/open: \(req\) => void openUrlExternally\(req\.url, 'bloc-confirm'\)/.test(s));
  assert.ok(/installBlocNavigationGate\(blocNavGate\);\s*registerBlocNavigationIpc\(ipcMain, blocNavGate\);/.test(s));
  assert.ok(!/openUrlExternally\([^)]*'bloc/.test(s.replace(/open: \(req\) => void openUrlExternally\(req\.url, 'bloc-confirm'\)/, '')), 'one call site');
  const g = code('src/main/bloc-html-guard.ts');
  assert.equal((g.match(/deps\.open\(/g) ?? []).length, 1, 'the gate has ONE path to open');
  assert.ok(/if \(confirmed\) deps\.open\(req\);/.test(g), 'and it is behind the confirmed answer');
  assert.equal((g.match(/deps\.showConfirmation\(/g) ?? []).length, 1);
});

test('the preload adds the three channels to the ONE existing exposure (no second exposeInMainWorld); channel names match main', () => {
  const p = code('src/preload/index.ts');
  for (const c of ['blocNav:pending', 'blocNav:request', 'blocNav:answer']) assert.ok(p.includes(`'${c}'`), c);
  assert.equal((p.match(/contextBridge\.exposeInMainWorld/g) ?? []).length, 1, 'still the ONE exposure the app already had');
});

test('blocFrameInfo survives Electron\'s throwing `frame` getter ("Render frame was disposed") and a null frame: unknown identity, never an exception', () => {
  const throwing = { get frame(): never { throw new Error('Render frame was disposed before WebFrameMain could be accessed'); } };
  assert.deepEqual(blocFrameInfo(throwing), { processId: -1, routingId: -1 });
  assert.deepEqual(blocFrameInfo({ frame: null }), { processId: -1, routingId: -1 });
  assert.deepEqual(blocFrameInfo({ frame: { processId: 4, routingId: 9 } }), { processId: 4, routingId: 9 });
  const g = rig(); g.gate.attempt('https://a.example/', F1);
  installBlocNavigationGate({ ...g.gate, attempt: () => { throw new Error('boom'); } });
  try { assert.match(onBlocNavigationAttempt('https://a.example/', F1), /→ error$/, 'a throwing gate is reported, not thrown (the navigation is already refused)'); } finally { installBlocNavigationGate(null); }
});

test('an UNKNOWN-identity attempt cannot slip past a dismissal: the answer silences the unknown frame too (a looping frame whose id Electron cannot give)', () => {
  const { gate, advance } = rig();
  const U = { processId: -1, routingId: -1 };
  assert.equal(gate.attempt('https://a.example/', F1), 'surfaced'); gate.answer('id1', false);
  assert.equal(gate.attempt('https://a.example/', U), 'muted');
  advance(BLOC_NAV_MUTE_DISMISS_MS + 1);
  assert.equal(gate.attempt('https://a.example/', U), 'surfaced');
});

test('blocFrameInfo keys on the INITIATOR (stable across repeats) and only falls back to `frame` when it is absent or unreadable', () => {
  const withThrowingFrame = (initiator: { processId: number; routingId: number } | null) => Object.defineProperties({ initiator }, { frame: { get(): never { throw new Error('Render frame was disposed'); } } }) as { initiator: typeof initiator; frame: never };
  assert.deepEqual(blocFrameInfo(withThrowingFrame({ processId: 7, routingId: 3 })), { processId: 7, routingId: 3 }, 'frame throws, initiator answers');
  assert.deepEqual(blocFrameInfo({ initiator: { processId: 7, routingId: 3 }, frame: { processId: 1, routingId: 1 } }), { processId: 7, routingId: 3 }, 'initiator wins');
  assert.deepEqual(blocFrameInfo({ initiator: null, frame: { processId: 1, routingId: 2 } }), { processId: 1, routingId: 2 });
  assert.deepEqual(blocFrameInfo({ get initiator(): never { throw new Error('x'); }, frame: { processId: 4, routingId: 5 } }), { processId: 4, routingId: 5 });
});

test('a looping bloc A dismissed repeatedly does not silence bloc B (distinct initiators); with identity UNKNOWN they would share one bucket', () => {
  const { gate, advance } = rig();
  const A = { processId: 7, routingId: 3 }, B = { processId: 7, routingId: 4 };
  gate.attempt('https://a/', A); gate.answer('id1', false); advance(BLOC_NAV_MUTE_DISMISS_MS + 1);
  gate.attempt('https://a/', A); gate.answer('id2', false);
  assert.equal(gate.attempt('https://b/', B), 'surfaced', "B's first attempt");
  gate.answer('id3', false); advance(BLOC_NAV_MUTE_DISMISS_MS + 1);
  assert.equal(gate.attempt('https://b/', B), 'surfaced', "B's SECOND attempt is not silenced by A's escalation");
});

test('a STALE id cannot confirm while a NEWER request is current: answer(oldId, true) is refused, opens nothing, and leaves the newer request pending', () => {
  const { gate, log } = rig();
  assert.equal(gate.attempt('https://old.example/', F1), 'surfaced'); // id1
  assert.equal(gate.answer('id1', false), 'dismissed');
  assert.equal(gate.attempt('https://new.example/', F2), 'surfaced'); // id2 — a different bloc, now current
  assert.equal(gate.answer('id1', true), 'stale', 'the dismissed request\'s id must not confirm the newer one');
  assert.deepEqual(log.opened, [], 'nothing opened');
  assert.equal(gate.pending()?.id, 'id2', 'the newer request is still waiting');
  assert.equal(gate.answer('id2', true), 'opened');
  assert.deepEqual(log.opened, [{ id: 'id2', url: 'https://new.example/' }]);
});

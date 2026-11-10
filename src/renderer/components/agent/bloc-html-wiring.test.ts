// #415 — where a Bloc HTML may render, pinned structurally (the components import React/Electron seams): agent replies only, label read whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
const DIR = 'src/renderer/components';

test('MarkdownView reads a fence label WHOLE (html-render is not html) and routes blocs through the shared reader', () => {
  const s = code(`${DIR}/agent/MarkdownView.tsx`);
  assert.ok(s.includes("/language-(\\S+)/"), 'whole-label match');
  assert.ok(!s.includes('language-(\\w+)'), 'the word-char match that cut `html-render` to `html` is gone');
  assert.ok(/blocs \? splitReply\(text\) : null/.test(s), 'splitReply only when blocs is on');
  assert.ok(/seg\.kind === 'bloc-pending'.*BlocPending/s.test(s) && /seg\.kind === 'bloc'\) return <BlocSlot/.test(s), 'closed ⇒ budgeted frame slot, open ⇒ placeholder');
  assert.ok(/return <MarkdownProse key=\{`r\$\{i\}`\} text=\{seg\.raw\} done \/>/.test(s), 'a refused (too-large) bloc renders its raw fence as code');
});

test('a placeholder lasts only while the reply is being written: a done reply with an open fence shows its raw fence as code', () => {
  const s = code(`${DIR}/agent/MarkdownView.tsx`);
  assert.ok(/seg\.kind === 'bloc-pending'\) return done \? <MarkdownProse key=\{`r\$\{i\}`\} text=\{seg\.raw\} done \/> : <BlocPending/.test(s));
});

test('ONLY the assistant text path passes blocs; every other MarkdownView caller stays code', () => {
  const callers = ['agent/MessageBubble.tsx', 'agent/PeerMessageGroup.tsx', 'agent/TaskNoticeGroup.tsx', 'agent/PermissionDialog.tsx'];
  for (const c of callers) {
    const s = code(`${DIR}/${c}`);
    const uses = s.match(/<MarkdownView[\s\S]*?\/>/g) ?? [];
    assert.ok(uses.length >= 1, c);
    if (c === 'agent/MessageBubble.tsx') {
      assert.ok(uses.every((u) => /blocs=\{role === 'assistant' && blocHtml\}/.test(u)), 'MessageBubble: assistant role + the enable switch');
      assert.ok(/const blocHtml = useBlocHtmlEnabled\(\)/.test(s));
    } else assert.ok(uses.every((u) => !u.includes('blocs')), `${c} must not render blocs`);
  }
  // no other file renders MarkdownView at all (a new caller must be added here, deliberately)
  const all = fs.readdirSync(path.join(process.cwd(), DIR), { recursive: true }).map(String).filter((f) => f.endsWith('.tsx') && !f.includes('__'));
  const users = all.filter((f) => /<MarkdownView\b/.test(code(`${DIR}/${f}`))).map((f) => f.replace(/\\/g, '/')).sort();
  assert.deepEqual(users, callers.map((c) => c).sort(), 'the set of MarkdownView callers');
});

test('the frame is sandboxed without allow-same-origin and accepts a height only from its own window', () => {
  const s = code(`${DIR}/agent/BlocFrame.tsx`);
  assert.ok(/sandbox="allow-scripts"/.test(s) && !/allow-same-origin/.test(s));
  assert.ok(/e\.source !== frameRef\.current\.contentWindow\) return;/.test(s), 'height accepted only from the frame this component created');
  assert.ok(/Math\.min\(BLOC_MAX_HEIGHT_PX/.test(s), 'clamped');
});

test('#419 BlocSlot: the frame is mounted through the live-frame budget only — the slot reads `live` from the manager, the manager observes the transcript scroller with two margins (mount < keep) and applies the ceiling, the placeholder keeps the last height', () => {
  const s = code(`${DIR}/agent/BlocSlot.tsx`);
  assert.ok(/registerBlocSlot\(el, setLive\)/.test(s), 'a slot never mounts itself: the manager decides');
  assert.ok(/height: recallBlocHeight\(key\)/.test(s) && /av-bloc av-bloc-idle/.test(s), 'the unmounted slot holds the last measured height');
  assert.ok(/const shown = live \|\| pins > 0 \|\| focusWithin;/.test(s) && /shown \? <BlocFrame/.test(s), 'a PINNED bloc (open overlay / source view) stays mounted');
  assert.ok(/BlocPinContext\.Provider value=\{pin\}/.test(s) && /rowPin\?\.\(\)/.test(s), 'the pin also pins the ROW');
  const m = code(`${DIR}/agent/bloc-live-manager.ts`);
  assert.ok(/closest\('\.av-message-list'\)/.test(m), 'the observer root is the transcript scroller (rootMargin widens an ELEMENT root only)');
  assert.ok(/watch\(BLOC_MOUNT_MARGIN_PX, \(v\) => \{ e\.near = v; \}\)/.test(m) && /watch\(BLOC_KEEP_MARGIN_PX, \(v\) => \{ e\.kept = v; \}\)/.test(m), 'near = mount margin, kept = the larger keep margin');
  assert.ok(/chooseLiveBlocs\([\s\S]*BLOC_LIVE_MAX\)/.test(m) && /e\.live \? e\.kept : e\.near/.test(m), 'candidates: near to mount, kept to stay; then the ceiling');
  const md = code(`${DIR}/agent/MarkdownView.tsx`);
  assert.ok(!/<BlocFrame\b/.test(md), 'MarkdownView never mounts a BlocFrame directly: every frame goes through the budget');
});

test('#419 BlocFrame: the failure watchdog is progress-based (armed at mount, re-armed from `load`, settled by the report) — never a fixed timer from the mount', () => {
  const s = code(`${DIR}/agent/BlocFrame.tsx`);
  assert.ok(/createBlocWatchdog/.test(s) && /onLoad=\{\(\) => watchdog\.current\?\.loaded\(\)\}/.test(s));
  assert.ok(/watchdog\.current\?\.reported\(\)/.test(s), 'the report settles the watchdog synchronously in the message handler (not through a state effect)');
  assert.ok(!/NO_REPORT_MS/.test(s), 'the 6 s-from-mount timer is gone');
  assert.ok(/useLayoutEffect\(\(\) => \{ \/\/ layout, not passive/.test(s) && /if \(failed && codeRef\.current\) rememberBlocHeight\(boxKey,/.test(s), 'listener + watchdog exist before any report/load; the code fallback height is remembered (its slot unloads without a shift, a remount retries)');
});

test('#419 BlocFrame: a zero-height report (the head-time first message) settles the watchdog but never becomes the height or the remembered placeholder height', () => {
  const s = code(`${DIR}/agent/BlocFrame.tsx`);
  const i = s.indexOf('const onMessage');
  const body = s.slice(i, s.indexOf('window.addEventListener', i));
  assert.ok(/watchdog\.current\?\.reported\(\);\s*\n\s*if \(h === 0\) return;/.test(body), 'reported() then the zero guard');
  assert.ok(body.indexOf('if (h === 0) return;') < body.indexOf('rememberBlocHeight(') && body.indexOf('if (h === 0) return;') < body.indexOf('setHeight('), 'the guard precedes the cache write and the state write');
});

test('#419 pinning: the windowed transcript widens its slice for pinned rows, and every row provides the row-pin context', () => {
  const v = code(`${DIR}/StructuredView.tsx`);
  assert.ok(/usePinnedRowIds\(\)/.test(v) && /widenWindowForPins\(start, end,/.test(v), 'the slice is widened by the pure function');
  assert.ok(/<RowPinContext\.Provider value=\{pinRow\}>/.test(v) && /pinRowFor\(item\.id\)/.test(v), 'MeasuredRow provides the pin of ITS row id');
  const p = code(`${DIR}/agent/bloc-pin.ts`);
  assert.ok(/useEffect\(\(\) => \(active && pin \? pin\(\) : undefined\), \[active, pin\]\)/.test(p), 'a pin is held exactly while `active`, released on cleanup');
});

test('#419 + #417: an open enlarge overlay or source view pins its bloc (slot + row), and the surfaces key their heights apart (inline vs enlarged)', () => {
  const s = code(`${DIR}/agent/BlocFrame.tsx`);
  assert.ok(/useBlocPin\(enlarged \|\| showSource\);/.test(s), 'the consumer: pinned exactly while the overlay or the source view is open');
  assert.ok(s.indexOf('useBlocPin(') < s.indexOf('if (failed) return'), 'a hook, called before the failed early return');
  assert.ok(/blocSurfaceKey\(mode, source\)/.test(s) && /blocSurfaceKey\('inline', source\)/.test(s), 'inline and enlarged frames have their own height entry');
  const sl = code(`${DIR}/agent/BlocSlot.tsx`);
  assert.ok(/blocBoxKey\(source\)/.test(sl) && /if \(h > 0\) rememberBlocHeight\(boxKey, h\)/.test(s) && /useState\(\(\) => wasBlocExpanded\(boxKey\)\)/.test(s), 'the placeholder reads the BOX entry that BlocFrame writes from what it really renders (clipped height when tall); « Afficher tout » is restored on remount');
});

test('#419: a failed bloc\'s retry starts at its remembered box (the code fallback height), not at the 80 px default — no shift while the frame loads again', () => {
  const s = code(`${DIR}/agent/BlocFrame.tsx`);
  assert.ok(/useState\(\(\) => peekBlocHeight\(inlineKey\) \?\? recallBlocHeight\(boxKey\)\)/.test(s));
  assert.ok(/useState\(\(\) => peekBlocHeight\(key\) \?\? initialHeight \?\? recallBlocHeight\(key\)\)/.test(s) && /initialHeight=\{height\}/.test(s), 'the live frame itself starts at that height too (its own state, not only the chrome\'s)');
});

test('#419 review: focus inside a slot keeps it mounted (overlay close hands focus to the bloc in the flush that releases the pin), and the unloaded placeholder announces the bloc by its title (story 31)', () => {
  const s = code(`${DIR}/agent/BlocSlot.tsx`);
  assert.ok(/onFocus=\{\(\) => \{ focusRef\.current = true; setFocusWithin\(true\); \}\}/.test(s) && /contains\(e\.relatedTarget as Node \| null\)\) dropFocus\(\)/.test(s), 'focus in / out of the slot');
  assert.ok(!/onFocus=[^>]*rowPin/.test(s), 'a BARE focus never takes the ROW pin (it re-windowed the transcript under a click — chrome-rig flake)');
  assert.ok(/requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{\s*if \(alive\.current && focusRef\.current && !focusRowPin\.current\) focusRowPin\.current = rowPin\?\.\(\) \?\? null;\s*rel\?\.\(\);/.test(s), 'the overlay-close handoff: the row pin moves to the focus BEFORE the old one is released');
  assert.ok(/focusWithin && !ref\.current\?\.contains\(document\.activeElement\)\) dropFocus\(\)/.test(s), 'a focused node that vanished without a blur does not pin the slot forever');
  assert.ok(/className="av-bloc av-bloc-idle" role="img" aria-label=\{title\}/.test(s) && !/av-bloc-idle[^>]*aria-hidden/.test(s), 'the placeholder is an img named by the title, not aria-hidden');
});

test('#419 follow-ups: the handoff acquires a row pin only while the slot is alive; every row exposes its pin count; a frame records its rendered box at UNMOUNT', () => {
  const sl = code(`${DIR}/agent/BlocSlot.tsx`);
  assert.ok(/alive\.current && focusRef\.current && !focusRowPin\.current/.test(sl) && /alive\.current = false;/.test(sl), 'no row pin is taken after the slot unmounted (it was never released)');
  const v = code(`${DIR}/StructuredView.tsx`);
  assert.ok(/data-row-pins=\{rowPinCount\(item\.id\)\}/.test(v), 'data-row-pins on .av-row: a rig can assert a bare focus holds no row');
  const f = code(`${DIR}/agent/BlocFrame.tsx`);
  assert.ok(/useLayoutEffect\(\(\) => \(\) => \{\s*const \{ failed: f, showSource: ss, enlarged: en \} = latest\.current;[\s\S]*?rememberBlocHeight\(boxKey, h\);\s*\}, \[boxKey\]\);/.test(f), 'the placeholder that replaces a frame is the box it had when it unmounted');
});

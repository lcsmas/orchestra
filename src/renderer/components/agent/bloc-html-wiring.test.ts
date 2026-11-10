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
  assert.ok(/seg\.kind === 'bloc-pending'.*BlocPending/s.test(s) && /seg\.kind === 'bloc'\) return <BlocFrame/.test(s), 'closed ⇒ frame, open ⇒ placeholder');
  assert.ok(/return <MarkdownProse key=\{`r\$\{i\}`\} text=\{seg\.raw\} done \/>/.test(s), 'a refused (too-large) bloc renders its raw fence as code');
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

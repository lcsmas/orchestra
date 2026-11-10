// #416 — the Bloc HTML navigation confirmation, pinned structurally (no DOM in node:test; the built-app rig drives the real thing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
const C = src('src/renderer/components/agent/BlocNavigationConfirm.tsx');

test('the URL is rendered whole: no slice / substring / truncation / ellipsis on it, and the CSS never ellipsises it', () => {
  assert.ok(/\{shown\.url\}/.test(C));
  assert.ok(!/shown\.url\s*\.(slice|substring|substr)|truncate|…|\.\.\./.test(C));
  const css = fs.readFileSync(path.join(process.cwd(), 'src/renderer/agent-view-theme.css'), 'utf8');
  const rule = css.slice(css.indexOf('.av-bloc-nav-url {'), css.indexOf('}', css.indexOf('.av-bloc-nav-url {')));
  assert.ok(/overflow-wrap: anywhere/.test(rule) && /user-select: text/.test(rule) && !/text-overflow:\s*ellipsis/.test(rule));
});

test('the answer carries the request id and a boolean — never the URL; only the « Open link » button answers true', () => {
  assert.ok(/answerBlocNavigation\(id, confirmed\)/.test(C));
  assert.equal((C.match(/answer\(shown\.id, true\)/g) ?? []).length, 1);
  assert.ok(/className="av-bloc-nav-open" disabled=\{!openArmed\(armedFor, shown\.id\)\} onClick=\{\(\) => \{ if \(openArmed\(armedFor, shown\.id\)\) answer\(shown\.id, true\); \}\}/.test(C));
  assert.ok(/onClick=\{\(\) => answer\(shown\.id, false\)\}>Don’t open/.test(C), '« Don’t open » dismisses');
});

test('the safe button takes the focus and Escape (capture + stop) dismisses — no Enter/Space shortcut confirms, and it cannot also cancel a permission dialog', () => {
  assert.ok(/cancelRef\.current\?\.focus\(\)/.test(C));
  assert.ok(/e\.key !== 'Escape'/.test(C) && /e\.stopPropagation\(\)/.test(C) && /addEventListener\('keydown', onKey, true\)/.test(C));
  assert.ok(!/answer\(true\)/.test(C.slice(C.indexOf('const onKey'), C.indexOf("window.addEventListener('keydown'"))), 'no key handler confirms');
  assert.ok(/armedFor/.test(C) && /disabled=\{!openArmed/.test(C) && /OPEN_ARM_MS/.test(C), '« Open link » is inert for a moment after showing (no click-jack)');
  assert.ok(/pushed\.current/.test(C), 'a late pull cannot resurrect a retracted request');
});

test('StructuredView mounts it once, per conversation, active-gated; the backdrop is a modal alertdialog', () => {
  const v = src('src/renderer/components/StructuredView.tsx');
  assert.equal((v.match(/<BlocNavigationConfirm active=\{isActive\} \/>/g) ?? []).length, 1);
  assert.ok(/role="alertdialog" aria-modal="true"/.test(C));
});

test('it only ever reads main\'s state: pull on mount + push, no URL parameter of its own', () => {
  assert.ok(/blocNavigationPending\(\)/.test(C) && /onBlocNavigation\(\(r\) => \{ pushed\.current = true; setReq\(r\); \}\)/.test(C));
  assert.ok(!/openExternal/.test(C), 'the renderer never opens a URL itself — main does, on a confirmed id');
});

test('« Open link » is armed for ONE request id: a retract+replace in the arming window leaves it inert for the new request', async () => {
  const { openArmed } = await import('../../../shared/bloc-html-navigation.ts');
  assert.equal(openArmed('r1', 'r1'), true);
  assert.equal(openArmed('r1', 'r2'), false, 'replaced request: the old arming does not carry over');
  assert.equal(openArmed(null, 'r2'), false);
  assert.equal(openArmed('r1', null), false);
  assert.ok(/if \(!req \|\| req\.id !== id\) return;/.test(C), 'an answer is only ever for the request on screen');
});

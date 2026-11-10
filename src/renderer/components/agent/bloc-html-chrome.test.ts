// #417 — the chrome's contract, pinned structurally (the component imports React/DOM seams); the built-app rig `test:bloc-html-chrome` measures the behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
const frame = code('src/renderer/components/agent/BlocFrame.tsx');

test('every frame message (height, Escape, pointer) is accepted only from the frame this component created', () => {
  const guard = frame.indexOf('e.source !== frameRef.current.contentWindow');
  assert.ok(guard > 0);
  for (const field of ['BLOC_ESCAPE_FIELD]', 'BLOC_HOVER_FIELD]', "typeof d.h !== 'number'"]) assert.ok(frame.indexOf(field) > guard, `${field} handled after the source check`);
});

test('BlocFrame keeps its {title, source} props and ONE live frame: the inline frame is not rendered while enlarged / showing the source', () => {
  assert.ok(/export function BlocFrame\(\{ title, source \}: Props\)/.test(frame) && /interface Props \{\s*title: string;\s*source: string;/.test(frame));
  assert.ok(/enlarged \? <div style=\{\{ height \}\} aria-hidden \/> : <BlocLive/.test(frame), 'inline frame replaced by a height placeholder while the overlay holds the frame');
  assert.ok(/showSource \? \(\s*<SourceCode source=\{source\} \/>/.test(frame), 'source view = the exact fence content');
  assert.ok(/<CodeBlock code=\{source\} lang="html" done=\{source\.length <= BLOC_SOURCE_HIGHLIGHT_MAX\} \/>/.test(frame), 'the existing CodeBlock/shiki path, plain mono above the cap');
  assert.ok(/BLOC_SOURCE_HIGHLIGHT_MAX = 64 \* 1024/.test(frame));
  assert.ok(/closest\('\.av-view\.active'\)/.test(frame) && /querySelector\('\.av-q'\)/.test(frame) && /new MutationObserver\(check\)/.test(frame), 'the overlay closes when its pane goes inactive or an AskUserQuestion arrives');
  assert.ok(/z-index: 50;[^\n]*av-permission-backdrop/.test(fs.readFileSync(path.join(process.cwd(), 'src/renderer/agent-view-structure.css'), 'utf8')), 'overlay (50) is above the composer popovers (30/40)');
  assert.ok(/\.av-permission-backdrop \{\s*position: absolute; inset: 0; z-index: 60;/.test(fs.readFileSync(path.join(process.cwd(), 'src/renderer/agent-view-theme.css'), 'utf8')), 'the permission backdrop (60) stays above the overlay');
  assert.ok(/q && q !== pending/.test(frame), 'only a NEW AskUserQuestion closes the overlay; a pending one does not block opening');
});

test('the actions are real buttons named for a screen reader; the overlay is a named modal dialog', () => {
  assert.ok(/aria-label=\{`\$\{showSource \? 'Rendu' : 'Afficher le source'\} : \$\{title\}`\}/.test(frame), 'the visible word is inside the accessible name (WCAG 2.5.3)');
  assert.ok(/aria-label=\{`Agrandir : \$\{title\}`\}/.test(frame) && /aria-haspopup="dialog"/.test(frame));
  assert.ok(/role="dialog" aria-modal="true" aria-label=\{title\}/.test(frame));
  assert.ok(/aria-expanded=\{!clipped\} aria-label=\{`\$\{clipped \? 'Afficher tout' : 'Réduire'\} : \$\{title\}`\}/.test(frame), '« Afficher tout » exposes its state and names its bloc');
  assert.ok(/aria-label=\{`Fermer \(Échap\) : \$\{title\}`\}/.test(frame));
});

test('Escape is a window CAPTURE listener that stops propagation (a pending permission dialog treats Escape as DENY); focus returns to the bloc', () => {
  assert.ok(/window\.addEventListener\('keydown', onKey, true\)/.test(frame));
  assert.ok(/e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); onClose\(\);/.test(frame));
  assert.ok(/wasEnlarged\.current && !enlarged\) enlargeRef\.current\?\.focus\(\)/.test(frame));
});

test('a clipped bloc is out of the Tab order and the Escape handler ignores an inactive pane', () => {
  assert.ok(/tabbable=\{!clipped\}/.test(frame) && /tabIndex=\{tabbable \? undefined : -1\}/.test(frame));
  assert.ok(/closest\('\.av-view\.active'\)\) return;/.test(frame));
});

test('the clip cap is 420px and the overlay is portaled into the bloc\'s own .av-view', () => {
  assert.ok(/export const BLOC_CLIP_PX = 420;/.test(frame));
  assert.ok(/anchor\.current\?\.closest\('\.av-view'\)/.test(frame) && /createPortal\(/.test(frame));
});

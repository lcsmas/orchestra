// #322 (D-Q7 = B) — the WIRING of the dedicated Plafond mémoire notice row, pinned structurally (the renderer components cannot run under `node --test`; the rendered HTML is proven by
// scripts/memory-cap-row-render-smoke.mjs and the pixels by scripts/memory-cap-row-screenshot.mjs). Each assertion is a relationship over comment-stripped source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = raw.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
  assert.ok(code.length > 300, `comment-stripping ${rel} returned too little`);
  return code;
}

test('ROW: the builder emits the DEDICATED kind (no longer the generic Warning row), with the structured row; the fold carries it to the message; the renderer routes it', () => {
  const m = codeOf('src/shared/mem-notice.ts');
  assert.ok(/stamp\(ctx, \{ type: 'notice' as const, kind: 'memory-cap' as const, text: e\.text, memCap: rowOfEntry\(e\) \}\)/.test(m), 'makeMemNotice');
  assert.ok(!/kind: 'warning'/.test(m), 'the Warning row is gone from this path');
  assert.ok(/row: memCapRowOf\(rec\) \}/.test(m), 'the entry is persisted WITH its structured row');
  const f = codeOf('src/shared/agent-events.ts');
  assert.ok(/\.\.\.\(event\.memCap !== undefined \? \{ noticeMemCap: event\.memCap \} : \{\}\),/.test(f), 'the fold copies the row onto the message');
  const n = codeOf('src/renderer/components/agent/NoticeRow.tsx');
  assert.ok(/if \(kind === 'memory-cap'\) return <MemoryCapRow message=\{message\} \/>;/.test(n), 'routed to the dedicated row');
  assert.ok(/'memory-cap': 'Plafond mémoire'/.test(n), 'its label');
  assert.ok(/a\.message\.noticeMemCap === b\.message\.noticeMemCap/.test(n), 'the memo compares the structured row too');
  const b = codeOf('src/renderer/components/agent/MessageBubble.tsx');
  assert.ok(/if \(message\.noticeKind\) return <NoticeRow message=\{message\} \/>;/.test(b), 'every notice kind still goes through NoticeRow');
});

test('ROW: the one-line markup — red / amber by tone, the command in a chip, the time at the right, the full sentence as the tooltip — and the styles use the design tokens (error / warn), not new colours', () => {
  const n = codeOf('src/renderer/components/agent/NoticeRow.tsx');
  assert.ok(/className=\{`av-notice av-notice-memory-cap is-\$\{row\.tone\}`\}/.test(n) && /data-notice="memory-cap"/.test(n) && /data-memcap-tone=\{row\.tone\}/.test(n) && /role="note"/.test(n) && /title=\{message\.text\}/.test(n));
  assert.ok(/<code className="av-notice-chip" data-memcap-chip="">/.test(n) && /av-notice-tag/.test(n));
  const css = codeOf('src/renderer/agent-view-theme.css');
  const block = css.slice(css.indexOf('.av-notice-memory-cap { color'), css.indexOf('.av-notice-tag {'));
  assert.ok(/\.av-notice-memory-cap\.is-hard \{[^}]*var\(--av-error\) 30%[^}]*var\(--av-error\) 6%/.test(block), 'hard = the error tokens');
  assert.ok(/\.av-notice-memory-cap\.is-soft \{[^}]*var\(--av-warn\) 34%[^}]*var\(--av-warn\) 7%/.test(block), 'soft = the warn tokens');
  assert.ok(/\.av-notice-memory-cap\.is-hard \.av-notice-dot \{ background: var\(--av-error\); \}/.test(block) && /\.av-notice-memory-cap\.is-soft \.av-notice-dot \{ background: var\(--av-warn\); \}/.test(block));
  assert.ok(/\.av-notice-chip \{[^}]*var\(--av-code-bg\)[^}]*var\(--av-code-border\)/.test(css), 'the chip is the code-chip tokens');
});

test('ROW: the bus message to the coordinator and the app-log lines are NOT touched by the row change (memBusBody / formatMemSoftLine keep their words)', () => {
  const s = codeOf('src/shared/memory-scope.ts');
  assert.ok(/export function memBusBody\(wsLabel: string, rec: MemNoticeRecord\): string \{/.test(s) && /Plafond mémoire — workspace \$\{wsLabel\}: \$\{cmd\} KILLED at the \$\{lvl\}\./.test(s));
  assert.ok(/export function memNoticeText\(rec: MemNoticeRecord\): string \{/.test(s), 'the plain sentence (tooltip / echo identity / a11y) is still the one builder');
});

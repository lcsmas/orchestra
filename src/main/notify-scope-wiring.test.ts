import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Root-only turn-end notifications (src/shared/notify-scope.ts, user ask 2026-10-31): a spawned child's
// turn-end gets no unseen-done bell, no OS toast, no chime — its QUESTION still notifies. activity.ts and
// App.tsx need Electron, so (like turn-start-stamp.test.ts) these arms pin the code of each FUNCTION.

const ROOT = process.cwd();
function codeOf(rel: string): string {
  return fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}
/** Body of `function <name>(` up to the next top-level `\nfunction`/`\nexport` — one function only. */
function fnBody(code: string, name: string): string {
  const start = code.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found — renamed?`);
  const rest = code.slice(start + 1);
  const end = rest.search(/\n(export )?(async )?function /);
  return rest.slice(0, end === -1 ? undefined : end);
}
/** The `window.orchestra.<sub>(` subscription, up to the next useEffect (a `});` cut stops at `.catch(() => {});`). */
function subscription(code: string, sub: string): string {
  const start = code.indexOf(`window.orchestra.${sub}(`);
  assert.notEqual(start, -1, `${sub} subscription not found`);
  const end = code.indexOf('useEffect(', start);
  assert.notEqual(end, -1);
  return code.slice(start, end);
}

const activity = codeOf('src/main/activity.ts');
const app = codeOf('src/renderer/App.tsx');

test('fireFinished: a child gets no unseen-done bell and returns before the OS toast', () => {
  const f = fnBody(activity, 'fireFinished');
  assert.match(f, /const child = hasLiveParent\(ws,/);
  assert.match(f, /markAutoUnread\(id, !seen && !child\)/);
  const ret = f.indexOf('if (focused || ws.loopingSince || child) return;');
  assert.ok(ret !== -1 && ret < f.indexOf('platform.notify('), 'the child early-return must precede platform.notify');
});

test('reconcileExited: a dead child process does not bell either', () => {
  assert.match(fnBody(activity, 'reconcileExited'), /markAutoUnread\(id, !seen && !hasLiveParent\(ws,/);
});

test('fireNeedsInput: a child QUESTION still notifies (no child gate)', () => {
  const f = fnBody(activity, 'fireNeedsInput');
  assert.doesNotMatch(f, /hasLiveParent/);
  assert.match(f, /platform\.notify\(/);
});

test('renderer: no finished-chime for a child, the needs-input chime is ungated', () => {
  const fin = subscription(app, 'onAgentFinished');
  const gate = fin.indexOf('hasLiveParent(ws,');
  assert.ok(gate !== -1 && gate < fin.indexOf('playFinishedChime()'), 'child gate must precede the chime');
  assert.doesNotMatch(subscription(app, 'onAgentNeedsInput'), /hasLiveParent/);
});

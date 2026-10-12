import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppUpdateMonitor } from './app-update.ts';
import type { AppUpdateState, InstalledIdentity } from '../shared/app-update.ts';

function rig(path = '/apps/Orchestra.AppImage') {
  const files = new Map<string, InstalledIdentity | null>([[path, { ino: 1, size: 100, mtimeMs: 1 }]]);
  const texts = new Map<string, string>();
  const pushed: AppUpdateState[] = [];
  const m = createAppUpdateMonitor({ path, stat: (p) => files.get(p) ?? null, read: (p) => texts.get(p) ?? null, push: (s) => pushed.push(s) });
  return { m, files, texts, pushed, path };
}

test('monitor: silent while the installed file is the one it started from; one push per change (replaced, then its version)', () => {
  const r = rig();
  r.m.check();
  assert.deepEqual(r.pushed, [], 'nothing at boot');
  r.files.set(r.path, { ino: 2, size: 200, mtimeMs: 2 });
  r.m.check();
  r.m.check();
  assert.equal(r.pushed.length, 1, 'pushed once, not on every check');
  assert.equal(r.pushed[0].kind === 'installed' && r.pushed[0].version, null);
  r.texts.set(`${r.path}.version`, '0.5.331 2 200');
  r.m.check();
  assert.equal(r.pushed.length, 2);
  assert.equal(r.m.current().kind === 'installed' && r.m.current().version, '0.5.331');
});

test('monitor: a file missing mid-swap keeps the banner; a dev build (no installed file) never shows one', () => {
  const r = rig();
  r.files.set(r.path, { ino: 2, size: 200, mtimeMs: 2 });
  r.m.check();
  r.files.set(r.path, null);
  r.m.check();
  assert.equal(r.m.current().kind, 'installed');
  assert.equal(r.pushed.length, 1);
  const dev = createAppUpdateMonitor({ path: '', stat: () => ({ ino: 9, size: 9, mtimeMs: 9 }), read: () => null, push: () => assert.fail('no push') });
  dev.check();
  assert.equal(dev.current().kind, 'none');
});

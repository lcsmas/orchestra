import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { offlineHandleCandidates } from './index.ts';
import { resolveHandle } from './resolve-handle.ts';

// #144 — the OFFLINE half of the send canonicalizer: when the app is down the
// CLI reads the persisted workspace list off disk and resolves the handle
// against it. This proves the disk path the app writes and the CLI reads AGREE.
//
// The store lives at `<ORCHESTRA_HOME>/userData/orchestra/store.json` — the app
// puts it there via `app.setPath('userData', <HOME>/userData)`, but ONLY when
// NOT in CLI mode, so the CLI must derive this home-relative path itself (never
// `app.getPath('userData')`). This test pins ORCHESTRA_HOME to a temp dir.

function withStore(
  t: { after: (fn: () => void) => void },
  workspaces: unknown,
): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-home-144-'));
  const dir = path.join(home, 'userData', 'orchestra');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ workspaces }));
  const prev = process.env.ORCHESTRA_HOME;
  process.env.ORCHESTRA_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.ORCHESTRA_HOME;
    else process.env.ORCHESTRA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

const FULL = '0a5c25bb-1111-4222-8333-444455556666';

test('#144 offline: the CLI reads workspaces from <HOME>/userData/orchestra/store.json', (t) => {
  withStore(t, [
    { id: FULL, name: 'impl-144', branch: 'x' },
    { id: 'b3f55639-1d61-4d21-b6bf-0d701445dc12', name: 'ops' },
  ]);
  const cands = offlineHandleCandidates();
  assert.equal(cands.length, 2);
  // And the short handle resolves against them to the FULL id (the whole point).
  assert.deepEqual(resolveHandle('0a5c25bb', cands), { ok: true, id: FULL });
});

test('#144 offline: a missing/unreadable store yields [] (send then refuses, never lands a short handle)', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-home-144-empty-'));
  const prev = process.env.ORCHESTRA_HOME;
  process.env.ORCHESTRA_HOME = home; // no store.json written
  t.after(() => {
    if (prev === undefined) delete process.env.ORCHESTRA_HOME;
    else process.env.ORCHESTRA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.deepEqual(offlineHandleCandidates(), []);
  // With no candidates, resolving anything is a REFUSAL, not a silent pass —
  // this is what stops the canary defect (landing a raw short handle) even when
  // the store is unreadable.
  assert.equal(resolveHandle('0a5c25bb', offlineHandleCandidates()).ok, false);
});

test('#144 offline: malformed records are dropped, not crashed on', (t) => {
  withStore(t, [{ name: 'no-id' }, { id: 42 }, { id: FULL, name: 'ok' }]);
  const cands = offlineHandleCandidates();
  assert.deepEqual(cands, [{ id: FULL, name: 'ok' }]);
});

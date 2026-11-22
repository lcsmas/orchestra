// #538 — `fanout state init --harness` / `state set --harness <ref|->` / `state show`: the declared integration harness (run-level). Built-CLI rig: scripts/e2e-fanout-harness-brief.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, type FanoutDeps, type Runner } from './fanout-state.ts';
import { readState, stateFile } from '../shared/fanout-state.ts';

function world(t: { after: (fn: () => void) => void }) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'harness-cli-538-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const none: Runner = () => ({ code: 1, stdout: '', stderr: '' });
  const deps: FanoutDeps = { env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'r1' }, cwd: home, runner: none, now: () => '2026-11-22T10:00:00.000Z', readStdin: () => '' };
  return { run: (...a: string[]) => runFanout(a, deps), state: () => readState(stateFile(home, 'r1')) };
}

test('init --harness declares it; show prints it; set --harness replaces it; "-" clears it (back to discovery)', (t) => {
  const w = world(t);
  assert.equal(w.run('state', 'init', '--run', 'r1', '--harness', 'pnpm run test:e2e').code, 0);
  assert.equal(w.state()?.harness, 'pnpm run test:e2e');
  assert.match(w.run('state', 'show').stdout, /harness \(#538\): pnpm run test:e2e\n/);
  const set = w.run('state', 'set', '--harness', 'test/e2e/boot.ts — jest');
  assert.equal(set.code, 0, set.stderr);
  assert.equal(w.state()?.harness, 'test/e2e/boot.ts — jest');
  assert.match(set.stdout, /harness: test\/e2e\/boot\.ts — jest/);
  const clr = w.run('state', 'set', '--harness', '-');
  assert.equal('harness' in w.state()!, false);
  assert.match(clr.stdout, /none declared \(discovery on origin\/master\)/);
  assert.doesNotMatch(w.run('state', 'show').stdout, /harness \(#538\)/);
});

test('set --harness is run-level: a ticket, another flag, a multi-line / over-long value, or no state is refused (nothing written)', (t) => {
  const w = world(t);
  w.run('state', 'init', '--run', 'r1', '--harness', 'make e2e');
  for (const args of [['state', 'set', 'T1', '--harness', 'x'], ['state', 'set', '--harness', 'x', '--status', 'started'], ['state', 'set', '--harness', 'a\nb'], ['state', 'set', '--harness', 'x'.repeat(301)]]) {
    const r = w.run(...args);
    assert.ok(r.code !== 0 && /harness/.test(r.stderr), `${args.join(' ')} → ${r.code} ${r.stderr}`);
  }
  assert.equal(w.state()?.harness, 'make e2e');
  assert.deepEqual(Object.keys(w.state()!.tickets), []);
  const fresh = world(t);
  const nr = fresh.run('state', 'set', '--harness', 'x');
  assert.ok(nr.code !== 0 && /no state|init/.test(nr.stderr), nr.stderr);
});

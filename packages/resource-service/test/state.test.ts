// state.json: ONE writer. N processes read-modify-write the same counter through withState; no update may be lost. Plus the stale state.lock steal.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readState, withState } from '../src/state.ts';

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'resctl-state-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const STATE_TS = fileURLToPath(new URL('../src/state.ts', import.meta.url));

describe('state', () => {
  it('concurrent withState from 4 processes loses no update', async () => {
    const script = `import { withState } from ${JSON.stringify(STATE_TS)};
for (let i = 0; i < 40; i++) await withState((s) => { const r = s.runs.counter ??= { id: 'counter', token: 't', owner: { pid: 0, startTime: 0 }, state: 'alive', startedAt: 0, lanes: [] }; r.startedAt += 1; }, ${JSON.stringify(dir)});`;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise<void>((resolve, reject) => {
          const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'inherit'] });
          c.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
        }),
      ),
    );
    assert.equal(readState(dir).runs.counter.startedAt, 160);
  });

  it('a state.lock left by a dead process is stolen, not waited on forever', async () => {
    fs.writeFileSync(path.join(dir, 'state.lock'), JSON.stringify({ pid: 2 ** 22 - 3, startTime: 1 }) + '\n');
    const t0 = Date.now();
    await withState((s) => void (s.runs.after = { ...s.runs.counter, id: 'after' }), dir);
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(readState(dir).runs.after);
  });

  it('a corrupt state file fails closed instead of reading as "no runs"', async () => {
    fs.writeFileSync(path.join(dir, 'state.json'), '{"version":1,"runs":');
    await assert.rejects(() => withState(() => 1, dir));
    fs.writeFileSync(path.join(dir, 'state.json'), '{"version":2,"runs":{}}');
    await assert.rejects(() => withState(() => 1, dir), /unsupported state/);
  });
});

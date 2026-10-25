// #398 / ADR 0009: the CDP proxy's seat is the ONLY debugger attacher in src/main. This pins the gate
// script (scripts/check-single-debugger-attacher.mjs) on the real tree AND on throwaway copies that
// reintroduce a second attacher in each shape, so the grep can say DIRTY (a gate that cannot fail proves nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain .mjs script, no types
import { verdict, selfTest } from '../../scripts/check-single-debugger-attacher.mjs';

const root = path.resolve(import.meta.dirname, '../..');

function copyTree(): string {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'attacher-test-'));
  fs.cpSync(path.join(root, 'src/main'), path.join(tmp, 'src/main'), { recursive: true });
  return tmp;
}
function withTree(edit: (dir: string) => void): { clean: boolean; problems: string[] } {
  const tmp = copyTree();
  try {
    edit(tmp);
    return verdict(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const append = (rel: string, text: string) => (dir: string) => fs.appendFileSync(path.join(dir, 'src/main', rel), text);

test('the real tree is CLEAN: every debugger use is in the proxy seat, with its one attach and a host that acquires it', () => {
  const v = verdict(root);
  assert.deepEqual(v.problems, []);
  assert.equal(v.clean, true);
  assert.equal(v.seatAttach.length, 1, 'positive control: the scan sees the proxy\'s own attach');
  assert.ok(v.hits.length > 1 && v.outside.length === 0);
});

test('the script self-test (positive + negative control) passes', () => {
  const r = selfTest(root);
  assert.equal(r.ok, true, r.why);
});

test('a second attacher in browser-panel.ts is DIRTY (the legacy shape)', () => {
  const v = withTree(append('browser-panel.ts', "\nfunction x(wc: any) { wc.debugger.attach('1.3'); }\n"));
  assert.equal(v.clean, false);
  assert.match(v.problems.join(), /outside the proxy seat/);
});

test('an aliased attach (no `debugger` word on the line) is DIRTY', () => {
  const v = withTree(append('agent-browser-tools.ts', "\nfunction y(d: any) { d.attach('1.3'); }\n"));
  assert.equal(v.clean, false);
});

test('a bare sendCommand outside the seat is DIRTY (a command path that skips the lease)', () => {
  const v = withTree(append('browser-panel.ts', "\nfunction z(d: any) { return d.sendCommand('Runtime.evaluate', {}); }\n"));
  assert.equal(v.clean, false);
});

test('a comment that names the debugger is NOT a use', () => {
  const v = withTree(append('browser-panel.ts', "\n// the proxy owns webContents.debugger.attach\n/* debugger */\n"));
  assert.equal(v.clean, true);
});

test('positive control bites: a seat with no attach( (blind pattern) is DIRTY, not vacuously clean', () => {
  const v = withTree((dir) => {
    const f = path.join(dir, 'src/main/browser-cdp-seat.ts');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("dbg.attach('1.3')", "dbg.connect('1.3')"));
  });
  assert.equal(v.clean, false);
  assert.match(v.problems.join(), /positive control/);
});

test('positive control bites: a host that stops acquiring the seat is DIRTY', () => {
  const v = withTree((dir) => {
    const f = path.join(dir, 'src/main/browser-cdp-host.ts');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/seatAcquire\(/g, 'seatAcquireX('));
  });
  assert.equal(v.clean, false);
  assert.match(v.problems.join(), /does not acquire the seat/);
});

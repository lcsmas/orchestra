// #441 (M3 of review #433) — no row-less `'default'` run is read at boot, and the `delivery` switch is read NOWHERE any more.
// Source pins on the Electron-side modules (not importable under `node --test`) + the real census over a real bus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBus } from './bus.ts';
import { startRun, countOpenRuns, openRunSwitchCount } from './bus-runs.ts';
import { closeRunsCoordinatedBy } from './bus-run-close.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(HERE, f), 'utf8');
/** code only: line comments and block comments dropped, so a comment may still NAME the removed thing */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

test("#441 the boot reads of the row-less 'default' run are gone (bus-liveness, bus-wake, session-watchdog)", () => {
  const live = code('bus-liveness.ts');
  const wake = code('bus-wake.ts');
  const dog = code('session-watchdog.ts');
  assert.doesNotMatch(live, /busSwitch\(\s*db\s*,\s*'default'/, "bus-liveness no longer reads busSwitch(db,'default',…)");
  assert.match(live, /openRunSwitchCount\(db, 'liveness'\)/, 'it reads the open runs instead');
  assert.doesNotMatch(wake, /readWakeSwitch\(\s*'default'\s*\)/, "bus-wake no longer reads readWakeSwitch('default')");
  assert.match(wake, /countOpenRuns\(db, \(id\) => readWakeSwitch\(id\)\)/, 'it reads the open runs through the injected wake reader');
  assert.doesNotMatch(dog, /=>\s*'default'/, "the session-watchdog resolver no longer defaults to the 'default' sentinel");
  assert.match(dog, /runIdOf\(ws, \(id\) => store\.getWorkspace\(id\)\)/, 'its default resolver is the real run of the workspace');
});

test('#441 nothing reads a `delivery` switch: no busSwitch/mechanism read of it anywhere in src (non-test)', () => {
  const root = path.resolve(HERE, '..');
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
        const c = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/busSwitch\([^)]*'delivery'\)|flags\.delivery|switches\.delivery|mechanismFromWire\('delivery'\)|\bdelivery:\s*(true|false)\b.*(wake|askGate)/.test(c)) offenders.push(path.relative(root, f));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], `a delivery-switch read survives in ${offenders.join(', ')}`);
});

test('#441 the boot census counts OPEN runs by their own frozen flag (a closed run and a row-less id are not counted)', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'oc441-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  try {
    startRun(db, { id: 'a', kind: 'mission', coordinator: 'a' }, { ...DEFAULT_BUS_SWITCHES, wake: true });
    startRun(db, { id: 'b', kind: 'mission', coordinator: 'b' }, { ...DEFAULT_BUS_SWITCHES });
    startRun(db, { id: 'c', kind: 'mission', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, wake: true });
    assert.deepEqual(openRunSwitchCount(db, 'wake'), { on: 2, total: 3 });
    assert.deepEqual(openRunSwitchCount(db, 'liveness'), { on: 0, total: 3 });
    closeRunsCoordinatedBy(db, ['c']);
    assert.deepEqual(openRunSwitchCount(db, 'wake'), { on: 1, total: 2 }, 'a closed run is not counted');
    assert.deepEqual(countOpenRuns(db, (id) => id === 'b'), { on: 1, total: 2 }, 'the injected reader decides');
    // a pre-update row frozen with the REMOVED key reads like any other: the other flags as frozen
    db.prepare('UPDATE run_flags SET flags = ? WHERE run_id = ?').run(JSON.stringify({ delivery: false, wake: true }), 'b');
    assert.deepEqual(openRunSwitchCount(db, 'wake'), { on: 2, total: 2 });
    assert.equal(openRunSwitchCount(db, 'delivery').on, 0, "'delivery' is an unknown mechanism: never ON");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

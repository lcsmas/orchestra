import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bus from '../main/bus.ts';
import * as busRuns from '../main/bus-runs.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { encodePauseAuto, PAUSE_AUTO_BY } from '../shared/pause-auto.ts';
import { encodeMemoryPause, MEMORY_PAUSE_BY } from '../shared/pause-memory.ts';

// #256 R4-1 — `orchestra run status` shows a HELD auto-Reprise (pause_auto.held): the BUILT CLI over a scratch bus under the real home (never the live one), app down.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };
const ROOT = path.join(os.homedir(), '.cache', `pause-auto-status-${process.pid}`);
const T0 = 1_800_000_000_000;
let n = 0;

function home(t: { after: (fn: () => void) => void }, held: boolean, motive: 'usage' | 'memory' = 'usage'): string {
  const h = path.join(ROOT, `h${n++}`);
  mkdirSync(h, { recursive: true });
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, { ...DEFAULT_BUS_SWITCHES, pause: true, wake: true });
    busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, { ...DEFAULT_BUS_SWITCHES, pause: true, wake: true });
    const hold = held ? { at: T0 + 5_000, addressees: ['Zc@Zc'], to: 'human' } : null;
    const auto = motive === 'memory' ? encodeMemoryPause({ reason: 'memory', pauseCycle: 1, episode: 1, availBytes: 2e9, thresholdBytes: 3e9 }, T0, hold) : encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, T0, hold);
    db.prepare("UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = 'hard', pause_trap_at = ?, pause_auto = ? WHERE id = 'O'").run(T0, motive === 'memory' ? MEMORY_PAUSE_BY : PAUSE_AUTO_BY, T0 + 1, auto);
  } finally {
    db.close();
  }
  t.after(() => rmSync(h, { recursive: true, force: true }));
  return h;
}

function status(h: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, 'run', 'status', '--run', 'O', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: h, ORCHESTRA_HOME: h, ORCHESTRA_SOCK: path.join(h, 'no.sock'), ORCHESTRA_WS_ID: 'O' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('run status (built CLI): a HELD auto-Reprise is a line — since when, who could not be woken, who was told, how to lift; --json carries `autoHeld`', needsBuild, (t) => {
  const h = home(t, true);
  const out = status(h, []);
  assert.match(out, /Auto-Reprise: HELD since 2027-01-15T08:00:05\.000Z — the usage quota is back, but the Reprise could not wake Zc@Zc /);
  assert.match(out, /told the human \(decision gate\)\. Detach that run \(the next tick Reprises\) or lift by hand: orchestra run resume --run O/);
  const json = JSON.parse(status(h, ['--json'])) as { autoHeld?: { at: number; addressees: string[]; to: string } };
  assert.deepEqual(json.autoHeld, { at: T0 + 5_000, addressees: ['Zc@Zc'], to: 'human' });
});

test('run status (built CLI): an auto pause that is NOT held prints no hold line and the JSON has no `autoHeld` key (older shape unchanged)', needsBuild, (t) => {
  const h = home(t, false);
  assert.ok(!/Auto-Reprise: HELD/.test(status(h, [])));
  assert.ok(!('autoHeld' in (JSON.parse(status(h, ['--json'])) as object)));
});

test('run status (built CLI): a HELD memory-Pause Reprise says MEMORY is back (not the usage quota), names who could not be woken, and shows the memory pauser', needsBuild, (t) => {
  const h = home(t, true, 'memory');
  const out = status(h, []);
  assert.match(out, /PAUSED \(hard\) since .* by host:memory/);
  assert.match(out, /Auto-Reprise: HELD since 2027-01-15T08:00:05\.000Z — memory is back, but the Reprise could not wake Zc@Zc /);
  assert.doesNotMatch(out, /usage quota/);
  const json = JSON.parse(status(h, ['--json'])) as { autoHeld?: { addressees: string[]; to: string; motive?: string } };
  assert.deepEqual(json.autoHeld, { at: T0 + 5_000, addressees: ['Zc@Zc'], to: 'human', motive: 'memory' });
});

// #612 — the pure half of the no-agent workspace: refusals, the display rule, the command's env, the pid + start-time record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noAgentCommandEnv, noDisplayRefusal, parseNoAgentRecord, parseProcStartTicks, recordIsAlive, runCommandRefusal, RUN_COMMAND_MAX } from './noagent.ts';

test('run command: required, one printable command, bounded', () => {
  assert.match(runCommandRefusal(undefined)!, /^\[noagent-no-command\]/);
  assert.match(runCommandRefusal('   ')!, /^\[noagent-no-command\]/);
  assert.match(runCommandRefusal('x'.repeat(RUN_COMMAND_MAX + 1))!, /^\[noagent-bad-command\]/);
  assert.match(runCommandRefusal('a\0b')!, /^\[noagent-bad-command\]/);
  assert.equal(runCommandRefusal('orchestra fanout run --tickets a,b'), null);
});

test('display: linux needs DISPLAY or WAYLAND_DISPLAY; other platforms are never refused', () => {
  assert.match(noDisplayRefusal({}, 'linux')!, /^\[noagent-no-display\] .*no display/);
  assert.match(noDisplayRefusal({ DISPLAY: '  ' }, 'linux')!, /^\[noagent-no-display\]/);
  assert.equal(noDisplayRefusal({ DISPLAY: ':99' }, 'linux'), null);
  assert.equal(noDisplayRefusal({ WAYLAND_DISPLAY: 'wayland-7' }, 'linux'), null);
  assert.equal(noDisplayRefusal({}, 'darwin'), null);
  assert.equal(noDisplayRefusal({}, 'win32'), null);
});

test('command env: the host-vouched identity wins over anything the app inherited; child-only vars are stripped', () => {
  const env = noAgentCommandEnv({
    base: { PATH: '/bin', CHROME_DESKTOP: 'orchestra.desktop', ORCHESTRA_WS_ID: 'someone-else', ORCHESTRA_SESSION_KEY: 'stolen', ORCHESTRA_SOCK: '/old.sock', ORCHESTRA_RUN_ID: 'old-run', ORCHESTRA_EVENTS_DIR: '/ev' },
    scriptEnv: { ORCHESTRA_BRANCH: 'ops-x', ORCHESTRA_PORT: '5001' },
    sock: '/new.sock', wsId: 'ws-1', key: 'k'.repeat(64), runId: 'run-1',
  });
  assert.equal(env.ORCHESTRA_WS_ID, 'ws-1');
  assert.equal(env.ORCHESTRA_SESSION_KEY, 'k'.repeat(64));
  assert.equal(env.ORCHESTRA_SOCK, '/new.sock');
  assert.equal(env.ORCHESTRA_RUN_ID, 'run-1');
  assert.equal(env.ORCHESTRA_BRANCH, 'ops-x');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CHROME_DESKTOP, undefined);
  assert.equal(env.ORCHESTRA_EVENTS_DIR, undefined);
});

const STAT = (comm: string, state = 'S', start = 123456) => `4242 (${comm}) ${state} 1 4242 4242 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${start} 1000000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0`;
test('/proc stat: start time is field 22 even when comm holds spaces and parens; a zombie reads as gone', () => {
  assert.equal(parseProcStartTicks(STAT('sh')), 123456);
  assert.equal(parseProcStartTicks(STAT('my (weird) name')), 123456);
  assert.equal(parseProcStartTicks(STAT('sh', 'Z')), null);
  assert.equal(parseProcStartTicks('garbage'), null);
});

test('record: same pid but another start time is NOT the same process (pid reuse); no recorded ticks falls back to the pid probe', () => {
  const rec = parseNoAgentRecord(JSON.stringify({ version: 1, pid: 4242, startTicks: 123456, startedAt: 't', command: 'c' }))!;
  assert.equal(recordIsAlive(rec, 123456, true), true);
  assert.equal(recordIsAlive(rec, 999, true), false, 'a reused pid');
  assert.equal(recordIsAlive(rec, null, true), false, 'gone / zombie');
  const noTicks = { ...rec, startTicks: null };
  assert.equal(recordIsAlive(noTicks, null, true), true);
  assert.equal(recordIsAlive(noTicks, null, false), false);
  assert.equal(parseNoAgentRecord('{"version":2}'), null);
  assert.equal(parseNoAgentRecord('nope'), null);
  assert.equal(parseNoAgentRecord(JSON.stringify({ version: 1, pid: 1, startTicks: null })), null, 'pid 1 is never ours');
});

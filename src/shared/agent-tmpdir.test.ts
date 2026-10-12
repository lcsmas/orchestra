import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TMPDIR_MAX_LEN, agentTmpDir, agentTmpName, agentTmpRoot, planAgentTmpSweep } from './agent-tmpdir.ts';

const WS = '0524718f-ac2a-4367-b746-51e57309f371';

test('the production path fits the Chromium socket bound, with room to spare', () => {
  const dir = agentTmpDir(agentTmpRoot(4294967294, '/home/someone-with-a-long-name/.orchestra'), WS);
  assert.match(dir, /^\/var\/tmp\/orch-4294967294-[0-9a-f]{6}\/0524718fac2a$/);
  assert.ok(dir.length <= AGENT_TMPDIR_MAX_LEN - 10, `${dir} (${dir.length})`);
});

test('two Orchestra homes get two roots (a dev instance never sweeps the packaged one)', () => {
  assert.notEqual(agentTmpRoot(1000, '/home/u/.orchestra'), agentTmpRoot(1000, '/home/u/.orchestra-dev'));
  assert.equal(agentTmpRoot(1000, '/h/.orchestra'), agentTmpRoot(1000, '/h/.orchestra'));
});

test('a short or odd id still gets a 12-char name', () => {
  assert.equal(agentTmpName('ws-1').length, 12);
  assert.notEqual(agentTmpName('ws-1'), agentTmpName('ws-2'));
  assert.equal(agentTmpName(WS), '0524718fac2a');
});

test('sweep removes only the dirs no workspace maps to', () => {
  const live = [WS, 'ws-1'];
  const entries = ['0524718fac2a', agentTmpName('ws-1'), 'deadbeef0000', 'not-ours', 'README'];
  assert.deepEqual(planAgentTmpSweep(entries, live), ['deadbeef0000']);
});

test('an empty workspace list sweeps nothing (unreadable store must not wipe the fleet)', () => {
  assert.deepEqual(planAgentTmpSweep(['0524718fac2a', 'deadbeef0000'], []), []);
});

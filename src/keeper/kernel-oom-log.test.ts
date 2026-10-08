import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJournalJson } from './kernel-oom-log.ts';

const MSG = 'oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=user.slice,mems_allowed=0,oom_memcg=/user.slice/app.slice/u.scope,task_memcg=/user.slice/app.slice/u.scope,task=python3,pid=2413311,uid=1000';

test('#322 m2: journalctl -o json lines → memcg oom kills with the journal\'s own timestamp; noise and byte-array messages are skipped', () => {
  const out = parseJournalJson([
    JSON.stringify({ MESSAGE: MSG, __REALTIME_TIMESTAMP: '1791484880414318' }),
    JSON.stringify({ MESSAGE: 'Memory cgroup out of memory: Killed process 2413311 (python3)', __REALTIME_TIMESTAMP: '1791484880414319' }),
    JSON.stringify({ MESSAGE: [111, 111, 109], __REALTIME_TIMESTAMP: '1' }),
    '{"MESSAGE": "torn',
    '',
    JSON.stringify({ MESSAGE: MSG.replace('pid=2413311', 'pid=77'), __REALTIME_TIMESTAMP: '1791484881000000' }),
  ].join('\n'));
  assert.deepEqual(out.map((k) => [k.pid, k.comm, k.atMs]), [[2413311, 'python3', 1791484880414], [77, 'python3', 1791484881000]]);
});

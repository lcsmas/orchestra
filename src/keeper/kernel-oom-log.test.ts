import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJournalJson, readKernelOomKills } from './kernel-oom-log.ts';

// #343 (review M4): `journalctl` exits 1 for « nothing matched » AND for an unreadable / empty journal. Only stderr tells them apart. A fake `journalctl` on PATH makes each case reproducible.
function withJournalctl(script: string, run: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakejournalctl-'));
  fs.writeFileSync(path.join(dir, 'journalctl'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev}`;
  return run().finally(() => {
    process.env.PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
const LINE = JSON.stringify({ MESSAGE: 'oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=x,mems_allowed=0,oom_memcg=/a/u.scope,task_memcg=/a/u.scope/k,task=node,pid=5,uid=1000', __REALTIME_TIMESTAMP: '1791800000000000' });

test('J1 exit 1 with an EMPTY stderr is « nothing matched » ([]), exit 1 with a message on stderr is UNKNOWN (null) — the unreadable journal never reads as an empty one', async () => {
  await withJournalctl('exit 1', async () => assert.deepEqual(await readKernelOomKills(0), []));
  await withJournalctl('echo "No journal files were opened due to insufficient permissions." >&2; exit 1', async () => assert.equal(await readKernelOomKills(0), null));
  await withJournalctl('echo "No journal boot entry found for the specified boot (+0)." >&2; exit 1', async () => assert.equal(await readKernelOomKills(0), null));
});

test('J2 success parses the lines; any other failure (exit 2, a missing binary) is unknown; a stderr WARNING on a successful run does not hide the lines', async () => {
  await withJournalctl(`echo '${LINE}'`, async () => assert.equal((await readKernelOomKills(0))?.length, 1));
  await withJournalctl(`echo '${LINE}'; echo "Hint: You are currently not seeing messages from other users and the system." >&2`, async () => assert.equal((await readKernelOomKills(0))?.length, 1));
  await withJournalctl('exit 2', async () => assert.equal(await readKernelOomKills(0), null));
  const prev = process.env.PATH;
  process.env.PATH = '/nonexistent-dir';
  try {
    assert.equal(await readKernelOomKills(0), null, 'journalctl missing');
  } finally {
    process.env.PATH = prev;
  }
});

test('J3 the argv: the app\'s long window asks for every boot (`-b all`) and greps for its units; the keeper\'s default read is the current boot with no extra filter; quiet mode is NOT used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakejournalctl-'));
  const log = path.join(dir, 'argv.txt');
  await withJournalctl(`printf '%s\\n' "$@" > ${log}; exit 1`, async () => {
    await readKernelOomKills(5000, { match: 'orchestra-ws-x\\.scope', allBoots: true });
    const a = fs.readFileSync(log, 'utf8').split('\n');
    assert.ok(a.includes('-b') && a[a.indexOf('-b') + 1] === 'all');
    assert.ok(a.includes('oom-kill:constraint=CONSTRAINT_MEMCG.*(orchestra-ws-x\\.scope)'));
    assert.ok(!a.includes('-q'));
    await readKernelOomKills(5000);
    const b = fs.readFileSync(log, 'utf8').split('\n');
    assert.ok(!b.includes('-b'));
    assert.ok(b.includes('oom-kill:constraint=CONSTRAINT_MEMCG'));
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

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

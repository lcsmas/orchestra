import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberLeaves, inWorkLeafArgv, type LeafFs } from './member-leaves.ts';

const S = '/sys/fs/cgroup/user.slice/app.slice/orchestra-ws-w-abc.scope';
const HARD = 256 * 1024 * 1024;

function fakeFs(over: { failOn?: string; limitBack?: string } = {}) {
  const log: string[] = [];
  const files = new Map<string, string>();
  const fs: LeafFs = {
    mkdir: (p) => { log.push(`mkdir ${p.slice(S.length)}`); if (over.failOn === 'mkdir') throw new Error('EACCES'); },
    write: (p, t) => { log.push(`write ${p.slice(S.length)} ${t}`); if (over.failOn && p.endsWith(over.failOn)) throw new Error(`EBUSY ${over.failOn}`); files.set(p, t); },
    read: (p) => { if (p.endsWith('memory.max')) return over.limitBack ?? files.get(p) ?? 'max'; throw new Error('ENOENT'); },
  };
  return { fs, log };
}

test('#332: the leaves are built in the kernel\'s order — mkdir both, THEN move the keeper into k, THEN enable the memory controller for the children, THEN the work leaf\'s limit', () => {
  const f = fakeFs();
  const r = buildMemberLeaves({ scopeDir: S, hardBytes: HARD, pid: 4242, fs: f.fs });
  assert.deepEqual(f.log, ['mkdir /k', 'mkdir /w', 'write /k/cgroup.procs 4242', 'write /cgroup.subtree_control +memory', `write /w/memory.max ${HARD}`, 'write /w/memory.swap.max 0']);
  assert.ok(r.ok && r.keeperDir === `${S}/k` && r.workDir === `${S}/w`);
});

test('#332: a second call in the same keeper (already in k) does not move it again', () => {
  const f = fakeFs();
  const r = buildMemberLeaves({ scopeDir: S, hardBytes: HARD, pid: 4242, fs: f.fs, alreadyInKeeperLeaf: true });
  assert.ok(r.ok);
  assert.ok(!f.log.some((l) => l.includes('cgroup.procs')));
});

test('#332 fail closed: each step that fails is named and nothing after it runs (no limit is claimed that was not set)', () => {
  for (const [failOn, step] of [['mkdir', 'mkdir keeper leaf'], ['cgroup.procs', 'move the keeper into its leaf'], ['cgroup.subtree_control', 'enable the memory controller for the leaves'], ['memory.max', 'set the work leaf\'s hard level']] as const) {
    const f = fakeFs({ failOn });
    const r = buildMemberLeaves({ scopeDir: S, hardBytes: HARD, pid: 1, fs: f.fs });
    assert.equal(r.ok, false, failOn);
    assert.equal(!r.ok && r.step, step, failOn);
    if (failOn === 'cgroup.subtree_control') assert.ok(!f.log.some((l) => l.includes('memory.max')), 'no limit written after the controller could not be enabled');
  }
});

test('#332 fail closed: a limit that reads back different from the one asked (not delegated, rounded wrongly, "max") is a failure, not an "active" cap', () => {
  assert.equal(buildMemberLeaves({ scopeDir: S, hardBytes: HARD, pid: 1, fs: fakeFs({ limitBack: 'max\n' }).fs }).ok, false);
  assert.equal(buildMemberLeaves({ scopeDir: S, hardBytes: HARD, pid: 1, fs: fakeFs({ limitBack: `${HARD * 2}\n` }).fs }).ok, false);
  assert.equal(buildMemberLeaves({ scopeDir: S, hardBytes: HARD, pid: 1, fs: fakeFs({ limitBack: `${HARD - 16384}\n` }).fs }).ok, true, 'the kernel rounds to its page size');
  assert.equal(buildMemberLeaves({ scopeDir: S, hardBytes: HARD, pid: 1, fs: fakeFs({ limitBack: `${HARD - 1024 * 1024}\n` }).fs }).ok, false);
});

test('#332: the swap escape of the work leaf is closed best-effort (a kernel without swap accounting has no such file)', () => {
  const f = fakeFs({ failOn: 'memory.swap.max' });
  assert.ok(buildMemberLeaves({ scopeDir: S, hardBytes: HARD, pid: 1, fs: f.fs }).ok);
});

test('#332: the CLI starts INSIDE the work leaf — a fresh sh moves itself in, then execs; a leaf that cannot be entered stops the start (&&) instead of running the CLI uncapped', () => {
  const a = inWorkLeafArgv(`${S}/w`, '/usr/bin/node', ['standin-cli.cjs', '--x']);
  assert.equal(a.command, '/bin/sh');
  assert.deepEqual(a.args.slice(0, 2), ['-c', 'echo $$ > "$1/cgroup.procs" && shift && exec "$@"']);
  assert.deepEqual(a.args.slice(3), [`${S}/w`, '/usr/bin/node', 'standin-cli.cjs', '--x']);
  assert.match(a.args[1], /&& shift && exec "\$@"/);
});

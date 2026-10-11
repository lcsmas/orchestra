import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberLeaves, createPlacementTripwire, probeToolPlacement, probeWithRetry, readLeafCpuUsec, type LeafFs } from './member-leaves.ts';

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

test('#332 probe: the wrapper PLACES a command in the work leaf ⇒ ok; anywhere else (the keeper leaf, the scope), no cgroup line, or a wrapper that did not run ⇒ not ok, with what it saw', () => {
  const ROOT = '/sys/fs/cgroup';
  const W = `${ROOT}/user.slice/app.slice/orchestra-ws-w-abc.scope/w`;
  const parse = (t: string): string | null => /^0::(.*)$/m.exec(t)?.[1] ?? null;
  const mk = (out: string | null) => probeToolPlacement({ wrapper: '/h/bin/oom-tool-wrapper.sh', workDir: W, cgroupRoot: ROOT, parseCgroup: parse, run: (_w, _a, _e) => out });
  assert.deepEqual(mk('0::/user.slice/app.slice/orchestra-ws-w-abc.scope/w\n'), { ok: true, ran: true, saw: W });
  const inK = mk('0::/user.slice/app.slice/orchestra-ws-w-abc.scope/k\n');
  assert.equal(inK.ok, false);
  assert.match(inK.saw, /scope\/k$/);
  assert.equal(mk('0::/user.slice/app.slice/orchestra-ws-w-abc.scope\n').ok, false, 'in the scope itself is not in the leaf');
  assert.equal(mk('0::/user.slice/app.slice/other-ws.scope/w\n').ok, false, 'another member\'s leaf is not ours');
  assert.match(mk('garbage\n').saw, /no cgroup v2 line/);
  assert.equal(mk('garbage\n').ran, true, 'it RAN (output came back) — only the placement is unproven');
  assert.equal(inK.ran, true);
  assert.deepEqual(mk(null), { ok: false, ran: false, saw: 'the wrapper did not run' });
});

test('#332 probe: the probe command and environment — the wrapper gets ONE argument, the work leaf and a PATH/SHELL, nothing from the keeper\'s environment', () => {
  let seen: { w: string; a: string[]; e: Record<string, string> } | null = null;
  probeToolPlacement({ wrapper: '/h/w.sh', workDir: '/sys/fs/cgroup/x.scope/w', cgroupRoot: '/sys/fs/cgroup', parseCgroup: () => null, run: (w, a, e) => { seen = { w, a, e }; return ''; } });
  assert.ok(seen);
  const s = seen as { w: string; a: string[]; e: Record<string, string> };
  assert.equal(s.w, '/h/w.sh');
  assert.deepEqual(s.a, ['cat /proc/self/cgroup'], 'one argument: the wrapper\'s 1-arg path (the shell route the CLI uses)');
  assert.equal(s.e.ORCHESTRA_MEMCAP_WORK_LEAF, '/sys/fs/cgroup/x.scope/w');
  assert.deepEqual(Object.keys(s.e).sort(), ['ORCHESTRA_MEMCAP_WORK_LEAF', 'PATH', 'SHELL']);
});

test('#332 fu tripwire: readLeafCpuUsec reads usage_usec of cpu.stat (NOT memory.stat pgfault: its flush is lazy, measured); absent / unreadable is null, never 0', () => {
  assert.equal(readLeafCpuUsec(() => 'usage_usec 171443\nuser_usec 100000\nsystem_usec 71443\n'), 171443);
  assert.equal(readLeafCpuUsec(() => 'user_usec 5\n'), null, 'a stat without usage_usec is not a reading');
  assert.equal(readLeafCpuUsec(() => 'xusage_usec 9\nusage_usec_extra 7\n'), null, 'anchored: a longer key is not usage_usec');
  assert.equal(readLeafCpuUsec(() => null), null);
});

test('#332 fu probe retry: the probe runs again ONCE after a failure and stops at the first success; `attempts` says how many ran', () => {
  const mk = (...seq: boolean[]) => { let i = 0; return () => { const ok = seq[i++] ?? false; return { ok, ran: true, saw: ok ? 'w' : 'k' }; }; };
  assert.deepEqual(probeWithRetry(mk(true)), { ok: true, ran: true, saw: 'w', attempts: 1 }, 'first probe fine: no second run');
  assert.deepEqual(probeWithRetry(mk(false, true)), { ok: true, ran: true, saw: 'w', attempts: 2 }, 'one flaky spawn does not decide the member\'s whole life');
  assert.equal(probeWithRetry(mk(false, false, true)).ok, false, 'ONE retry, not a loop');
  assert.equal(probeWithRetry(mk(false, false, true)).attempts, 2);
  assert.equal(probeWithRetry(mk(false, true), 0).attempts, 1, 'retries = 0 is the old single probe');
});

const bashUse = (id: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
const readUse = (id: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }] } });
const result = (id: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('#332 fu tripwire (review m2c): after 5 BASH tool results, a work leaf whose CPU-time counter never moved past the post-probe baseline TRIPS (once); one that moved does not', () => {
  const trips: number[] = [];
  const tw = createPlacementTripwire({ baseline: 100, readCounter: () => 100, onTrip: (n) => trips.push(n) });
  tw.onLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}');
  for (let i = 1; i <= 4; i++) { tw.onLine(bashUse(`b${i}`)); tw.onLine(result(`b${i}`)); }
  assert.deepEqual(trips, [], 'four results: too early to say');
  tw.onLine(bashUse('b5'));
  tw.onLine(result('b5'));
  assert.deepEqual(trips, [5], 'the fifth Bash result: the leaf was never charged CPU time ⇒ no shell command ever ran in it');
  assert.equal(tw.tripped(), true);
  for (let i = 6; i < 12; i++) { tw.onLine(bashUse(`b${i}`)); tw.onLine(result(`b${i}`)); }
  assert.deepEqual(trips, [5], 'fires ONCE');
  const ok: number[] = [];
  const tw2 = createPlacementTripwire({ baseline: 100, readCounter: () => 5000, onTrip: (n) => ok.push(n) });
  for (let i = 0; i < 8; i++) { tw2.onLine(bashUse(`c${i}`)); tw2.onLine(result(`c${i}`)); }
  assert.deepEqual(ok, []);
  assert.equal(tw2.tripped(), false);
});

test('#332 fu tripwire: Read / Edit / MCP results and results of unknown ids say NOTHING about the work leaf — a session that only read files never trips', () => {
  const trips: number[] = [];
  const tw = createPlacementTripwire({ baseline: 100, readCounter: () => 100, onTrip: (n) => trips.push(n) });
  for (let i = 0; i < 20; i++) { tw.onLine(readUse(`r${i}`)); tw.onLine(result(`r${i}`)); }
  tw.onLine(result('never-announced'));
  tw.onLine('not json with "tool_result" inside');
  assert.deepEqual(trips, [], '20 Read results + an unknown id + junk: nothing counted');
  for (let i = 0; i < 5; i++) { tw.onLine(bashUse(`k${i}`)); tw.onLine(result(`k${i}`)); }
  assert.deepEqual(trips, [5], 'only the 5 Bash results counted');
});

test('#332 fu tripwire: an UNREADABLE counter never trips (unknown is not a verdict), re-checks at later results and gives up after giveUpAfter; a custom threshold is honoured; the stand-in CLI\'s result shape counts', () => {
  let reads = 0;
  let value: number | null = null;
  const trips: number[] = [];
  const tw = createPlacementTripwire({ baseline: 10, readCounter: () => { reads += 1; return value; }, onTrip: (n) => trips.push(n), after: 2, giveUpAfter: 4 });
  const line = '{"type":"user","tool_result":{"id":"x"}}';
  for (let i = 0; i < 3; i++) tw.onLine(line);
  assert.equal(reads, 2, 'results 2 and 3 each tried to read');
  value = 10;
  tw.onLine(line);
  assert.deepEqual(trips, [4]);
  const reads0 = reads;
  tw.onLine(line);
  assert.equal(reads, reads0, 'done: no more reads after the verdict');
  let v2: number | null = null;
  const gaveUp: number[] = [];
  const tw3 = createPlacementTripwire({ baseline: 10, readCounter: () => v2, onTrip: (n) => gaveUp.push(n), after: 1, giveUpAfter: 3 });
  for (let i = 0; i < 5; i++) tw3.onLine(line);
  v2 = 10;
  tw3.onLine(line);
  assert.deepEqual(gaveUp, [], 'gave up while unreadable: a later readable-but-unmoved counter does not retroactively trip');
});

const resultMeta = (id: string, kind: string) => JSON.stringify({ type: 'user', tool_result_meta: [{ id, non_execution_kind: kind }], message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'The operation could not be completed.' }] } });

test('#332 fu tripwire (review): Bash results the CLI marks non_execution_kind (user-rejected / interrupted / cancelled) came back WITHOUT the command running — they never count', () => {
  const trips: number[] = [];
  const tw = createPlacementTripwire({ baseline: 100, readCounter: () => 100, onTrip: (n) => trips.push(n) });
  for (const [i, kind] of ['user-rejected', 'interrupted', 'cancelled', 'user-rejected', 'user-rejected', 'cancelled'].entries()) { tw.onLine(bashUse(`n${i}`)); tw.onLine(resultMeta(`n${i}`, kind)); }
  assert.deepEqual(trips, [], 'six Bash calls that never ran: nothing counted');
  for (let i = 0; i < 4; i++) { tw.onLine(bashUse(`x${i}`)); tw.onLine(result(`x${i}`)); }
  assert.deepEqual(trips, [], 'four real results: still too early');
  tw.onLine(bashUse('x4'));
  tw.onLine(result('x4'));
  assert.deepEqual(trips, [5], 'the fifth REAL result trips');
});

test('#332 fu tripwire (review): a tripwire that gives up on an unreadable counter SAYS so, once', () => {
  const gave: number[] = [];
  const tw = createPlacementTripwire({ baseline: 1, readCounter: () => null, onTrip: () => assert.fail('never trips on an unknown'), onGiveUp: (n) => gave.push(n), after: 1, giveUpAfter: 3 });
  for (let i = 0; i < 8; i++) tw.onLine('{"type":"user","tool_result":{"id":"x"}}');
  assert.deepEqual(gave, [3], 'said once, at giveUpAfter');
});

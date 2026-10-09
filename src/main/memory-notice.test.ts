import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __memNoticeIdle, handleMemRecord, startMemoryNotices, type BusSendInput, type MemNoticeDeps } from './memory-notice.ts';
import type { Workspace } from '../shared/types.ts';
import type { MemKillRecord, MemSoftRecord } from '../shared/memory-scope.ts';
import type { MemNoticeEntry } from '../shared/mem-notice.ts';

const GIB = 1024 ** 3;
const kill = (over: Partial<MemKillRecord> = {}): MemKillRecord => ({ kind: 'kill', source: 'kernel', seq: 1, at: 100, level: 'hard', command: 'cargo build', pid: 7, rssBytes: 50 * 1024 * 1024, candidates: [], unit: 'u.scope', hardBytes: 6 * GIB, ...over });
const soft = (over: Partial<MemSoftRecord> = {}): MemSoftRecord => ({ kind: 'soft', seq: 2, at: 200, unit: 'u.scope', bytes: 3.2 * GIB, softBytes: 3 * GIB, hardBytes: 6 * GIB, ...over });

function world(opts: { parent?: Partial<Workspace> | null; busFails?: boolean; switchOff?: boolean; logs?: string[] } = {}) {
  const wss = new Map<string, Workspace>();
  wss.set('member', { id: 'member', name: 'feat-x', branch: 'feat-x', parentId: 'coord' } as unknown as Workspace);
  if (opts.parent !== null) wss.set('coord', { id: 'coord', name: 'ops', branch: 'ops', ...(opts.parent ?? {}) } as unknown as Workspace);
  const sent: BusSendInput[] = [];
  const emitted: Array<{ wsId: string; entry: MemNoticeEntry }> = [];
  const deps: MemNoticeDeps = {
    getWorkspace: (id) => wss.get(id),
    patchWorkspace: async (id, patch) => {
      await Promise.resolve();
      wss.set(id, { ...(wss.get(id) as Workspace), ...patch });
    },
    emitLive: (wsId, entry) => emitted.push({ wsId, entry }),
    sendToCoordinator: (m) => {
      if (opts.busFails) throw new Error('no bus');
      if (opts.switchOff) return 'counted';
      sent.push(m);
      return 'sent';
    },
    resolveRunId: () => 'run-1',
    log: { info: (m) => opts.logs?.push(m), warn: () => {} },
  };
  return { wss, sent, emitted, deps };
}

test('#322: a kill ⇒ ONE notice row (stored AND emitted live) and ONE escalation to the coordinator naming workspace, command, level', async () => {
  const w = world();
  handleMemRecord(w.deps, 'member', kill());
  await __memNoticeIdle('member');
  assert.equal(w.emitted.length, 1);
  assert.equal(w.emitted[0].entry.text, 'Command cargo build killed: Plafond mémoire 6 GB reached');
  assert.deepEqual((w.wss.get('member') as Workspace).sdkMemNotices?.map((e) => [e.unit, e.seq, e.level]), [['u.scope', 1, 'hard']]);
  assert.equal(w.sent.length, 1);
  assert.deepEqual({ runId: w.sent[0].runId, sender: w.sent[0].sender, recipient: w.sent[0].recipient, kind: w.sent[0].kind }, { runId: 'run-1', sender: 'member', recipient: 'coord', kind: 'escalation' });
  assert.match(w.sent[0].body, /workspace feat-x \(member\)/);
  assert.match(w.sent[0].body, /command `cargo build`/);
  assert.match(w.sent[0].body, /hard level \(6 GB\)/);
});

test('#322 D-Q2: the warning level takes the SAME path — a row, and a `status` (not an escalation) to the coordinator', async () => {
  const w = world();
  handleMemRecord(w.deps, 'member', soft());
  await __memNoticeIdle('member');
  assert.equal(w.emitted[0].entry.level, 'soft');
  assert.match(w.emitted[0].entry.text, /^Working set 3\.2 GB \(reclaimable cache excluded\) — Plafond mémoire warning level \(3 GB\) crossed; hard cap 6 GB$/);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].kind, 'status');
  assert.match(w.sent[0].body, /Nothing was killed or slowed/);
});

test('#322: a record handled twice stores and emits the ROW once (a retry after a failed bus write must not duplicate it)', async () => {
  const w = world();
  handleMemRecord(w.deps, 'member', kill());
  handleMemRecord(w.deps, 'member', kill());
  await __memNoticeIdle('member');
  assert.equal(w.emitted.length, 1);
  assert.equal((w.wss.get('member') as Workspace).sdkMemNotices?.length, 1);
});

test('#322: two records in one tick are BOTH stored (the write chain — no lost update)', async () => {
  const w = world();
  handleMemRecord(w.deps, 'member', kill({ seq: 1 }));
  handleMemRecord(w.deps, 'member', soft({ seq: 2 }));
  handleMemRecord(w.deps, 'member', kill({ seq: 3, command: 'make' }));
  await __memNoticeIdle('member');
  assert.deepEqual((w.wss.get('member') as Workspace).sdkMemNotices?.map((e) => e.seq), [1, 2, 3]);
  assert.equal(w.emitted.length, 3);
});

test('#322: no live coordinator (standalone, archived or deleted parent) ⇒ the member\'s row only, no bus write, no throw', async () => {
  for (const parent of [null, { archived: true }] as const) {
    const w = world({ parent });
    handleMemRecord(w.deps, 'member', kill());
    await __memNoticeIdle('member');
    assert.equal(w.sent.length, 0);
    assert.equal(w.emitted.length, 1, 'the member still hears about it');
  }
});

test('#322: the bus is down ⇒ handleMemRecord THROWS (the delivery layer keeps the record owed and retries); the row is stored once regardless', async () => {
  const w = world({ busFails: true });
  assert.throws(() => handleMemRecord(w.deps, 'member', kill()), /no bus/);
  assert.throws(() => handleMemRecord(w.deps, 'member', kill()), /no bus/);
  await __memNoticeIdle('member');
  assert.equal(w.emitted.length, 1);
});

test('#322: a deleted workspace is told nothing; startMemoryNotices subscribes BOTH hooks and unsubscribes both', async () => {
  const w = world();
  handleMemRecord(w.deps, 'gone', kill());
  assert.equal(w.sent.length, 0);
  const subs: string[] = [];
  const fns: Record<string, (id: string, r: never) => void> = {};
  const off = startMemoryNotices(w.deps, {
    onMemoryKill: (fn) => ((fns.kill = fn as never), subs.push('kill'), () => subs.push('off-kill')),
    onMemorySoft: (fn) => ((fns.soft = fn as never), subs.push('soft'), () => subs.push('off-soft')),
  });
  fns.kill('member', kill() as never);
  fns.soft('member', soft() as never);
  await __memNoticeIdle('member');
  assert.deepEqual(w.sent.map((m) => m.kind), ['escalation', 'status']);
  off();
  assert.deepEqual(subs, ['kill', 'soft', 'off-kill', 'off-soft']);
});

test('review F8: startMemoryNotices is idempotent — a second call (macOS `activate` re-runs createMainWindow) does not subscribe twice, so a record sends ONE bus message', async () => {
  const w = world();
  const subs: string[] = [];
  const fns: Array<(id: string, r: never) => void> = [];
  const hooks = {
    onMemoryKill: (fn: (id: string, r: never) => void) => (fns.push(fn), subs.push('kill'), () => subs.push('off-kill')),
    onMemorySoft: (fn: (id: string, r: never) => void) => (fns.push(fn), subs.push('soft'), () => subs.push('off-soft')),
  };
  const off1 = startMemoryNotices(w.deps, hooks as never);
  const off2 = startMemoryNotices(w.deps, hooks as never);
  assert.equal(off2, off1, 'the same subscription is returned');
  assert.deepEqual(subs, ['kill', 'soft'], 'subscribed once');
  fns[0]('member', kill() as never);
  await __memNoticeIdle('member');
  assert.equal(w.sent.length, 1);
  off1();
  const off3 = startMemoryNotices(w.deps, hooks as never);
  assert.deepEqual(subs, ['kill', 'soft', 'off-kill', 'off-soft', 'kill', 'soft'], 'after an unsubscribe a new start subscribes again');
  off3();
});

test('review F6: the run\'s liveness switch OFF ⇒ «counted, not fired»: the member\'s row still appears, nothing is written to the bus, and the record counts as handled (no retry loop)', async () => {
  const logs: string[] = [];
  const w = world({ switchOff: true, logs });
  assert.doesNotThrow(() => handleMemRecord(w.deps, 'member', kill()));
  await __memNoticeIdle('member');
  assert.equal(w.sent.length, 0);
  assert.equal(w.emitted.length, 1, 'the member is still told');
  assert.ok(logs.some((l) => /would have told coord .*counted, not fired/.test(l)), logs.join(' | '));
});

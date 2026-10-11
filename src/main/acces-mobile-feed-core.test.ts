// Accès mobile #337: the feed core — history fold, live fold, heal-on-turn-end, LRU, zero cost while nobody watches. Events come
// from a transcript captured from the real CLI through the real backfill normalizer, never hand-written SDK payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptToEvents } from '../shared/agent-transcript.ts';
import { createMobileFeed, MAX_CACHED, type FeedMessage } from './acces-mobile-feed-core.ts';
import type { AgentEvent } from '../shared/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE = fs.readFileSync(path.join(root, 'scripts/fixtures/payloads/acces-mobile-transcript.sample.jsonl'), 'utf8').trim().split('\n');
const eventsOf = (lines: string[], seq: number): AgentEvent[] => transcriptToEvents(lines.join('\n'), { seq, now: () => 1_700_000_000_000 }, 'claude-opus-5-5');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(history: (id: string) => Promise<AgentEvent[]>) {
  const taps = new Set<(c: string, a: unknown[]) => void>();
  const loads: string[] = [];
  const warns: string[] = [];
  const feed = createMobileFeed({
    loadHistory: (id) => {
      loads.push(id);
      return history(id);
    },
    onBroadcast: (t) => {
      taps.add(t);
      return () => taps.delete(t);
    },
    warn: (m) => warns.push(m),
    announceMs: 5,
    pingMs: 60_000,
  });
  const broadcast = (channel: string, ...args: unknown[]) => taps.forEach((t) => t(channel, args));
  return { feed, taps, loads, warns, broadcast };
}

test('zero cost while nobody watches; armed by a read or a stream, disarmed when the last one leaves', async () => {
  const r = rig(async () => []);
  assert.equal(r.taps.size, 0, 'nothing tapped at rest');
  const off = r.feed.subscribeMobileFeed(() => {});
  assert.equal(r.taps.size, 1);
  off();
  assert.equal(r.taps.size, 0, 'unsubscribed with an empty cache ⇒ untapped');
});

test('history then live events: the phone sees both, and the stream announces the new version', async () => {
  const r = rig(async () => eventsOf(SAMPLE.slice(0, 1), 1_000_000));
  const msgs: FeedMessage[] = [];
  const off = r.feed.subscribeMobileFeed((m) => msgs.push(m));
  const c1 = await r.feed.getMobileConversation('w1');
  assert.deepEqual(c1.lines.map((l) => l.kind), ['user'], 'control: history only');
  for (const e of eventsOf(SAMPLE.slice(1), 2_000_000)) r.broadcast('agent:event', 'w1', e);
  r.broadcast('agent:event', 'other-ws', eventsOf(SAMPLE.slice(0, 1), 3_000_000)[0]); // not cached: ignored
  await sleep(30);
  const c2 = await r.feed.getMobileConversation('w1');
  assert.deepEqual(c2.lines.map((l) => l.kind), ['user', 'tool', 'assistant']);
  assert.ok(c2.version > c1.version);
  const conv = msgs.filter((m) => m.t === 'conv');
  assert.ok(conv.length >= 1 && conv.length < 4, `announcements are coalesced (got ${conv.length})`);
  assert.deepEqual(conv.at(-1), { t: 'conv', id: 'w1', v: c2.version });
  assert.equal(r.loads.length, 1, 'history read once — a normal turn end (nothing missed) never re-reads it');
  off();
});

test('an event arriving while history loads is not lost for good: the next turn end re-reads the history', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let call = 0;
  const r = rig(async () => {
    call++;
    if (call === 1) {
      await gate;
      return eventsOf(SAMPLE.slice(0, 1), 1_000_000);
    }
    return eventsOf(SAMPLE, 1_000_000);
  });
  const pending = r.feed.getMobileConversation('w1');
  for (const e of eventsOf(SAMPLE.slice(1, 2), 2_000_000)) r.broadcast('agent:event', 'w1', e); // dropped: loading
  release();
  const c1 = await pending;
  assert.deepEqual(c1.lines.map((l) => l.kind), ['user'], 'control: the mid-load event was dropped');
  r.broadcast('agent:event', 'w1', { type: 'turn-end', seq: 2_100_000, at: 1_700_000_001_000 } as unknown as AgentEvent);
  const c2 = await r.feed.getMobileConversation('w1');
  assert.equal(r.loads.length, 2, 'turn end ⇒ the history is re-read');
  assert.deepEqual(c2.lines.map((l) => l.kind), ['user', 'tool', 'assistant']);
});

test('LRU: at most MAX_CACHED conversations folded in memory', async () => {
  const r = rig(async () => []);
  for (let i = 0; i <= MAX_CACHED; i++) await r.feed.getMobileConversation(`w${i}`);
  const st = r.feed.mobileFeedState();
  assert.equal(st.cached.length, MAX_CACHED);
  assert.ok(!st.cached.includes('w0'), 'the least recently read is dropped');
});

test('a workspace change announces « workspaces » to open streams; an unreadable history degrades to live-only', async () => {
  const r = rig(async () => {
    throw new Error('EACCES');
  });
  const msgs: FeedMessage[] = [];
  const off = r.feed.subscribeMobileFeed((m) => msgs.push(m));
  r.broadcast('workspace:update', { id: 'w1' });
  assert.deepEqual(msgs, [{ t: 'workspaces' }]);
  const c = await r.feed.getMobileConversation('w1');
  assert.equal(c.ok, true);
  assert.equal(c.lines.length, 0);
  assert.equal(r.warns.length, 1);
  off();
});

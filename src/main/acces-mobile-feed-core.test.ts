// Accès mobile #337: the feed core — history fold, live fold, heal-on-turn-end, LRU, zero cost while nobody watches. Events come
// from a transcript captured from the real CLI through the real backfill normalizer, never hand-written SDK payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptToEvents } from '../shared/agent-transcript.ts';
import { createMobileFeed, EMPTY_RETRY_MAX, MAX_CACHED, type FeedMessage } from './acces-mobile-feed-core.ts';
import type { AgentEvent } from '../shared/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE = fs.readFileSync(path.join(root, 'scripts/fixtures/payloads/acces-mobile-transcript.sample.jsonl'), 'utf8').trim().split('\n');
const eventsOf = (lines: string[], seq: number): AgentEvent[] => transcriptToEvents(lines.join('\n'), { seq, now: () => 1_700_000_000_000 }, 'claude-opus-5-5');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(history: (id: string) => Promise<AgentEvent[]>, emptyRetryMs = 5, isRunning?: (id: string) => boolean) {
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
    emptyRetryMs,
    ...(isRunning ? { isRunning } : {}),
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

// ---- #337 review fixes ----

function askEvent(requestId: string): AgentEvent {
  return { type: 'permission-request', seq: 3_000_000, at: 1_700_000_000_900, requestId, toolUseId: null, name: 'AskUserQuestion', input: { questions: [{ question: 'Q ?', options: [{ label: 'a' }] }] } } as unknown as AgentEvent;
}

test('M1: the asks come from the LIVE parked list — an ask raised before the phone opened shows, an answered one goes', async () => {
  let live: AgentEvent[] | null = [askEvent('r-before')];
  const taps = new Set<(c: string, a: unknown[]) => void>();
  const feed = createMobileFeed({ loadHistory: async () => eventsOf(SAMPLE, 1_000_000), onBroadcast: (t) => (taps.add(t), () => taps.delete(t)), liveAsks: () => live as never });
  const c1 = await feed.getMobileConversation('w1');
  assert.deepEqual(c1.asks.map((a) => a.requestId), ['r-before'], 'raised before the phone was listening: still shown');
  // folded ghost: the fold saw an ask the desktop already answered — the live list wins
  taps.forEach((t) => t('agent:event', ['w1', askEvent('r-ghost')]));
  live = [];
  const c2 = await feed.getMobileConversation('w1');
  assert.deepEqual(c2.asks, [], 'answered elsewhere: gone at once');
  live = null; // no live session: the fold is all we have
  const c3 = await feed.getMobileConversation('w1');
  assert.deepEqual(c3.asks.map((a) => a.requestId), ['r-ghost'], 'control: without a session the fold is the source');
});

test('M2: « running » is the live status, not the history (which always ends with a synthetic turn end)', async () => {
  let busy = true;
  const feed = createMobileFeed({ loadHistory: async () => eventsOf(SAMPLE, 1_000_000), onBroadcast: () => () => {}, isRunning: () => busy });
  assert.equal((await feed.getMobileConversation('w1')).running, true);
  busy = false;
  assert.equal((await feed.getMobileConversation('w1')).running, false);
});

test('M3: a turn end that lands WHILE the history loads still heals — reload once idle, and the phone is told', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let loads = 0;
  const taps = new Set<(c: string, a: unknown[]) => void>();
  const msgs: FeedMessage[] = [];
  const feed = createMobileFeed({
    loadHistory: async () => {
      loads++;
      if (loads === 1) {
        await gate;
        return eventsOf(SAMPLE.slice(0, 1), 1_000_000);
      }
      return eventsOf(SAMPLE, 1_000_000);
    },
    onBroadcast: (t) => (taps.add(t), () => taps.delete(t)),
    announceMs: 5,
  });
  const off = feed.subscribeMobileFeed((m) => msgs.push(m));
  const pending = feed.getMobileConversation('w1');
  taps.forEach((t) => t('agent:event', ['w1', { type: 'turn-end', seq: 2_100_000, at: 1_700_000_001_000 } as unknown as AgentEvent]));
  release();
  await pending;
  await sleep(30);
  assert.ok(msgs.some((m) => m.t === 'conv'), 'the phone is told to refetch after a load that missed events');
  const c = await feed.getMobileConversation('w1');
  assert.equal(loads, 2, 're-folded from disk');
  assert.deepEqual(c.lines.map((l) => l.kind), ['user', 'tool', 'assistant'], 'the final reply is there');
  off();
});

test('sweep: an open stream keeps the conversations; without one, idle ones are dropped', async () => {
  let t = 1_000_000;
  const feed = createMobileFeed({ loadHistory: async () => [], onBroadcast: () => () => {}, now: () => t });
  await feed.getMobileConversation('w1');
  const off = feed.subscribeMobileFeed(() => {});
  t += 11 * 60_000;
  feed.sweep();
  assert.deepEqual(feed.mobileFeedState().cached, ['w1'], 'kept while a stream is open');
  off();
  feed.sweep();
  assert.deepEqual(feed.mobileFeedState().cached, [], 'dropped once nobody streams');
  assert.equal(feed.mobileFeedState().tapped, false, 'and the tap released');
});

// ---- #375: a workspace the phone opens right after it was launched — its transcript may not be on disk yet ----

test('#375 must-FAIL on the unfixed feed: an EMPTY history (the transcript was not on disk yet) is not trusted — the phone is told, and the next read heals', async () => {
  let calls = 0;
  const r = rig(async () => (++calls === 1 ? [] : eventsOf(SAMPLE.slice(0, 1), 1_000_000)));
  const msgs: FeedMessage[] = [];
  const off = r.feed.subscribeMobileFeed((m) => msgs.push(m));
  const first = await r.feed.getMobileConversation('w1');
  assert.deepEqual(first.lines, [], 'control: the first read found nothing');
  await sleep(60); // the heal timer fires (5 ms) and the announcement is coalesced (5 ms)
  const told = msgs.filter((m): m is Extract<FeedMessage, { t: 'conv' }> => m.t === 'conv');
  assert.ok(told.length >= 1 && told[0].v > first.version, `the phone must be told with a NEW version (it ignores the one it has): ${JSON.stringify(told)} vs ${first.version}`);
  const healed = await r.feed.getMobileConversation('w1');
  assert.deepEqual(healed.lines.map((l) => l.kind), ['user'], 'the re-read found the transcript');
  assert.equal(r.loads.length, 2);
  off();
});

test('#375: the heal is BOUNDED — a conversation that stays empty is re-read a few times, then left alone', async () => {
  const r = rig(async () => []);
  const msgs: FeedMessage[] = [];
  let v = -1;
  const off = r.feed.subscribeMobileFeed(async (m) => {
    if (m.t === 'conv' && m.v !== v) {
      v = m.v;
      msgs.push(m);
      const c = await r.feed.getMobileConversation('w1'); // the phone refetches on a new version
      v = c.version;
    }
  });
  await r.feed.getMobileConversation('w1');
  await sleep(400);
  const loadsAfter = r.loads.length;
  assert.ok(loadsAfter >= 2 && loadsAfter <= 6, `re-read a few times (got ${loadsAfter})`);
  await sleep(200);
  assert.equal(r.loads.length, loadsAfter, 'and then quiet: no endless polling of an empty workspace');
  off();
});

test('#375: a NON-empty history is never re-read on a timer (the live fold stays authoritative)', async () => {
  const r = rig(async () => eventsOf(SAMPLE.slice(0, 1), 1_000_000));
  const msgs: FeedMessage[] = [];
  const off = r.feed.subscribeMobileFeed((m) => msgs.push(m));
  await r.feed.getMobileConversation('w1');
  await sleep(80);
  assert.equal(msgs.filter((m) => m.t === 'conv').length, 0, 'no announcement from a timer');
  await r.feed.getMobileConversation('w1');
  assert.equal(r.loads.length, 1, 'one read');
  off();
});

test('#375: an entry evicted before its heal timer fires announces nothing afterwards', async () => {
  const r = rig(async (id) => (id === 'w-empty' ? [] : eventsOf(SAMPLE.slice(0, 1), 1_000_000)), 40);
  const msgs: FeedMessage[] = [];
  const off = r.feed.subscribeMobileFeed((m) => msgs.push(m));
  await r.feed.getMobileConversation('w-empty');
  for (let i = 0; i < MAX_CACHED; i++) await r.feed.getMobileConversation(`w${i}`); // evicts w-empty (the oldest)
  await sleep(120);
  assert.deepEqual(msgs.filter((m) => m.t === 'conv' && m.id === 'w-empty'), [], 'a dropped conversation stays silent');
  off();
});

test('#375 must-FAIL on the first heal: once LIVE events have filled an empty conversation, a lagging disk read never SHRINKS the live fold (the rig\'s conv/live-turn lost its user line)', async () => {
  // the workspace starts EMPTY, the human sends a message, the real turn's events arrive live — the CLI has not written its transcript
  // yet when the feed re-reads, so a re-read that replaced the live fold would drop the user line it already has.
  let calls = 0;
  const r = rig(async () => (++calls === 1 ? [] : eventsOf(SAMPLE.slice(1), 1_000_000)), 20); // a lagging disk: later reads miss the first line
  const off = r.feed.subscribeMobileFeed(() => {});
  const first = await r.feed.getMobileConversation('w1');
  assert.deepEqual(first.lines, [], 'control: opened empty');
  for (const e of eventsOf(SAMPLE, 2_000_000)) r.broadcast('agent:event', 'w1', e); // the live turn, complete (ends with its turn end)
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 200 && stable < 8; i++) {
    const c = await r.feed.getMobileConversation('w1'); // the phone keeps reading while the heal timers fire
    assert.deepEqual(c.lines.map((l) => l.kind), ['user', 'tool', 'assistant'], `read ${i}: the live fold is what the phone gets, user line included`);
    if (r.loads.length === last) stable++;
    else {
      stable = 0;
      last = r.loads.length;
    }
    await sleep(15);
  }
  assert.ok(last >= 2, `control: a re-read WAS attempted (the lagging disk was offered and refused) — got ${last}`);
  assert.ok(stable >= 8, 'and the attempts STOP: a disk that never catches up is not polled forever (the retry budget is spent)');
  off();
});

test('#375 must-FAIL on the first heal (review MAJOR): a SLOW first turn — the phone read an empty history while the turn runs; at the turn end the conversation is re-read and the user line the live fold never saw appears', async () => {
  let running = true;
  let calls = 0;
  const r = rig(async () => (++calls === 1 ? [] : eventsOf(SAMPLE, 1_000_000)), 15, () => running); // the transcript is complete on the 2nd read
  const off = r.feed.subscribeMobileFeed(() => {});
  const first = await r.feed.getMobileConversation('w1');
  assert.deepEqual(first.lines, [], 'control: the first read found nothing');
  await sleep(60); // the heal timer fires while the turn RUNS: the phone re-reads, nothing is re-read mid-turn
  await r.feed.getMobileConversation('w1');
  assert.equal(r.loads.length, 1, 'control: no disk re-read mid-turn (it would overlap the events still arriving)');
  for (const e of eventsOf(SAMPLE.slice(1), 2_000_000)) r.broadcast('agent:event', 'w1', e); // the turn streams in WITHOUT its user echo (emitted before the feed was armed)
  running = false; // …and ends
  const after = await r.feed.getMobileConversation('w1');
  assert.deepEqual(after.lines.map((l) => l.kind), ['user', 'tool', 'assistant'], 'the turn end re-folded from the complete transcript: the prompt is back');
  off();
});

test('#375: the heal is bounded to EXACTLY EMPTY_RETRY_MAX reads in all (the first + the retries), each retry announcing a new version', async () => {
  const r = rig(async () => [], 10);
  const seen: number[] = [];
  let v = -1;
  const off = r.feed.subscribeMobileFeed(async (m) => {
    if (m.t === 'conv' && m.v !== v) {
      seen.push(m.v);
      v = (await r.feed.getMobileConversation('w1')).version;
    }
  });
  v = (await r.feed.getMobileConversation('w1')).version;
  await sleep(500);
  assert.equal(r.loads.length, EMPTY_RETRY_MAX, 'the first read + EMPTY_RETRY_MAX - 1 re-reads (the last announcement finds the budget spent)');
  assert.equal(seen.length, EMPTY_RETRY_MAX, 'one announcement per retry, each a version the phone did not have');
  off();
});

test('#375: an empty conversation is NOT re-read while its turn runs (the retry waits for the turn end); it is once the turn is over', async () => {
  let running = true;
  const r = rig(async () => [], 10, () => running);
  const off = r.feed.subscribeMobileFeed(() => {});
  await r.feed.getMobileConversation('w1');
  await sleep(40);
  await r.feed.getMobileConversation('w1');
  await r.feed.getMobileConversation('w1');
  assert.equal(r.loads.length, 1, 'no re-read while running');
  running = false;
  await r.feed.getMobileConversation('w1');
  assert.equal(r.loads.length, 2, 'the first read after the turn re-reads');
  off();
});

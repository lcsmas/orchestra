// Accès mobile #337: the feed core — history fold, live fold, heal-on-turn-end, LRU, zero cost while nobody watches. Events come
// from a transcript captured from the real CLI through the real backfill normalizer, never hand-written SDK payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptToEvents } from '../shared/agent-transcript.ts';
import { createMobileFeed, HEAL_RETRY_MAX, MAX_CACHED, type FeedMessage } from './acces-mobile-feed-core.ts';
import type { AgentEvent } from '../shared/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE = fs.readFileSync(path.join(root, 'scripts/fixtures/payloads/acces-mobile-transcript.sample.jsonl'), 'utf8').trim().split('\n');
const eventsOf = (lines: string[], seq: number): AgentEvent[] => transcriptToEvents(lines.join('\n'), { seq, now: () => 1_700_000_000_000 }, 'claude-opus-5-5');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(history: (id: string) => Promise<AgentEvent[]>, healMs = 5, isRunning?: (id: string) => boolean, lagMs = 60) {
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
    healMs,
    lagMs,
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

test('#375: the heal is bounded to EXACTLY HEAL_RETRY_MAX re-reads after the first read, each retry announcing a new version', async () => {
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
  assert.equal(r.loads.length, 1 + HEAL_RETRY_MAX, 'the first read + HEAL_RETRY_MAX re-reads');
  assert.equal(seen.length, HEAL_RETRY_MAX, 'one announcement per retry, each a version the phone did not have');
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

// ---- #375 fix round (verifier MAJOR + reviewer F1): the heal is LEVEL-triggered — a read that may predate the CLI's flush is suspect ----

const kindsOf = (c: { lines: { kind: string }[] }) => c.lines.map((l) => l.kind);

test('#375 must-FAIL on 7377c71e (verifier MAJOR): a launch whose answer came BEFORE its conversation was first read — the first read is non-empty but stale, no event follows, and the phone must still get the answer', async () => {
  // the launch returns at the session's first output, so the turn's events are over when the phone opens; the CLI has flushed the user line only
  let calls = 0;
  const startedAt: number[] = [];
  const r = rig(async () => {
    startedAt.push(Date.now());
    return ++calls === 1 ? eventsOf(SAMPLE.slice(0, 1), 1_000_000) : eventsOf(SAMPLE, 1_000_000);
  }, 10);
  const msgs: FeedMessage[] = [];
  const off = r.feed.subscribeMobileFeed((m) => msgs.push(m));
  const t0 = Date.now();
  for (const e of eventsOf(SAMPLE.slice(1), 2_000_000)) r.broadcast('agent:event', 'w1', e); // w1 is not cached yet: the tap sees the answer, nothing folds it
  const first = await r.feed.getMobileConversation('w1');
  assert.deepEqual(kindsOf(first), ['user'], 'control: the first read is stale (user line only)');
  await sleep(50);
  const told = msgs.filter((m): m is Extract<FeedMessage, { t: 'conv' }> => m.t === 'conv' && m.v > first.version);
  assert.ok(told.length >= 1, 'the phone is told to read again, with a version it does not have');
  const healed = await r.feed.getMobileConversation('w1');
  assert.deepEqual(kindsOf(healed), ['user', 'tool', 'assistant'], 'the re-read brought the answer');
  await sleep(300); // the trust read (past the quiet window) happens, then nothing
  await r.feed.getMobileConversation('w1');
  const settled = r.loads.length;
  await sleep(250);
  assert.equal(r.loads.length, settled, 'and then quiet');
  assert.ok(settled <= 1 + HEAL_RETRY_MAX, `bounded (${settled} reads)`);
  assert.ok(startedAt[startedAt.length - 1] - t0 >= 60, `trust is EARNED: the last read started ${startedAt[startedAt.length - 1] - t0} ms after the last event, past the 60 ms quiet window`);
  off();
});

test('#375 must-FAIL on 7377c71e (reviewer F1): a post-turn read that lags by the head the live fold lacks is NOT a heal — equal message counts, the answer must not disappear', async () => {
  let calls = 0;
  const lag = eventsOf(SAMPLE.slice(0, 2), 1_000_000); // [user, tool]: the answer line is not flushed yet
  const r = rig(async () => (++calls === 1 ? [] : calls === 2 ? lag : eventsOf(SAMPLE, 1_000_000)), 10);
  const off = r.feed.subscribeMobileFeed(() => {});
  assert.deepEqual(kindsOf(await r.feed.getMobileConversation('w1')), [], 'control: opened empty');
  for (const e of eventsOf(SAMPLE.slice(1), 2_000_000)) r.broadcast('agent:event', 'w1', e); // the live turn WITHOUT its user echo: tool, assistant, turn end
  for (let i = 0; i < 40; i++) {
    const c = await r.feed.getMobileConversation('w1');
    assert.ok(kindsOf(c).includes('assistant'), `read ${i}: the answer stays on the phone (${kindsOf(c).join(',')}) — a lagging equal-length read must not replace the live fold`);
    await sleep(10);
  }
  assert.deepEqual(kindsOf(await r.feed.getMobileConversation('w1')), ['user', 'tool', 'assistant'], 'and the complete transcript, once it is past the quiet window, brings the head back');
  assert.ok(calls >= 3, `control: the lagging read AND the complete one were both offered (${calls})`);
  off();
});

test('#375: a QUIET conversation (its last agent event is older than the lag window) is read ONCE and never polled — stale-looking or not', async () => {
  const r = rig(async () => eventsOf(SAMPLE.slice(0, 1), 1_000_000), 10);
  const msgs: FeedMessage[] = [];
  const off = r.feed.subscribeMobileFeed((m) => msgs.push(m));
  for (const e of eventsOf(SAMPLE.slice(1), 2_000_000)) r.broadcast('agent:event', 'w1', e);
  await sleep(100); // > lagMs (60): the disk has had its time
  await r.feed.getMobileConversation('w1');
  await sleep(150);
  await r.feed.getMobileConversation('w1');
  assert.equal(r.loads.length, 1, 'one read');
  assert.equal(msgs.filter((m) => m.t === 'conv').length, 0, 'no announcement from a timer');
  off();
});

test('#375: a workspace that keeps emitting events is not polled without bound — the re-reads stop at HEAL_RETRY_MAX', async () => {
  const r = rig(async () => eventsOf(SAMPLE.slice(0, 1), 1_000_000), 5, undefined, 40); // a disk that never gets past the user line
  let v = -1;
  const off = r.feed.subscribeMobileFeed(async (m) => {
    if (m.t === 'conv' && m.v !== v) v = (await r.feed.getMobileConversation('w1')).version;
  });
  const tick = setInterval(() => r.broadcast('agent:event', 'w1', eventsOf(SAMPLE.slice(2, 3), 2_000_000)[0]), 4);
  v = (await r.feed.getMobileConversation('w1')).version;
  await sleep(500);
  clearInterval(tick);
  await sleep(300);
  assert.ok(r.loads.length <= 1 + HEAL_RETRY_MAX + 1, `bounded: ${r.loads.length} reads`);
  const settled = r.loads.length;
  await sleep(250);
  assert.equal(r.loads.length, settled, 'quiet after the events stop');
  off();
});

test('#375: a spent retry budget is renewed at the next turn end — a disk that was empty for a while still heals when the turn arrives', async () => {
  let ready = false;
  const r = rig(async () => (ready ? eventsOf(SAMPLE, 1_000_000) : []), 5);
  let v = -1;
  const off = r.feed.subscribeMobileFeed(async (m) => {
    if (m.t === 'conv' && m.v !== v) v = (await r.feed.getMobileConversation('w1')).version;
  });
  v = (await r.feed.getMobileConversation('w1')).version;
  await sleep(300);
  assert.equal(r.loads.length, 1 + HEAL_RETRY_MAX, 'control: the budget is spent on the empty disk');
  ready = true;
  for (const e of eventsOf(SAMPLE.slice(1), 2_000_000)) r.broadcast('agent:event', 'w1', e); // the turn arrives, with its end
  await sleep(40);
  assert.deepEqual(kindsOf(await r.feed.getMobileConversation('w1')), ['user', 'tool', 'assistant'], 'the turn end re-read the (now complete) transcript');
  off();
});

test('#375: the last-event table is bounded (a long-lived main sees every workspace of the fleet)', async () => {
  const r = rig(async () => []);
  const off = r.feed.subscribeMobileFeed(() => {});
  const ev = eventsOf(SAMPLE.slice(0, 1), 1_000_000)[0];
  for (let i = 0; i < 400; i++) r.broadcast('agent:event', `ws-${i}`, ev);
  assert.ok(r.feed.mobileFeedState().activity <= 256, `tracked ${r.feed.mobileFeedState().activity}`);
  assert.ok(r.feed.mobileFeedState().activity > 0, 'control: it does track');
  off();
});

test('#375: driven like the phone (it refetches on every announcement), the heal ends with a read that STARTS after the quiet window — three reads, not the whole budget burnt inside it', async () => {
  const startedAt: number[] = [];
  const r = rig(async () => {
    startedAt.push(Date.now());
    return startedAt.length === 1 ? eventsOf(SAMPLE.slice(0, 1), 1_000_000) : eventsOf(SAMPLE, 1_000_000);
  }, 10);
  let v = -1;
  const off = r.feed.subscribeMobileFeed(async (m) => {
    if (m.t === 'conv' && m.v !== v) v = (await r.feed.getMobileConversation('w1')).version;
  });
  const t0 = Date.now();
  for (const e of eventsOf(SAMPLE.slice(1), 2_000_000)) r.broadcast('agent:event', 'w1', e);
  v = (await r.feed.getMobileConversation('w1')).version;
  await sleep(500);
  assert.equal(r.loads.length, 3, `the first read, a quick retry, and the read past the quiet window — got ${r.loads.length}`);
  assert.ok(startedAt[2] - t0 >= 60, `the last read started ${startedAt[2] - t0} ms after the last event (quiet window 60 ms)`);
  assert.deepEqual(kindsOf(await r.feed.getMobileConversation('w1')), ['user', 'tool', 'assistant']);
  off();
});

// ---- #375 fix round, pre-review findings ----

/** The phone: refetches on every announcement with a version it has not got. */
function phoneOf(r: ReturnType<typeof rig>, id = 'w1') {
  const told: Extract<FeedMessage, { t: 'conv' }>[] = [];
  let v = -1;
  let last: Awaited<ReturnType<typeof r.feed.getMobileConversation>> | null = null;
  const off = r.feed.subscribeMobileFeed(async (m) => {
    if (m.t === 'conv' && m.id === id && m.v !== v) {
      told.push(m);
      last = await r.feed.getMobileConversation(id);
      v = last.version;
    }
  });
  return { told, off, last: () => last, open: async () => { last = await r.feed.getMobileConversation(id); v = last.version; return last; } };
}

test('#375 must-FAIL (pre-review MAJOR 1): a read that comes back EMPTY at the moment trust would be earned (a failed read) does not earn it — the heal goes on', async () => {
  let calls = 0;
  const r = rig(async () => (++calls <= 2 ? eventsOf(SAMPLE.slice(0, 1), 1_000_000) : calls === 3 ? [] : eventsOf(SAMPLE, 1_000_000)), 10);
  const ph = phoneOf(r);
  for (const e of eventsOf(SAMPLE.slice(1), 2_000_000)) r.broadcast('agent:event', 'w1', e);
  await ph.open();
  await sleep(600);
  assert.ok(calls >= 4, `a fourth read was made after the empty third (${calls})`);
  assert.deepEqual(kindsOf(ph.last()!), ['user', 'tool', 'assistant']);
  ph.off();
});

test('#375 must-FAIL (pre-review 3): the store still says « running » when the turn-end read comes (its status lags the event) — the read is asked for again, not forgotten', async () => {
  let ready = false;
  let runningUntil = Infinity;
  const r = rig(async () => (ready ? eventsOf(SAMPLE, 1_000_000) : []), 10, () => Date.now() < runningUntil);
  const ph = phoneOf(r);
  runningUntil = Date.now() + 1;
  await ph.open(); // opened on an empty transcript
  ready = true;
  runningUntil = Date.now() + 45; // the turn ends below, but the store keeps saying « running » for ~45 ms
  for (const e of eventsOf(SAMPLE.slice(1), 2_000_000)) r.broadcast('agent:event', 'w1', e);
  await sleep(400);
  assert.deepEqual(kindsOf(ph.last()!), ['user', 'tool', 'assistant'], 'healed by the PHONE\'s own refetch once the status caught up (no manual read here)');
  ph.off();
});

test('#375: a LONG turn (the store says running for good) is not polled — the skipped heals are bounded and nothing is read', async () => {
  const r = rig(async () => [], 10, () => true);
  const ph = phoneOf(r);
  await ph.open();
  await sleep(500);
  assert.equal(r.loads.length, 1, 'no read mid-turn');
  assert.ok(ph.told.length <= HEAL_RETRY_MAX + 3, `the phone was told ${ph.told.length} times — bounded`);
  const settled = ph.told.length;
  await sleep(200);
  assert.equal(ph.told.length, settled, 'and then quiet');
  ph.off();
});

test('#375 must-FAIL (pre-review 4): the turn end lands INSIDE the last budgeted read — its events are lost, the follow-up read is still owed', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => (release = res));
  const r = rig(async () => {
    calls++;
    if (calls === HEAL_RETRY_MAX + 1) {
      await gate; // the last budgeted re-read: slow, and it saw the transcript BEFORE the CLI flushed
      return [];
    }
    return calls > HEAL_RETRY_MAX + 1 ? eventsOf(SAMPLE, 1_000_000) : [];
  }, 10);
  const ph = phoneOf(r);
  await ph.open();
  for (let i = 0; i < 100 && calls < HEAL_RETRY_MAX + 1; i++) await sleep(10);
  assert.equal(calls, HEAL_RETRY_MAX + 1, 'control: the last budgeted read is in flight');
  for (const e of eventsOf(SAMPLE.slice(1), 2_000_000)) r.broadcast('agent:event', 'w1', e); // the turn arrives and ends meanwhile: dropped (the entry is loading)
  release();
  await sleep(300);
  assert.deepEqual(kindsOf(ph.last()!), ['user', 'tool', 'assistant'], 'the follow-up read happened');
  ph.off();
});

test('#375 must-FAIL (pre-review 5): retries of an EMPTY transcript are spaced by the heal pace even when the last event is long past', async () => {
  const at: number[] = [];
  const r = rig(async () => {
    at.push(Date.now());
    return [];
  }, 40, undefined, 30);
  const ph = phoneOf(r);
  r.broadcast('agent:event', 'w1', eventsOf(SAMPLE.slice(0, 1), 1_000_000)[0]);
  await sleep(80); // quiet window (30 ms) long over: the trust time is in the past
  await ph.open();
  await sleep(450);
  assert.ok(at.length >= 4, `control: several retries (${at.length})`);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 30, `gap ${i}: ${at[i] - at[i - 1]} ms (heal pace 40)`);
  ph.off();
});

test('#375 must-FAIL (pre-review 5): hot is judged from when the read STARTED, not when it ended — a slow read of a stale transcript is still suspect', async () => {
  const r = rig(async () => {
    await sleep(80); // a long read: it ends past the quiet window (60 ms) though it began inside it
    return eventsOf(SAMPLE.slice(0, 1), 1_000_000);
  }, 10);
  const ph = phoneOf(r);
  r.broadcast('agent:event', 'w1', eventsOf(SAMPLE.slice(1), 2_000_000)[0]);
  const first = await ph.open();
  void first;
  await sleep(120);
  assert.ok(ph.told.length >= 1, 'the phone was told to read again');
  ph.off();
});

test('#375: the DEFAULT pace and quiet window apply when a feed is built without them — one second to the first retry, a window longer than a few ms', async () => {
  const taps = new Set<(c: string, a: unknown[]) => void>();
  const feed = createMobileFeed({ loadHistory: async () => eventsOf(SAMPLE.slice(0, 1), 1_000_000), onBroadcast: (t) => (taps.add(t), () => taps.delete(t)), announceMs: 5, pingMs: 60_000 });
  const told: number[] = [];
  const t0 = Date.now();
  const off = feed.subscribeMobileFeed((m) => m.t === 'conv' && told.push(Date.now() - t0));
  taps.forEach((tap) => tap('agent:event', ['w1', eventsOf(SAMPLE.slice(1), 2_000_000)[0]]));
  await sleep(30);
  await feed.getMobileConversation('w1');
  await sleep(1400);
  assert.equal(told.length >= 1, true, 'the heal fired at all (a default quiet window of a few ms would have trusted the first read)');
  assert.ok(told[0] >= 900 && told[0] <= 1300, `the first retry came ${told[0]} ms after the event (default pace 1 s)`);
  off();
});

test('#375: the last-event table drops the LEAST recently active workspace, not the first inserted — a workspace that just spoke stays tracked', async () => {
  const r = rig(async () => eventsOf(SAMPLE.slice(0, 1), 1_000_000), 10, undefined, 5000);
  const ph = phoneOf(r, 'ws-A');
  const ev = eventsOf(SAMPLE.slice(0, 1), 1_000_000)[0];
  r.broadcast('agent:event', 'ws-A', ev);
  for (let i = 0; i < 255; i++) r.broadcast('agent:event', `ws-${i}`, ev);
  r.broadcast('agent:event', 'ws-A', ev); // A speaks again: now the MOST recent
  for (let i = 300; i < 320; i++) r.broadcast('agent:event', `ws-${i}`, ev); // 20 newcomers push the oldest out
  await ph.open();
  await sleep(100);
  assert.ok(ph.told.length >= 1, 'A is still tracked ⇒ its first read was hot ⇒ the phone is told to read again');
  ph.off();
});

test('#375 (known transient, pinned): a hot read that is LONGER than the live fold but lacks its tail replaces it for a moment — the answer is back after the next read', async () => {
  // count-based « grows » cannot tell a longer-but-staler read from a fresher one; the entry stays suspect, so the quiet-window read repairs it
  let calls = 0;
  const r = rig(async () => (++calls === 1 ? [] : calls === 2 ? eventsOf(SAMPLE.slice(0, 2), 1_000_000) : eventsOf(SAMPLE, 1_000_000)), 10);
  const ph = phoneOf(r);
  await ph.open();
  for (const e of eventsOf(SAMPLE.slice(2), 2_000_000)) r.broadcast('agent:event', 'w1', e); // the live fold: the answer only
  await sleep(500);
  assert.deepEqual(kindsOf(ph.last()!), ['user', 'tool', 'assistant'], 'repaired');
  assert.ok(calls <= 1 + HEAL_RETRY_MAX, `bounded (${calls})`);
  ph.off();
});

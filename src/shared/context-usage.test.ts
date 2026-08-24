import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLiveContextUsage,
  normalizeContextCommandUsage,
  contextUsageFromTranscript,
  computePercentage,
  usedTokens,
  isDeferredCategory,
  isMoreAuthoritative,
  transcriptContextTokens,
  resolveContextUsage,
  transcriptContextWindow,
  STALE_MS,
  type ContextUsage,
} from './context-usage.ts';

// Fixtures are the payloads VERIFIED against CLI 2.1.234 and captured in
// docs/research/sdk-runtime-payloads.md — not invented shapes. Using the real
// captures is what makes these tests evidence about the wire contract rather
// than a second implementation of my own assumptions.

/** `Query.getContextUsage()` — camelCase, `isDeferred` booleans, TUI colors. */
const LIVE_PAYLOAD = {
  categories: [
    { name: 'System tools', tokens: 14144, color: 'inactive' },
    { name: 'MCP tools (deferred)', tokens: 52191, color: 'inactive', isDeferred: true },
    { name: 'System tools (deferred)', tokens: 15618, color: 'inactive', isDeferred: true },
    { name: 'Memory files', tokens: 52060, color: 'claude' },
    { name: 'Skills', tokens: 1993, color: 'warning' },
    { name: 'Messages', tokens: 4994, color: 'purple_FOR_SUBAGENTS_ONLY' },
    { name: 'Free space', tokens: 126809, color: 'promptBorder' },
  ],
  totalTokens: 73191,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  autocompactSource: 'auto',
  percentage: 37,
  model: 'claude-haiku-4-5-20251001',
  gridRows: [],
};

/** The `context_usage` field on a `/context` result — snake_case, `kind` enum. */
const COMMAND_PAYLOAD = {
  model: 'claude-haiku-4-5-20251001',
  total_tokens: 68205,
  raw_max_tokens: 200000,
  percentage: 34,
  categories: [
    { name: 'System tools', tokens: 14144, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 24056, kind: 'deferred' },
    { name: 'System tools (deferred)', tokens: 15618, kind: 'deferred' },
    { name: 'Memory files', tokens: 52060, kind: 'used' },
    { name: 'Skills', tokens: 1993, kind: 'used' },
    { name: 'Messages', tokens: 8, kind: 'used' },
    { name: 'Free space', tokens: 131795, kind: 'free' },
  ],
};

test('normalizeLiveContextUsage maps the verified getContextUsage() payload', () => {
  const u = normalizeLiveContextUsage(LIVE_PAYLOAD, 1000);
  assert.ok(u);
  assert.equal(u.totalTokens, 73191);
  assert.equal(u.maxTokens, 200000);
  assert.equal(u.percentage, 37); // matches the CLI's own reported percentage
  assert.equal(u.model, 'claude-haiku-4-5-20251001');
  assert.equal(u.source, 'live');
  assert.equal(u.at, 1000);
});

test('live payload: isDeferred rows become kind=deferred, Free space becomes free', () => {
  const u = normalizeLiveContextUsage(LIVE_PAYLOAD, 0);
  const byName = new Map(u!.categories!.map((c) => [c.name, c.kind]));
  assert.equal(byName.get('MCP tools (deferred)'), 'deferred');
  assert.equal(byName.get('System tools (deferred)'), 'deferred');
  assert.equal(byName.get('Free space'), 'free');
  assert.equal(byName.get('Memory files'), 'used');
  assert.equal(byName.get('Messages'), 'used');
});

// The trap this module exists to prevent: deferred tool schemas are listed but
// held OUT of the window. Summing every row would report 267,809 tokens against
// a 200K window — a >100% gauge on a session that is 37% full.
test('deferred tokens are excluded from usage math, not folded into the total', () => {
  const u = normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!;
  const naiveSum = u.categories!.reduce((s, c) => s + c.tokens, 0);
  assert.equal(naiveSum, 267809);
  assert.ok(naiveSum > u.maxTokens!, 'fixture must exercise the overflow case');
  // The headline number comes from the producer, so it is unaffected.
  assert.equal(u.totalTokens, 73191);
  // used-only excludes deferred AND free.
  assert.equal(usedTokens(u.categories!), 14144 + 52060 + 1993 + 4994);
  assert.equal(u.categories!.filter(isDeferredCategory).length, 2);
});

test('normalizeContextCommandUsage maps the verified /context payload', () => {
  const u = normalizeContextCommandUsage(COMMAND_PAYLOAD, 55);
  assert.ok(u);
  assert.equal(u.totalTokens, 68205);
  assert.equal(u.maxTokens, 200000);
  assert.equal(u.percentage, 34); // matches the CLI's own reported percentage
  assert.equal(u.source, 'context-command');
  assert.equal(u.at, 55);
  const byName = new Map(u.categories!.map((c) => [c.name, c.kind]));
  assert.equal(byName.get('MCP tools (deferred)'), 'deferred');
  assert.equal(byName.get('Free space'), 'free');
  assert.equal(byName.get('System tools'), 'used');
});

test('both wire shapes converge on the same normalized structure', () => {
  const live = normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!;
  const cmd = normalizeContextCommandUsage(COMMAND_PAYLOAD, 0)!;
  assert.deepEqual(Object.keys(live).sort(), Object.keys(cmd).sort());
  // Same categories, same classification — only the source tag differs.
  assert.deepEqual(
    live.categories!.map((c) => c.kind),
    cmd.categories!.map((c) => c.kind),
  );
});

test('unknown category kinds degrade to used rather than dropping the row', () => {
  const u = normalizeContextCommandUsage(
    { total_tokens: 10, raw_max_tokens: 100, categories: [{ name: 'Future', tokens: 5, kind: 'something-new' }] },
    0,
  );
  assert.equal(u!.categories!.length, 1);
  assert.equal(u!.categories![0].kind, 'used');
});

test('malformed rows are skipped, not crashed on', () => {
  const u = normalizeLiveContextUsage(
    {
      totalTokens: 10,
      rawMaxTokens: 100,
      categories: [null, 'nope', { name: 'ok', tokens: 5 }, { name: 'no tokens' }, { tokens: 1 }],
    },
    0,
  );
  assert.equal(u!.categories!.length, 1);
  assert.equal(u!.categories![0].name, 'ok');
});

// A payload we cannot read must yield null so the caller falls back to the
// transcript. Returning a zeroed reading would hit the app's "context was
// reset" sentinel and wrongly CLEAR the badge.
test('unusable payloads return null so the caller can fall back', () => {
  assert.equal(normalizeLiveContextUsage(null, 0), null);
  assert.equal(normalizeLiveContextUsage(undefined, 0), null);
  assert.equal(normalizeLiveContextUsage({}, 0), null);
  assert.equal(normalizeLiveContextUsage({ totalTokens: 'lots' }, 0), null);
  assert.equal(normalizeLiveContextUsage({ totalTokens: NaN }, 0), null);
  assert.equal(normalizeContextCommandUsage({}, 0), null);
  assert.equal(normalizeContextCommandUsage({ total_tokens: null }, 0), null);
});

test('a zero total is a real reading, not an unusable payload', () => {
  const u = normalizeLiveContextUsage({ totalTokens: 0, rawMaxTokens: 200000 }, 0);
  assert.ok(u);
  assert.equal(u.totalTokens, 0);
  assert.equal(u.percentage, 0);
});

test('rawMaxTokens wins over maxTokens so both sources share a denominator', () => {
  const u = normalizeLiveContextUsage(
    { totalTokens: 50000, maxTokens: 160000, rawMaxTokens: 200000 },
    0,
  )!;
  assert.equal(u.maxTokens, 200000);
  assert.equal(u.percentage, 25);
});

test('maxTokens is used when rawMaxTokens is absent', () => {
  const u = normalizeLiveContextUsage({ totalTokens: 50000, maxTokens: 200000 }, 0)!;
  assert.equal(u.maxTokens, 200000);
});

test('percentage is unknown, not zero, when the window is unknown', () => {
  const u = normalizeLiveContextUsage({ totalTokens: 1234 }, 0)!;
  assert.equal(u.maxTokens, null);
  assert.equal(u.percentage, null);
  assert.equal(computePercentage(1234, null), null);
  assert.equal(computePercentage(1234, 0), null);
});

// An over-limit session genuinely reads past 100%; pinning it to 100 would hide
// exactly the state the gauge exists to warn about.
test('over-limit usage exceeds 100% rather than clamping', () => {
  const u = normalizeLiveContextUsage({ totalTokens: 220000, rawMaxTokens: 200000 }, 0)!;
  assert.equal(u.percentage, 110);
});

// The transcript records NO window (verified absent on every real assistant
// line), but a detached/history pane must still show a percentage — so the
// window is DERIVED from the model id, reusing the app's existing rules rather
// than a second convention.
test('contextUsageFromTranscript derives the default window when the model is unknown', () => {
  const u = contextUsageFromTranscript(50000, 7);
  assert.equal(u.totalTokens, 50000);
  assert.equal(u.maxTokens, 200_000);
  assert.equal(u.percentage, 25);
  assert.equal(u.source, 'transcript');
  assert.equal(u.at, 7);
});

test('contextUsageFromTranscript honours a [1m] long-context model id', () => {
  const u = contextUsageFromTranscript(500_000, 0, 'claude-opus-4-8[1m]');
  assert.equal(u.maxTokens, 1_000_000);
  assert.equal(u.percentage, 50);
  assert.equal(u.model, 'claude-opus-4-8[1m]');
});

test('a plain model id gets the default window, not the 1M one', () => {
  const u = contextUsageFromTranscript(50000, 0, 'claude-opus-4-8');
  assert.equal(u.maxTokens, 200_000);
  assert.equal(u.percentage, 25);
});

test('transcriptContextWindow maps model ids to windows', () => {
  assert.equal(transcriptContextWindow(null), 200_000);
  assert.equal(transcriptContextWindow(undefined), 200_000);
  assert.equal(transcriptContextWindow(''), 200_000);
  assert.equal(transcriptContextWindow('claude-opus-5'), 200_000);
  assert.equal(transcriptContextWindow('claude-opus-4-8[1m]'), 1_000_000);
});

// A transcript reading is an ASSUMED window, so it must still lose to a live
// one — otherwise a wrong assumption would outlive the real measurement.
test('a derived-window transcript reading still loses to a live reading', () => {
  const t = contextUsageFromTranscript(50000, 1000, 'claude-opus-5');
  assert.equal(t.maxTokens, 200_000);
  assert.equal(isMoreAuthoritative(live(500), t), true);
});

// ── precedence ──────────────────────────────────────────────────────────────

const live = (at: number): ContextUsage => normalizeLiveContextUsage(LIVE_PAYLOAD, at)!;
const transcript = (at: number): ContextUsage => contextUsageFromTranscript(50000, at);

test('any reading is accepted when there is none yet', () => {
  assert.equal(isMoreAuthoritative(transcript(0), undefined), true);
  assert.equal(isMoreAuthoritative(live(0), undefined), true);
});

test('a live reading always supersedes a transcript one', () => {
  assert.equal(isMoreAuthoritative(live(2000), transcript(1000)), true);
  // Even when the transcript reading is NEWER — authority beats recency here.
  assert.equal(isMoreAuthoritative(live(1000), transcript(2000)), true);
});

// The core regression this gate prevents: shell-hook posttools fire constantly
// and would otherwise clobber the CLI's exact figure seconds after it landed.
test('a fresh transcript reading does NOT clobber a current live one', () => {
  assert.equal(isMoreAuthoritative(transcript(1500), live(1000)), false);
});

test('a stale live reading yields to the transcript so the gauge cannot freeze', () => {
  const prev = live(1000);
  assert.equal(isMoreAuthoritative(transcript(1000 + STALE_MS), prev), false);
  assert.equal(isMoreAuthoritative(transcript(1000 + STALE_MS + 1), prev), true);
});

test('equal authority takes the newer reading', () => {
  assert.equal(isMoreAuthoritative(live(2000), live(1000)), true);
  assert.equal(isMoreAuthoritative(live(1000), live(2000)), false);
  assert.equal(isMoreAuthoritative(transcript(2000), transcript(1000)), true);
});

test('context-command outranks transcript but not live', () => {
  const cmd = normalizeContextCommandUsage(COMMAND_PAYLOAD, 1500)!;
  assert.equal(isMoreAuthoritative(cmd, transcript(1000)), true);
  assert.equal(isMoreAuthoritative(cmd, live(1000)), false);
});

// ── transcript fallback (history / detached sessions, no live Query) ─────────

test('transcriptContextTokens sums the three input components, excluding output', () => {
  assert.equal(
    transcriptContextTokens({
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 3,
      // Output is what the model PRODUCED, not what was fed back in.
      output_tokens: 9999,
    } as Record<string, unknown>),
    123,
  );
});

test('transcriptContextTokens returns 0 for absent/garbage usage', () => {
  assert.equal(transcriptContextTokens(null), 0);
  assert.equal(transcriptContextTokens(undefined), 0);
  assert.equal(transcriptContextTokens({}), 0);
  assert.equal(transcriptContextTokens({ input_tokens: 'lots' }), 0);
  assert.equal(transcriptContextTokens({ input_tokens: NaN }), 0);
});

test('transcriptContextTokens tolerates partially-present components', () => {
  assert.equal(transcriptContextTokens({ input_tokens: 50 }), 50);
  assert.equal(transcriptContextTokens({ cache_read_input_tokens: 7 }), 7);
});

// ── resolveContextUsage — the gauge's single sourcing decision ───────────────
//
// The provenance seam: a driver must be able to assert WHICH producer fed the
// gauge. A fabricated turn-end and a real live reading can render the same
// number, so the tag — not the value — is the evidence.

test('resolveContextUsage prefers an emitted reading over turn-end fields', () => {
  const live = normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!;
  const r = resolveContextUsage(live, { contextUsedTokens: 999, contextWindow: 1000 });
  assert.equal(r!.source, 'live');
  assert.equal(r!.totalTokens, 73191);
});

test('resolveContextUsage falls back to turn-end fields, tagged as such', () => {
  const r = resolveContextUsage(undefined, { contextUsedTokens: 50000, contextWindow: 200000 });
  assert.ok(r);
  assert.equal(r.source, 'turn-end');
  assert.equal(r.totalTokens, 50000);
  assert.equal(r.maxTokens, 200000);
  assert.equal(r.percentage, 25);
});

test('resolveContextUsage keeps a turn-end reading whose window is unknown', () => {
  // The exact case that used to render NOTHING: modelUsage reported no window.
  const r = resolveContextUsage(undefined, { contextUsedTokens: 50000, contextWindow: null });
  assert.ok(r, 'a windowless turn-end must still yield a reading');
  assert.equal(r.source, 'turn-end');
  assert.equal(r.maxTokens, null);
  assert.equal(r.percentage, null);
});

test('resolveContextUsage returns null when there is nothing to show', () => {
  assert.equal(resolveContextUsage(undefined, undefined), null);
  assert.equal(resolveContextUsage(undefined, {}), null);
  assert.equal(resolveContextUsage(undefined, { contextUsedTokens: 0 }), null);
  assert.equal(resolveContextUsage(undefined, { contextUsedTokens: null }), null);
});

test('a transcript reading still beats turn-end fields', () => {
  const r = resolveContextUsage(contextUsageFromTranscript(48000, 5), {
    contextUsedTokens: 999,
    contextWindow: 1000,
  });
  assert.equal(r!.source, 'transcript');
  assert.equal(r!.totalTokens, 48000);
});

test('turn-end ranks below every emitted source', () => {
  const te = resolveContextUsage(undefined, { contextUsedTokens: 1, contextWindow: 2 })!;
  // Any emitted reading must supersede a synthesized turn-end one.
  assert.equal(isMoreAuthoritative(contextUsageFromTranscript(10, 0), te), true);
  assert.equal(isMoreAuthoritative(live(0), te), true);
});

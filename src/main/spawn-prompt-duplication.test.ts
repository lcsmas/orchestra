// Issue #112 — a spawned agent must not receive its brief twice.
//
// ── The field failure ───────────────────────────────────────────────────────
//
// `orchestra spawn --task "<brief>"` on a repo with slow session init (the
// reporter's `metarepo`: a 55 KB CLAUDE.md with 25 `@imports`, MCP handshakes)
// produced workspaces that sat `idle` for 10+ minutes, and one that woke up
// ~15 min later and ran a brief that had ALREADY been respawned elsewhere —
// two PRs for one task. `orchestra.log` showed, 4 seconds after the spawn:
//
//     16:49:24 [WARN] getContextUsage failed for 4fd681ed-…: timed out
//     16:49:25 [INFO] re-sending 1 pending prompt(s) lost to a quit for …
//
// Nothing had quit. `startWorkspaceAgentHeadless` sends the task through
// `sdkSend`, which parks it on `ws.sdkPendingPrompts` as quit insurance; the
// renderer then mounts the new workspace's `StructuredView` (panes mount for
// the whole LRU set, not just the active one) which calls `agentSdkHistory` →
// `recoverPendingPrompts`. The CLI writes a user line to the transcript only
// once it STARTS the turn, so during init the freshly-sent task is absent from
// disk — byte-for-byte the same observable as a prompt lost to a quit. The
// recovery re-sent it, and CLEARED the entry, destroying the real insurance.
//
// ── What this file gates ────────────────────────────────────────────────────
//
// The decision is pure, so it is EXECUTED here rather than grepped: the tests
// compose `partitionLivePrompts` + `filterUnconsumedPrompts` exactly as
// `recoverPendingPrompts` does, and the first one FAILS on the pre-fix
// composition (which was `filterUnconsumedPrompts(pending, …)` with no live
// partition at all) — see `test('unfixed composition …')`, which reproduces the
// old behaviour explicitly so the gate cannot go vacuously green.
//
// The wiring — that `recoverPendingPrompts` really calls the partition, that
// `sdkSend` stores the queue entry's own uuid, and that the result-boundary
// clear no longer wipes still-queued entries — is pinned by source assertions
// at the bottom, for the same reason turn-start-stamp.test.ts uses them:
// agent-sdk.ts cannot be imported under `node --test` (Electron + extensionless
// directory imports).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  countConsumedKeys,
  filterUnconsumedPrompts,
  partitionLivePrompts,
  pendingPromptKey,
  type PendingPrompt,
} from '../shared/pending-prompts.ts';

const ROOT = process.cwd();
const AGENT_SDK = path.join(ROOT, 'src', 'main', 'agent-sdk.ts');

/** One pending entry keyed exactly as `sdkSend` keys it. `id` is the turn's
 *  `rewindId` — the same uuid the live session's queue entry carries. */
function entry(id: string, text: string): PendingPrompt {
  return { id, key: pendingPromptKey({ text }), text };
}

/** The recovery decision, composed exactly as `recoverPendingPrompts` does. */
function decide(
  pending: readonly PendingPrompt[],
  liveIds: ReadonlySet<string>,
  transcriptUserTexts: readonly string[],
): { resend: PendingPrompt[]; keptInStore: PendingPrompt[] } {
  const { live, recoverable } = partitionLivePrompts(pending, liveIds);
  const consumed = countConsumedKeys(transcriptUserTexts.map((text) => ({ text })));
  return { resend: filterUnconsumedPrompts(recoverable, consumed), keptInStore: live };
}

const BRIEF = 'Review PR 1566 and report the import-builder findings.';
const TASK_UUID = '1f2d9149-1a05-42e7-91c8-14b8198b0ece';

// ── The reported failure, as an executable case ─────────────────────────────

test('#112: a task still queued behind session init is NOT re-sent', () => {
  const pending = [entry(TASK_UUID, BRIEF)];
  // The live session holds it: `sdkSend` pushed it onto `session.queue` and the
  // CLI has not started the turn, so the transcript is still empty.
  const live = new Set([TASK_UUID]);

  const { resend, keptInStore } = decide(pending, live, []);

  assert.deepEqual(resend, [], 'a queued-but-unstarted task must never be re-sent');
  assert.deepEqual(
    keptInStore.map((p) => p.id),
    [TASK_UUID],
    'and its insurance must SURVIVE the pass — clearing it loses the prompt if the app quits next',
  );
});

test('#112: the same input on the UNFIXED composition re-sends — the gate is not vacuous', () => {
  // The pre-fix body, verbatim in shape: no live partition, transcript-only.
  const pending = [entry(TASK_UUID, BRIEF)];
  const consumed = countConsumedKeys([]);
  const missingUnfixed = filterUnconsumedPrompts(pending, consumed);

  assert.equal(
    missingUnfixed.length,
    1,
    'the old composition really did classify a live queued prompt as lost — ' +
      'if this ever reads 0 the first test proves nothing',
  );
});

test('#112: the turn IN FLIGHT is live too (yielded, but not yet on disk)', () => {
  // `promptStream` shifts the entry OFF the queue before yielding it, and the
  // CLI may not have flushed the user line yet. Queue membership alone would
  // read this as lost, which is why `livePromptIds` also folds in
  // `session.gateTurnUuid`.
  const pending = [entry(TASK_UUID, BRIEF)];
  const live = new Set([TASK_UUID]); // contributed by gateTurnUuid, queue empty

  assert.deepEqual(decide(pending, live, []).resend, []);
});

// ── The quit case this feature exists for must still work ───────────────────

test('#112: with NO live session, a prompt absent from the transcript is still recovered', () => {
  const pending = [entry(TASK_UUID, BRIEF)];
  // App quit: `sessions` has no entry, so `livePromptIds` returns an empty set.
  const { resend, keptInStore } = decide(pending, new Set(), []);

  assert.deepEqual(resend.map((p) => p.text), [BRIEF], 'quit recovery must be untouched');
  assert.deepEqual(keptInStore, [], 'nothing to preserve when nothing is live');
});

test('#112: a prompt that DID run is still dropped, live session or not', () => {
  const pending = [entry(TASK_UUID, BRIEF)];
  const { resend, keptInStore } = decide(pending, new Set(), [BRIEF]);
  assert.deepEqual(resend, [], 'transcript-covered entries are done for good');
  assert.deepEqual(keptInStore, []);
});

test('#112: live and lost entries in one pass are handled independently', () => {
  const lostText = 'Also update the ledger.';
  const pending = [entry(TASK_UUID, BRIEF), entry('b0000000-0000-4000-8000-000000000002', lostText)];
  // Only the first is still held by the session (the second was sent before a
  // quit and its session is gone).
  const { resend, keptInStore } = decide(pending, new Set([TASK_UUID]), []);

  assert.deepEqual(resend.map((p) => p.text), [lostText], 'the genuinely lost one is recovered');
  assert.deepEqual(keptInStore.map((p) => p.id), [TASK_UUID], 'the live one is left alone');
});

test('#112: identical bodies are told apart by id, not text', () => {
  // Two sends of the SAME brief: one still queued in the live session, one lost
  // to a quit. A body-keyed predicate cannot separate them; `id` can.
  const liveId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const lostId = 'bbbbbbbb-0000-4000-8000-000000000002';
  const pending = [entry(lostId, BRIEF), entry(liveId, BRIEF)];

  const { resend, keptInStore } = decide(pending, new Set([liveId]), []);

  assert.deepEqual(resend.map((p) => p.id), [lostId]);
  assert.deepEqual(keptInStore.map((p) => p.id), [liveId]);
});

test('partitionLivePrompts preserves order and never invents or drops entries', () => {
  const ids = ['i1', 'i2', 'i3', 'i4'];
  const pending = ids.map((id, n) => entry(id, `prompt ${n}`));
  const { live, recoverable } = partitionLivePrompts(pending, new Set(['i2', 'i4']));

  assert.deepEqual(live.map((p) => p.id), ['i2', 'i4']);
  assert.deepEqual(recoverable.map((p) => p.id), ['i1', 'i3']);
  assert.equal(live.length + recoverable.length, pending.length, 'partition must be total');
});

// ── Wiring: the pure decision above must be the one main actually runs ──────

/** agent-sdk.ts with comment lines stripped, so PROSE about the fix cannot
 *  satisfy an assertion about the CODE. */
function agentSdkCode(): string {
  const stripped = fs
    .readFileSync(AGENT_SDK, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  assert.ok(stripped.length > 50_000, 'comment-stripping agent-sdk.ts returned too little');
  return stripped;
}

/** The body of `recoverPendingPrompts`, so a file-wide grep cannot stand in for
 *  a check about THIS function. */
function recoverBody(code: string): string {
  const start = code.indexOf('export async function recoverPendingPrompts');
  assert.notEqual(start, -1, 'recoverPendingPrompts not found — was it renamed?');
  const rest = code.slice(start);
  const end = rest.indexOf('\n}\n');
  assert.notEqual(end, -1, 'recoverPendingPrompts has no closing brace at column 0');
  return rest.slice(0, end);
}

test('wiring: recoverPendingPrompts partitions on the LIVE session before recovering', () => {
  const body = recoverBody(agentSdkCode());
  assert.match(
    body,
    /partitionLivePrompts\(\s*pending,\s*livePromptIds\(wsId\)\s*\)/,
    'the live partition must be computed from the live session, not from the transcript',
  );
  assert.match(
    body,
    /filterUnconsumedPrompts\(\s*recoverable\s*,/,
    'the transcript filter must run over `recoverable`, never over the full `pending` list',
  );
  assert.doesNotMatch(
    body,
    /\bawait clearPendingPrompts\(wsId\)/,
    'the blanket clear must be gone — it deleted the insurance for still-live prompts',
  );
  assert.match(
    body,
    /keepOnlyPendingPrompts\(wsId,\s*live\)/,
    'live entries must be written back, not dropped',
  );
});

test('wiring: livePromptIds reads BOTH the queue and the in-flight turn', () => {
  const code = agentSdkCode();
  const start = code.indexOf('function livePromptIds');
  assert.notEqual(start, -1, 'livePromptIds not found — was it renamed?');
  const body = code.slice(start, start + code.slice(start).indexOf('\n}\n'));

  assert.match(body, /sessions\.get\(wsId\)/, 'must consult the live session map');
  assert.match(body, /for \(const m of session\.queue\)/, 'must include queued turns');
  assert.match(body, /session\.gateTurnUuid/, 'must include the turn already yielded to the SDK');
  assert.match(
    body,
    /if \(!session\) return new Set\(\)/,
    'no live session must mean NO live ids — that is the quit case recovery exists for',
  );
});

test('wiring: sdkSend stores the queue entry uuid as the pending id', () => {
  const code = agentSdkCode();
  // The entry literal must key `id` to `rewindId` — the same token that becomes
  // `SDKUserMessage.uuid` and therefore `session.queue[n].uuid`. A fresh
  // `randomUUID()` here would make `livePromptIds` match nothing, ever, and the
  // whole guard would silently no-op.
  const start = code.indexOf('const entry: PendingPrompt = {');
  assert.notEqual(start, -1, 'the PendingPrompt literal in sdkSend was not found');
  const literal = code.slice(start, start + 400);
  assert.match(literal, /\bid:\s*rewindId,/, 'the pending id must BE the turn uuid');
  assert.doesNotMatch(literal, /\bid:\s*randomUUID\(\)/, 'a fresh uuid here silently disarms #112');

  // And `rewindId` must still be what rides onto the queue entry.
  assert.match(code, /uuid:\s*rewindId,/, 'rewindId must remain the SDKUserMessage uuid');
});

test('wiring: the turn-result clear keeps prompts still queued behind that turn', () => {
  const code = agentSdkCode();
  const start = code.indexOf("if (msg.type === 'result')");
  assert.notEqual(start, -1, "the result branch in consume() was not found");
  const branch = code.slice(start, start + 2_000);

  assert.match(
    branch,
    /for \(const m of session\.queue\) if \(m\.uuid\) stillQueued\.add\(m\.uuid\)/,
    'the result boundary must compute what is STILL queued before clearing',
  );
  assert.match(
    branch,
    /keepOnlyPendingPrompts\(session\.wsId, live\)/,
    'entries for turns that have not run yet must survive the turn-end clear',
  );
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { forkTargetId, canForkFrom, forkBranchName } from './fork-session.ts';
import type { RenderMessage } from './types.ts';

/**
 * Tests for #18's "Resume from here" pure logic.
 *
 * Every assertion below names the CLAUSE it guards, and each was verified to
 * FAIL against the corresponding mutant (see the mutation matrix in
 * `docs/spikes/fork-session-findings.md`). The off-by-one assertions exist
 * because getting the fork point wrong fails INVISIBLY — it silently keeps or
 * drops a whole turn, producing a plausible-looking fork either way.
 */

/** A transcript row. `rewindId` present = an Orchestra-minted user turn (a
 *  valid fork boundary); absent = an assistant/tool row or un-idd history. */
function msg(role: RenderMessage['role'], rewindId?: string, text?: string): RenderMessage {
  return { id: `${role}:${rewindId ?? text ?? 'x'}`, role, ...(rewindId ? { rewindId } : {}), ...(text ? { text } : {}) };
}

/** The canonical shape: three user turns with assistant replies interleaved. */
const TRANSCRIPT: RenderMessage[] = [
  msg('user', 'u1', 'first question'),
  msg('assistant', undefined, 'ALPHA'),
  msg('user', 'u2', 'second question'),
  msg('assistant', undefined, 'BETA'),
  msg('user', 'u3', 'third question'),
  msg('assistant', undefined, 'GAMMA'),
];

describe('forkTargetId — the inclusive-cut off-by-one', () => {
  it('returns the PREDECESSOR user id, not the target itself', () => {
    // CLAUSE: the backward walk (`for (let i = idx - 1; ...)`). `upToMessageId`
    // is INCLUSIVE (measured), so returning `rewindId` itself would copy the
    // user message being resumed-from WITHOUT its reply, and the fork would
    // answer that dangling turn as its first act.
    // Fixture reaches it: 'u3' is at index 4, so the loop runs from index 3.
    assert.equal(forkTargetId(TRANSCRIPT, 'u3'), 'u2');
    assert.equal(forkTargetId(TRANSCRIPT, 'u2'), 'u1');
    // MUTATION PROOF: with the loop seeded at `idx` instead of `idx - 1`, both
    // of these return the target itself ('u3' / 'u2') and fail.
  });

  it('SKIPS assistant and tool rows when walking back', () => {
    // CLAUSE: `if (id) return id` inside the walk — rows without a rewindId are
    // not valid cut points. The fixture REACHES this clause because an
    // assistant row sits at index 3, directly between 'u3' and 'u2'; a walk
    // that did not test `id` would return that row's `undefined`.
    const withTools: RenderMessage[] = [
      msg('user', 'u1'),
      msg('assistant'),
      msg('tool'),
      msg('tool'),
      msg('user', 'u2'),
    ];
    assert.equal(forkTargetId(withTools, 'u2'), 'u1');
    // MUTATION PROOF: dropping the `if (id)` guard returns undefined here.
  });

  it('returns undefined for the FIRST rewindable turn (empty fork)', () => {
    // CLAUSE: the `return undefined` after the walk exhausts. Forking before
    // the first turn yields an EMPTY slice, which the SDK rejects outright
    // ('Session <id> has no messages to fork' — measured). Callers must render
    // no affordance rather than one that can only fail.
    assert.equal(forkTargetId(TRANSCRIPT, 'u1'), undefined);
  });

  it('returns undefined for an id NOT in the transcript', () => {
    // CLAUSE: `if (idx < 0) return undefined`. Critical because `undefined`
    // means "omit upToMessageId" to the SDK, which is a FULL session copy —
    // the exact opposite of the user's intent. The caller must never pass this
    // through; canForkFrom() is what enforces that at the UI boundary.
    assert.equal(forkTargetId(TRANSCRIPT, 'nope'), undefined);
    // Negative control: the SAME transcript DOES resolve a real id, so the
    // undefined above is a real miss and not a broken fixture.
    assert.equal(forkTargetId(TRANSCRIPT, 'u2'), 'u1');
  });

  it('walks back past a user turn that carries NO id', () => {
    // CLAUSE: the walk continues rather than stopping at the first user row.
    // Un-idd user turns are real (externally-originated / pre-feature history)
    // and are NOT forkable boundaries — cutting at one is impossible, since we
    // have no uuid for it at all.
    const mixed: RenderMessage[] = [
      msg('user', 'u1'),
      msg('assistant'),
      msg('user', undefined, 'externally originated, no id'),
      msg('assistant'),
      msg('user', 'u3'),
    ];
    assert.equal(forkTargetId(mixed, 'u3'), 'u1');
  });
});

describe('canForkFrom — gating the affordance', () => {
  it('is false exactly where the fork would be empty or impossible', () => {
    // CLAUSE: `!== undefined`. Guards the UI against offering a control whose
    // only outcome is an SDK throw.
    assert.equal(canForkFrom(TRANSCRIPT, 'u1'), false, 'first turn: empty fork');
    assert.equal(canForkFrom(TRANSCRIPT, 'nope'), false, 'unknown id');
  });

  it('is true where a complete earlier exchange exists', () => {
    // Positive control for the assertion above: the same predicate DOES return
    // true, so the two falses are discriminating rather than a stuck `false`.
    assert.equal(canForkFrom(TRANSCRIPT, 'u2'), true);
    assert.equal(canForkFrom(TRANSCRIPT, 'u3'), true);
  });
});

describe('forkBranchName', () => {
  it('slugifies the message into a fork- prefixed branch', () => {
    // CLAUSE: the prefix + the `[^a-z0-9]+` collapse. The prefix is what makes
    // a forked workspace identifiable in the sidebar.
    assert.equal(forkBranchName('Add the retry banner'), 'fork-add-the-retry-banner');
  });

  it('strips leading/trailing separators rather than emitting them', () => {
    // CLAUSE: `.replace(/^-+|-+$/g, '')`. A branch name with a trailing hyphen
    // is legal but ugly, and a LEADING one after the prefix reads as `fork--x`.
    assert.equal(forkBranchName('  !!Fix the thing!!  '), 'fork-fix-the-thing');
  });

  it('truncates a long message at SLUG_MAX', () => {
    // CLAUSE: `.slice(0, SLUG_MAX)`. The fixture REACHES it: the slug is 41
    // chars before slicing (41), so a missing slice would leave the tail on.
    // (The post-slice `-+$` strip is NOT reached here — this cut lands
    // mid-word — so it gets its own test below rather than being credited
    // to this one.)
    const name = forkBranchName('abcdefghij klmnopqrst uvwxyzabcdefgh ijkl');
    assert.equal(name, 'fork-abcdefghij-klmnopqrst-uvwxyzabcd');
    assert.ok(name.length <= 'fork-'.length + 32);
    // MUTATION PROOF: dropping the slice yields the full 41-char slug.
  });

  it('drops a hyphen left exactly at the truncation boundary', () => {
    // The discriminating case for the post-slice strip: 31 chars of slug then
    // a separator, so the 32-char slice ends ON the hyphen.
    const input = 'a'.repeat(31) + ' tail';
    const name = forkBranchName(input);
    assert.equal(name, `fork-${'a'.repeat(31)}`);
    assert.ok(!name.endsWith('-'));
  });

  it('falls back to the bare prefix when nothing survives', () => {
    // CLAUSE: `slug ? ... : 'fork'`. An image-only or punctuation-only turn
    // must still produce a LEGAL branch name — `fork-` alone would be a
    // trailing-hyphen branch.
    assert.equal(forkBranchName('!!!'), 'fork');
    assert.equal(forkBranchName(''), 'fork');
    assert.equal(forkBranchName(undefined), 'fork');
  });
});

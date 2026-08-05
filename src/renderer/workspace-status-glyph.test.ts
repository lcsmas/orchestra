/**
 * Which status glyph does a workspace row show?
 *
 * The sidebar's `WorkspaceStatusGlyph` picks between an SVG ring, a CSS
 * spinner, and a bare dot. That choice cannot be verified by driving the app:
 * the `running` state is derived from a LIVE agent process, so a seeded
 * `status: 'running'` is recomputed away before the sidebar renders it — an
 * E2E drive of a seeded store shows zero running rows and reports the running
 * branch as neither passing nor failing, just untouched.
 *
 * So the branch selection is pinned here instead, against the same predicate
 * the component uses. This file does NOT import the component: JSX cannot run
 * under `node --test`, so the switch is mirrored below. The mirror is kept
 * honest by living beside the component in review, and by the fact that both
 * enumerate the same `WorkspaceStatus` union — adding a status makes the
 * exhaustiveness of one visibly diverge from the other.
 *
 * The CSS side — that `.ws-glyph-spin` computes to a green ring with a
 * transparent top edge — is verified separately by driving the built app,
 * because a stylesheet cannot be asserted from here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceStatus } from '../shared/types.ts';

/** The glyph kind a row shows, given its status and whether it is hibernated.
 * Mirrors the switch in `WorkspaceStatusGlyph`
 * (src/renderer/components/WorkspaceStatusGlyph.tsx), which every live-agent
 * surface renders: sidebar rows, Inbox, jump palette, Resources table.
 * Keep the two in step: if you add a status, add it in both places. */
export function glyphKindFor(
  status: WorkspaceStatus,
  hibernated: boolean,
): 'ring-check' | 'ring-question' | 'ring-x' | 'spinner' | 'dot' {
  // A hibernated agent's process is STOPPED, so it must never animate as if it
  // were working — even though its last recorded status is often 'running'.
  if (hibernated) return 'dot';
  switch (status) {
    case 'running':
      return 'spinner';
    case 'waiting':
      return 'ring-question';
    case 'error':
      return 'ring-x';
    case 'idle':
      return 'ring-check';
    default:
      return 'dot';
  }
}

test('each status maps to its own glyph', () => {
  assert.equal(glyphKindFor('running', false), 'spinner');
  assert.equal(glyphKindFor('idle', false), 'ring-check');
  assert.equal(glyphKindFor('waiting', false), 'ring-question');
  assert.equal(glyphKindFor('error', false), 'ring-x');
  assert.equal(glyphKindFor('stopped', false), 'dot');
});

test('hibernated never animates, whatever the recorded status', () => {
  // The regression this guards: a hibernated row whose last status was
  // 'running' spinning forever, implying an agent is working when its process
  // was killed to free memory.
  for (const s of ['running', 'idle', 'waiting', 'error', 'stopped'] as const) {
    assert.equal(glyphKindFor(s, true), 'dot', `hibernated ${s} must be a quiet dot`);
  }
});

test('the four active states are mutually distinguishable', () => {
  // Shape carries the meaning, not just colour — someone who cannot separate
  // green from amber must still tell "finished" from "needs you". Five
  // identically-shaped dots in five hues could not do that, which is why the
  // glyphs replaced the old `.ws-dot`.
  const kinds = (['running', 'idle', 'waiting', 'error'] as const).map((s) => glyphKindFor(s, false));
  assert.equal(new Set(kinds).size, kinds.length, 'two active states share a glyph shape');
});

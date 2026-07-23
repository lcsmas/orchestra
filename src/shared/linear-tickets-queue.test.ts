// The ticket-queue selection rule, extracted as pure logic so it is testable
// without Electron (node --test cannot import anything that reaches `electron`).
//
// This is the rule the sidebar's `queuedTickets` memo applies, and it decides
// the single most visible behaviour of the feature: which tickets are shown.
// Getting it wrong is silent — a ticket shown twice, or one that vanishes
// entirely — so it is worth pinning down independently of the component.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PinnedTicket } from './types.ts';
import { queuedTickets } from './linear-tickets-queue.ts';

const ticket = (identifier: string, workspaceId?: string): PinnedTicket => ({
  identifier,
  url: `https://linear.app/acme/issue/${identifier}`,
  title: `title for ${identifier}`,
  pinnedAt: 1,
  ...(workspaceId ? { workspaceId } : {}),
});

test('a ticket with no workspace is queued', () => {
  const out = queuedTickets([ticket('NMC-1')], []);
  assert.deepEqual(out.map((t) => t.identifier), ['NMC-1']);
});

test('a graduated ticket is hidden — never shown twice', () => {
  // Its work is already visible as a workspace row carrying the
  // branch-derived Linear badge, so listing it here too would duplicate it.
  const out = queuedTickets([ticket('NMC-1', 'ws-a')], ['ws-a']);
  assert.deepEqual(out, []);
});

test('a ticket whose workspace was DELETED returns to the queue', () => {
  // The dangling-pointer case. Without this the ticket is invisible: hidden
  // from the queue because it looks graduated, yet its workspace is gone — so
  // the user can neither see it nor act on it.
  const out = queuedTickets([ticket('NMC-1', 'ws-gone')], ['ws-other']);
  assert.deepEqual(out.map((t) => t.identifier), ['NMC-1']);
});

test('mixed sets partition correctly and preserve pin order', () => {
  const out = queuedTickets(
    [ticket('NMC-1'), ticket('NMC-2', 'ws-a'), ticket('NMC-3', 'ws-gone'), ticket('NMC-4')],
    ['ws-a'],
  );
  assert.deepEqual(out.map((t) => t.identifier), ['NMC-1', 'NMC-3', 'NMC-4']);
});

test('empty inputs are safe', () => {
  assert.deepEqual(queuedTickets([], []), []);
  assert.deepEqual(queuedTickets([], ['ws-a']), []);
});

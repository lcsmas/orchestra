// The inbox tray's backend — issue #64.
//
// Orchestra parks a peer message in `~/.orchestra/inbox/<workspace-id>.txt`
// whenever it cannot hand it to a live session (`queueInbox` in workspaces.ts).
// Until now that file was invisible to the human: the `inbox-instruction.sh`
// hook printed and deleted it at the target's next SessionStart or
// UserPromptSubmit, so a parked message sat unseen for as long as the workspace
// stayed idle — and then arrived as an unattributed wall of text in the agent's
// context with no way to decline it. THAT INVISIBILITY IS THE BUG #64 FIXES.
//
// This module exposes the file as a list the renderer can render and act on:
//   • read    — parse the file into blocks (see shared/inbox-blocks.ts);
//   • release — deliver ONE block to the session as its next turn, peer-origin
//               tagged so it renders as a #56 compact row, and remove it;
//   • refuse  — discard ONE block, with a log line (never a silent drop);
//   • watch   — tell the renderer when the file changed underneath it.
//
// ── DIFFERENT CHANNEL FROM #42 ───────────────────────────────────────────────
// This is Orchestra's OWN durable inbox file. It is NOT the Claude CLI's
// `crossSessionInbound: 'hold'` buffer, which lives in the CLI process heap
// with no API handle (measured in fix-wave-5; issue #42 stays open as the
// honest record of that upstream limitation). Nothing here fixes #42.
//
// ── Two invariants this module is built around ───────────────────────────────
//
// 1. THE FILE IS SHARED WITH A SHELL HOOK. `inbox-instruction.sh` runs
//    `cat "$f"; rm -f "$f"` on every SessionStart AND every UserPromptSubmit
//    (workspaces.ts). So the file can be drained between the moment the tray
//    renders a row and the moment the human clicks it. Every mutation here is
//    therefore a read-modify-write that MATCHES THE BLOCK BY CONTENT and
//    reports whether it actually found it — a vanished block yields
//    `{ ok: false, reason: 'gone' }`, never a delivery of the wrong message.
//
// 2. DELIVERY MUST BE CONFIRMED BEFORE THE BLOCK IS REMOVED. Removing first
//    would destroy the only durable copy if the turn never ran. So release
//    delivers via `sdkDeliverConfirmed` (the issue-#57 seam: only `'started'`
//    means the message really became the session's turn) and removes the block
//    ONLY on that result. Anything else leaves the file untouched, so the
//    message is still parked and the human can retry — losing a message is
//    strictly worse than showing it twice.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './logger';
import { platform } from './platform';
import { store } from './store';
import { sdkDeliverConfirmed } from './sdk-delivery';
import {
  parseInboxBlocks,
  removeBlock,
  serializeInboxBlocks,
  type InboxActionFailure,
  type InboxActionOutcome,
  type InboxBlock,
} from '../shared/inbox-blocks.ts';
import { recognizeFormattedPeerMessage, type PeerOrigin } from '../shared/peer-messages.ts';

/** Mirrors `INBOX_ROOT` in workspaces.ts — the same directory `queueInbox`
 *  appends to and the inbox hook reads. Duplicated rather than exported from
 *  there to avoid importing the whole workspaces module (and its side effects)
 *  into this leaf; the shape is asserted by a test. */
const INBOX_ROOT = path.join(os.homedir(), '.orchestra', 'inbox');

export function inboxFilePath(workspaceId: string): string {
  return path.join(INBOX_ROOT, `${workspaceId}.txt`);
}


function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    // ENOENT is the common, expected case: no mail parked.
    return '';
  }
}

/** The blocks currently parked for a workspace, in arrival order. Empty when
 *  the file is absent — "no inbox file" and "empty inbox" are the same state to
 *  a reader, and the hook deletes the file rather than truncating it. */
export function readInbox(workspaceId: string): InboxBlock[] {
  return parseInboxBlocks(readFileOrEmpty(inboxFilePath(workspaceId)));
}

/** Write back the surviving blocks, deleting the file when none are left so the
 *  shell hook's `[ -s "$f" ]` guard keeps short-circuiting exactly as before
 *  (an empty file left behind would be a subtle behaviour change for it). */
function writeInbox(workspaceId: string, texts: string[]): boolean {
  const file = inboxFilePath(workspaceId);
  try {
    if (!texts.length) {
      fs.rmSync(file, { force: true });
      return true;
    }
    fs.mkdirSync(INBOX_ROOT, { recursive: true });
    fs.writeFileSync(file, serializeInboxBlocks(texts), 'utf8');
    return true;
  } catch (e) {
    log.warn(`inbox-tray: write failed for ${workspaceId}`, e);
    return false;
  }
}

/** Broadcast the workspace's current parked count so every open renderer view
 *  re-reads. Sent on every mutation AND from the watcher, so a drain performed
 *  by the shell hook retracts the chip too. */
function broadcastInbox(workspaceId: string): void {
  platform.broadcast('inbox:update', {
    workspaceId,
    count: readInbox(workspaceId).length,
  });
}

/** Recover the structural peer origin for a parked block so the released turn
 *  renders as a #56 compact peer row rather than as a human turn.
 *
 *  The envelope is the ONE source for this: `queueInbox` stores no sidecar
 *  metadata, so the sender's branch and id survive only inside the block text
 *  that `formatPeerMessage` wrote. When the envelope is unrecognized (a
 *  hand-written block, or a future format) we return undefined and the turn is
 *  delivered UNTAGGED — visible and correct, just not collapsed. Fabricating an
 *  origin would attribute the message to an agent that never sent it. */
function originFor(block: InboxBlock): PeerOrigin | undefined {
  const recognized = recognizeFormattedPeerMessage(block.text);
  return recognized?.origin;
}

/** Deliver one parked block as the session's next turn, then remove it.
 *
 *  ORDER IS LOAD-BEARING: deliver first, remove only on a CONFIRMED start (see
 *  invariant 2). `sdkDeliverConfirmed` returns `'started'` only when the turn
 *  actually began, which is the same honesty bar `dispatchMessageRequest` holds
 *  itself to since issue #57. On `'none'` (no live structured session) nothing
 *  is delivered and nothing is removed — the caller surfaces that the session
 *  must be running to release into it. */
export async function releaseInboxBlock(
  workspaceId: string,
  text: string,
): Promise<InboxActionOutcome> {
  const blocks = readInbox(workspaceId);
  const target = blocks.find((b) => b.text.trim() === text.trim());
  if (!target) {
    // Already drained by the hook or by another window. Re-broadcast so the
    // stale row disappears from the view that just tried to act on it.
    broadcastInbox(workspaceId);
    return { ok: false, reason: 'gone', remaining: blocks.length };
  }

  const confirmed = await sdkDeliverConfirmed(workspaceId, target.text, originFor(target));
  if (confirmed !== 'started') {
    log.info(
      `inbox-tray: release for ${workspaceId} not delivered (${confirmed}) — block left parked`,
    );
    return { ok: false, reason: 'not-delivered', remaining: blocks.length };
  }

  // Re-read before rewriting: the hook may have drained the file while the
  // delivery was in flight, and writing back our stale snapshot would resurrect
  // blocks it already handed to the agent.
  const fresh = removeBlock(readFileOrEmpty(inboxFilePath(workspaceId)), target.text);
  if (fresh.removed && !writeInbox(workspaceId, parseInboxBlocks(fresh.contents).map((b) => b.text))) {
    broadcastInbox(workspaceId);
    return { ok: false, reason: 'write-failed', remaining: readInbox(workspaceId).length };
  }
  log.info(`inbox-tray: released 1 parked message into ${workspaceId} (from '${target.from}')`);
  broadcastInbox(workspaceId);
  return { ok: true, remaining: readInbox(workspaceId).length };
}

/** Discard one parked block without running a turn.
 *
 *  LOGGED, NOT SILENT (spec): a refused message is a decision the human made,
 *  and the sender is owed an explanation if anyone ever goes looking. The full
 *  body goes to the app log before the block is dropped, so a refusal is
 *  recoverable from the log even though it is gone from the inbox. */
export async function refuseInboxBlock(
  workspaceId: string,
  text: string,
): Promise<InboxActionOutcome> {
  const before = readFileOrEmpty(inboxFilePath(workspaceId));
  const target = parseInboxBlocks(before).find((b) => b.text.trim() === text.trim());
  const res = removeBlock(before, text);
  if (!res.removed) {
    broadcastInbox(workspaceId);
    return { ok: false, reason: 'gone', remaining: parseInboxBlocks(before).length };
  }
  log.info(
    `inbox-tray: REFUSED a parked message for ${workspaceId} from '${target?.from ?? 'unknown'}' ` +
      `(${target?.fromId ?? 'unknown id'}) — discarded by the human, not delivered. Body: ${
        target?.body ?? ''
      }`,
  );
  // RE-READ before rewriting, exactly as `releaseInboxBlock` does. The write
  // below replaces the WHOLE file, so a `queueInbox` append that landed while we
  // were matching and logging would be clobbered — measured: a peer's message
  // appended inside this window vanished from disk. The window is short (no
  // await between the read and the write) but it is not zero, and the asymmetry
  // with release was an oversight, not an accepted risk.
  const fresh = removeBlock(readFileOrEmpty(inboxFilePath(workspaceId)), text);
  if (!fresh.removed) {
    // Drained under us after all — nothing to write, and nothing was lost.
    broadcastInbox(workspaceId);
    return { ok: false, reason: 'gone', remaining: readInbox(workspaceId).length };
  }
  if (!writeInbox(workspaceId, parseInboxBlocks(fresh.contents).map((b) => b.text))) {
    broadcastInbox(workspaceId);
    return { ok: false, reason: 'write-failed', remaining: readInbox(workspaceId).length };
  }
  broadcastInbox(workspaceId);
  return { ok: true, remaining: readInbox(workspaceId).length };
}

/** Release every parked block, oldest first.
 *
 *  Sequential on purpose: each delivery must be CONFIRMED before the next is
 *  attempted, both to preserve arrival order in the session's queue and because
 *  a failure partway through must leave the remaining blocks parked rather than
 *  firing them all at a session that just stopped accepting turns. Stops at the
 *  first non-delivery and reports how many actually landed. */
export async function releaseAllInboxBlocks(
  workspaceId: string,
): Promise<{ released: number; remaining: number; failed?: InboxActionFailure }> {
  let released = 0;
  // Snapshot the texts up front, then act on each by content — the file is
  // rewritten between iterations, so indices would not survive the loop.
  for (const block of readInbox(workspaceId)) {
    const res = await releaseInboxBlock(workspaceId, block.text);
    if (!res.ok) {
      if (res.reason === 'gone') continue; // drained under us; not a failure
      return { released, remaining: res.remaining, failed: res };
    }
    released += 1;
  }
  return { released, remaining: readInbox(workspaceId).length };
}

// ── Watching ────────────────────────────────────────────────────────────────
//
// The tray must retract when the shell hook drains the file, which happens
// without any main-process involvement at all. So we watch the inbox DIRECTORY
// (not each file: files are created and deleted, and a watch on a deleted path
// dies with it) and broadcast the affected workspace's fresh count.

let watcher: fs.FSWatcher | null = null;

/** Start broadcasting `inbox:update` whenever a workspace's inbox file changes.
 *  Idempotent. Best-effort: a platform without usable fs watching simply falls
 *  back to the counts sent on each mutation and at renderer mount. */
export function startInboxWatcher(): void {
  if (watcher) return;
  try {
    fs.mkdirSync(INBOX_ROOT, { recursive: true });
    watcher = fs.watch(INBOX_ROOT, (_event, filename) => {
      if (!filename || !filename.endsWith('.txt')) return;
      const workspaceId = filename.slice(0, -'.txt'.length);
      // Only broadcast for workspaces we actually know: the directory is keyed
      // by id, and a stale file from a deleted workspace should not produce
      // events for a workspace the renderer has no row for.
      if (!store.getWorkspace(workspaceId)) return;
      broadcastInbox(workspaceId);
    });
  } catch (e) {
    log.warn('inbox-tray: could not watch the inbox directory', e);
  }
}

export function stopInboxWatcher(): void {
  watcher?.close();
  watcher = null;
}

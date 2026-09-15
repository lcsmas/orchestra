import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseInboxBlocks,
  removeBlock,
  serializeInboxBlocks,
  sanitizeInboxBody,
} from '../shared/inbox-blocks.ts';

// The read-modify-write discipline the inbox tray depends on (issue #64, R2 of
// the adversarial review).
//
// `inbox-tray.ts` cannot be imported here — it pulls in `./platform`, `./store`
// and `./sdk-delivery`, i.e. Electron — and `src/main` tests in this repo stay
// Electron-free. So this test exercises the exact SEQUENCE those functions
// perform against a real temp file: read, match, (log), re-read, write-whole-file.
// It is a model, so it carries a SOURCE-BINDING GUARD below: if the real
// function stops re-reading, the guard fails and says so, rather than this file
// quietly continuing to validate a shape the code no longer has.

const DELIM = '='.repeat(40);
const fmt = (branch: string, id: string, text: string): string =>
  `[message from agent '${branch}' (${id})]\n${text}\n\nReply with: orchestra message ${id} "<reply>"`;

/** Exactly what `queueInbox` appends, including the write-time sanitize. */
function appendLikeQueueInbox(file: string, branch: string, id: string, text: string): void {
  fs.appendFileSync(file, `\n${DELIM}\n${sanitizeInboxBody(fmt(branch, id, text))}\n${DELIM}\n`, 'utf8');
}

function tmpInbox(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-inbox-rmw-'));
  return path.join(dir, `${name}.txt`);
}

/** The mutation as `refuseInboxBlock` performs it. `reread` toggles the fix so
 *  both arms run through the SAME code path — an arm the fix cannot change is
 *  not a measurement. */
function refuseSequence(file: string, targetText: string, reread: boolean, duringWindow: () => void) {
  const before = fs.readFileSync(file, 'utf8');
  const matched = removeBlock(before, targetText);
  if (!matched.removed) return { removed: false };
  // …the real function logs here; anything appended during that window is the
  // hazard this test exists for.
  duringWindow();
  const source = reread ? removeBlock(fs.readFileSync(file, 'utf8'), targetText) : matched;
  fs.writeFileSync(
    file,
    serializeInboxBlocks(parseInboxBlocks(source.contents).map((b) => b.text)),
    'utf8',
  );
  return { removed: true };
}

test('refuse must RE-READ before writing, or a concurrent append is clobbered', () => {
  const run = (reread: boolean) => {
    const file = tmpInbox('ws-rmw');
    fs.writeFileSync(file, '');
    appendLikeQueueInbox(file, 'alpha', 'id-a', 'message ONE');
    appendLikeQueueInbox(file, 'beta', 'id-b', 'message TWO');
    const target = parseInboxBlocks(fs.readFileSync(file, 'utf8'))[0].text;

    // A peer parks a message inside the read→write window.
    const res = refuseSequence(file, target, reread, () =>
      appendLikeQueueInbox(file, 'gamma', 'id-g', 'URGENT message THREE'),
    );
    assert.equal(res.removed, true);
    const senders = parseInboxBlocks(fs.readFileSync(file, 'utf8')).map((b) => b.from);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return senders;
  };

  // CONTROL — the unfixed arm must actually lose the message, or this test
  // asserts nothing at all.
  const unfixed = run(false);
  assert.deepEqual(unfixed, ['beta'], 'CONTROL: without the re-read, gamma is lost');
  assert.ok(!unfixed.includes('gamma'), 'CONTROL: the clobber is real');

  // FIXED — the refused block is gone and the concurrent append survives.
  const fixed = run(true);
  assert.deepEqual(fixed, ['beta', 'gamma'], 'with the re-read, gamma survives');
});

test('a block drained under us during the window is reported gone, not written back', () => {
  const file = tmpInbox('ws-drained');
  fs.writeFileSync(file, '');
  appendLikeQueueInbox(file, 'alpha', 'id-a', 'only message');
  const target = parseInboxBlocks(fs.readFileSync(file, 'utf8'))[0].text;

  // The inbox shell hook does `cat; rm -f` on every UserPromptSubmit.
  const before = fs.readFileSync(file, 'utf8');
  const matched = removeBlock(before, target);
  assert.equal(matched.removed, true, 'matched against the pre-drain snapshot');
  fs.rmSync(file, { force: true });

  // The re-read now finds nothing — so the fixed path must NOT recreate the
  // file from its stale snapshot (that would resurrect a message the agent has
  // already been shown).
  const fresh = removeBlock(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', target);
  assert.equal(fresh.removed, false, 'the re-read correctly finds nothing to remove');
  assert.equal(fs.existsSync(file), false, 'the drained file is NOT resurrected');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('Release all accounts for EVERY block, and a mid-run failure leaves the rest parked', () => {
  // Re-attacked because it was the highest-risk path found sound in review, so
  // it is the natural regression target once the framing changed. Models
  // `releaseAllInboxBlocks`: snapshot the list, then act on each BY TEXT,
  // treating a miss as 'gone' -> continue.
  const release = (file: string, deliver: (i: number) => boolean) => {
    const snapshot = parseInboxBlocks(file);
    let cur = file;
    const released: string[] = [];
    const skipped: string[] = [];
    snapshot.forEach((b, i) => {
      const probe = parseInboxBlocks(cur).find((x) => x.text.trim() === b.text.trim());
      if (!probe) return void skipped.push(b.from || '(orphan)');
      if (!deliver(i)) return; // stop: the rest must stay parked
      const r = removeBlock(cur, b.text);
      if (!r.removed) return void skipped.push(b.from || '(orphan)');
      cur = serializeInboxBlocks(parseInboxBlocks(r.contents).map((x) => x.text));
      released.push(b.from || '(orphan)');
    });
    return { released, skipped, left: parseInboxBlocks(cur) };
  };

  const file2 = (() => {
    const D = '='.repeat(40);
    const m1 = sanitizeInboxBody(`[message from agent 'impl-62' (id-1)]\ndiff:\n${D}\nAll gates green.`);
    const m2 = sanitizeInboxBody(`[message from agent 'ops' (id-2)]\nMERGE BLOCKED`);
    return `\n${D}\n${m1}\n${D}\n` + `\n${D}\n${m2}\n${D}\n`;
  })();

  // All deliveries succeed: exactly the 2 real messages go, file ends empty.
  const all = release(file2, () => true);
  assert.deepEqual(all.released, ['impl-62', 'ops']);
  assert.deepEqual(all.skipped, []);
  assert.equal(all.left.length, 0, 'file drained');

  // First succeeds, second fails: the survivor must remain PARKED, never fired
  // at a session that stopped accepting turns.
  const partial = release(file2, (i) => i === 0);
  assert.deepEqual(partial.released, ['impl-62']);
  assert.equal(partial.left.length, 1, 'the undelivered message is still parked');
  assert.equal(partial.left[0].from, 'ops');

  // Nothing may be silently unaccounted for in either run.
  for (const r of [all, partial]) {
    assert.equal(
      r.released.length + r.skipped.length + r.left.length,
      2,
      'every block is released, skipped or still parked — never vanished',
    );
  }
});

test('SOURCE-BINDING GUARD: both mutators really do re-read before writing', () => {
  // This file MODELS inbox-tray.ts rather than importing it (Electron deps), and
  // a model that was faithful when written goes stale silently. So assert the
  // structural property the model assumes still holds in the real source, with
  // comments stripped so prose about the design cannot satisfy a code check.
  const src = fs
    .readFileSync(new URL('./inbox-tray.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const bodies = ['releaseInboxBlock', 'refuseInboxBlock'].map((name) => {
    const start = src.indexOf(`export async function ${name}(`);
    assert.ok(start > -1, `${name} not found — the model's subject moved`);
    const next = src.indexOf('\nexport ', start + 1);
    return { name, body: src.slice(start, next === -1 ? undefined : next) };
  });

  for (const { name, body } of bodies) {
    // The load-bearing shape: a read of the file feeding removeBlock, occurring
    // in the same function that writes.
    assert.match(
      body,
      /removeBlock\(\s*readFileOrEmpty\(inboxFilePath\(workspaceId\)\)/,
      `${name} must re-read the file immediately before rewriting it (R2)`,
    );
    assert.match(body, /writeInbox\(/, `${name} should still be the writer`);
  }

  // And the writer sanitizes (R1). Same stripping discipline.
  const ws = fs
    .readFileSync(new URL('./workspaces.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(
    ws,
    /const block = `\\n\$\{INBOX_DELIMITER\}\\n\$\{sanitizeInboxBody\(body\)\}/,
    'queueInbox must sanitize the body at write time (R1)',
  );
});

test('PHANTOM-RELEASE GUARD (#91): a Release on an absent file no-ops BEFORE any delivery', () => {
  // The user can click Release ▶ on a tray row whose backing file the hook
  // already drained (the #91 stale chip). The backend must re-derive from the
  // FILE and no-op cleanly — never re-deliver from the text the renderer passed
  // (which is a cached body). `releaseInboxBlock` re-reads the file, matches the
  // block by CONTENT, and on no match returns `{ ok:false, reason:'gone' }`
  // WITHOUT reaching `sdkDeliverConfirmed`. That ordering is the guarantee, so
  // assert it structurally (the module can't be imported — Electron deps).
  const src = fs
    .readFileSync(new URL('./inbox-tray.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const start = src.indexOf('export async function releaseInboxBlock(');
  assert.ok(start > -1, 'releaseInboxBlock not found — the subject moved');
  const next = src.indexOf('\nexport ', start + 1);
  const body = src.slice(start, next === -1 ? undefined : next);

  // The file is re-read into `blocks` and the target matched by content.
  const readIdx = body.search(/const blocks = readInbox\(workspaceId\)/);
  const matchIdx = body.search(/blocks\.find\(/);
  const goneReturnIdx = body.search(/return \{ ok: false, reason: 'gone'/);
  const deliverIdx = body.search(/sdkDeliverConfirmed\(/);
  assert.ok(readIdx > -1, 'release must re-read the file (readInbox)');
  assert.ok(matchIdx > readIdx, 'release must match the target against the fresh read');
  assert.ok(goneReturnIdx > -1, "release must have a 'gone' early return");
  assert.ok(deliverIdx > -1, 'release must call sdkDeliverConfirmed on the happy path');
  // The load-bearing ordering: the 'gone' return precedes the delivery call, so
  // an absent block can NEVER reach delivery from a cached body.
  assert.ok(
    goneReturnIdx < deliverIdx,
    "the 'gone' no-op must return BEFORE sdkDeliverConfirmed — else a phantom row could re-deliver a cached body",
  );
});

test('TRAY RE-DERIVE GUARD (#91): the composer re-reads the inbox FILE on focus and on turn start', () => {
  // #91's stale chip: the renderer's `parkedInbox` cache retracted ONLY via the
  // fs.watch-driven `inbox:update` event, which is best-effort and drops events
  // — so a drained file left the chip reading "N held" with LIVE buttons. The
  // fix makes the tray re-derive from the file authoritatively at focus and at
  // every turn start, independent of the watcher. Assert that wiring is present
  // in the real source (comments stripped so design prose can't satisfy it).
  const src = fs
    .readFileSync(new URL('../renderer/components/StructuredView.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  // A refresh callback that reads the file via the IPC and writes it back.
  assert.match(
    src,
    /const refreshInbox = useCallback\(/,
    'the tray must have a refreshInbox callback',
  );
  assert.match(
    src,
    /window\.orchestra\s*\.listInbox\(workspaceId\)/,
    'refreshInbox must re-read the inbox FILE (listInbox), not trust the cache',
  );
  // It must REPLACE the cache authoritatively — including clearing to empty —
  // rather than the old "only set when non-empty" mount read that could never
  // retract. The write goes through the shared `resolveInboxReDerive` decision.
  assert.match(
    src,
    /parkedInbox: \{ \.\.\.st\.parkedInbox, \[workspaceId\]: decision\.blocks \}/,
    'refreshInbox must write the freshly-read blocks back authoritatively',
  );
  // STALENESS TOKEN (REVIEW-91 F1): the write must run through the shared
  // decision that discards a read invalidated by a concurrent watcher retract,
  // and it must snapshot the generation BEFORE the async read. Without this the
  // turn-start re-derive re-introduces the #91 stale chip via a clobber race —
  // the behaviour is driven end-to-end in inbox-blocks.test.ts (#91 F1).
  assert.match(
    src,
    /const genAtRead = useStore\.getState\(\)\.parkedInboxGen\[workspaceId\] \?\? 0;/,
    'refreshInbox must snapshot the drain-generation BEFORE the async read',
  );
  assert.match(
    src,
    /resolveInboxReDerive\(\{[\s\S]*?genAtRead,[\s\S]*?genNow: st\.parkedInboxGen\[workspaceId\]/,
    'refreshInbox must gate the write on the staleness token (resolveInboxReDerive)',
  );
  // A rejected read must not throw unhandled (F3).
  assert.match(src, /\.catch\(\(e\) => \{[\s\S]*?inbox re-derive failed/, 'refreshInbox must .catch its read');
  // Triggered on focus (isActive) …
  assert.match(
    src,
    /if \(isActive\) return refreshInbox\(\);/,
    'the tray must re-derive when the workspace gains focus',
  );
  // … and on the turn-start edge (running false -> true).
  assert.match(
    src,
    /if \(running && !wasRunning\.current\) refreshInbox\(\);/,
    'the tray must re-derive on turn start (running false->true edge)',
  );
});

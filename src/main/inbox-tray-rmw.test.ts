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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInboxBlocks,
  removeBlock,
  serializeInboxBlocks,
  INBOX_DELIMITER,
} from './inbox-blocks.ts';

// The fixture below is a REAL block, copied byte-for-byte out of a live
// `~/.orchestra/inbox/<wsid>.txt` (read with `cat -A` to confirm the framing and
// the absence of stray \r). Hand-authoring the format would only re-encode this
// module's own assumptions; the point of the fixture is that the WRITER and the
// PARSER agree on a sample neither of them produced for this test.
const REAL_BLOCK =
  "[message from agent 'sdk-feature-audit' (0524718f-ac2a-4367-b746-51e57309f371)]\n" +
  'Fleet sdk-wave-2 CLOSED: composed re-gate PASS on master 24fe975, ledger #39 carries the final verdict and every documented gap.\n' +
  '\n' +
  'Reply with: orchestra message 0524718f-ac2a-4367-b746-51e57309f371 "<reply>"';

/** Frame block texts exactly as `queueInbox` appends them. */
function file(...texts: string[]): string {
  return texts.map((t) => `\n${INBOX_DELIMITER}\n${t}\n${INBOX_DELIMITER}\n`).join('');
}

test('parses a real captured block into sender, body and preview', () => {
  const blocks = parseInboxBlocks(file(REAL_BLOCK));
  assert.equal(blocks.length, 1);
  const [b] = blocks;
  assert.equal(b.from, 'sdk-feature-audit');
  assert.equal(b.fromId, '0524718f-ac2a-4367-b746-51e57309f371');
  // The envelope header and the reply footer are stripped from the BODY (they
  // are boilerplate), but retained in `text` — what actually gets delivered.
  assert.ok(b.body.startsWith('Fleet sdk-wave-2 CLOSED'), b.body);
  assert.ok(!b.body.includes('Reply with: orchestra message'), 'footer must be stripped');
  assert.ok(!b.body.includes('[message from agent'), 'header must be stripped');
  assert.ok(b.text.includes('[message from agent'), 'delivered text keeps the envelope');
  assert.ok(b.preview.startsWith('Fleet sdk-wave-2 CLOSED'));
});

test('a file holds N appended blocks, in file order', () => {
  const a = "[message from agent 'alpha' (id-a)]\nfirst\n\nReply with: orchestra message id-a \"<reply>\"";
  const b = "[message from agent 'beta' (id-b)]\nsecond\n\nReply with: orchestra message id-b \"<reply>\"";
  const blocks = parseInboxBlocks(file(a, b));
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((x) => x.from),
    ['alpha', 'beta'],
  );
  assert.deepEqual(
    blocks.map((x) => x.preview),
    ['first', 'second'],
  );
});

test('empty and whitespace-only files hold no blocks', () => {
  assert.deepEqual(parseInboxBlocks(''), []);
  assert.deepEqual(parseInboxBlocks('\n\n  \n'), []);
});

test('an unrecognized block still surfaces its content instead of an empty row', () => {
  // A hand-written or future-format block must not render as a blank row — the
  // whole point of the tray is that nothing parked is invisible.
  const blocks = parseInboxBlocks(file('just some text\nwith two lines'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].from, '');
  assert.equal(blocks[0].preview, 'just some text');
  assert.equal(blocks[0].body, 'just some text\nwith two lines');
});

test('a delimiter-like rule INSIDE a body does not split the block', () => {
  // Guard against the framing regex losing its line anchors. To exercise that
  // clause the fixture must satisfy every OTHER conjunct the pattern requires:
  // a full-length (40-char) '=' run, since a shorter run cannot match the
  // delimiter at all — an earlier version of this test used '====' and passed
  // with the anchors deleted, i.e. it was a vacuous guard.
  //
  // Two shapes, because the anchors do two different jobs:
  //   • a 40-run with text around it on the same line (fails `^`/`$`);
  //   • a LONGER run on its own line, which the `=*` tail deliberately DOES
  //     treat as framing — asserted separately below so the tail stays honest.
  const inline = `[message from agent 'alpha' (id-a)]\nsee ${'='.repeat(40)} rule\n\nReply with: orchestra message id-a "<reply>"`;
  const blocks = parseInboxBlocks(file(inline));
  assert.equal(blocks.length, 1, 'a 40-char = run mid-LINE is body text, not framing');
  assert.equal(blocks[0].from, 'alpha');
  assert.ok(blocks[0].body.includes('='.repeat(40)), 'the rule survives in the body');

  // Control proving the fixture above is discriminating rather than merely
  // unmatched: the SAME run on its own line IS framing, so it splits.
  const onOwnLine = `[message from agent 'alpha' (id-a)]\nbefore\n${'='.repeat(40)}\nafter`;
  assert.equal(
    parseInboxBlocks(file(onOwnLine)).length,
    2,
    'a delimiter on its own line frames — so the mid-line case above is a real distinction',
  );
});

test('removeBlock removes only the addressed block and reports it', () => {
  const a = "[message from agent 'alpha' (id-a)]\nfirst\n\nReply with: orchestra message id-a \"<reply>\"";
  const b = "[message from agent 'beta' (id-b)]\nsecond\n\nReply with: orchestra message id-b \"<reply>\"";
  const res = removeBlock(file(a, b), a);
  assert.equal(res.removed, true);
  const left = parseInboxBlocks(res.contents);
  assert.equal(left.length, 1);
  assert.equal(left[0].from, 'beta');
});

test('removeBlock reports removed:false when the block already vanished', () => {
  // The inbox hook (`cat; rm -f`) fires on every UserPromptSubmit and can drain
  // the file between render and click. A caller must be able to tell that
  // nothing was removed, so it never claims a delivery that did not happen.
  const a = "[message from agent 'alpha' (id-a)]\nfirst\n\nReply with: orchestra message id-a \"<reply>\"";
  const res = removeBlock('', a);
  assert.equal(res.removed, false);
  assert.equal(res.contents, '');

  const other = removeBlock(file('unrelated parked message'), a);
  assert.equal(other.removed, false);
  assert.equal(parseInboxBlocks(other.contents).length, 1, 'a miss must not drop anything');
});

test('two byte-identical parked messages are two messages; releasing one leaves the other', () => {
  const dup = "[message from agent 'alpha' (id-a)]\nsame\n\nReply with: orchestra message id-a \"<reply>\"";
  const res = removeBlock(file(dup, dup), dup);
  assert.equal(res.removed, true);
  assert.equal(parseInboxBlocks(res.contents).length, 1);
});

test('serialize→parse round-trips, and matches queueInbox framing byte-for-byte', () => {
  // The framing assertion is the load-bearing one: the shell hook still reads
  // this file, so a rewrite must be indistinguishable from an appended one.
  const serialized = serializeInboxBlocks([REAL_BLOCK]);
  assert.equal(serialized, `\n${INBOX_DELIMITER}\n${REAL_BLOCK}\n${INBOX_DELIMITER}\n`);
  assert.equal(INBOX_DELIMITER, '========================================');
  assert.equal(INBOX_DELIMITER.length, 40);
  const round = parseInboxBlocks(serialized);
  assert.equal(round.length, 1);
  assert.equal(round[0].text, REAL_BLOCK);
  assert.equal(serializeInboxBlocks([]), '');
});

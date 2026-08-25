import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInboxBlocks,
  removeBlock,
  serializeInboxBlocks,
  INBOX_DELIMITER,
  sanitizeInboxBody,
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
  const inline = `[message from agent 'alpha' (id-a)]\nsee ${'='.repeat(40)} rule\n\nReply with: orchestra message id-a "<reply>"`;
  const blocks = parseInboxBlocks(file(inline));
  assert.equal(blocks.length, 1, 'a 40-char = run mid-LINE is body text, not framing');
  assert.equal(blocks[0].from, 'alpha');
  assert.ok(blocks[0].body.includes('='.repeat(40)), 'the rule survives in the body');
});

test('a delimiter-shaped LINE reaching the file DOES frame — which is why the writer sanitizes', () => {
  // This documents the on-disk grammar, and is the reason `sanitizeInboxBody`
  // exists rather than a parser-side heuristic: once such a line is in the file
  // it is INDISTINGUISHABLE from real framing, so the information needed to do
  // the right thing is already gone. An earlier version of this test asserted
  // the split as merely "deliberate" and stopped there — it never traced that
  // ACTING on the resulting rows rewrites the file around a mis-parse and
  // destroys a neighbour (measured in adversarial review). The guard now lives
  // at the write site; this test pins the grammar the guard protects.
  const raw = `[message from agent 'alpha' (id-a)]\nbefore\n${'='.repeat(40)}\nafter`;
  assert.equal(parseInboxBlocks(file(raw)).length, 2, 'unsanitized: frames as two');
  // Sanitized, the same body is ONE block and the rule is still legible.
  const safe = parseInboxBlocks(file(sanitizeInboxBody(raw)));
  assert.equal(safe.length, 1, 'sanitized: one message stays one block');
  assert.equal(safe[0].from, 'alpha');
  assert.ok(safe[0].body.includes('='.repeat(40)), 'the rule is preserved, not stripped');
});

test('sanitizeInboxBody neutralizes delimiter LINES only, and is idempotent', () => {
  const D = '='.repeat(40);
  // A delimiter-shaped line is defused...
  assert.equal(sanitizeInboxBody(`a\n${D}\nb`), `a\n ${D}\nb`);
  // ...at 40 AND above (the parser's pattern is `={40,}`), including the last
  // line with no trailing newline and a run at the very start.
  assert.equal(sanitizeInboxBody(`${D}=====`), ` ${D}=====`);
  assert.equal(sanitizeInboxBody(`x\n${D}`), `x\n ${D}`);
  // ...but a SHORTER run is left exactly alone (39 never matched the pattern),
  // and so is a run with anything else on its line.
  const short = '='.repeat(39);
  assert.equal(sanitizeInboxBody(`a\n${short}\nb`), `a\n${short}\nb`);
  assert.equal(sanitizeInboxBody(`see ${D} rule`), `see ${D} rule`);
  // Idempotent: re-sanitizing an already-safe body changes nothing, so a body
  // that somehow passes through twice cannot accumulate indentation.
  const once = sanitizeInboxBody(`a\n${D}\nb`);
  assert.equal(sanitizeInboxBody(once), once);
  // An ordinary body is untouched.
  assert.equal(sanitizeInboxBody('plain text\nsecond line'), 'plain text\nsecond line');
});

test('REGRESSION: a sanitized message cannot destroy its NEIGHBOUR when acted on', () => {
  // The measured R1 failure, end to end: msg1's body carries a 40-'=' rule and
  // msg2 is an unrelated real message. Unsanitized, the tray shows a phantom
  // orphan row, and refusing that orphan rewrites the file around the mis-parse
  // and deletes real text. Sanitized at write time, there is no orphan to act on.
  const D = '='.repeat(40);
  const m1 = `[message from agent 'impl-62' (id-1)]\nHere is the diff summary:\n${D}\nAll gates green.\n\nReply with: orchestra message id-1 "<reply>"`;
  const m2 = `[message from agent 'ops' (id-2)]\nMERGE BLOCKED: do not merge until B1 is fixed\n\nReply with: orchestra message id-2 "<reply>"`;

  // CONTROL — the unfixed arm must actually exhibit the loss, or this test is
  // asserting nothing. Both arms run through the SAME parse/remove path.
  const unsafe = file(m1, m2);
  const unsafeRows = parseInboxBlocks(unsafe);
  assert.equal(unsafeRows.length, 3, 'unsanitized: one message renders as two rows');
  const orphan = unsafeRows.find((b) => b.from === '');
  assert.ok(orphan, 'unsanitized: a sender-less orphan row exists');
  const afterUnsafe = removeBlock(unsafe, orphan.text);
  assert.ok(
    !afterUnsafe.contents.includes('All gates green.'),
    'CONTROL: the unfixed arm really does destroy body text',
  );

  // FIXED arm — the writer sanitizes, so the file frames as exactly 2 messages
  // and refusing either leaves the other byte-intact.
  const safe = file(sanitizeInboxBody(m1), sanitizeInboxBody(m2));
  const rows = parseInboxBlocks(safe);
  assert.equal(rows.length, 2, 'sanitized: two messages, two rows');
  assert.deepEqual(rows.map((b) => b.from), ['impl-62', 'ops']);
  assert.ok(rows[0].body.includes('All gates green.'), 'the whole message is ONE row');

  const afterRefuse = removeBlock(safe, rows[0].text);
  assert.equal(afterRefuse.removed, true);
  const survivors = parseInboxBlocks(afterRefuse.contents);
  assert.equal(survivors.length, 1, 'exactly one survivor');
  assert.equal(survivors[0].from, 'ops');
  assert.ok(
    afterRefuse.contents.includes('MERGE BLOCKED: do not merge until B1 is fixed'),
    'the neighbouring message is intact',
  );
});

test('REGRESSION: a message cannot be delivered as a semantic FRAGMENT', () => {
  // The sharpest measured form of R1: unsanitized, this body split so that
  // Release delivered "APPROVED: merge it" alone — peer-tagged and attributed
  // to the sender — while the qualifier became a row the human could refuse.
  // Inverting a message's meaning is worse than losing it.
  const D = '='.repeat(40);
  const body = `[message from agent 'ops' (id-9)]\nAPPROVED: merge it\n${D}\nNOT APPROVED: hold\n\nReply with: orchestra message id-9 "<reply>"`;

  // CONTROL: the unfixed arm fragments.
  const unsafeRows = parseInboxBlocks(file(body));
  assert.equal(unsafeRows.length, 2, 'CONTROL: unsanitized, the message fragments');
  assert.equal(unsafeRows[0].body, 'APPROVED: merge it');
  assert.ok(!unsafeRows[0].body.includes('NOT APPROVED'), 'CONTROL: qualifier separated');

  // FIXED: one row, carrying BOTH halves, so Release delivers the whole thing.
  const rows = parseInboxBlocks(file(sanitizeInboxBody(body)));
  assert.equal(rows.length, 1, 'sanitized: one indivisible message');
  assert.ok(rows[0].body.includes('APPROVED: merge it'));
  assert.ok(rows[0].body.includes('NOT APPROVED: hold'), 'the qualifier rides with the approval');
  assert.equal(rows[0].from, 'ops', 'attribution preserved');
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseInboxBlocks,
  removeBlock,
  serializeInboxBlocks,
  resolveInboxReDerive,
  appendInboxBlock,
  INBOX_DELIMITER,
  sanitizeInboxBody,
  type InboxBlock,
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

test('BOUNDARY: 39 "=" is left byte-identical; 40+ is defused', () => {
  // The measured boundary the reviewer carries in: 39 was always safe, >=40
  // splits. The sanitizer must respect it EXACTLY — defusing 39 would corrupt
  // legitimate bodies (a 39-char rule is a perfectly ordinary markdown rule),
  // and missing 40 would leave the hazard live.
  for (const n of [1, 20, 38, 39]) {
    const body = `text\n${'='.repeat(n)}\nmore`;
    assert.equal(sanitizeInboxBody(body), body, `n=${n} must be untouched`);
    assert.equal(parseInboxBlocks(file(body)).length, 1, `n=${n} never framed anyway`);
  }
  for (const n of [40, 41, 60]) {
    const body = `text\n${'='.repeat(n)}\nmore`;
    assert.notEqual(sanitizeInboxBody(body), body, `n=${n} must be defused`);
    // CONTROL: unsanitized really does split, so the fixed arm is measuring something.
    assert.ok(parseInboxBlocks(file(body)).length > 1, `CONTROL n=${n} splits unsanitized`);
    assert.equal(parseInboxBlocks(file(sanitizeInboxBody(body))).length, 1, `n=${n} one block after`);
  }
});

test('sanitizing does not CORRUPT a legitimate document body', () => {
  // Defusing must be recoverable and minimal: the only change is one leading
  // space per delimiter line, so the reader still sees every rule and the
  // original text is reconstructible.
  const doc = `report:\n${'='.repeat(45)}\n| a | b |\n${'='.repeat(40)}\ndone`;
  const safe = sanitizeInboxBody(doc);
  assert.equal(parseInboxBlocks(file(safe)).length, 1, 'stays one block');
  assert.ok(safe.includes('='.repeat(45)), 'the 45-rule is still present');
  assert.ok(safe.includes('='.repeat(40)), 'the 40-rule is still present');
  assert.ok(safe.includes('| a | b |'), 'content preserved');
  assert.equal(safe.replace(/^ /gm, ''), doc, 'original recoverable by stripping one leading space');
});

test('RESIDUAL: a PRE-EXISTING unsanitized file still carries the hazard', () => {
  // Pins the honest scope of the fix so nobody later reads "R1 fixed" as "no
  // inbox file can be mis-framed". The guard is at WRITE time; it cannot repair
  // a file appended to before it shipped. Documented in
  // docs/research/inbox-tray-64.md (RESIDUAL) — deliberately NOT migrated,
  // because rewriting a user's real parked mail is more dangerous than the
  // condition, which has zero measured instances.
  const D = '='.repeat(40);
  const legacy =
    `\n${D}\n[message from agent 'impl-62' (id-1)]\ndiff:\n${D}\nAll gates green.\n${D}\n` +
    `\n${D}\n[message from agent 'ops' (id-2)]\nMERGE BLOCKED\n${D}\n`;
  const rows = parseInboxBlocks(legacy);
  assert.equal(rows.length, 3, 'a legacy file still splits into 3');
  const orphan = rows.find((b) => !b.from);
  assert.ok(orphan, 'and still shows a sender-less orphan row');
  const after = removeBlock(legacy, orphan.text);
  assert.ok(!after.contents.includes('All gates green.'), 'acting on it still loses text');
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

// ── #91 REVIEW-91 F1: the turn-start/focus re-derive must NOT clobber a chip the
//    watcher just retracted. Drives the real interleave through the SAME pure
//    decision the renderer uses (`resolveInboxReDerive`) against a mini-store,
//    so this is behaviour, not a source-regex guard.

/** A minimal model of the renderer store's parkedInbox + drain-generation and
 *  the two writers that race: the composer's async file re-derive and the
 *  directory watcher's `inbox:update`. */
function makeInboxStore(initialBlocks: InboxBlock[]) {
  let blocks = initialBlocks;
  let gen = 0;
  return {
    blocks: () => blocks,
    gen: () => gen,
    /** The watcher fired `inbox:update` — bump the gen (always) and set blocks. */
    watcherUpdate(next: InboxBlock[]) {
      gen += 1;
      blocks = next;
    },
    /** Begin a re-derive: snapshot the gen NOW; the returned resolve() applies
     *  the async read's result through the real decision when it lands later. */
    beginReDerive(read: InboxBlock[]) {
      const genAtRead = gen;
      return () => {
        const decision = resolveInboxReDerive({ genAtRead, genNow: gen, prev: blocks, read });
        if (decision.write) blocks = decision.blocks;
      };
    },
  };
}

test('#91 F1: a re-derive that started before a watcher retract does NOT resurrect the chip', () => {
  const B = parseInboxBlocks(`\n${INBOX_DELIMITER}\n${REAL_BLOCK}\n${INBOX_DELIMITER}\n`);
  assert.equal(B.length, 1, 'fixture parses to one block');
  const store = makeInboxStore(B); // chip shows "1 held"

  // (1) Turn starts (running flips the instant the prompt is QUEUED, BEFORE the
  //     hook rm's the file) → the re-derive's listInbox reads B STILL PRESENT.
  const resolveStaleRead = store.beginReDerive(B);
  // (2) The CLI hook rm's the file → watcher fires inbox:update count:0 → retract.
  store.watcherUpdate([]);
  assert.equal(store.blocks().length, 0, 'watcher correctly retracted the chip');
  // (3) The stale read from step 1 resolves LAST.
  resolveStaleRead();

  // FIXED: the drain-generation advanced during the read, so the stale write is
  // discarded and the chip STAYS empty.
  assert.equal(store.blocks().length, 0, 'stale re-derive must not resurrect the delivered block');
});

test('#91 F1 CONTROL: without the staleness token the SAME interleave DOES resurrect it', () => {
  // The must-FAIL arm — model the pre-fix behaviour (write the read back
  // unconditionally, no gen check). If this ever stops resurrecting, the test
  // above is proving nothing.
  const B = parseInboxBlocks(`\n${INBOX_DELIMITER}\n${REAL_BLOCK}\n${INBOX_DELIMITER}\n`);
  let blocks = B;
  // (1) read reads B present. (2) watcher retracts. (3) stale read clobbers.
  const read = B;
  blocks = []; // watcher retract
  // pre-fix write: unconditional
  blocks = read;
  assert.equal(blocks.length, 1, 'CONTROL: the un-guarded write reproduces the #91 stale chip');
});

test('#91: with NO concurrent watcher event, the re-derive DOES write (the retract #91 exists for)', () => {
  // The gen guard must not neuter the whole fix: when nothing races (the missed
  // drain the ticket is about), the read is authoritative and is written.
  const B = parseInboxBlocks(`\n${INBOX_DELIMITER}\n${REAL_BLOCK}\n${INBOX_DELIMITER}\n`);
  const store = makeInboxStore(B); // stale cache says "1 held"
  // The file is already drained on disk (no watcher event ever fired). A focus
  // re-derive reads EMPTY and, with the gen unchanged, writes the retract.
  const resolve = store.beginReDerive([]);
  resolve();
  assert.equal(store.blocks().length, 0, 'a genuine re-derive still retracts a stale chip');
});

// ── #93: concurrent large appends must not splice one block inside another ────
//
// `queueInbox` framed a block and did ONE bare `await appendFile(path, block)`.
// O_APPEND is atomic per write(2) syscall, NOT per multi-chunk appendFile — Node
// splits a large buffer, so two appendFiles racing on the same path interleave
// their chunks and SPLICE a block, adding phantom delimiter lines that make
// parseInboxBlocks OVER-COUNT (no bytes lost). Fix: appendInboxBlock serializes
// per-path in-process. Every arm here writes >=512KB blocks — past the bracketed
// onset (448K ok / 512K wrong). SUBSTRATE MATTERS: the splice needs a real
// filesystem; the rig pins its scratch dir to the same fs as prod (~/.orchestra
// is btrfs on the dev box) and SKIPS LOUDLY off-btrfs rather than passing the
// mutant vacuously on tmpfs.

const CONC_N = 10;
const CONC_SIZE = 512 * 1024;

function fsTypeOf(dir: string): string {
  try {
    return execFileSync('findmnt', ['-no', 'FSTYPE', '-T', dir]).toString().trim();
  } catch {
    return 'unknown';
  }
}

// Scratch under the repo tree (btrfs on the dev box), NOT os.tmpdir() (tmpfs),
// so the concurrency defect can actually manifest. On any other fs the arms
// SKIP so a green never masks an untested substrate.
const REPO_DIR = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH_FS = fsTypeOf(REPO_DIR);

async function driveConcurrent(
  write: (file: string, body: string) => Promise<void>,
): Promise<number[]> {
  const base = await mkdtemp(nodePath.join(REPO_DIR, '.inbox93-'));
  try {
    const counts: number[] = [];
    for (let trial = 0; trial < 5; trial++) {
      const file = nodePath.join(base, `ws-${trial}.txt`);
      await Promise.all(
        Array.from({ length: CONC_N }, (_, i) =>
          write(file, `writer-${i} ` + String.fromCharCode(97 + i).repeat(CONC_SIZE)),
        ),
      );
      counts.push(parseInboxBlocks(await readFile(file, 'utf8')).length);
    }
    return counts;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('#93: appendInboxBlock reads exactly N blocks under concurrent large appends', async (t) => {
  if (SCRATCH_FS !== 'btrfs') {
    t.skip(`scratch fs is '${SCRATCH_FS}', not btrfs — the splice needs a real fs; SKIPPING loudly rather than passing vacuously`);
    return;
  }
  const counts = await driveConcurrent(async (file, body) => {
    const block = `\n${INBOX_DELIMITER}\n${sanitizeInboxBody(body)}\n${INBOX_DELIMITER}\n`;
    await appendInboxBlock(file, block);
  });
  assert.deepEqual(
    counts,
    Array(counts.length).fill(CONC_N),
    `every trial must parse exactly ${CONC_N} blocks; got ${counts.join(',')}`,
  );
});

test('#93 CONTROL (the pre-fix mutant): a bare appendFile OVER-COUNTS — proving the rig discriminates', async (t) => {
  if (SCRATCH_FS !== 'btrfs') {
    t.skip(`scratch fs is '${SCRATCH_FS}', not btrfs — SKIPPING loudly`);
    return;
  }
  // Exactly queueInbox's PREVIOUS body: mkdir + one bare appendFile, no lock.
  const counts = await driveConcurrent(async (file, body) => {
    const block = `\n${INBOX_DELIMITER}\n${sanitizeInboxBody(body)}\n${INBOX_DELIMITER}\n`;
    await mkdir(nodePath.dirname(file), { recursive: true });
    await appendFile(file, block, 'utf8');
  });
  // Reverting the fix reddens: at least one trial splices to more than N blocks.
  assert.ok(
    counts.some((c) => c > CONC_N),
    `the unguarded write must splice at least once (got ${counts.join(',')}); if this is all ${CONC_N}, the rig lost its power`,
  );
});

test('#93 source-pin: queueInbox appends through appendInboxBlock, not a bare appendFile', () => {
  const ws = readFileSyncStripped(new URL('../main/workspaces.ts', import.meta.url));
  // Isolate queueInbox's body.
  const start = ws.indexOf('async function queueInbox(');
  assert.ok(start > -1, 'queueInbox not found — subject moved');
  const body = ws.slice(start, ws.indexOf('\nasync function', start + 1));
  assert.match(body, /appendInboxBlock\(inboxPathFor\(id\)/, 'must use the serialized appendInboxBlock writer');
  assert.doesNotMatch(body, /\bappendFile\(/, 'must NOT do a bare appendFile (the #93 splice)');
});

function readFileSyncStripped(url: URL): string {
  return readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ISSUE #86 — `orchestra message --children` / `--to <id,id,...>`.
//
// WHAT THIS FILE GATES, and why it is shaped this way:
//
// The ticket's promise is a PER-TARGET delivery report. The failure mode that
// promise exists to exclude is "one status copied N times" — a broadcast that
// sends to 3 targets and prints the SAME word 3 times looks identical to a real
// per-target report as long as all three happen to agree. So every assertion
// here drives a stub server that answers a DIFFERENT delivery kind per target,
// and asserts the report pairs each id with ITS OWN status. A test where every
// line agrees would pass on an implementation that ignores its input entirely.
//
// Sibling `fail-exit-code.test.ts` points ORCHESTRA_SOCK at a NONEXISTENT path,
// which is right for its subject (refusals at connect) but structurally cannot
// test a report shape — nothing ever answers. So this file stands up a real
// Unix-socket HTTP server speaking the app's `/message` contract.
//
// Drive the BUILT bundle, not the source: index.ts's auto-run block is guarded
// on `typeof require !== 'undefined'`, so running the source as raw ESM leaves
// main() uncalled and every command exits 0 having done nothing.
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const BUILT = existsSync(CLI);
const needsBuild = {
  skip: BUILT ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`',
};

interface Captured {
  from?: string;
  to?: unknown;
  children?: boolean;
  text?: string;
}

interface StubOutcome {
  code: number;
  stdout: string;
  stderr: string;
  /** Every request body the stub server received, in order. */
  seen: Captured[];
}

// WHY THE SERVER RUNS IN ITS OWN PROCESS.
//
// The obvious rig — stand up an http server on a Unix socket, then
// `execFileSync` the CLI against it — DEADLOCKS, and it deadlocks silently:
// execFileSync blocks the very event loop the server needs in order to accept
// the connection, so the CLI waits for a reply that cannot come and the whole
// test file times out with ZERO output. (Measured while writing this file,
// 2026-08-25: `node --test` produced 5 lines of TAP preamble and nothing else,
// which looks like a broken harness rather than a failing test.) The sibling
// `fail-exit-code.test.ts` sidesteps this only because its socket path does not
// exist — it never needs anything to answer.
//
// So the server lives in a CHILD process driven by a tiny generated script,
// which runs the CLI itself and prints a JSON envelope on stdout. The parent
// only parses that envelope.
const RUNNER = `
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// With node -e <script> -- a b c, process.argv is [execPath, a, b, c] — there
// is NO script-path slot, so the usual [, , ...] skip is off by one and
// JSON.parse lands on the CLI path instead of the args array. Slice from the
// explicit sentinel instead of counting positions.
const argv = process.argv.slice(process.argv.indexOf('--ARGS--') + 1);
const [cliPath, argsJson, replySrc, wsId] = argv;
const args = JSON.parse(argsJson);
const reply = new Function('body', replySrc);
const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-bcast-'));
const sock = path.join(dir, 's.sock');
const seen = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    seen.push(body);
    // ALWAYS answer, even if the reply builder throws. The builders index
    // body.to as an array, which is exactly what an UNFIXED CLI does not send
    // (it forwards the literal string '--to' as one target id). An unanswered
    // request would hang the CLI forever, turning the unfixed arm's honest
    // FAILURE into a timeout with no output.
    let payload;
    try {
      payload = reply(body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'stub reply failed: ' + String(e) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => server.listen(sock, r));

const env = { ...process.env, ORCHESTRA_SOCK: sock };
if (wsId) env.ORCHESTRA_WS_ID = wsId;
else delete env.ORCHESTRA_WS_ID;

execFile(process.execPath, [cliPath, ...args], { encoding: 'utf8', env, timeout: 15000 },
  (err, stdout, stderr) => {
    server.closeAllConnections();
    server.close(() => {
      rmSync(dir, { recursive: true, force: true });
      process.stdout.write('__ENVELOPE__' + JSON.stringify({
        code: err ? (err.code ?? -1) : 0, stdout, stderr, seen,
      }));
      process.exit(0);
    });
  });
`;

/** Drive the BUILT CLI against a stub Orchestra socket. `replySrc` is the BODY
 *  of a function taking the parsed request `body` and returning the JSON the
 *  app would answer — it is stringified into the child, so it must be
 *  self-contained. */
function driveCli(args: string[], replySrc: string, wsId: string | null = 'caller-1'): StubOutcome {
  const out = execFileSync(
    process.execPath,
    // The bare `--` is required: without it node treats the next token as one of
    // its OWN options and dies with `bad option`. The `--ARGS--` sentinel after
    // it is what the runner slices from, because argv layout under `-e` has no
    // script-path slot and positional counting is off by one.
    ['--input-type=module', '-e', RUNNER, '--', '--ARGS--', CLI, JSON.stringify(args), replySrc, wsId ?? ''],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  const marker = out.indexOf('__ENVELOPE__');
  assert.notEqual(marker, -1, `stub runner produced no envelope:\n${out}`);
  return JSON.parse(out.slice(marker + '__ENVELOPE__'.length)) as StubOutcome;
}

// ---------------------------------------------------------------------------
// THE TICKET'S ACTUAL PROMISE: one line per target, each with ITS OWN status.
//
// The stub answers THREE DIFFERENT delivery kinds. An implementation that
// printed one status N times, or that lost the id-to-status pairing, fails
// here: the assertions require alpha->live, beta->inbox, gamma->started on
// their own lines, AND explicitly require the three words to DIFFER.
// ---------------------------------------------------------------------------
test('--to: report pairs each target with its OWN delivery kind', needsBuild, () => {
  const kinds: Record<string, string> = { alpha: 'live', beta: 'inbox', gamma: 'started' };
  const r = driveCli(
    ['message', '--to', 'alpha,beta,gamma', 'halt', 'now'],
    `const kinds = { alpha: 'live', beta: 'inbox', gamma: 'started' };
     return { ok: true, results: body.to.map((id) => ({ id, ok: true, branch: 'br-' + id, delivery: kinds[id] })) };`,
  );
  assert.equal(r.code, 0, `expected success, got ${r.code}: ${r.stderr}`);

  // Each id appears on a line carrying ITS kind — not merely "the output
  // contains the word live somewhere".
  const lineFor = (id: string): string =>
    r.stdout.split('\n').find((l) => l.startsWith(id)) ?? '';
  for (const [id, kind] of Object.entries(kinds)) {
    const line = lineFor(id);
    assert.ok(line, `no report line for ${id}\n${r.stdout}`);
    assert.match(line, new RegExp(`\\b${kind}\\b`), `${id} did not report ${kind}: ${line}`);
    assert.match(line, new RegExp(`br-${id}`), `${id} line lost its branch: ${line}`);
  }

  // THE ANTI-VACUITY CLAUSE. Without it, a report printing the SAME word on all
  // three lines could still look plausible. Three distinct kinds must be
  // observable in ONE report — that is the only thing that distinguishes a real
  // per-target result from one status copied N times.
  const distinct = new Set(
    Object.keys(kinds).map((id) => {
      const l = lineFor(id);
      return Object.values(kinds).find((k) => new RegExp(`\\b${k}\\b`).test(l));
    }),
  );
  assert.equal(distinct.size, 3, `report must show 3 DIFFERENT kinds, saw ${distinct.size}:\n${r.stdout}`);
});

// ---------------------------------------------------------------------------
// PARTIAL FAILURE. The valid target still gets the message AND the failure is
// visible in BOTH the report and the exit code. An all-or-nothing 0 that hid
// the failure, and an abort-after-first-failure that stranded the valid target,
// each fail a different assertion here.
// ---------------------------------------------------------------------------
test('--to: a partial failure still delivers the rest, RC=1, both visible', needsBuild, () => {
  const r = driveCli(
    ['message', '--to', 'alpha,ghost', 'halt'],
    `return { ok: false, results: body.to.map((id) => id === 'ghost'
       ? { id, ok: false, error: 'unknown target workspace' }
       : { id, ok: true, branch: 'br-' + id, delivery: 'live' }) };`,
  );
  assert.equal(r.code, 1, 'a partial failure must exit non-zero — scripts gate on $?');

  const alpha = r.stdout.split('\n').find((l) => l.startsWith('alpha')) ?? '';
  assert.match(alpha, /\blive\b/, `valid target must STILL deliver:\n${r.stdout}`);

  const ghost = r.stdout.split('\n').find((l) => l.startsWith('ghost')) ?? '';
  assert.ok(ghost, 'the failed target must appear in the report, not be silently dropped');
  assert.match(ghost, /FAILED/);
  assert.match(ghost, /unknown target workspace/);

  // The failure must ALSO be summarised, naming which target — a human scanning
  // seven lines should not have to diff them by eye.
  assert.match(r.stderr, /1 of 2 target\(s\) failed/);
  assert.match(r.stderr, /ghost/);
});

// The whole point of the broadcast is that ONE call reaches N targets.
test('--to: a single request carries every target (not N sequential calls)', needsBuild, () => {
  const r = driveCli(
    ['message', '--to', 'a,b,c', 'hello', 'world'],
    `return { ok: true, results: body.to.map((id) => ({ id, ok: true, delivery: 'live' })) };`,
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen.length, 1, 'a broadcast must be ONE socket call, not one per target');
  assert.deepEqual(r.seen[0].to, ['a', 'b', 'c']);
  assert.equal(r.seen[0].text, 'hello world');
  assert.equal(r.seen[0].from, 'caller-1');
});

// Duplicates collapse ON THE WIRE: delivering the same halt twice is not
// harmless, it becomes two separate turns for that agent. Asserted on `seen`
// (what the CLI actually sent) rather than on the printed report, because a
// report built from the SERVER's echo would look correct even if the CLI had
// sent the duplicate — the server dedupes as well, and a test that cannot tell
// the two layers apart proves neither.
test('--to: duplicate ids are sent once', needsBuild, () => {
  const r = driveCli(
    ['message', '--to', 'a,b,a,', 'hi'],
    `return { ok: true, results: body.to.map((id) => ({ id, ok: true, delivery: 'live' })) };`,
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.seen[0].to, ['a', 'b'], 'duplicates and the trailing comma must be dropped');
});

// --children sends the INTENT and lets the app resolve the tree. If the CLI
// enumerated children itself it would race the store — and /peers does not even
// expose parentId. So assert the WIRE SHAPE, not just the printed output.
test('--children sends children:true and no explicit target list', needsBuild, () => {
  const r = driveCli(
    ['message', '--children', 'stop', 'everything'],
    `return { ok: true, results: [
       { id: 'kid1', ok: true, branch: 'b1', delivery: 'live' },
       { id: 'kid2', ok: true, branch: 'b2', delivery: 'inbox' }] };`,
    'parent-1',
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen[0].children, true);
  assert.equal(r.seen[0].to, undefined, 'the CLI must not enumerate children itself');
  assert.equal(r.seen[0].text, 'stop everything');
  assert.equal(r.seen[0].from, 'parent-1');
  // Two DIFFERENT kinds again — the same anti-vacuity guard as above.
  assert.match(r.stdout, /kid1.*\blive\b/);
  assert.match(r.stdout, /kid2.*\binbox\b/);
});

// An empty child set must be a NAMED refusal with a non-zero exit. A silent 0
// would let an emergency halt report success having reached NOBODY — which is
// exactly what the unfixed CLI does (it reads '--children' as a workspace id).
test('--children with no children: named error, non-zero exit', needsBuild, () => {
  const r = driveCli(
    ['message', '--children', 'halt'],
    `return { ok: false, error: 'no children to message' };`,
    'lonely',
  );
  assert.notEqual(r.code, 0, 'reaching nobody must never exit 0');
  assert.match(r.stderr, /no children to message/);
  assert.doesNotMatch(r.stdout, /Delivered/);
});

// ---------------------------------------------------------------------------
// BACKWARD COMPATIBILITY. The positional single-target form is what every
// existing agent and script uses, and its output is parsed. It must be
// untouched — byte for byte.
// ---------------------------------------------------------------------------
test('positional form still sends a STRING `to` and prints the legacy line', needsBuild, () => {
  const r = driveCli(
    ['message', 'some-id', 'hello', 'there'],
    `return { ok: true, delivery: 'live', branch: 'br' };`,
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Delivered (live).\n', 'legacy output must be byte-for-byte unchanged');
  assert.equal(r.seen[0].to, 'some-id', 'a single target must stay a STRING on the wire');
  assert.equal(r.seen[0].children, undefined);
  assert.equal(r.seen[0].text, 'hello there');
});

test('--children and --to together are refused before reaching the socket', needsBuild, () => {
  const r = driveCli(['message', '--children', '--to', 'a,b', 'x'], `return { ok: true, results: [] };`);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /mutually exclusive/);
  assert.equal(r.seen.length, 0, 'must refuse BEFORE reaching the socket');
});

test('a broadcast with no text is a usage error, not an empty broadcast', needsBuild, () => {
  const r = driveCli(['message', '--to', 'a,b'], `return { ok: true, results: [] };`);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: orchestra message/);
  assert.equal(r.seen.length, 0);
});

// ---------------------------------------------------------------------------
// F1 REGRESSION (found in review, 2026-08-25) — A MESSAGE BODY IS DATA.
//
// The first cut of this ticket ran takeBoolFlag/takeFlag over the WHOLE argv
// and chose the positional-vs-broadcast branch AFTERWARDS. So a flag token
// sitting inside the message TEXT hijacked the routing:
//
//     orchestra message ws1 pass --to bob
//       -> {"to":["bob"],"text":"ws1 pass"}   RC=0
//
// i.e. delivered to the WRONG workspace, with the intended target swallowed
// into the text, reporting SUCCESS. That is the mirror image of the defect #86
// exists to eliminate, and it is likely text: `--to`/`--children` are now this
// command's documented vocabulary, so "use --children for this, not --to" is an
// ordinary sentence to send a peer.
//
// WHY THE ORIGINAL SUITE COULD NOT CATCH IT: all nine fixtures above put the
// flag at args[0]. Not one drives a positional send whose TEXT contains a flag
// token, so the D6 backward-compatibility guard was structurally incapable of
// failing on this input class. A guard that cannot fail on the defect it guards
// IS the defect. These fixtures exist specifically to close that class, so the
// assertions below are on the WIRE BODY — where misdelivery is visible — not
// merely on the printed output.
// ---------------------------------------------------------------------------
for (const [label, body] of [
  ['--to inside the text', ['pass', '--to', 'bob']],
  ['--children inside the text', ['halt', '--children', 'now']],
  ['a flag as the LAST word', ['stop', 'using', '--to']],
  ['both flag tokens in the text', ['prefer', '--children', 'over', '--to']],
  ['a flag token repeated later in the body', ['says', '--to', 'is', 'not', '--to']],
] as Array<[string, string[]]>) {
  test(`positional send is NOT re-routed by ${label}`, needsBuild, () => {
    const r = driveCli(
      ['message', 'ws1', ...body],
      `return { ok: true, delivery: 'live', branch: 'br' };`,
    );

    const sent = r.seen[0];
    assert.ok(sent, `no request reached the socket: ${r.stderr}`);

    // THE MISDELIVERY ASSERTION. `to` must be the STRING 'ws1' — not an array,
    // not 'bob', not absent. This is the one that fails on the unfixed build.
    assert.equal(
      sent.to,
      'ws1',
      `MISDELIVERY: message intended for ws1 was routed to ${JSON.stringify(sent.to)}`,
    );
    assert.equal(sent.children, undefined, 'a body token must never set children:true');

    // The payload must survive VERBATIM — the target id must not be swallowed
    // into it, and no word may be stripped out of the message.
    assert.equal(
      sent.text,
      body.join(' '),
      'the message text must pass through unchanged, flags and all',
    );

    // And the legacy output contract still holds for this input class.
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Delivered (live).\n');
  });
}

// The flags must still WORK in their legitimate leading position — otherwise
// "never parse flags" would be a fix that silently deletes the feature. This is
// the positive control for the guard above.
test('CONTROL: a LEADING --to is still parsed as a flag, not as a target id', needsBuild, () => {
  const r = driveCli(
    ['message', '--to', 'a,b', 'hello', '--to', 'world'],
    `return { ok: true, results: body.to.map((id) => ({ id, ok: true, delivery: 'live' })) };`,
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.seen[0].to, ['a', 'b'], 'the LEADING --to must still select targets');
  // ...and a second occurrence inside the text stays part of the payload.
  assert.equal(r.seen[0].text, 'hello --to world', 'only the leading flag is consumed');
});

// ---------------------------------------------------------------------------
// F2 (found in review, 2026-08-25) — `results: []` is TRUTHY.
//
// A bare `if (!results)` sails past an empty array and prints an empty table
// plus `Delivered to 0 target(s).` at RC=0 — "reached nobody, reported
// success", the exact founding defect of this ticket. Latent today (the server
// returns before building an empty list), gated anyway: the client half decides
// the exit code an emergency-halt script reads.
// ---------------------------------------------------------------------------
test('an EMPTY results array is a refusal, never a success', needsBuild, () => {
  const r = driveCli(
    ['message', '--children', 'EMERGENCY HALT'],
    `return { ok: true, results: [] };`,
  );
  assert.notEqual(r.code, 0, 'reaching zero targets must never exit 0');
  assert.doesNotMatch(r.stdout, /Delivered to 0 target\(s\)/, 'must not claim delivery to nobody');
});

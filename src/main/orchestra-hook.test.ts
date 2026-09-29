import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The activity-event writer hook (ORCHESTRA_HOOK_SCRIPT in workspaces.ts) is
// pure bash and is the piece most prone to subtle concurrency bugs: several
// hook processes (pretool/posttool/stop) can fire microseconds apart and each
// must claim a DISTINCT, strictly-increasing seq, or the reader's exactly-once
// dedup would either drop real events (two share a seq) or fail to dedup. We
// keep an in-test copy of just the seq-allocation + append core and exercise it
// against the real filesystem with genuinely concurrent invocations.
//
// This mirrors the script in workspaces.ts; if that script changes, this copy
// must change with it. It is intentionally a copy rather than an import because
// the source embeds the script as a TS template literal inside a module that
// pulls in electron.
const HOOK = `#!/usr/bin/env bash
dir="\${ORCHESTRA_EVENTS_DIR:-$HOME/.orchestra/events}"
[ -n "\${ORCHESTRA_WS_ID:-}" ] || exit 0
event="\${1:-}"
[ -n "$event" ] || exit 0
mkdir -p "$dir" 2>/dev/null || true
spool="$dir/$ORCHESTRA_WS_ID.jsonl"
seqf="$dir/$ORCHESTRA_WS_ID.seq"
seq=0
if command -v flock >/dev/null 2>&1; then
  exec 9>>"$seqf"
  if flock -w 2 9; then
    cur="$(cat "$seqf" 2>/dev/null)"
    case "$cur" in ''|*[!0-9]*) cur=0 ;; esac
    seq=$((cur + 1))
    printf '%s' "$seq" >"$seqf"
  fi
  exec 9>&-
fi
printf '{"seq":%s,"event":"%s","tool":"%s"}\\n' "$seq" "$event" "" >> "$spool"
exit 0
`;

function setup(): { dir: string; script: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-hook-'));
  const script = path.join(dir, 'orchestra-hook.sh');
  fs.writeFileSync(script, HOOK, { mode: 0o755 });
  return {
    dir,
    script,
    env: { ...process.env, ORCHESTRA_EVENTS_DIR: dir, ORCHESTRA_WS_ID: 'ws-test' },
  };
}

function readSeqs(dir: string): number[] {
  const spool = path.join(dir, 'ws-test.jsonl');
  if (!fs.existsSync(spool)) return [];
  return fs
    .readFileSync(spool, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { seq: number }).seq);
}

const hasFlock = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v flock'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('sequential invocations produce strictly increasing seqs from 1', () => {
  const { dir, script, env } = setup();
  for (const ev of ['submit', 'pretool', 'posttool', 'stop']) {
    execFileSync('bash', [script, ev], { env });
  }
  const seqs = readSeqs(dir);
  assert.deepEqual(
    seqs,
    hasFlock ? [1, 2, 3, 4] : [0, 0, 0, 0],
    'each event gets the next seq (or all 0 on a flock-less host)',
  );
});

test('concurrent invocations never duplicate or skip a seq', { skip: !hasFlock }, async () => {
  const { dir, script, env } = setup();
  // Fire many writers at once; flock must serialize the read-bump-write so the
  // multiset of seqs is exactly 1..N with no gaps and no repeats.
  const N = 50;
  await Promise.all(
    Array.from({ length: N }, (_unused, i) => {
      const ev = ['submit', 'pretool', 'posttool', 'notify', 'stop'][i % 5];
      return new Promise<void>((resolve, reject) => {
        import('node:child_process').then(({ execFile }) => {
          execFile('bash', [script, ev], { env }, (err) => (err ? reject(err) : resolve()));
        });
      });
    }),
  );
  const seqs = readSeqs(dir).sort((a, b) => a - b);
  assert.equal(seqs.length, N, 'every invocation appended exactly one line');
  assert.deepEqual(
    seqs,
    Array.from({ length: N }, (_u, i) => i + 1),
    'seqs are exactly 1..N — no duplicate (collision) and no gap (lost bump)',
  );
});

test('a fresh start re-uses the wsid file path (rotation/restart resets counter externally)', () => {
  // The counter file is the single source of the next seq; deleting it (as the
  // startEventsSpool startup wipe does) restarts numbering from 1, which is
  // consistent because the reader's cursor lastSeq is also 0 on a fresh run.
  const { dir, script, env } = setup();
  execFileSync('bash', [script, 'submit'], { env });
  fs.rmSync(path.join(dir, 'ws-test.seq'), { force: true });
  fs.rmSync(path.join(dir, 'ws-test.jsonl'), { force: true });
  execFileSync('bash', [script, 'submit'], { env });
  assert.deepEqual(readSeqs(dir), hasFlock ? [1] : [0], 'numbering restarts from 1 after a wipe');
});

// ---------------------------------------------------------------------------
// Payload mining: the REAL ORCHESTRA_HOOK_SCRIPT, rendered from its template
// literal in workspaces.ts (the module itself pulls in electron), run on a stdin
// payload; the result is read back from the spool line it writes. The two Stop
// payloads are REAL captures from a live claude 2.1.234 run (one with an armed
// ScheduleWakeup, one without) — they pin the compact wire format.
const WORKSPACES = path.join(process.cwd(), 'src', 'main', 'workspaces.ts');
function realHookScript(): string {
  const src = fs.readFileSync(WORKSPACES, 'utf8');
  const head = 'const ORCHESTRA_HOOK_SCRIPT = `';
  const start = src.indexOf(head);
  assert.notEqual(start, -1, 'ORCHESTRA_HOOK_SCRIPT not found in workspaces.ts');
  const body = src.slice(start + head.length, src.indexOf('`;\n', start + head.length));
  assert.doesNotMatch(body, /(^|[^\\])\$\{/, 'the hook script gained a real interpolation — extractor unsafe');
  const script = new Function(`return \`${body}\`;`)() as string;
  assert.match(script, /^#!\/usr\/bin\/env bash\n/, 'positive control: extracted text is the hook script');
  return script;
}
const REAL_HOOK = realHookScript();

// The CLI hands hooks the app's env — a UTF-8 LANG (en_US.UTF-8 here), under which
// bash matching is multibyte; without one bash runs in C and a locale bug is invisible.
const HOOK_LANG = 'C.UTF-8';
test('positive control: the hook env below really is a multibyte locale', () => {
  const len = execFileSync('bash', ['-c', 'x=é; printf %s "${#x}"'], { env: { PATH: '/usr/bin:/bin', LANG: HOOK_LANG } }).toString();
  assert.equal(len, '1', `${HOOK_LANG} not available: bash counted é as ${len} chars`);
});

/** Run a hook script as Claude Code does (`bash <script> <event>`, payload on
 *  stdin) and return the raw spool line it appended + the wall time. */
function runHookScript(script: string, event: string, payload: string | Buffer, timeout = 20_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-hook-mine-'));
  try {
    const file = path.join(dir, 'hook.sh');
    fs.writeFileSync(file, script, { mode: 0o755 });
    const t0 = process.hrtime.bigint();
    execFileSync('bash', [file, event], {
      input: payload,
      env: { PATH: '/usr/bin:/bin', LANG: HOOK_LANG, HOME: dir, ORCHESTRA_WS_ID: 'ws-test', ORCHESTRA_EVENTS_DIR: dir },
      timeout,
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { raw: fs.readFileSync(path.join(dir, 'ws-test.jsonl')), ms };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function runReal(event: string, payload: string | Buffer) {
  const { raw, ms } = runHookScript(REAL_HOOK, event, payload);
  return { ...(JSON.parse(raw.toString()) as Record<string, string>), raw, ms };
}

const STOP_PAYLOAD_NO_CRONS =
  '{"session_id":"dd36f181-6d5b-4c5b-b082-91036d455db0","transcript_path":"/tmp/p/dd36f181.jsonl","cwd":"/tmp/p","prompt_id":"caded681-8b3b-47ef-ad44-d6fb658d08ca","permission_mode":"default","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"ok","background_tasks":[],"session_crons":[]}';
const STOP_PAYLOAD_WITH_CRON =
  '{"session_id":"dad3c204-9820-4a9e-b7da-2ca1ced85a3a","transcript_path":"/tmp/p/dad3c204.jsonl","cwd":"/tmp/p","prompt_id":"23b0a366-d18d-41d8-823e-0df855b305b8","permission_mode":"default","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Done.","background_tasks":[],"session_crons":[{"id":"d806bf5b","schedule":"51 19 * * *","recurring":false,"prompt":"noop"}]}';

function runParse(payload: string): string {
  const l = runReal('stop', payload);
  return `${l.tool}|${l.transcript}|${l.crons}`;
}

test('Stop payload with empty session_crons → crons=none (definitively not looping)', () => {
  assert.equal(runParse(STOP_PAYLOAD_NO_CRONS), '|/tmp/p/dd36f181.jsonl|none');
});

test('Stop payload with an armed session cron → crons=some', () => {
  assert.equal(runParse(STOP_PAYLOAD_WITH_CRON), '|/tmp/p/dad3c204.jsonl|some');
});

test('payload without session_crons (older CLI) → crons empty = no opinion', () => {
  const legacy =
    '{"session_id":"x","transcript_path":"/tmp/p/x.jsonl","hook_event_name":"Stop","stop_hook_active":false}';
  assert.equal(runParse(legacy), '|/tmp/p/x.jsonl|');
});

test('a message QUOTING session_crons:[] cannot spoof the matcher — JSON escaping breaks the pattern', () => {
  // The bash matcher is a substring scan, not a JSON parse — but it is still
  // unspoofable by string CONTENT: inside any JSON string value a double quote
  // is escaped as \" on the wire, so the raw byte sequence "session_crons":[]
  // can only ever appear as a real top-level key. A payload whose
  // last_assistant_message quotes the empty form must still read the REAL
  // field (here: an armed cron → some).
  const spoofed = STOP_PAYLOAD_WITH_CRON.replace('"Done."', '"see \\"session_crons\\":[] here"');
  assert.equal(runParse(spoofed).split('|')[2], 'some');
});

// ---------------------------------------------------------------------------
// #198 D20: mining must stay LINEAR in the payload. The pre-fix
// `${payload#*"tool_use_id"}` is O(n²) in bash, and a PostToolUse carries the
// tool_response BEFORE the top-level id (CLI 2.1.284 key order): a real 295 KB
// Edit payload took 46 s, and past the CLI's 60 s hook timeout the posttool is lost.
const common = (hook_event_name: string) => ({
  session_id: 'S', transcript_path: '/home/u/.claude/projects/p/S.jsonl', cwd: '/home/u/wt',
  prompt_id: 'P', permission_mode: 'bypassPermissions', hook_event_name,
});
const REAL_FILE = fs.readFileSync(WORKSPACES, 'utf8'); // a real ~290 KB source file

test('a real-size Edit PostToolUse (whole file in tool_response) is mined in bounded time', () => {
  const payload = JSON.stringify({
    ...common('PostToolUse'), tool_name: 'Edit',
    tool_input: { file_path: '/home/u/wt/w.ts', old_string: 'a', new_string: 'b', replace_all: false },
    tool_response: { filePath: '/home/u/wt/w.ts', oldString: 'a', newString: 'b', originalFile: REAL_FILE, structuredPatch: [], userModified: false, replaceAll: false },
    tool_use_id: 'toolu_BIG_EDIT', duration_ms: 44,
  });
  assert.ok(payload.length > 250_000, `positive control: real-size payload (${payload.length} B)`);
  const l = runReal('posttool', payload);
  assert.equal(l.toolUseId, 'toolu_BIG_EDIT');
  assert.equal(l.tool, 'Edit');
  assert.ok(l.ms < 5_000, `posttool hook took ${Math.round(l.ms)} ms on ${payload.length} B (pre-fix: ~46 s)`);
});

test('a real-size Write PreToolUse (content in tool_input) is mined in bounded time', () => {
  const payload = JSON.stringify({
    ...common('PreToolUse'), tool_name: 'Write',
    tool_input: { file_path: '/home/u/wt/w.ts', content: REAL_FILE }, tool_use_id: 'toolu_BIG_WRITE',
  });
  const l = runReal('pretool', payload);
  assert.equal(l.toolUseId, 'toolu_BIG_WRITE');
  assert.ok(l.ms < 5_000, `pretool hook took ${Math.round(l.ms)} ms on ${payload.length} B`);
});

test('a real-size FAILED Write (PostToolUseFailure: content before tool_use_id) is mined in bounded time', () => {
  // reviewer-t6b F1: T6b wired PostToolUseFailure to this same miner. Real CLI key
  // order: tool_name, tool_input, tool_use_id, error, is_interrupt, duration_ms.
  const payload = JSON.stringify({
    ...common('PostToolUseFailure'), tool_name: 'Write',
    tool_input: { file_path: '/home/u/wt/w.ts', content: REAL_FILE }, tool_use_id: 'toolu_BIG_FAIL',
    error: 'File has not been read yet. Read it first before writing to it.', is_interrupt: false, duration_ms: 3,
  });
  const l = runReal('posttool', payload);
  assert.equal(l.toolUseId, 'toolu_BIG_FAIL');
  assert.ok(l.ms < 5_000, `failure hook took ${Math.round(l.ms)} ms on ${payload.length} B (pre-fix: ~46 s)`);
});

// The pre-fix mining block, frozen verbatim: the oracle for byte-identity. It is
// spliced into the REAL script in place of the new block, so both scripts share
// every other line (line format, escaping, crons) and only the mining differs.
const LEGACY_MINING = `    case "$payload" in
      *'"tool_name"'*)
        rest="\${payload#*'"tool_name"'}"
        rest="\${rest#*:}"
        rest="\${rest#*'"'}"
        tool="\${rest%%'"'*}"
        ;;
    esac
    case "$payload" in
      *'"tool_use_id"'*)
        rest="\${payload#*'"tool_use_id"'}"
        rest="\${rest#*:}"
        rest="\${rest#*'"'}"
        tooluseid="\${rest%%'"'*}"
        ;;
    esac
    if [ "$event" = "session" ]; then
      case "$payload" in
        *'"source"'*)
          rest="\${payload#*'"source"'}"
          rest="\${rest#*:}"
          rest="\${rest#*'"'}"
          tool="\${rest%%'"'*}"
          ;;
      esac
    fi
    case "$payload" in
      *'"transcript_path"'*)
        rest="\${payload#*'"transcript_path"'}"
        rest="\${rest#*:}"
        rest="\${rest#*'"'}"
        transcript="\${rest%%'"'*}"
        ;;
    esac
`;
function legacyHook(): string {
  const from = REAL_HOOK.indexOf('    payload="$(cat)"\n');
  const to = REAL_HOOK.indexOf('    # Loop level-signal');
  assert.ok(from > 0 && to > from, 'mining region markers not found in the real hook');
  const head = REAL_HOOK.slice(0, from + '    payload="$(cat)"\n'.length);
  const out = head + LEGACY_MINING + REAL_HOOK.slice(to);
  assert.notEqual(out, REAL_HOOK, 'positive control: the oracle differs from the shipped script');
  return out;
}

/** CLI-shaped payloads: the common prefix, a tool_name, seeded nested
 *  tool_input/tool_response (nested tool_use_id/tool_name/source/transcript_path
 *  keys with string, number, null, object values; unicode, escaped quotes,
 *  colons, backslashes, pretty-printed JSON), then the top-level id. */
function minedCorpus(): Buffer[] {
  let seed = 198_020;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const KEYS = ['tool_use_id', 'tool_name', 'source', 'transcript_path', 'content'];
  const STR = ['toolu_01AbC', 'srvtoolu_NESTED', 'é→—中文 💥', 'a:b', 'say "hi"', '', 'tool_use_id', '"tool_use_id":"x"', 'l\nb', 'back\\slash', ' sp '];
  const val = (d: number): unknown => {
    const r = rnd();
    if (d > 2 || r < 0.45) return pick(STR);
    if (r < 0.55) return Math.floor(rnd() * 1000);
    if (r < 0.6) return null;
    if (r < 0.85) { const o: Record<string, unknown> = {}; for (let i = 0; i < 1 + rnd() * 3; i++) o[pick(KEYS)] = val(d + 1); return o; }
    return [val(d + 1), val(d + 1)];
  };
  const list: Buffer[] = [];
  for (let i = 0; i < 40; i++) {
    const ev = pick(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
    const p: Record<string, unknown> = { ...common(ev), tool_name: pick(['Bash', 'Edit', 'WebSearch', 'é']), tool_input: val(0) };
    if (ev === 'PostToolUse') p.tool_response = val(0);
    p.tool_use_id = `toolu_${i}`;
    // A failure's `error` string AFTER the id may even read exactly "tool_use_id".
    if (ev === 'PostToolUseFailure') Object.assign(p, { error: pick(STR), is_interrupt: false });
    if (ev !== 'PreToolUse') p.duration_ms = 5;
    list.push(Buffer.from(rnd() < 0.25 ? JSON.stringify(p, null, 1) : JSON.stringify(p)));
  }
  list.push(
    Buffer.from(STOP_PAYLOAD_NO_CRONS), Buffer.from(STOP_PAYLOAD_WITH_CRON),
    ...['startup', 'resume', 'clear', 'compact'].map((source) => Buffer.from(JSON.stringify({ ...common('SessionStart'), source }))),
    // An older CLI / remote wire: a tool call WITHOUT a tool_use_id.
    Buffer.from(JSON.stringify({ ...common('PreToolUse'), tool_name: 'Bash', tool_input: { command: 'x' } })),
    // A WebSearch whose tool_response nests a server-tool id before the top-level one.
    Buffer.from(JSON.stringify({ ...common('PostToolUse'), tool_name: 'WebSearch', tool_input: { query: 'q' }, tool_response: { results: [{ tool_use_id: 'srvtoolu_01NESTED' }] }, tool_use_id: 'toolu_TOP' })),
    // A "tool_use_id" STRING VALUE after the top-level key (a failure's error): not a key.
    Buffer.from(JSON.stringify({ ...common('PostToolUseFailure'), tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'toolu_OWN', error: 'tool_use_id', is_interrupt: false, duration_ms: 4 })),
    // Invalid UTF-8 inside mined values: byte semantics, as bash's own fallback.
    Buffer.concat([Buffer.from('{"tool_name":"Ba'), Buffer.from([0xff, 0xfe]), Buffer.from('sh","tool_use_id":"to'), Buffer.from([0xe2, 0x82]), Buffer.from('lu_X"}')]),
  );
  return list;
}

/** The call's own id: the payload's TOP-LEVEL tool_use_id (undefined if none). */
function ownId(buf: Buffer): string | undefined {
  try {
    const id = (JSON.parse(buf.toString('utf8')) as { tool_use_id?: unknown }).tool_use_id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}
const lineId = (raw: Buffer) => /"toolUseId":"([^"]*)"/.exec(raw.toString('latin1'))?.[1];

test('the spool line equals the pre-fix parse, except a toolUseId it mis-mined, which is now the call\'s own id', () => {
  // D20 byte-identity is scoped to payloads where the pre-fix parse mined the
  // CALL's own id; where it took a nested/value "tool_use_id" (WebSearch
  // srvtoolu_), the fix must differ in that one field — and only there (F1).
  const legacy = legacyHook();
  const corpus = minedCorpus();
  let identical = 0;
  const corrected = new Set<number>();
  for (const [i, buf] of corpus.entries()) {
    const own = ownId(buf);
    for (const event of ['pretool', 'posttool', 'stop', 'notify', 'session']) {
      const want = runHookScript(legacy, event, buf).raw;
      const got = runHookScript(REAL_HOOK, event, buf).raw;
      if (got.equals(want)) { identical++; continue; }
      const was = lineId(want);
      assert.ok(own !== undefined && was !== own, `payload #${i} ${event}: differs although the pre-fix parse mined the call's own id\n  legacy ${want}\n  shipped ${got}`);
      const ownLatin1 = Buffer.from(own, 'utf8').toString('latin1');
      const expected = want.toString('latin1').replace(`"toolUseId":"${was}"`, `"toolUseId":"${ownLatin1}"`);
      assert.equal(got.toString('latin1'), expected, `payload #${i} ${event}: only toolUseId may change, to the own id`);
      corrected.add(i);
    }
  }
  // Positive control + enumeration: exactly the payloads with a "tool_use_id"
  // BEFORE the top-level key are corrected (the corpus must exercise them).
  const nestedFirst = corpus.flatMap((buf, i) => {
    const own = ownId(buf);
    const raw = buf.toString('latin1');
    const first = /"tool_use_id"[^:]*:[^"]*"([^"]*)/.exec(raw)?.[1];
    const occurrences = raw.split('"tool_use_id"').length - 1;
    return own !== undefined && occurrences > 1 && first !== Buffer.from(own, 'utf8').toString('latin1') ? [i] : [];
  });
  assert.ok(nestedFirst.length > 0, 'positive control: the corpus has nested-id payloads');
  assert.deepEqual([...corrected].sort((x, y) => x - y), nestedFirst, 'corrected set == nested-id-first payloads');
  assert.equal(identical + corrected.size * 5, corpus.length * 5);
});

test('a real-shape WebSearch posttool carries the call\'s own id, not the nested srvtoolu_ one (F1)', () => {
  // CLI 2.1.284 capture: tool_response.results[0].tool_use_id precedes the top-level key.
  const payload = JSON.stringify({
    ...common('PostToolUse'), tool_name: 'WebSearch', tool_input: { query: 'anthropic claude code hooks' },
    tool_response: {
      query: 'anthropic claude code hooks',
      results: [{ tool_use_id: 'srvtoolu_01QKHnHcAnzmMwPRRvpKcqAy', content: [{ title: 'Hooks', url: 'https://docs.anthropic.com/hooks' }] }, 'Based on the search results, …'],
      durationSeconds: 6.8, searchCount: 1,
    },
    tool_use_id: 'toolu_01BUYBKT9Jo6HGaGUN8m1zaa', duration_ms: 6800,
  });
  assert.equal(lineId(runHookScript(legacyHook(), 'posttool', payload).raw), 'srvtoolu_01QKHnHcAnzmMwPRRvpKcqAy', 'control: the pre-fix parse mis-mines');
  assert.equal(runReal('posttool', payload).toolUseId, 'toolu_01BUYBKT9Jo6HGaGUN8m1zaa');
});

test('invalid UTF-8 inside a mined value is kept byte-for-byte (C-locale scan under a UTF-8 LANG)', () => {
  const buf = minedCorpus().at(-1)!;
  const { raw } = runHookScript(REAL_HOOK, 'posttool', buf);
  assert.ok(raw.includes(Buffer.concat([Buffer.from('"toolUseId":"to'), Buffer.from([0xe2, 0x82]), Buffer.from('lu_X"')])), `got ${raw.toString('latin1')}`);
});

test('the one divergence from the pre-fix parse: a key with no string after it mines nothing', () => {
  // Pre-fix returned the raw tail (`null}`); no CLI payload has a mined key
  // without a string value after it, so this cannot move a real spool line.
  const payload = '{"tool_name":"Bash","tool_use_id":null}';
  assert.equal(runHookScript(legacyHook(), 'posttool', payload).raw.toString().includes('"toolUseId":"null}"'), true);
  assert.equal(runReal('posttool', payload).toolUseId, '');
});

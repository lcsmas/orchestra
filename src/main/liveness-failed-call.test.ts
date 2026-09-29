// #199 residual (T6b, ledger #198 D19): the "hung mid-call 10m" escalation still
// false-positived on v0.5.295 (verifier ca4268dd, 17:04:07Z). Cause, measured: a
// tool call can END without PostToolUse — a FAILED call (Bash non-zero exit) fires
// PostToolUseFailure, a DENIED call fires neither, only the batch's PostToolBatch
// (real CLI 2.1.284). Orchestra wired PostToolUse only, so the call stayed in
// inFlightTools until the turn ended. 15/15 field escalations had an is_error Bash
// at T-(600..720)s. The coalesced wake of the incident emits no event (not a cause).
//
// These arms run the REAL hook script (extracted from workspaces.ts source, where
// it is a template literal in an Electron-bound module) on payloads shaped like the
// real CLI's, then the SHIPPED tracker + policy. The installer wiring and the
// activity.ts dispatch are pinned by source checks; the real-module chain (real
// installOrchestraHooks → real spool reader → real applyAgentEvent) is driven by
// scripts/e2e-liveness-failed-call.sh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  noteToolStart,
  noteToolEnd,
  noteToolBatchEnd,
  getInFlightTools,
  forgetHibernationActivity,
} from './hibernation-activity.ts';
import { decideEscalation, type MemberLivenessState } from '../shared/bus-liveness.ts';

const WORKSPACES = path.join(process.cwd(), 'src', 'main', 'workspaces.ts');
const ACTIVITY = path.join(process.cwd(), 'src', 'main', 'activity.ts');
const MIN = 60_000;

/** The shipped ORCHESTRA_HOOK_SCRIPT, evaluated exactly as the TS template literal
 *  renders it (refuses if the body ever gains a real `${}` interpolation). */
function realHookScript(): string {
  const src = fs.readFileSync(WORKSPACES, 'utf8');
  const head = 'const ORCHESTRA_HOOK_SCRIPT = `';
  const start = src.indexOf(head);
  assert.notEqual(start, -1, 'ORCHESTRA_HOOK_SCRIPT not found in workspaces.ts');
  const end = src.indexOf('`;\n', start + head.length);
  const body = src.slice(start + head.length, end);
  assert.doesNotMatch(body, /(^|[^\\])\$\{/, 'the hook script gained a real interpolation — extractor unsafe');
  const script = new Function(`return \`${body}\`;`)() as string;
  assert.match(script, /^#!\/usr\/bin\/env bash\n/, 'positive control: extracted text is the hook script');
  return script;
}

/** Run the real hook script as Claude Code does: `bash orchestra-hook.sh <event>`
 *  (the installed command's argv), payload JSON on stdin. Returns the spool lines. */
function runHook(
  runs: Array<{ event: string; payload: object }>,
  timeoutMs = 10_000,
): Array<{ seq: number; event: string; tool: string; toolUseId: string }> {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.t6b-hook-test-'));
  try {
    const script = path.join(dir, 'orchestra-hook.sh');
    fs.writeFileSync(script, realHookScript(), { mode: 0o755 });
    const env = { PATH: '/usr/bin:/bin', HOME: dir, ORCHESTRA_WS_ID: 'ws-t6b', ORCHESTRA_EVENTS_DIR: dir };
    for (const r of runs) {
      execFileSync('bash', [script, r.event], { input: JSON.stringify(r.payload), env, timeout: timeoutMs });
    }
    return fs
      .readFileSync(path.join(dir, 'ws-t6b.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Payloads in the key order CLI 2.1.284 emits (captured with a hook logger).
const common = {
  session_id: 'S',
  transcript_path: '/home/u/.claude/projects/p/S.jsonl',
  cwd: '/home/u/wt',
  prompt_id: 'P',
  permission_mode: 'bypassPermissions',
};
const preToolUse = (id: string, tool = 'Bash') => ({
  ...common,
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: { command: 'false', description: 'd' },
  tool_use_id: id,
});
const postToolUseFailure = (id: string) => ({
  ...common,
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command: 'false', description: 'd' },
  tool_use_id: id,
  error: 'Exit code 1',
  is_interrupt: false,
  duration_ms: 270,
});
const postToolBatch = (calls: Array<[string, string, unknown]>) => ({
  ...common,
  hook_event_name: 'PostToolBatch',
  tool_calls: calls.map(([tool_name, tool_use_id, tool_response]) => ({
    tool_name,
    tool_input: { command: 'x' },
    tool_use_id,
    tool_response,
  })),
});

/** Feed spool lines through the per-event tracker dispatch activity.ts performs
 *  (pinned by the source checks below). */
function apply(ws: string, lines: Array<{ event: string; tool: string; toolUseId: string }>): void {
  for (const l of lines) {
    const id = l.toolUseId || null;
    if (l.event === 'pretool') noteToolStart(ws, l.tool || null, id);
    else if (l.event === 'posttool') noteToolEnd(ws, id, l.tool || null);
    else if (l.event === 'toolbatch') noteToolBatchEnd(ws, id);
  }
}

function member(ws: string): MemberLivenessState {
  return {
    reader: ws,
    coordinator: 'coord',
    hasTask: true,
    lastActivityAt: Date.now(),
    appStartedAt: Date.now(),
    running: true, // the turn is still in flight — the incident's shape
    waiting: false,
    inFlightTools: getInFlightTools(ws),
  } as MemberLivenessState;
}

test('T6b must-FAIL on master: a FAILED Bash (PostToolUseFailure) leaves in-flight → no hung-mid-call at +10 min', (t) => {
  const ws = 'ws-t6b-failed';
  t.after(() => forgetHibernationActivity(ws));
  // The hook the installer wires for PostToolUseFailure runs `orchestra-hook.sh posttool`.
  const lines = runHook([
    { event: 'pretool', payload: preToolUse('toolu_FAILED') },
    { event: 'posttool', payload: postToolUseFailure('toolu_FAILED') },
  ]);
  assert.deepEqual(
    lines.map((l) => [l.event, l.toolUseId]),
    [['pretool', 'toolu_FAILED'], ['posttool', 'toolu_FAILED']],
    'the real script mines the failure payload\'s tool_use_id into a posttool line',
  );
  apply(ws, lines);
  assert.deepEqual(getInFlightTools(ws), []);
  const d = decideEscalation(member(ws), undefined, Date.now() + 10 * MIN + 1_000, true);
  assert.equal(d.kind, 'skip', 'a finished (failed) call must not escalate as hung');
  // Contrast (the master shape): without that posttool line the same call escalates.
  const wsM = 'ws-t6b-failed-master';
  t.after(() => forgetHibernationActivity(wsM));
  apply(wsM, lines.slice(0, 1));
  const dm = decideEscalation(member(wsM), undefined, Date.now() + 10 * MIN + 1_000, true);
  assert.equal(dm.kind, 'escalate', 'control: the unwired failure strands the pretool → escalates');
});

test('T6b: a failed call leaves at FAILURE time, not batch end — a long sibling keeps the batch open', (t) => {
  const ws = 'ws-t6b-long-sibling';
  t.after(() => forgetHibernationActivity(ws));
  apply(ws, runHook([
    { event: 'pretool', payload: preToolUse('toolu_LONG', 'mcp__slow__long_query') },
    { event: 'pretool', payload: preToolUse('toolu_FAILED') },
    { event: 'posttool', payload: postToolUseFailure('toolu_FAILED') },
  ]));
  assert.deepEqual(getInFlightTools(ws).map((c) => c.toolUseId), ['toolu_LONG']);
  // The MCP call is 10 min into a 30-min ceiling: alive. The failed Bash is gone.
  assert.equal(decideEscalation(member(ws), undefined, Date.now() + 10 * MIN + 1_000, true).kind, 'skip');
});

test('T6b must-FAIL on master: a DENIED call is removed by the batch (toolbatch lists EVERY id)', (t) => {
  const ws = 'ws-t6b-denied';
  t.after(() => forgetHibernationActivity(ws));
  const lines = runHook([
    { event: 'pretool', payload: preToolUse('toolu_OK') },
    { event: 'pretool', payload: preToolUse('toolu_DENIED') },
    { event: 'posttool', payload: { ...postToolUseFailure('toolu_OK'), hook_event_name: 'PostToolUse' } },
    // The denied call gets no per-call end at all — only its batch.
    {
      event: 'toolbatch',
      payload: postToolBatch([
        ['Bash', 'toolu_OK', { stdout: 'ok' }],
        ['Bash', 'toolu_DENIED', 'Permission denied'],
      ]),
    },
  ]);
  const batch = lines.find((l) => l.event === 'toolbatch');
  assert.equal(batch?.toolUseId, 'toolu_OK,toolu_DENIED', 'every call id of the batch, in order');
  apply(ws, lines);
  assert.deepEqual(getInFlightTools(ws), []);
  assert.equal(decideEscalation(member(ws), undefined, Date.now() + 10 * MIN + 1_000, true).kind, 'skip');
});

test('T6b: a WebSearch posttool mis-mined to a nested srvtoolu id is reconciled by its batch', (t) => {
  const ws = 'ws-t6b-web';
  t.after(() => forgetHibernationActivity(ws));
  const nested = { query: 'q', results: [{ tool_use_id: 'srvtoolu_NESTED', content: [] }] };
  const lines = runHook([
    { event: 'pretool', payload: preToolUse('toolu_WEB', 'WebSearch') },
    {
      event: 'posttool',
      payload: {
        ...common,
        hook_event_name: 'PostToolUse',
        tool_name: 'WebSearch',
        tool_input: { query: 'q' },
        tool_response: nested,
        tool_use_id: 'toolu_WEB',
        duration_ms: 5,
      },
    },
    { event: 'toolbatch', payload: postToolBatch([['WebSearch', 'toolu_WEB', nested]]) },
  ]);
  // Field c3593714: the per-call hook takes the FIRST "tool_use_id" — here the
  // nested one — so the call outlives its own posttool; the batch must repair it.
  apply(ws, lines.slice(0, 2));
  const perCallMined = lines[1].toolUseId;
  apply(ws, lines.slice(2));
  assert.deepEqual(getInFlightTools(ws), [], `the batch removed it (per-call hook mined ${perCallMined})`);
});

test('T6b must-PASS: a genuinely hung call (no end, batch never resolves) still escalates', (t) => {
  const ws = 'ws-t6b-hung';
  t.after(() => forgetHibernationActivity(ws));
  apply(ws, runHook([
    { event: 'pretool', payload: preToolUse('toolu_HUNG') },
    { event: 'pretool', payload: preToolUse('toolu_FAILED') },
    { event: 'posttool', payload: postToolUseFailure('toolu_FAILED') },
  ]));
  assert.deepEqual(getInFlightTools(ws).map((c) => c.toolUseId), ['toolu_HUNG']);
  const d = decideEscalation(member(ws), undefined, Date.now() + 10 * MIN + 1_000, true);
  assert.equal(d.kind, 'escalate');
});

test('T6b must-PASS: a batch removes ONLY its listed ids — the parent Agent call survives a subagent batch', (t) => {
  const ws = 'ws-t6b-subagent';
  t.after(() => forgetHibernationActivity(ws));
  noteToolStart(ws, 'Agent', 'toolu_PARENT');
  noteToolStart(ws, 'Bash', 'toolu_SUB');
  noteToolBatchEnd(ws, 'toolu_SUB,srvtoolu_UNKNOWN');
  assert.deepEqual(getInFlightTools(ws).map((c) => c.toolUseId), ['toolu_PARENT']);
  const d = decideEscalation(member(ws), undefined, Date.now() + 30 * MIN + 1_000, true);
  assert.equal(d.kind, 'escalate', 'a hung parent Agent call must still escalate at its 30-min ceiling');
});

test('T6b must-PASS: an empty/unmatched batch never falls back to FIFO on an id-less call', (t) => {
  const ws = 'ws-t6b-fifo';
  t.after(() => forgetHibernationActivity(ws));
  noteToolStart(ws, 'Bash', null); // legacy hook / remote wire: no id
  noteToolBatchEnd(ws, null);
  noteToolBatchEnd(ws, '');
  noteToolBatchEnd(ws, 'toolu_OTHER');
  assert.equal(getInFlightTools(ws).length, 1, 'the id-less call must survive a batch that does not name it');
});

test('T6b: the toolbatch id mining is LINEAR — a 2 MB batch payload completes in bounded time', () => {
  // A batch carries every tool_response (an Edit's whole originalFile). The per-call
  // `${payload#*"tool_use_id"}` expansion is O(n^2) (200 KB = 20.8 s measured);
  // the same form here would blow this bound by minutes.
  const big = 'x'.repeat(1_000_000);
  const t0 = Date.now();
  const lines = runHook(
    [{ event: 'toolbatch', payload: postToolBatch([['Read', 'toolu_A', { content: big }], ['Edit', 'toolu_B', { originalFile: big }]]) }],
    5_000,
  );
  assert.equal(lines[0].toolUseId, 'toolu_A,toolu_B');
  assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0} ms`);
});

// ── source pins: the installer wiring + the activity.ts dispatch ─────────────

function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

test('T6b source: the installer wires PostToolUseFailure → posttool and PostToolBatch → toolbatch (must-FAIL on master)', () => {
  const src = code(WORKSPACES);
  assert.match(
    src,
    /const POSTTOOL_HOOK_EVENTS = \['PostToolUse', 'PostToolUseFailure'\] as const;/,
    'both per-call END events must be listed (literal, not derived)',
  );
  assert.match(src, /const HOOK_ACTIVITY_TOOLBATCH_CMD = activityHookCmd\('toolbatch'\);/);
  assert.match(
    src,
    /for \(const ev of POSTTOOL_HOOK_EVENTS\) \{[^}]*upsertHookCommand\(list, HOOK_ACTIVITY_POSTTOOL_CMD\);[^}]*hooks\[ev\] = list;/,
    'every POSTTOOL_HOOK_EVENTS entry must be wired to the posttool command',
  );
  assert.match(
    src,
    /hooks\.PostToolBatch as unknown\[\]\) \?\?= \[\]\);\s*upsertHookCommand\(toolBatchList, HOOK_ACTIVITY_TOOLBATCH_CMD\);\s*hooks\.PostToolBatch = toolBatchList;/,
  );
  // The reinstall sentinel must cover the WIRING, or re-pointing an event at an
  // existing command never reaches already-installed worktrees.
  const hv = src.slice(src.indexOf('const HOOKS_VERSION'), src.indexOf(".digest('hex')"));
  assert.match(hv, /POSTTOOL_HOOK_EVENTS\.join\(','\)/);
  assert.match(hv, /HOOK_ACTIVITY_TOOLBATCH_CMD/);
});

test('T6b source: activity.ts routes toolbatch to noteToolBatchEnd with the id list', () => {
  const src = code(ACTIVITY);
  const start = src.indexOf("case 'toolbatch':");
  assert.notEqual(start, -1, "activity.ts has no case 'toolbatch' — the batch line would hit the unhandled-event default");
  const arm = src.slice(start, src.indexOf('break;', start));
  assert.match(arm, /noteToolBatchEnd\(\s*id\s*,\s*toolUseId \?\? null\s*\)/);
  assert.doesNotMatch(arm, /clearInFlightTools/, 'a batch must never clear-all (subagent batch vs parent call)');
});

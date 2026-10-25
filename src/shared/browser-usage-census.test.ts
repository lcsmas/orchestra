// #392 (spec #388 success metric): the browser usage census counts REAL tool_use blocks, never tool listings.
// Positive control = scripts/fixtures/browser-usage-census (one call + listings/prose/results/replays/mentions → exactly 1);
// the must-FAIL arms mutate the script's source in a scratch copy and require the control to redden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as census from '../../scripts/browser-usage-census.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'browser-usage-census.mjs');
const FIXTURE_ROOT = path.join(REPO, 'scripts', 'fixtures', 'browser-usage-census', 'projects');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-usage-census-test-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

type Mod = typeof census;
const calls = (r: any) => Object.fromEntries(Object.entries(r.surfaces).map(([k, v]: [string, any]) => [k, v.calls]));
const total = (r: any) => Object.values(calls(r)).reduce((a: number, b: any) => a + b, 0);
/** The ticket's promise as one predicate: the fixture (one call + listings/prose/result/replay/CLI mentions) counts exactly 1. */
function controlHolds(mod: Mod): boolean {
  const r = mod.runCensus({ roots: [FIXTURE_ROOT] });
  return total(r) === 1 && r.surfaces['chrome-main'].calls === 1 && r.surfaces['chrome-main'].sessions === 1;
}
const asst = (sessionId: string, ts: string | undefined, ...content: any[]) => JSON.stringify({ type: 'assistant', sessionId, ...(ts ? { timestamp: ts } : {}), message: { role: 'assistant', content } });
const use = (id: string, name: string, input: any = {}) => ({ type: 'tool_use', id, name, input });
const sh = (id: string, command: string) => use(id, 'Bash', { command });

test('C1 positive control: one call + one listing (and prose, result, replay, CLI mention) counts EXACTLY 1', () => {
  const r = census.runCensus({ roots: [FIXTURE_ROOT] });
  assert.equal(total(r), 1);
  assert.deepEqual(calls(r), { 'chrome-main': 1, 'chrome-devtools': 0, 'panel-mcp': 0, 'orchestra-browser-cli': 0 });
  assert.deepEqual(r.surfaces['chrome-main'].tools, { 'mcp__chrome-main__click': 1 });
  assert.equal(r.surfaces['chrome-main'].sessions, 1);
  assert.equal(r.scanned.files, 1);
  assert.equal(r.scanned.lines, 7, 'the fixture really holds the 7 lines (listing ×2, prose, call, result, replay, Bash mention) the control argues from');
  assert.equal(controlHolds(census), true);
});

test('C2 CLI process: JSON on stdout, table on stderr, exit 0; a root with no transcript refuses to report a zero', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, '--root', FIXTURE_ROOT], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).surfaces['chrome-main'].calls, 1);
  assert.match(ok.stderr, /chrome-main\s+1\s+1/);
  const empty = fs.mkdtempSync(path.join(scratch, 'empty-'));
  const none = spawnSync(process.execPath, [SCRIPT, '--root', empty, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(none.status, 3, 'an empty scan is an error, not a baseline of 0');
  assert.equal(none.stdout, '');
  const bad = spawnSync(process.execPath, [SCRIPT, '--root', FIXTURE_ROOT, '--since', 'yesterday'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

function mutate(name: string, edits: Array<[string, string]>): Promise<Mod> {
  let src = fs.readFileSync(SCRIPT, 'utf8');
  for (const [from, to] of edits) {
    assert.equal(src.split(from).length - 1, 1, `${name}: mutant anchor must occur exactly once in the live script: ${from}`);
    src = src.replace(from, () => to);
  }
  assert.notEqual(src, fs.readFileSync(SCRIPT, 'utf8'));
  const file = path.join(scratch, `${name}.mjs`);
  fs.writeFileSync(file, src);
  return import(pathToFileURL(file).href);
}

test('C3 must-FAIL: "count tool names anywhere in a line" reddens the control (listing + prose + result + replay all counted)', async () => {
  const m = await mutate('names-anywhere', [
    ["if (!record || record.type !== 'assistant' || !Array.isArray(record.message?.content)) return [];", "return [...JSON.stringify(record ?? {}).matchAll(/mcp__(?:chrome-main|chrome-devtools|browser)__[a-z_]+/g)].map((x) => ({ type: 'tool_use', name: x[0] }));"],
    ["if (!line.includes('tool_use')) continue;", ''],
  ]);
  assert.equal(controlHolds(m), false);
  assert.ok(total(m.runCensus({ roots: [FIXTURE_ROOT] })) >= 6, 'listings (3+3), prose (2), result (1), replay (1) and the call are all counted by the mutant');
});

test('C3b must-FAIL: a plain-substring `orchestra browser` match counts the quoted/heredoc mention and reddens the control', async () => {
  const m = await mutate('cli-substring', [
    ['const m = CLI_RE.exec(shellSkeleton(command));', 'const m = /orchestra\\s+browser(?:\\s+([A-Za-z][\\w-]*))?/.exec(command);'],
  ]);
  assert.equal(controlHolds(m), false);
  assert.equal(m.runCensus({ roots: [FIXTURE_ROOT] }).surfaces['orchestra-browser-cli'].calls, 1);
});

test('C3c must-FAIL: dropping the tool_use-id de-duplication double-counts a copied history', async () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'dup-'));
  const line = asst('s1', '2026-10-01T00:00:00Z', use('toolu_dup', 'mcp__browser__navigate'));
  fs.writeFileSync(path.join(dir, 'a.jsonl'), `${line}\n`);
  fs.writeFileSync(path.join(dir, 'b.jsonl'), `${line}\n`);
  assert.equal(census.runCensus({ roots: [dir] }).surfaces['panel-mcp'].calls, 1);
  const m = await mutate('no-dedupe', [['if (census.seenIds.has(block.id)) { census.scanned.duplicatesSkipped++; continue; }', '']]);
  assert.equal(m.runCensus({ roots: [dir] }).surfaces['panel-mcp'].calls, 2);
});

test('C4 the four surfaces, tools and distinct sessions; subagent/other-name tool_use are not browser calls', () => {
  const c = census.createCensus();
  const w = census.parseWindow(null, null);
  census.addTranscriptText(c, [
    asst('s1', '2026-10-01T00:00:00Z', use('t1', 'mcp__chrome-main__click'), use('t2', 'mcp__chrome-main__click'), use('t3', 'mcp__chrome-main__navigate_page')),
    asst('s2', '2026-10-02T00:00:00Z', use('t4', 'mcp__chrome-devtools__take_snapshot'), use('t5', 'mcp__browser__navigate'), use('t6', 'mcp__browser__screenshot')),
    asst('s2', '2026-10-03T00:00:00Z', sh('t7', 'orchestra browser snapshot --json'), use('t8', 'Read', { file_path: '/x' }), use('t9', 'mcp__linear-server__get_issue')),
    asst('s3', '2026-10-04T00:00:00Z', sh('t10', 'ls && orchestra browser click @e1')),
  ].join('\n'), w, 'file-a');
  const r = census.finalize(c, { window: w, roots: ['r'] });
  assert.deepEqual(calls(r), { 'chrome-main': 3, 'chrome-devtools': 1, 'panel-mcp': 2, 'orchestra-browser-cli': 2 });
  assert.deepEqual(Object.fromEntries(Object.entries(r.surfaces).map(([k, v]: [string, any]) => [k, v.sessions])), { 'chrome-main': 1, 'chrome-devtools': 1, 'panel-mcp': 1, 'orchestra-browser-cli': 2 });
  assert.deepEqual(r.surfaces['chrome-main'].tools, { 'mcp__chrome-main__click': 2, 'mcp__chrome-main__navigate_page': 1 });
  assert.deepEqual(r.surfaces['orchestra-browser-cli'].tools, { 'orchestra browser snapshot': 1, 'orchestra browser click': 1 });
  assert.deepEqual([r.totals.humanChrome, r.totals.panel, r.totals.panelShare], [4, 4, 0.5]);
  assert.equal(r.surfaces['orchestra-browser-cli'].firstTs, '2026-10-03T00:00:00.000Z');
  assert.match(census.renderTable(r), /panel share 50\.0%/);
});

test('C5 de-duplicates by tool_use id (a replayed/forked history counts once); api-request-blob and non-assistant records are never calls', () => {
  const c = census.createCensus();
  const w = census.parseWindow(null, null);
  const call = use('toolu_same', 'mcp__chrome-main__click');
  census.addTranscriptText(c, [asst('s1', '2026-10-01T00:00:00Z', call), asst('s1', '2026-10-01T00:00:00Z', call), JSON.stringify({ type: 'api-request-blob', sessionId: 's1', message: { role: 'assistant', content: [call] } }), JSON.stringify({ type: 'user', message: { role: 'user', content: [call] } }), '{not json tool_use'].join('\n'), w, 'f');
  census.addTranscriptText(c, asst('s9', '2026-10-01T00:00:00Z', call), w, 'f2');
  const r = census.finalize(c, { window: w, roots: [] });
  assert.equal(r.surfaces['chrome-main'].calls, 1);
  assert.equal(r.surfaces['chrome-main'].sessions, 1);
  assert.deepEqual([r.scanned.duplicatesSkipped, r.scanned.unparsableLines, r.scanned.files], [2, 1, 2]);
});

test('C5b a record without sessionId is attributed to its file; with `session_id` only, to that', () => {
  const c = census.createCensus();
  const w = census.parseWindow(null, null);
  census.addTranscriptText(c, JSON.stringify({ type: 'assistant', message: { content: [use('a', 'mcp__browser__scroll')] } }), w, 'file-x');
  census.addTranscriptText(c, JSON.stringify({ type: 'assistant', session_id: 'sid-y', message: { content: [use('b', 'mcp__browser__scroll')] } }), w, 'file-z');
  assert.equal(census.finalize(c, { window: w, roots: [] }).surfaces['panel-mcp'].sessions, 2);
});

test('C6 --since/--until are inclusive UTC days; undated records are excluded (and counted) once a window is set', () => {
  const lines = [
    asst('s', '2026-09-30T23:59:59Z', use('a', 'mcp__chrome-main__click')),
    asst('s', '2026-10-01T00:00:00Z', use('b', 'mcp__chrome-main__click')),
    asst('s', '2026-10-02T23:59:59Z', use('c', 'mcp__chrome-main__click')),
    asst('s', '2026-10-03T00:00:00Z', use('d', 'mcp__chrome-main__click')),
    asst('s', undefined, use('e', 'mcp__chrome-main__click')),
  ].join('\n');
  const run = (since: string | null, until: string | null) => {
    const c = census.createCensus();
    const w = census.parseWindow(since, until);
    census.addTranscriptText(c, lines, w, 'f');
    return census.finalize(c, { window: w, roots: [] });
  };
  const win = run('2026-10-01', '2026-10-02');
  assert.equal(win.surfaces['chrome-main'].calls, 2, 'the 1st 00:00:00 and the 2nd 23:59:59 are in; the 30th 23:59:59 and the 3rd 00:00:00 are out');
  assert.deepEqual([win.scanned.outsideWindow, win.scanned.undatedExcluded], [2, 1]);
  assert.equal(run('2026-10-02', null).surfaces['chrome-main'].calls, 2);
  assert.equal(run(null, '2026-10-01').surfaces['chrome-main'].calls, 2);
  const all = run(null, null);
  assert.equal(all.surfaces['chrome-main'].calls, 5, 'no window: everything, undated included');
  assert.deepEqual(all.window, { since: null, until: null, tz: 'UTC' });
  assert.throws(() => census.parseWindow('2026-13-40', null), /YYYY-MM-DD/);
  assert.throws(() => census.parseWindow('2026-10-02', '2026-10-01'), /after/);
  assert.throws(() => census.parseWindow('oct 1', null), /YYYY-MM-DD/);
});

test('C7 `orchestra browser` counts only when the command RUNS it (positives and negatives)', () => {
  const inv = census.orchestraBrowserInvocation;
  const yes: Array<[string, string]> = [
    ['orchestra browser snapshot', 'orchestra browser snapshot'],
    ['orchestra browser', 'orchestra browser'],
    ['  orchestra   browser   click @e3', 'orchestra browser click'],
    ['cd /w && orchestra browser navigate https://x', 'orchestra browser navigate'],
    ['FOO=1 BAR=2 orchestra browser tabs', 'orchestra browser tabs'],
    ['/usr/local/bin/orchestra browser snapshot', 'orchestra browser snapshot'],
    ['timeout 20 orchestra browser snapshot', 'orchestra browser snapshot'],
    ['env -u X orchestra browser eval "1+1"', 'orchestra browser eval'],
    ['x=$(orchestra browser tabs)', 'orchestra browser tabs'],
    ['echo "$(orchestra browser tabs)"', 'orchestra browser tabs'],
    ['echo `orchestra browser tabs`', 'orchestra browser tabs'],
    ["bash -lc 'orchestra browser snapshot'", 'orchestra browser snapshot'],
    ['sh -c "cd x; orchestra browser close"', 'orchestra browser close'],
    ['if true; then orchestra browser tabs; fi', 'orchestra browser tabs'],
    ['sleep 1\norchestra browser snapshot', 'orchestra browser snapshot'],
    ['orchestra browser snapshot | jq .', 'orchestra browser snapshot'],
    ['cat <<EOF >/dev/null\nignored\nEOF\norchestra browser tabs', 'orchestra browser tabs'],
  ];
  for (const [cmd, tool] of yes) assert.equal(inv(cmd), tool, `should count: ${JSON.stringify(cmd)}`);
  const no = [
    'echo "orchestra browser snapshot"',
    "echo 'orchestra browser snapshot'",
    "grep -rn 'orchestra browser' docs/",
    'gh issue comment 1 --body "run orchestra browser snapshot first"',
    "cat <<'EOF'\norchestra browser snapshot\nEOF",
    'cat <<EOF > x.md\norchestra browser click\nEOF',
    'cat <<-EOF\n\torchestra browser click\n\tEOF',
    'git commit -m "docs: orchestra browser CLI"',
    'ls orchestra-browser/',
    'orchestra bus status',
    'orchestra browsers',
    'my-orchestra browser snapshot',
    '# orchestra browser snapshot',
    'cat orchestra browser.md',
    'echo hi; echo orchestra browser',
    "bash -c 'echo orchestra browser'",
    'printf "%s" "$(echo orchestra browser)"',
    '',
  ];
  for (const cmd of no) assert.equal(inv(cmd), null, `must NOT count: ${JSON.stringify(cmd)}`);
  assert.equal(inv(undefined as any), null);
  assert.equal(census.classifyToolUse({ type: 'tool_use', name: 'Bash', input: {} }), null);
  assert.equal(census.classifyToolUse({ type: 'tool_use', name: 'PowerShell', input: { command: 'orchestra browser tabs' } }), null);
  assert.equal(census.classifyToolUse({ type: 'text', name: 'mcp__chrome-main__click' }), null);
});

test('C8 parseArgs', () => {
  assert.deepEqual(census.parseArgs([]), { roots: [], since: null, until: null, format: 'both' });
  assert.deepEqual(census.parseArgs(['--since', '2026-10-01', '--until', '2026-10-25', '--root', 'a', '--root', 'b', '--json']), { roots: ['a', 'b'], since: '2026-10-01', until: '2026-10-25', format: 'json' });
  assert.equal(census.parseArgs(['--table']).format, 'table');
  assert.throws(() => census.parseArgs(['--since']), /needs a value/);
  assert.throws(() => census.parseArgs(['--format', 'xml']), /json\|table\|both/);
  assert.throws(() => census.parseArgs(['--nope']), /unknown argument/);
});

test('C9 defaultRoots: every ~/.claude*/projects, a symlinked config dir read once, absent projects skipped', () => {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-work', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-empty'), { recursive: true });
  fs.mkdirSync(path.join(home, '.other', 'projects'), { recursive: true });
  fs.symlinkSync(path.join(home, '.claude'), path.join(home, '.claude-alias'));
  const roots = census.defaultRoots(home).map((p: string) => path.relative(home, p));
  assert.deepEqual(roots, [path.join('.claude', 'projects'), path.join('.claude-work', 'projects')], 'the alias (same realpath) is read once as the first name; .claude-empty and .other are ignored');
});

test('C10 read-only: scanning leaves the transcript tree byte-identical', () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'ro-'));
  fs.cpSync(FIXTURE_ROOT, dir, { recursive: true });
  const digest = () => crypto.createHash('sha256').update([...census.walkJsonl(dir)].map((f: string) => `${f}\n${fs.readFileSync(f, 'utf8')}\n${fs.statSync(f).mtimeMs}`).join('\0')).digest('hex');
  const before = digest();
  assert.equal(total(census.runCensus({ roots: [dir] })), 1);
  assert.equal(digest(), before);
  assert.deepEqual(fs.readdirSync(dir), ['-work-census-control']);
});

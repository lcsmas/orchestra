import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bus from '../main/bus.ts';

// 2026-10-04 incident: `orchestra send … --file /tmp/x` delivered the text
// "--file /tmp/x" with rc 0 (send has no --file; unknown options were glued into
// the body). Drives the BUILT cli.js against a real bus in an isolated home and
// reads the rows back: a refusal must write nothing, --body-file / "--" must
// deliver the exact text.
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

function cli(home: string, args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...process.env, ORCHESTRA_HOME: home, HOME: home, ORCHESTRA_WS_ID: 'tester-body' };
  delete env.ORCHESTRA_RUN_ID; // the `default` run: no runs row needed
  // The runner inherits the LIVE app's socket; a dead path keeps every arm off it.
  env.ORCHESTRA_SOCK = path.join(home, 'dead.sock');
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function rows(home: string, sql: string): Array<Record<string, unknown>> {
  const prev = process.env.ORCHESTRA_HOME;
  process.env.ORCHESTRA_HOME = home;
  try {
    const p = bus.busPath();
    if (!existsSync(p)) return [];
    const db = bus.openBus(p, {});
    try {
      return db.prepare(sql).all() as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRA_HOME;
    else process.env.ORCHESTRA_HOME = prev;
  }
}

function freshHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'orch-body-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const bodies = (home: string): string[] => rows(home, 'SELECT body FROM messages ORDER BY sequence').map((r) => r.body as string);

test('send with an unknown option is REFUSED and writes no row (the incident shape)', needsBuild, (t) => {
  const home = freshHome(t);
  const r = cli(home, ['send', '--type', 'status', '--to', 'human', '--file', '/tmp/w6b-tooltips.txt']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /orchestra send: unknown option --file — nothing was sent/);
  assert.deepEqual(bodies(home), []);
});

test('send --body-file delivers the file content; "-" reads stdin', needsBuild, (t) => {
  const home = freshHome(t);
  const f = path.join(home, 'order.txt');
  writeFileSync(f, 'LEAD ORDER: add tooltips.\n\n1. badges\n2. legend\n');
  assert.equal(cli(home, ['send', '--type', 'status', '--body-file', f]).code, 0);
  assert.equal(cli(home, ['send', '--type', 'status', '--body-file', '-'], 'from stdin\n').code, 0);
  assert.deepEqual(bodies(home), ['LEAD ORDER: add tooltips.\n\n1. badges\n2. legend', 'from stdin']);
});

test('send: text after "--" is delivered verbatim, options before it still parse', needsBuild, (t) => {
  const home = freshHome(t);
  const r = cli(home, ['send', '--type', 'status', '--', '--file', 'is', 'a', 'word', 'here']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(bodies(home), ['--file is a word here']);
});

test('send: --body-file together with inline text is refused, no row', needsBuild, (t) => {
  const home = freshHome(t);
  const f = path.join(home, 'b.txt');
  writeFileSync(f, 'x');
  const r = cli(home, ['send', '--type', 'status', '--body-file', f, 'inline']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not both/);
  assert.deepEqual(bodies(home), []);
});

test('ask with an unknown option is refused, no row', needsBuild, (t) => {
  const home = freshHome(t);
  const r = cli(home, ['ask', '--to', 'human', '--body', 'what now?']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /orchestra ask: unknown option --body — nothing was sent/);
  assert.deepEqual(bodies(home), []);
});

test('gate open: unknown option refused; --body-file becomes the question verbatim', needsBuild, (t) => {
  const home = freshHome(t);
  const bad = cli(home, ['gate', 'open', '--to', 'human', '--file', 'q.txt']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /orchestra gate open: unknown option --file — nothing was sent/);
  assert.deepEqual(rows(home, 'SELECT question FROM decision_gates'), []);
  const f = path.join(home, 'q.txt');
  writeFileSync(f, 'A or B? use --to bob for B\n');
  assert.equal(cli(home, ['gate', 'open', '--to', 'human', '--body-file', f]).code, 0);
  assert.deepEqual(rows(home, 'SELECT question FROM decision_gates').map((r) => r.question), ['A or B? use --to bob for B']);
});

test('status with an unknown option is refused before reaching the app', needsBuild, (t) => {
  const home = freshHome(t);
  const r = cli(home, ['status', '--note', 'testing']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /orchestra status: unknown option --note — nothing was sent/);
});

test('ask --body-file delivers the question body verbatim', needsBuild, (t) => {
  const home = freshHome(t);
  const f = path.join(home, 'q.txt');
  writeFileSync(f, 'Ruling needed: A or B?\nOptions in ledger Q3.\n');
  const r = cli(home, ['ask', '--to', 'human', '--body-file', f]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(bodies(home), ['Ruling needed: A or B?\nOptions in ledger Q3.']);
});

test('gate open without --to: a "--to" inside the question is text, never a recipient', needsBuild, (t) => {
  const home = freshHome(t);
  const f = path.join(home, 'q.txt');
  writeFileSync(f, 'Ship now? if not, use --to bob\n');
  const r = cli(home, ['gate', 'open', '--body-file', f]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(rows(home, 'SELECT question, recipient FROM decision_gates'), [
    { question: 'Ship now? if not, use --to bob', recipient: null },
  ]);
});

test('status --body-file reaches the app request with the file text (dead socket)', needsBuild, (t) => {
  const home = freshHome(t);
  const f = path.join(home, 's.txt');
  writeFileSync(f, 'reviewing #1705\n');
  const r = cli(home, ['status', '--body-file', f]);
  // Validation passed and the request was attempted: the only failure left is the dead socket.
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not reach Orchestra socket/, r.stderr);
});

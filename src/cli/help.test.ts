import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, suggest, wantsCommandHelp } from './help.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = {
  skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`',
};

/** Top-level verbs dispatched by main(): the 4-space-indented `case` labels. */
function dispatchedVerbs(): string[] {
  const src = readFileSync(path.join(here, 'index.ts'), 'utf8');
  const body = src.slice(src.indexOf('async function main('));
  return [...body.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1]);
}

test('every dispatched verb has a help entry, and every entry is dispatched', () => {
  const verbs = dispatchedVerbs();
  assert.ok(verbs.length >= 30, `parsed only ${verbs.length} verbs — parser broken?`);
  const documented = COMMANDS.map((c) => c.name);
  assert.deepEqual([...verbs].sort(), [...documented].sort());
});

test('each detail starts with its own usage line', () => {
  for (const c of COMMANDS) assert.ok(c.detail.startsWith(`usage: orchestra ${c.name}`), c.name);
});

test('help flag is honoured only at the head, never inside free text', () => {
  assert.equal(wantsCommandHelp(['--help']), true);
  assert.equal(wantsCommandHelp(['-h']), true);
  assert.equal(wantsCommandHelp(['open', '--help']), true);
  assert.equal(wantsCommandHelp(['some-id', 'see', '--help']), false);
  assert.equal(wantsCommandHelp(['working', '--help']), false);
  assert.equal(wantsCommandHelp([]), false);
});

test('typo suggestions', () => {
  assert.deepEqual(suggest('sttaus')[0], 'status');
  assert.ok(suggest('verify').includes('verify-landed'));
  assert.deepEqual(suggest('zzzzzzzz'), []);
});

function run(args: string[]): { code: number; stdout: string; stderr: string; home: string } {
  // Isolated home + dead socket: any verb that ACTS (socket or bus write) fails
  // or leaves a trace under `home`, instead of touching real state.
  const home = mkdtempSync(path.join(os.tmpdir(), 'orch-help-'));
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    ORCHESTRA_HOME: home,
    ORCHESTRA_SOCK: path.join(home, 'no.sock'),
    ORCHESTRA_WS_ID: 'help-test-ws',
    ORCHESTRA_RUN_ID: 'help-test-run',
  };
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '', home };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '', home };
  }
}

test('control: a verb that acts fails against the dead socket', needsBuild, () => {
  const r = run(['status', 'hello']);
  rmSync(r.home, { recursive: true, force: true });
  assert.notEqual(r.code, 0, 'rig broken: status reached a live socket');
});

test('`<cmd> --help` prints that command\'s help and does nothing else', needsBuild, () => {
  for (const c of COMMANDS) {
    for (const flag of ['--help', '-h']) {
      const r = run([c.name, flag]);
      const trace = readdirSync(r.home);
      rmSync(r.home, { recursive: true, force: true });
      assert.equal(r.code, 0, `${c.name} ${flag}: rc=${r.code} stderr=${r.stderr}`);
      assert.ok(r.stdout.startsWith(`usage: orchestra ${c.name}`), `${c.name} ${flag}: ${r.stdout}`);
      assert.deepEqual(trace, [], `${c.name} ${flag} wrote state: ${trace.join(',')}`);
    }
  }
});

test('`help <cmd>` and subcommand `--help`', needsBuild, () => {
  for (const args of [['help', 'send'], ['gate', 'open', '--help'], ['linear', 'add', '-h']]) {
    const r = run(args);
    rmSync(r.home, { recursive: true, force: true });
    assert.equal(r.code, 0, args.join(' '));
    assert.match(r.stdout, /^usage: orchestra (send|gate|linear)/, args.join(' '));
  }
});

test('overview is grouped and lists every command', needsBuild, () => {
  const r = run(['--help']);
  rmSync(r.home, { recursive: true, force: true });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^Fleet bus:$/m);
  for (const c of COMMANDS) assert.match(r.stdout, new RegExp(`^  ${c.name} `, 'm'), c.name);
});

test('unknown command suggests and exits 1', needsBuild, () => {
  const r = run(['sttaus']);
  rmSync(r.home, { recursive: true, force: true });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did you mean: status/);
  const h = run(['help', 'sttaus']);
  rmSync(h.home, { recursive: true, force: true });
  assert.equal(h.code, 1);
  assert.match(h.stderr, /did you mean: status/);
});

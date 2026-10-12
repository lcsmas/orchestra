import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TMP_GUARD_SCRIPT } from './tmp-guard.ts';

// Runs the SHIPPED script against a fake /tmp (ORCHESTRA_TMP_GUARD_ROOT) holding known entries.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-guard-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const fakeTmp = path.join(root, 'tmp');
const diskTmp = path.join(root, 'disk');
fs.mkdirSync(path.join(fakeTmp, '.X11-unix'), { recursive: true });
fs.mkdirSync(path.join(fakeTmp, 'claude-1000'), { recursive: true });
fs.writeFileSync(path.join(fakeTmp, 'old.log'), '');
fs.mkdirSync(diskTmp);
const script = path.join(root, 'guard.sh');
fs.writeFileSync(script, TMP_GUARD_SCRIPT, { mode: 0o755 });

function run(payload: unknown, env: NodeJS.ProcessEnv = { ORCHESTRA_AGENT_TMPDIR: diskTmp }) {
  const r = spawnSync('bash', [script], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { PATH: process.env.PATH, HOME: '/home/u', ORCHESTRA_TMP_GUARD_ROOT: fakeTmp, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr };
}
const bash = (command: string) => ({
  session_id: 's', transcript_path: '/tmp/zz-transcript/s.jsonl', cwd: '/tmp/zz-cwd',
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' },
});
const file = (tool: string, input: Record<string, unknown>) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });

const BLOCK: Array<[string, unknown]> = [
  ['mkdir a rig dir', bash('mkdir -p /tmp/rv12671 && cd /tmp/rv12671')],
  ['redirect a log', bash('pnpm test > /tmp/w1-test.log 2>&1')],
  ['quoted path', bash('cp a "/tmp/qa346/x"')],
  ['git worktree in /tmp', bash('git worktree add --detach /tmp/rev-a2 abc')],
  ['heredoc line start', bash(`cat <<'EOF' | sh\n/tmp/runme.sh\nEOF`)],
  ['Write into a new /tmp dir', file('Write', { file_path: '/tmp/loopfees/a.md', content: 'x' })],
  ['NotebookEdit', file('NotebookEdit', { notebook_path: '/tmp/nb.ipynb', new_source: 'x' })],
  ['new name beside an existing one', bash('cat /tmp/old.log > /tmp/new.log')],
];
for (const [name, payload] of BLOCK) {
  test(`blocks: ${name}`, () => {
    const r = run(payload);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /BLOCKED/);
    assert.ok(r.err.includes(diskTmp), r.err);
  });
}

const ALLOW: Array<[string, unknown]> = [
  ['an existing /tmp entry', bash('ls /tmp/.X11-unix; tail /tmp/old.log; ls /tmp/claude-1000/x')],
  ['$TMPDIR paths', bash('mkdir -p "$TMPDIR/rig" && mktemp -d')],
  ['/var/tmp is not /tmp', bash('ls /var/tmp/foo')],
  ['a home tmp dir', bash('ls ~/tmp/foo $HOME/tmp/bar ${HOME}/tmp/baz')],
  ['a relative tmp dir', bash('ls ./tmp/x worktree/tmp/y')],
  ['hook metadata is not the call (transcript/cwd under /tmp)', bash('echo hi')],
  ['Write outside /tmp', file('Write', { file_path: '/home/u/dev/a.ts', content: 'see /tmp/zz-new' })],
  ['bare /tmp', bash('df -h /tmp; ls /tmp/')],
];
for (const [name, payload] of ALLOW) {
  test(`allows: ${name}`, () => {
    const r = run(payload);
    assert.equal(r.code, 0, r.err);
  });
}

test('no disk TMPDIR for this session ⇒ the guard is inert', () => {
  assert.equal(run(bash('mkdir /tmp/rv1'), {}).code, 0);
  assert.equal(run(bash('mkdir /tmp/rv1'), { ORCHESTRA_AGENT_TMPDIR: path.join(root, 'missing') }).code, 0);
});

test('empty / garbage stdin fails open', () => {
  assert.equal(run('').code, 0);
  assert.equal(run('not json').code, 0);
});

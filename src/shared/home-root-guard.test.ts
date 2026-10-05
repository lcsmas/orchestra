import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_ROOT_GUARD_SCRIPT } from './home-root-guard.ts';

// Runs the SHIPPED script string against a fake $HOME with known entries.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-root-guard-'));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, 'dev'), { recursive: true });
fs.mkdirSync(path.join(home, '.orchestra'), { recursive: true });
fs.writeFileSync(path.join(home, 'notes.md'), '');
fs.symlinkSync('/nonexistent-target', path.join(home, 'dangling'));
const script = path.join(root, 'guard.sh');
fs.writeFileSync(script, HOME_ROOT_GUARD_SCRIPT, { mode: 0o755 });

function run(payload: unknown, env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('bash', [script], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_WS_ID: 'ws-1', ...env },
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr };
}
const bash = (command: string) => ({
  session_id: 's', transcript_path: `${home}/.claude/p/s.jsonl`, cwd: `${home}/dev`,
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' },
});
const file = (tool: string, input: Record<string, unknown>) => ({
  hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input,
});

const BLOCK: Array<[string, unknown]> = [
  ['mkdir ~/rig', bash('mkdir -p ~/w1-rig && cd ~/w1-rig')],
  ['$HOME/x', bash('echo hi > "$HOME/w1-q.md"')],
  ['${HOME}/x', bash('cp a ${HOME}/rev-a2-cand')],
  ['literal home path', bash(`git worktree add --detach ${home}/rev-a2-master abc`)],
  ['path at the start of a heredoc line', bash(`cat <<'EOF' | sh\n${home}/runme.sh\nEOF`)],
  ['redirect target', bash(`npx tsc --noEmit >${home}/w1-tsc.log 2>&1`)],
  ['new name beside an existing one', bash('ls ~/dev && mkdir ~/dev2')],
  ['Write at home root', file('Write', { file_path: `${home}/w1-gl2.md`, content: 'x' })],
  ['Edit under a new home dir', file('Edit', { file_path: `${home}/b4-rig/a.ts`, old_string: 'a', new_string: 'b' })],
  ['NotebookEdit', file('NotebookEdit', { notebook_path: `${home}/nb.ipynb`, new_source: 'x' })],
  ['new dot dir', bash('mkdir -p ~/.a2-rig/arms')],
  ['new dot file via ORCHESTRA_HOME', bash('ORCHESTRA_HOME=$HOME/.orchestra-wake149-rig node x.mjs')],
  ['Write a new dot file', file('Write', { file_path: `${home}/.w6b`, content: 'x' })],
  ['spaced JSON', `{"tool_name": "Bash", "tool_input": {"command": "mkdir ~/spaced"}}`],
];
for (const [name, payload] of BLOCK) {
  test(`blocks: ${name}`, () => {
    const r = run(payload);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /BLOCKED/);
    assert.match(r.err, /\.orchestra\/agent-tmp\/ws-1\//);
  });
}

const ALLOW: Array<[string, unknown]> = [
  ['existing dir', bash('mkdir -p ~/dev/x && echo > $HOME/dev/y')],
  ['existing file', bash(`cat ${home}/notes.md`)],
  ['dangling symlink (exists as a link)', bash('ls ~/dangling')],
  ['existing dot entry', bash('mkdir -p ~/.orchestra/agent-tmp/ws-1/rig && ls $HOME/.orchestra')],
  ['bare ~/. and ~/..', bash('ls ~/. ~/.. && echo $HOME/...')],
  ['outside home', bash('mkdir -p /var/tmp/x && ls /home/someone-else/x')],
  ['home-prefix lookalike', bash(`mkdir ${home}other/x`)],
  ['trailing period after an existing name', bash('echo "see ~/dev."')],
  ['~user form', bash('ls ~root/x')],
  ['tilde inside a word', bash('echo a~/zzz')],
  ['Write content mentions a new home path', file('Write', { file_path: `${home}/dev/a.md`, content: `see ~/nope and ${home}/nope2` })],
  ['empty stdin', ''],
  ['garbage stdin', 'not json'],
];
for (const [name, payload] of ALLOW) {
  test(`allows: ${name}`, () => {
    const r = run(payload);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, '');
  });
}

test('fail-open when HOME is unset or /', () => {
  assert.equal(run(bash('mkdir ~/x'), { HOME: '' }).code, 0);
  assert.equal(run(bash('mkdir /x'), { HOME: '/' }).code, 0);
});

test('a 4 MB Bash payload is judged in bounded time', () => {
  const t = Date.now();
  const r = run(bash(`${'echo aaaa ~/dev/b\n'.repeat(200_000)}mkdir ~/late`));
  assert.equal(r.code, 2, r.err);
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
});

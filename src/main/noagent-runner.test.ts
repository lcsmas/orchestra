// #612 — the REAL lifecycle of a no-agent command (real processes, a temp home): detached start, key before process, no re-key of a live command, survives "an app restart" (a new runner on the same home), stop kills the group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createNoAgentRunner } from './noagent-runner.ts';
const require_events = () => ({ EventEmitter });
import type { Workspace } from '../shared/types.ts';

const SOCK = '/nonexistent/fake.sock';

function rig(over: Partial<Workspace> = {}, hostEnv: Record<string, string | undefined> = { PATH: process.env.PATH, DISPLAY: ':9' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noagent-'));
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt);
  const ws = { id: 'ws-na', name: 'n', repoPath: wt, worktreePath: wt, branch: 'ops-x', baseBranch: 'master', createdAt: 1, status: 'idle', agent: 'claude', noAgent: true, runCommand: 'echo "$ORCHESTRA_WS_ID $ORCHESTRA_SESSION_KEY $ORCHESTRA_SOCK" > out.txt; exec sleep 30', ...over } as Workspace;
  const keys: Array<{ id: string; key: string }> = [];
  const forgotten: string[] = [];
  const mk = () => createNoAgentRunner({
    home, getWorkspace: (id) => (id === ws.id ? ws : undefined), runIdOf: () => 'run-x', scriptEnv: () => ({ ORCHESTRA_BRANCH: 'ops-x' }),
    hostEnv, sock: () => SOCK, registerKey: (id, key) => { keys.push({ id, key }); }, forgetKey: (id) => { forgotten.push(id); },
  });
  return { home, wt, ws, keys, forgotten, mk, runner: mk() };
}
const until = async (f: () => boolean, ms = 4000): Promise<void> => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };

test('start: key registered BEFORE the process, command sees the vouched identity, runs detached in its own session', async () => {
  const r = rig();
  const out = await r.runner.start('ws-na');
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.reused, false);
  assert.equal(r.keys.length, 1);
  await until(() => fs.existsSync(path.join(r.wt, 'out.txt')) && fs.readFileSync(path.join(r.wt, 'out.txt'), 'utf8').includes(SOCK));
  assert.equal(fs.readFileSync(path.join(r.wt, 'out.txt'), 'utf8').trim(), `ws-na ${r.keys[0].key} ${SOCK}`);
  assert.equal(fs.statSync(path.join(r.home, 'noagent', 'ws-na.json')).mode & 0o777, 0o600);
  const stat = fs.readFileSync(`/proc/${out.pid}/stat`, 'utf8');
  assert.equal(Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]), out.pid, 'the command is its own session leader (setsid)');
  await r.runner.stop('ws-na');
});

test('a live command is never re-keyed (a new key would supersede it); a second runner on the same home — the restarted app — sees it alive', async () => {
  const r = rig();
  const a = await r.runner.start('ws-na');
  assert.ok(a.ok);
  const b = await r.runner.start('ws-na');
  assert.ok(b.ok && b.reused && a.ok && b.pid === a.pid);
  assert.equal(r.keys.length, 1, 'no second key');
  const restarted = r.mk(); // "app quit + reopen": a fresh runner, nothing in memory
  assert.equal(restarted.running('ws-na'), true);
  const c = await restarted.start('ws-na');
  assert.ok(c.ok && c.reused);
  assert.equal(r.keys.length, 1);
  await restarted.stop('ws-na');
});

test('concurrent starts collapse into ONE process and ONE key', async () => {
  const r = rig();
  const [a, b] = await Promise.all([r.runner.start('ws-na'), r.runner.start('ws-na')]);
  assert.ok(a.ok && b.ok && a.pid === b.pid);
  assert.equal(r.keys.length, 1);
  await r.runner.stop('ws-na');
});

test('stop: the whole process group dies, the record goes, and the command is then startable again with a NEW key', async () => {
  const r = rig({ runCommand: 'sleep 60 & sleep 60 & wait' });
  const a = await r.runner.start('ws-na');
  assert.ok(a.ok);
  const stopped = await r.runner.stop('ws-na', 1000);
  assert.equal(stopped.stopped, true);
  assert.equal(r.runner.running('ws-na'), false);
  await until(() => { try { process.kill(-a.pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } }, 3000); // no member of the group (the two sleeps) survives — they may be reaped a tick after the leader
  assert.equal(fs.existsSync(path.join(r.home, 'noagent', 'ws-na.json')), false);
  const b = await r.runner.start('ws-na');
  assert.ok(b.ok && !b.reused);
  assert.equal(r.keys.length, 2);
  assert.notEqual(r.keys[0].key, r.keys[1].key);
  await r.runner.stop('ws-na');
});

test('a command that exits is not "running" (and the pid of a dead one is never trusted)', async () => {
  const r = rig({ runCommand: 'sleep 1' });
  const a = await r.runner.start('ws-na');
  assert.ok(a.ok);
  await until(() => !r.runner.running('ws-na'));
  const b = await r.runner.start('ws-na');
  assert.ok(b.ok && !b.reused, 'a dead record is replaced');
});

test('refusals create nothing and register no key: not a no-agent workspace, no command, unknown id', async () => {
  const plain = rig({ noAgent: undefined });
  const b = await plain.runner.start('ws-na');
  assert.ok(!b.ok && /^\[noagent-not-noagent\]/.test(b.error));
  assert.equal(plain.keys.length, 0);
  const nocmd = rig({ runCommand: undefined });
  const c = await nocmd.runner.start('ws-na');
  assert.ok(!c.ok && /^\[noagent-no-command\]/.test(c.error));
  const d = await nocmd.runner.start('nope');
  assert.ok(!d.ok && /unknown workspace/.test(d.error));
  assert.equal(nocmd.keys.length, 0);
});

test('#612 m2: a RUNNING host whose env exports neither DISPLAY nor WAYLAND_DISPLAY (Wayland falls back to wayland-0) still starts the command — only the CLI preflight names a missing display', async () => {
  const r = rig({}, { PATH: process.env.PATH });
  const a = await r.runner.start('ws-na');
  assert.ok(a.ok, JSON.stringify(a));
  assert.equal(r.keys.length, 1);
  await r.runner.stop('ws-na');
});

test('a spawn that fails forgets the key it just registered (it vouched nobody)', async () => {
  const r = rig({ worktreePath: '/nonexistent/dir/for/cwd' });
  const a = await r.runner.start('ws-na');
  assert.ok(!a.ok);
  assert.deepEqual(r.forgotten, ['ws-na']);
});

test('a key that cannot be persisted starts nothing', async () => {
  const r = rig();
  const bad = createNoAgentRunner({ home: r.home, getWorkspace: () => r.ws, runIdOf: () => 'r', scriptEnv: () => ({}), hostEnv: { DISPLAY: ':1' }, sock: () => SOCK, registerKey: () => { throw new Error('disk full'); }, forgetKey: () => {} });
  const a = await bad.start('ws-na');
  assert.ok(!a.ok && /disk full/.test(a.error));
  assert.equal(bad.running('ws-na'), false);
});

test('on Linux a command whose start time cannot be read (gone at once) is a FAILED start: no record, the key is forgotten (a pid-less record would let a reused pid pass)', async () => {
  const r = rig({ runCommand: 'exit 0' });
  // a fake spawn that "succeeds" with a pid that does not exist: readTicks → null
  const fake = createNoAgentRunner({ home: r.home, getWorkspace: () => r.ws, runIdOf: () => 'r', scriptEnv: () => ({}), hostEnv: { DISPLAY: ':1' }, sock: () => SOCK, registerKey: (id, k) => { r.keys.push({ id, key: k }); }, forgetKey: (id) => { r.forgotten.push(id); }, platform: 'linux',
    spawn: () => { const { EventEmitter } = require_events(); const e = new EventEmitter() as import('node:child_process').ChildProcess; (e as { pid?: number }).pid = 2 ** 22 - 7; (e as { unref?: () => void }).unref = () => {}; setImmediate(() => e.emit('spawn')); return e; } });
  const a = await fake.start('ws-na');
  assert.ok(!a.ok && /exited immediately/.test(a.error));
  assert.equal(fs.existsSync(path.join(r.home, 'noagent', 'ws-na.json')), false);
  assert.deepEqual(r.forgotten, ['ws-na']);
});

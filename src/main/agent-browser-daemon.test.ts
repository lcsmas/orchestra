import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abEnv, abLayout, closeDaemon, ensureDaemon, installBinary, listSessions, prepareLayout, sockPath, terminateDaemonsOf, type AbDeps } from './agent-browser-daemon.ts';

const layout = abLayout('/home/u/.orchestra', '/run/user/1000');

test('layout: scratch home + config under ORCHESTRA_HOME, a SHORT hashed socket dir under the runtime dir', () => {
  assert.equal(layout.home, '/home/u/.orchestra/browser-cli/home');
  assert.match(layout.socketDir, /^\/run\/user\/1000\/orch-ab-[0-9a-f]{8}$/);
  // a rig with a very long ORCHESTRA_HOME still gets a socket path under the unix limit
  const long = abLayout('/var/tmp/avr-1000/e2e64c-123456/oh/some-long-arm-name-1790000000000/more', '/run/user/1000');
  assert.ok(sockPath(long, 'a1b2c3d4e5f6').length < 100, sockPath(long, 'a1b2c3d4e5f6'));
  assert.notEqual(abLayout('/a', '/r').socketDir, abLayout('/b', '/r').socketDir, 'two ORCHESTRA_HOMEs never share daemons');
  assert.match(abLayout('/a', undefined, '/tmpx').socketDir, /^\/tmpx\/orch-ab-/);
});

test('abEnv pins session, namespace, socket dir, scratch HOME and the empty config', () => {
  const e = abEnv(layout, 'sess1', '/shots');
  assert.equal(e.AGENT_BROWSER_SESSION, 'sess1');
  assert.equal(e.AGENT_BROWSER_NAMESPACE, 'orchestra');
  assert.equal(e.AGENT_BROWSER_SOCKET_DIR, layout.socketDir);
  assert.equal(e.HOME, layout.home);
  assert.equal(e.AGENT_BROWSER_CONFIG, layout.config);
  assert.equal(e.AGENT_BROWSER_SCREENSHOT_DIR, '/shots');
  assert.equal('AGENT_BROWSER_SCREENSHOT_DIR' in abEnv(layout, 's', undefined), false);
});

function fakeDeps(live: boolean) {
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const deps: AbDeps = {
    run: async (_b, args, env) => {
      calls.push({ args, env });
      return { code: 0, out: '' };
    },
    canConnect: async () => live,
  };
  return { deps, calls };
}

test('ensureDaemon: a live socket is left alone; a dead one is (re)connected to the proxy URL with the host env', async () => {
  const a = fakeDeps(true);
  await ensureDaemon('/bin/ab', layout, 's1', 'ws://127.0.0.1:1/t/devtools/browser/x', a.deps);
  assert.equal(a.calls.length, 0);
  const b = fakeDeps(false);
  await ensureDaemon('/bin/ab', layout, 's1', 'ws://127.0.0.1:1/t/devtools/browser/x', b.deps);
  assert.deepEqual(b.calls[0]!.args, ['connect', 'ws://127.0.0.1:1/t/devtools/browser/x']);
  assert.equal(b.calls[0]!.env.AGENT_BROWSER_SESSION, 's1');
});

test("ensureDaemon surfaces a failed connect with the client's own words", async () => {
  const deps: AbDeps = { run: async () => ({ code: 1, out: 'boom: refused' }), canConnect: async () => false };
  await assert.rejects(ensureDaemon('/bin/ab', layout, 's', 'ws://x', deps), /could not connect to the panel \(boom: refused\)/);
});

test('closeDaemon runs `close` for the session and never throws', async () => {
  const a = fakeDeps(true);
  await closeDaemon('/bin/ab', layout, 's9', a.deps);
  assert.deepEqual(a.calls[0]!.args, ['close']);
  assert.equal(a.calls[0]!.env.AGENT_BROWSER_SESSION, 's9');
  await closeDaemon('/bin/ab', layout, 's9', {
    run: async () => {
      throw new Error('x');
    },
    canConnect: async () => false,
  });
});

test('prepareLayout writes the scratch dirs (0700 socket dir) and an empty config; installBinary copies once, executable', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'abd-'));
  const l = abLayout(path.join(root, 'oh'), path.join(root, 'run'));
  fs.mkdirSync(path.join(root, 'run'));
  prepareLayout(l);
  assert.equal(fs.readFileSync(l.config, 'utf8').trim(), '{}');
  assert.equal(fs.statSync(l.socketDir).mode & 0o777, 0o700);
  const src = path.join(root, 'src-bin');
  fs.writeFileSync(src, 'binary-bytes');
  const dst = installBinary(src, l, '0.0.1');
  assert.equal(fs.readFileSync(dst, 'utf8'), 'binary-bytes');
  assert.equal(fs.statSync(dst).mode & 0o111, 0o111);
  const ino = fs.statSync(dst).ino;
  assert.equal(installBinary(src, l, '0.0.1'), dst);
  assert.equal(fs.statSync(dst).ino, ino, 'unchanged binary is not recopied');
  fs.mkdirSync(path.join(l.socketDir, 'namespaces', 'orchestra', 'run'), { recursive: true });
  fs.writeFileSync(path.join(l.socketDir, 'namespaces', 'orchestra', 'run', 'abc.sock'), '');
  assert.deepEqual(listSessions(l), ['abc']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('ensureDaemon is single-flight per session: concurrent first calls share ONE connect (pre-review M5: two parallel connects raced and one failed)', async () => {
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const deps: AbDeps = { run: async () => { runs++; await gate; return { code: 0, out: '' }; }, canConnect: async () => false };
  const ps = [1, 2, 3].map(() => ensureDaemon('/bin/ab', layout, 'sf', 'ws://x', deps));
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all(ps);
  assert.equal(runs, 1);
  // a different session is NOT serialized with it, and a finished flight does not poison the next call
  await ensureDaemon('/bin/ab', layout, 'other', 'ws://x', { run: async () => { runs++; return { code: 0, out: '' }; }, canConnect: async () => false });
  await ensureDaemon('/bin/ab', layout, 'sf', 'ws://x', { run: async () => { runs++; return { code: 0, out: '' }; }, canConnect: async () => false });
  assert.equal(runs, 3);
});

test('terminateDaemonsOf signals only pids whose environment names THIS socket dir (identity re-read), never a recycled pid or garbage', () => {
  const dir = '/run/user/1000/orch-ab-test/namespaces/orchestra/run';
  const l = { ...layout, socketDir: '/run/user/1000/orch-ab-test' };
  const files: Record<string, string> = { 'a.pid': '111\n', 'b.pid': '222\n', 'c.pid': 'junk', 'd.pid': '1\n', 'e.sock': '' };
  const killed: number[] = [];
  const out = terminateDaemonsOf(l, {
    readdir: () => Object.keys(files),
    read: (f) => files[f.slice(dir.length + 1)]!,
    environ: (pid) => (pid === 111 ? ['AGENT_BROWSER_SOCKET_DIR=/run/user/1000/orch-ab-test', 'X=1'] : pid === 222 ? ['AGENT_BROWSER_SOCKET_DIR=/run/user/1000/orch-ab-other'] : null),
    kill: (pid) => { killed.push(pid); },
  });
  assert.deepEqual(out, [111]);
  assert.deepEqual(killed, [111], 'pid 222 belongs to another socket dir, junk and pid 1 are skipped, a vanished /proc entry is skipped');
  assert.deepEqual(terminateDaemonsOf(l, { readdir: () => { throw new Error('ENOENT'); }, read: () => '', environ: () => null, kill: () => undefined }), []);
});

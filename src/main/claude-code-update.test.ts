import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createClaudeCodeUpdateMonitor, readPublishedVersion, runClaudeUpdate, updateCommandEnv } from './claude-code-update.ts';
import type { ClaudeCodeUpdateState, UpdateRunResult } from '../shared/claude-code-update.ts';

/** A fake machine: what is installed, what the channel publishes (null = the network does not answer), what `claude update` does. */
function rig(o: { installed?: string | null; published?: string | null } = {}) {
  const world = {
    installed: 'installed' in o ? o.installed! : '2.1.310',
    published: 'published' in o ? o.published! : '2.1.322',
    updates: 0,
    /** one entry per read of the installed version: was a FRESH read asked for (no memo)? */
    reads: [] as boolean[],
    update: async (): Promise<UpdateRunResult> => ({ code: 0, stdout: '', stderr: '' }),
  };
  const pushed: ClaudeCodeUpdateState[] = [];
  const m = createClaudeCodeUpdateMonitor({
    installed: async (fresh) => {
      world.reads.push(fresh);
      return world.installed;
    },
    published: async () => world.published,
    update: () => {
      world.updates++;
      return world.update();
    },
    push: (s) => pushed.push(s),
  });
  return { m, world, pushed };
}

test('monitor: silent while Claude Code is up to date; ONE push when a newer version is published, not one per check', async () => {
  const r = rig({ published: '2.1.310' });
  await r.m.checkPublished();
  assert.deepEqual(r.pushed, [], 'nothing while up to date');
  r.world.published = '2.1.322';
  await r.m.checkPublished();
  await r.m.checkPublished();
  await r.m.checkInstalled();
  assert.deepEqual(r.pushed, [{ kind: 'available', installed: '2.1.310', published: '2.1.322' }]);
  assert.deepEqual(r.m.current(), r.pushed[0]);
});

test('monitor: a check the network does not answer keeps what was known (silent at boot, the notice stays later)', async () => {
  const r = rig({ published: null });
  await r.m.checkPublished();
  assert.deepEqual(r.pushed, [], 'offline at boot: nothing');
  r.world.published = '2.1.322';
  await r.m.checkPublished();
  r.world.published = null;
  await r.m.checkPublished();
  await r.m.checkInstalled();
  assert.equal(r.m.current().kind, 'available', 'a failed check is not « up to date »');
  assert.equal(r.pushed.length, 1);
});

test('monitor: an update made elsewhere (a terminal) clears the notice at the next installed re-read, without asking the network', async () => {
  const r = rig();
  await r.m.checkPublished();
  r.world.installed = '2.1.322';
  r.world.published = null; // would erase the notice only by a network answer: there is none
  await r.m.checkInstalled();
  assert.deepEqual(r.pushed.at(-1), { kind: 'none' });
});

/** `claude update` held open until the test lets it finish. */
function heldUpdate(r: ReturnType<typeof rig>, then: () => UpdateRunResult) {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  r.world.update = async () => {
    await gate;
    return then();
  };
  return release;
}

test('monitor: « Mettre à jour » — en cours while the command runs, then « installé » until acknowledged; never two updates at once', async () => {
  const r = rig();
  await r.m.checkPublished();
  const release = heldUpdate(r, () => {
    r.world.installed = '2.1.322';
    return { code: 0, stdout: 'Successfully updated from 2.1.310 to version 2.1.322\n', stderr: '' };
  });
  const first = r.m.run();
  const second = r.m.run();
  await r.m.checkInstalled();
  await r.m.checkPublished();
  assert.deepEqual(r.m.current(), { kind: 'running', installed: '2.1.310', published: '2.1.322' }, 'a check during the run does not replace « en cours »');
  release();
  await Promise.all([first, second]);
  assert.equal(r.world.updates, 1, 'the second click started nothing');
  assert.deepEqual(r.m.current(), { kind: 'installed', from: '2.1.310', version: '2.1.322' });
  await r.m.checkInstalled();
  await r.m.checkPublished();
  assert.equal(r.m.current().kind, 'installed', 'stays until the human closes it');
  r.m.acknowledge();
  assert.deepEqual(r.m.current(), { kind: 'none' });
  assert.deepEqual(r.pushed.map((s) => s.kind), ['available', 'running', 'installed', 'none']);
});

test('monitor: « Mettre à jour » with nothing to update starts no command', async () => {
  const r = rig({ published: '2.1.310' });
  await r.m.checkPublished();
  await r.m.run();
  assert.equal(r.world.updates, 0);
  assert.deepEqual(r.pushed, []);
});

test('monitor: a failed update says why and stays; « Réessayer » runs again; the next network check starts over', async () => {
  const r = rig();
  await r.m.checkPublished();
  r.world.update = async () => ({ code: 1, stdout: '', stderr: 'Error: Failed to install native update\n' });
  await r.m.run();
  assert.deepEqual(r.m.current(), { kind: 'failed', installed: '2.1.310', published: '2.1.322', error: 'Error: Failed to install native update' });
  await r.m.checkInstalled();
  assert.equal(r.m.current().kind, 'failed', 'the 30 s re-read does not erase the failure');
  await r.m.run();
  assert.equal(r.world.updates, 2, '« Réessayer » starts the command again');
  assert.equal(r.m.current().kind, 'failed');
  await r.m.checkPublished();
  assert.deepEqual(r.m.current(), { kind: 'available', installed: '2.1.310', published: '2.1.322' }, 'back to « disponible » at the next check');
});

test('monitor: after a failure, a retry that works ends on « installé »; an update made elsewhere clears the failure', async () => {
  const r = rig();
  await r.m.checkPublished();
  r.world.update = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  await r.m.run();
  r.world.installed = '2.1.322';
  await r.m.checkInstalled();
  assert.deepEqual(r.m.current(), { kind: 'none' }, 'updated in a terminal meanwhile');

  const s = rig();
  await s.m.checkPublished();
  s.world.update = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  await s.m.run();
  s.world.update = async () => {
    s.world.installed = '2.1.322';
    return { code: 0, stdout: '', stderr: '' };
  };
  await s.m.run();
  assert.deepEqual(s.m.current(), { kind: 'installed', from: '2.1.310', version: '2.1.322' });
});

test('monitor: a command that ends well but installs nothing (an install it does not manage) is a failure showing what it said', async () => {
  const r = rig();
  await r.m.checkPublished();
  r.world.update = async () => ({ code: 0, stdout: 'Claude is managed by Homebrew. Run: brew upgrade claude-code\n', stderr: '' });
  await r.m.run();
  assert.deepEqual(r.m.current(), { kind: 'failed', installed: '2.1.310', published: '2.1.322', error: 'Claude is managed by Homebrew. Run: brew upgrade claude-code' });
});

// ---- the real edges: a process and a socket, no mocks ----

function fakeClaude(t: { after(fn: () => void): void }, script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

test('the command runs under NO Compte: the env it gets is the app\'s own, minus the config dir of whoever launched the app', () => {
  const env = updateCommandEnv({ PATH: '/usr/bin', HOME: '/home/u', CLAUDE_CONFIG_DIR: '/home/u/.claude-work', CHROME_DESKTOP: 'orchestra.desktop', EMPTY: undefined });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/u' });
});

test('`claude update` is run as `<bin> update` from the given directory, to its end, with what it printed and how it ended', async (t) => {
  const ok = fakeClaude(t, 'echo "args:$*"; echo "config:${CLAUDE_CONFIG_DIR:-none}"; echo "cwd:$(pwd -P)"; echo "Successfully updated"');
  const home = fs.realpathSync(path.dirname(ok));
  assert.deepEqual(await runClaudeUpdate(ok, { env: { PATH: process.env.PATH ?? '' }, cwd: home, timeoutMs: 5000 }), { code: 0, stdout: `args:update\nconfig:none\ncwd:${home}\nSuccessfully updated\n`, stderr: '' });
  const bad = fakeClaude(t, 'echo "Checking"; echo "Error: boom" >&2; exit 1');
  assert.deepEqual(await runClaudeUpdate(bad, { env: { PATH: process.env.PATH ?? '' }, cwd: home, timeoutMs: 5000 }), { code: 1, stdout: 'Checking\n', stderr: 'Error: boom\n' });
});

test('`claude update` that cannot start or never ends is a failure with a reason, never a hang or a throw', async (t) => {
  const missing = await runClaudeUpdate('/nonexistent/claude', { env: {}, cwd: os.tmpdir(), timeoutMs: 5000 });
  assert.equal(missing.code, null);
  assert.match(missing.stderr, /ENOENT/);
  const stuck = fakeClaude(t, 'echo started; exec sleep 30');
  const t0 = Date.now();
  const r = await runClaudeUpdate(stuck, { env: { PATH: process.env.PATH ?? '' }, cwd: os.tmpdir(), timeoutMs: 300 });
  assert.ok(Date.now() - t0 < 5000, 'killed at the deadline');
  assert.equal(r.code, null);
  assert.match(r.stderr, /interrompue après 0[.,]3 s sans réponse/);
});

test('the published version is read from the channel URL: a bare version, or nothing (error page, 404, no answer, a server that hangs)', async (t) => {
  const answers: Record<string, (res: http.ServerResponse) => void> = {
    '/rel/latest': (res) => res.end('2.1.322\n'),
    '/rel/html': (res) => res.end('<!doctype html><title>blocked</title>'),
    '/rel/hang': () => {},
    '/rel/broken': (res) => ((res.statusCode = 500), res.end('9.9.9')),
  };
  const server = http.createServer((req, res) => (answers[req.url ?? ''] ?? ((r) => ((r.statusCode = 404), r.end('not found'))))(res));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => (server.closeAllConnections(), server.close()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/rel`;
  assert.equal(await readPublishedVersion(`${base}/latest`, 2000), '2.1.322');
  assert.equal(await readPublishedVersion(`${base}/html`, 2000), null);
  assert.equal(await readPublishedVersion(`${base}/stable`, 2000), null, '404');
  assert.equal(await readPublishedVersion(`${base}/broken`, 2000), null, 'an error status is not an answer, whatever its body');
  assert.equal(await readPublishedVersion(`${base}/hang`, 200), null, 'gives up at the deadline');
  assert.equal(await readPublishedVersion('http://127.0.0.1:9/rel/latest', 2000), null, 'nothing listening');
});

test('monitor: a run that blows up ends on « échec », never on a button disabled for good', async () => {
  const r = rig();
  await r.m.checkPublished();
  r.world.update = async () => {
    throw new Error('spawn EACCES');
  };
  await r.m.run();
  assert.deepEqual(r.m.current(), { kind: 'failed', installed: '2.1.310', published: '2.1.322', error: 'spawn EACCES' });
});

test('monitor: an installed version that cannot be read at a re-read (the link mid-swap) is UNKNOWN, not gone — the notice stays; the next network check tells the truth', async () => {
  const r = rig();
  await r.m.checkPublished();
  r.world.installed = null;
  await r.m.checkInstalled();
  assert.equal(r.m.current().kind, 'available', 'no flicker on an unreadable moment');
  assert.equal(r.pushed.length, 1);
  await r.m.checkPublished();
  assert.deepEqual(r.m.current(), { kind: 'none' }, 'really gone: the network check accepts it');
});

test('monitor: after a run the installed version is read FRESH (a wrapper script never changes on disk), like at a network check; the 30 s re-read may use the memo', async () => {
  const r = rig();
  await r.m.checkPublished();
  await r.m.checkInstalled();
  assert.deepEqual(r.world.reads, [true, false]);
  r.world.update = async () => {
    r.world.installed = '2.1.322';
    return { code: 0, stdout: '', stderr: '' };
  };
  await r.m.run();
  assert.deepEqual(r.world.reads, [true, false, true]);
});

test('monitor: a run after which the installed version cannot be read is UNKNOWN — back to « disponible », never a red notice quoting « Successfully updated »; the next re-read settles it', async () => {
  const r = rig();
  await r.m.checkPublished();
  r.world.update = async () => {
    r.world.installed = null; // the probe timed out
    return { code: 0, stdout: 'Successfully updated from 2.1.310 to version 2.1.322\n', stderr: '' };
  };
  await r.m.run();
  assert.deepEqual(r.m.current(), { kind: 'available', installed: '2.1.310', published: '2.1.322' });
  r.world.installed = '2.1.322';
  await r.m.checkInstalled();
  assert.deepEqual(r.m.current(), { kind: 'none' });
});

// Which real daemon the relay forwards to, and where a run's socket lives (pure: no docker, no process).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isOwnRelaySocket, relaySocketPath, resolveUpstream, type UpstreamDeps } from '../src/relay-host.ts';

const deps = (o: { ctx?: string | null; kinds?: Record<string, 'socket' | 'missing' | 'other'>; asked?: string[] } = {}): UpstreamDeps => ({
  contextHost: async (env) => (o.asked?.push(`ctx:${env.DOCKER_HOST ?? ''}`), o.ctx ?? null),
  pathKind: (p) => o.kinds?.[p] ?? 'socket',
});
const ok = async (env: Record<string, string>, d = deps()) => {
  const r = await resolveUpstream(env, d);
  assert.ok(r.ok, r.ok ? '' : r.reason);
  return r;
};
const fails = async (env: Record<string, string>, d = deps()): Promise<string> => {
  const r = await resolveUpstream(env, d);
  assert.ok(!r.ok, 'must be refused');
  return r.ok ? '' : r.reason;
};

describe('resolveUpstream', () => {
  it('RESCTL_DOCKER_SOCKET wins over DOCKER_HOST', async () => {
    const r = await ok({ RESCTL_DOCKER_SOCKET: '/a.sock', DOCKER_HOST: 'unix:///b.sock' });
    assert.deepEqual([r.socketPath, r.via], ['/a.sock', 'RESCTL_DOCKER_SOCKET']);
    assert.equal((await ok({ RESCTL_DOCKER_SOCKET: 'unix:///a.sock' })).socketPath, '/a.sock');
  });
  it('DOCKER_HOST (unix) is next — a keeper relay is a legitimate upstream, the labels stack', async () => {
    const r = await ok({ DOCKER_HOST: 'unix:///home/x/keepers/ws.docker.sock' });
    assert.deepEqual([r.socketPath, r.via], ['/home/x/keepers/ws.docker.sock', 'DOCKER_HOST']);
  });
  it('a DOCKER_HOST naming one of OUR relays is not a daemon: skipped, and hidden from the context lookup', async () => {
    const asked: string[] = [];
    const r = await ok({ DOCKER_HOST: 'unix:///s/relay/other.resctl-docker.sock' }, deps({ ctx: 'unix:///ctx.sock', asked }));
    assert.deepEqual([r.socketPath, r.via], ['/ctx.sock', 'docker context']);
    assert.deepEqual(asked, ['ctx:']);
  });
  it('without DOCKER_HOST: the effective docker context, else the default socket', async () => {
    assert.equal((await ok({}, deps({ ctx: 'unix:///run/user/1000/docker.sock' }))).socketPath, '/run/user/1000/docker.sock');
    const d = await ok({}, deps({ ctx: null }));
    assert.deepEqual([d.socketPath, d.via], ['/var/run/docker.sock', 'default']);
  });
  it('refuses what it cannot forward to, never swapping in the local daemon', async () => {
    assert.match(await fails({ DOCKER_HOST: 'tcp://10.0.0.1:2375' }), /not a unix socket/);
    assert.match(await fails({}, deps({ ctx: 'ssh://host' })), /not a unix socket/);
    assert.match(await fails({ RESCTL_DOCKER_SOCKET: 'rel/path.sock' }), /absolute/);
    assert.match(await fails({ RESCTL_DOCKER_SOCKET: '/s/relay/x.resctl-docker.sock' }), /resctl relay/);
    assert.match(await fails({ RESCTL_DOCKER_SOCKET: '/nope.sock' }, deps({ kinds: { '/nope.sock': 'missing' } })), /does not exist/);
    assert.match(await fails({ RESCTL_DOCKER_SOCKET: '/file' }, deps({ kinds: { '/file': 'other' } })), /not a socket/);
  });
  it('isOwnRelaySocket tells our relay sockets from a keeper relay', () => {
    assert.ok(isOwnRelaySocket('/x/relay/r1.resctl-docker.sock'));
    assert.ok(!isOwnRelaySocket('/x/keepers/ws.docker.sock'));
  });
});

describe('relaySocketPath', () => {
  it('is <state>/relay/<id>.resctl-docker.sock, the same on every call', () => {
    assert.equal(relaySocketPath('/s', 'run-1'), '/s/relay/run-1.resctl-docker.sock');
    assert.equal(relaySocketPath('/s', 'run-1'), relaySocketPath('/s', 'run-1'));
    assert.notEqual(relaySocketPath('/s', 'run-1'), relaySocketPath('/s', 'run-2'));
  });
  it('an id too long for a unix socket path gets a stable hashed name in the same directory', () => {
    const long = 'x'.repeat(120);
    const p = relaySocketPath('/s', long);
    assert.ok(Buffer.byteLength(p) <= 107, p);
    assert.match(p, /^\/s\/relay\/h-[0-9a-f]{16}\.resctl-docker\.sock$/);
    assert.equal(p, relaySocketPath('/s', long));
    assert.notEqual(p, relaySocketPath('/s', `${long}y`));
  });
  it('refuses loudly when even the hashed name does not fit (a state dir that long cannot host a socket)', () => {
    assert.throws(() => relaySocketPath(`/${'d'.repeat(100)}`, 'r'), /too long for a unix socket/);
  });
});

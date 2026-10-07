import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCKER_LABEL_RUN, DOCKER_LABEL_WS } from './docker-labels.ts';
import {
  dockerRelayOffer,
  isContainerCreate,
  isRelaySocketPath,
  maxSocketPathBytes,
  relayUpstreamFile,
  relaySocketPath,
  resolveRelayUpstream,
  stampContainerCreateBody,
  stampCreateBodyBytes,
  type UpstreamDeps,
} from './docker-relay.ts';

const LABELS = { [DOCKER_LABEL_WS]: 'ws-1', [DOCKER_LABEL_RUN]: 'run-9' };

test('label keys are the exact contract #292/#293 list containers by', () => {
  assert.equal(DOCKER_LABEL_WS, 'orchestra.ws');
  assert.equal(DOCKER_LABEL_RUN, 'orchestra.run');
});

// ── which call is a create ───────────────────────────────────────────────────────────────────────────────────────

test('isContainerCreate: POST /containers/create with or without version/query; nothing else', () => {
  for (const url of ['/containers/create', '/v1.47/containers/create', '/v1.47/containers/create?name=x&platform=linux/amd64', '/v1/containers/create']) {
    assert.equal(isContainerCreate('POST', url), true, url);
  }
  // must-FAIL arms: each near-miss is NOT a create
  assert.equal(isContainerCreate('GET', '/containers/create'), false);
  assert.equal(isContainerCreate('POST', '/containers/abc/start'), false);
  assert.equal(isContainerCreate('POST', '/containers/create/x'), false);
  assert.equal(isContainerCreate('POST', '/networks/create'), false);
  assert.equal(isContainerCreate('POST', '/v1.47/containers/abc/exec'), false);
  assert.equal(isContainerCreate(undefined, undefined), false);
});

// ── the textual stamp ────────────────────────────────────────────────────────────────────────────────────────────

function labelsOf(text: string): Record<string, string> {
  return (JSON.parse(text) as { Labels: Record<string, string> }).Labels;
}

test('stamp: no Labels key → inserted, everything else untouched', () => {
  const body = '{"Image":"alpine","Cmd":["sleep","1"]}';
  const out = stampContainerCreateBody(body, LABELS)!;
  assert.deepEqual(labelsOf(out), LABELS);
  assert.deepEqual({ ...JSON.parse(out), Labels: undefined }, { Image: 'alpine', Cmd: ['sleep', '1'], Labels: undefined });
});

test('stamp: existing Labels are kept and ours are appended last (a client-supplied orchestra.ws loses)', () => {
  const out = stampContainerCreateBody('{"Labels":{"a":"b","orchestra.ws":"forged"},"Image":"x"}', LABELS)!;
  assert.deepEqual(labelsOf(out), { a: 'b', ...LABELS });
});

test('stamp: Labels null, empty object, empty body object', () => {
  assert.deepEqual(labelsOf(stampContainerCreateBody('{"Labels":null}', LABELS)!), LABELS);
  assert.deepEqual(labelsOf(stampContainerCreateBody('{"Labels":{}}', LABELS)!), LABELS);
  assert.deepEqual(labelsOf(stampContainerCreateBody('{ "Labels" : { } }', LABELS)!), LABELS);
  assert.deepEqual(labelsOf(stampContainerCreateBody('{}', LABELS)!), LABELS);
});

test('stamp: only a TOP-LEVEL Labels counts — a nested one (HostConfig) is not the container label set', () => {
  const out = stampContainerCreateBody('{"HostConfig":{"Labels":{"inner":"1"}},"Image":"x"}', LABELS)!;
  const v = JSON.parse(out) as { Labels: Record<string, string>; HostConfig: { Labels: Record<string, string> } };
  assert.deepEqual(v.Labels, LABELS);
  assert.deepEqual(v.HostConfig.Labels, { inner: '1' });
});

test('stamp: strings holding braces/quotes/the word Labels do not confuse the scanner', () => {
  const body = '{"Cmd":["sh","-c","echo \\"Labels\\": {\\"x\\": 1} }"],"Env":["A=}{"],"Image":"x"}';
  const out = stampContainerCreateBody(body, LABELS)!;
  const v = JSON.parse(out) as { Cmd: string[]; Env: string[]; Labels: Record<string, string> };
  assert.deepEqual(v.Labels, LABELS);
  assert.equal(v.Cmd[2], 'echo "Labels": {"x": 1} }');
  assert.deepEqual(v.Env, ['A=}{']);
});

test('stamp: an escaped quote followed by a structural-looking brace stays inside its string (escape handling)', () => {
  const body = '{"Cmd":["echo \\"}"],"Image":"x"}';
  const out = stampContainerCreateBody(body, LABELS);
  assert.notEqual(out, null);
  const v = JSON.parse(out!) as { Cmd: string[]; Image: string; Labels: Record<string, string> };
  assert.deepEqual(v.Cmd, ['echo "}']);
  assert.equal(v.Image, 'x');
  assert.deepEqual(v.Labels, LABELS);
});

test('stamp: integers above 2^53 survive byte-for-byte (a parse/stringify round trip would turn them into 2^63)', () => {
  const body = '{"HostConfig":{"Memory":9223372036854775807,"Ulimits":[{"Name":"memlock","Soft":-1,"Hard":18446744073709551615}]},"Image":"x"}';
  const out = stampContainerCreateBody(body, LABELS)!;
  assert.ok(out.includes('9223372036854775807'), out);
  assert.ok(out.includes('18446744073709551615'), out);
  // control: the naive round trip really does corrupt it, so this arm can fail
  assert.ok(!JSON.stringify(JSON.parse(body)).includes('9223372036854775807'));
});

test('stamp: bytes outside the insertion are identical (whitespace preserved)', () => {
  const body = '{\n  "Image": "alpine",\n  "Cmd": ["x"]\n}\n';
  const out = stampContainerCreateBody(body, LABELS)!;
  assert.ok(out.endsWith(',\n  "Image": "alpine",\n  "Cmd": ["x"]\n}\n'), out);
});

test('stamp: values we cannot edit with certainty return null (forward untouched), never a corrupted body', () => {
  for (const bad of ['', 'null', '[]', '"x"', '{', '{"a":1', '{"a":1}}', '{"a":}', '{"a":1,}', '{a:1}', '{"Labels":["x"]}', '{"Labels":"str"}', '{"a":"unterminated}']) {
    assert.equal(stampContainerCreateBody(bad, LABELS), null, JSON.stringify(bad));
  }
});

test('stampCreateBodyBytes: invalid UTF-8 is left alone; valid bytes stamp', () => {
  assert.equal(stampCreateBodyBytes(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), LABELS), null);
  const out = stampCreateBodyBytes(Buffer.from('{"Image":"é😀"}'), LABELS)!;
  assert.equal((JSON.parse(out.toString('utf8')) as { Image: string }).Image, 'é😀');
});

// ── paths ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('relaySocketPath sits beside the keeper socket and never ends in .pid', () => {
  assert.equal(relaySocketPath('/h/keepers/ws.sock'), '/h/keepers/ws.docker.sock');
  assert.equal(relaySocketPath('/tmp/okeeper-ab12.sock'), '/tmp/okeeper-ab12.docker.sock');
  assert.ok(!relaySocketPath('/h/keepers/ws.sock').endsWith('.pid'));
});

// ── upstream resolution ──────────────────────────────────────────────────────────────────────────────────────────

const deps = (over: Partial<UpstreamDeps> & { sockets?: string[]; other?: string[] } = {}): UpstreamDeps => ({
  dockerContextHost: over.dockerContextHost ?? (() => 'unix:///var/run/docker.sock'),
  pathKind: over.pathKind ?? ((p) => ((over.sockets ?? ['/var/run/docker.sock']).includes(p) ? 'socket' : (over.other ?? []).includes(p) ? 'other' : 'missing')),
});

test('upstream: default context → /var/run/docker.sock', async () => {
  assert.deepEqual(await resolveRelayUpstream({}, deps()), { ok: true, socketPath: '/var/run/docker.sock', via: 'docker context', daemonUp: true });
});

test('upstream: no docker CLI → the default socket', async () => {
  const r = await resolveRelayUpstream({}, deps({ dockerContextHost: () => null }));
  assert.deepEqual(r, { ok: true, socketPath: '/var/run/docker.sock', via: 'default', daemonUp: true });
});

test('upstream: the member DOCKER_HOST (unix) is the real socket; tcp/ssh is NOT silently swapped for the local daemon', async () => {
  assert.deepEqual(await resolveRelayUpstream({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, deps({ sockets: ['/run/user/1000/docker.sock'] })), {
    ok: true,
    socketPath: '/run/user/1000/docker.sock',
    via: 'DOCKER_HOST',
    daemonUp: true,
  });
  const tcp = await resolveRelayUpstream({ DOCKER_HOST: 'tcp://10.0.0.5:2375' }, deps());
  assert.equal(tcp.ok, false);
  const ssh = await resolveRelayUpstream({ DOCKER_HOST: 'ssh://me@box' }, deps());
  assert.equal(ssh.ok, false);
});

test('upstream: a non-unix docker context is refused (its member keeps its own endpoint)', async () => {
  const r = await resolveRelayUpstream({}, deps({ dockerContextHost: () => 'tcp://remote:2376' }));
  assert.equal(r.ok, false);
});

test('upstream: ORCHESTRA_DOCKER_SOCKET wins; something that is not a socket is a refusal', async () => {
  assert.deepEqual(await resolveRelayUpstream({ ORCHESTRA_DOCKER_SOCKET: '/tmp/x.sock', DOCKER_HOST: 'tcp://h:1' }, deps({ sockets: ['/tmp/x.sock'] })), {
    ok: true,
    socketPath: '/tmp/x.sock',
    via: 'ORCHESTRA_DOCKER_SOCKET',
    daemonUp: true,
  });
  const regular = await resolveRelayUpstream({ ORCHESTRA_DOCKER_SOCKET: '/tmp/a-file' }, deps({ other: ['/tmp/a-file'] }));
  assert.equal(regular.ok, false);
  assert.equal((await resolveRelayUpstream({ ORCHESTRA_DOCKER_SOCKET: 'relative.sock' }, deps({ sockets: ['relative.sock'] }))).ok, false);
});

test('upstream (F4): a daemon socket that is NOT THERE YET still resolves — the relay can come up and 502 until dockerd appears', async () => {
  const r = await resolveRelayUpstream({}, deps({ sockets: [] })); // default context, nothing at /var/run/docker.sock
  assert.deepEqual(r, { ok: true, socketPath: '/var/run/docker.sock', via: 'docker context', daemonUp: false });
  const explicit = await resolveRelayUpstream({ ORCHESTRA_DOCKER_SOCKET: '/run/late.sock' }, deps({ sockets: [] }));
  assert.deepEqual(explicit, { ok: true, socketPath: '/run/late.sock', via: 'ORCHESTRA_DOCKER_SOCKET', daemonUp: false });
  // control: an existing NON-socket in the way is still refused
  assert.equal((await resolveRelayUpstream({ ORCHESTRA_DOCKER_SOCKET: '/run/x' }, deps({ other: ['/run/x'] }))).ok, false);
});

test('upstream (review #1): the built-in DEFAULT path is a guess — "not there" is believed only when the member or a REAL docker context named it', async () => {
  // the context lookup FAILED (CLI timeout under fleet-start load / missing CLI / a podman shim) and nothing listens at the default path: NO relay (the member's own endpoint keeps working)
  const guessed = await resolveRelayUpstream({}, deps({ dockerContextHost: () => null, sockets: [] }));
  assert.equal(guessed.ok, false);
  assert.match(guessed.ok ? '' : guessed.reason, /no docker context named another endpoint/);
  // controls: the same missing path IS believed when a context the CLI really read named it, or the member's DOCKER_HOST / explicit override did
  assert.equal((await resolveRelayUpstream({}, deps({ dockerContextHost: () => 'unix:///Users/u/.docker/run/docker.sock', sockets: [] }))).ok, true);
  assert.equal((await resolveRelayUpstream({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, deps({ sockets: [] }))).ok, true);
  assert.equal((await resolveRelayUpstream({ ORCHESTRA_DOCKER_SOCKET: '/run/late.sock' }, deps({ sockets: [] }))).ok, true);
  // and a default that EXISTS with no context answer (CLI absent, daemon up) still gets its relay
  assert.deepEqual(await resolveRelayUpstream({}, deps({ dockerContextHost: () => null, sockets: ['/var/run/docker.sock'] })), { ok: true, socketPath: '/var/run/docker.sock', via: 'default', daemonUp: true });
});

test('upstream (review #7): a relay socket is refused whichever input named it — ORCHESTRA_DOCKER_SOCKET and a docker-context endpoint too, not only DOCKER_HOST', async () => {
  const relay = '/h/.orchestra/keepers/ws-A.docker.sock';
  assert.equal((await resolveRelayUpstream({ ORCHESTRA_DOCKER_SOCKET: relay }, deps({ sockets: [relay] }))).ok, false);
  assert.equal((await resolveRelayUpstream({ ORCHESTRA_DOCKER_SOCKET: `unix://${relay}` }, deps({ sockets: [relay] }))).ok, false);
  const viaContext = await resolveRelayUpstream({}, deps({ dockerContextHost: () => `unix://${relay}`, sockets: [relay] }));
  assert.equal(viaContext.ok, false);
  assert.match(viaContext.ok ? '' : viaContext.reason, /keeper relay socket/);
});

test('relayUpstreamFile sits beside the relay socket, never a .pid / .sock name', () => {
  assert.equal(relayUpstreamFile('/h/keepers/ws.sock'), '/h/keepers/ws.docker.upstream');
  assert.equal(relayUpstreamFile('/tmp/okeeper-ab12.sock'), '/tmp/okeeper-ab12.docker.upstream');
});

test('upstream: an inherited RELAY DOCKER_HOST is not the real daemon — ignored, and hidden from the context lookup', async () => {
  const seenEnvs: Array<Record<string, string | undefined>> = [];
  const d = deps({
    dockerContextHost: (e) => {
      seenEnvs.push(e);
      return 'unix:///var/run/docker.sock';
    },
    sockets: ['/h/.orchestra/keepers/ws-A.docker.sock', '/var/run/docker.sock'],
  });
  const r = await resolveRelayUpstream({ DOCKER_HOST: 'unix:///h/.orchestra/keepers/ws-A.docker.sock', HOME: '/h' }, d);
  assert.deepEqual(r, { ok: true, socketPath: '/var/run/docker.sock', via: 'docker context', daemonUp: true });
  assert.equal(seenEnvs.length, 1);
  assert.equal(seenEnvs[0].DOCKER_HOST, undefined, 'the context lookup must not see (and echo back) the other relay');
  assert.equal(seenEnvs[0].HOME, '/h');
  // the tmpdir-fallback relay name (keeperSocketPath hashes an over-long path into os.tmpdir())
  const t = await resolveRelayUpstream({ DOCKER_HOST: 'unix:///tmp/okeeper-0123456789abcdef.docker.sock' }, d);
  assert.equal(t.ok && t.via, 'docker context');
});

test('isRelaySocketPath: any <name>.docker.sock (keepers dir or tmpdir fallback); never a real daemon socket', () => {
  assert.equal(isRelaySocketPath('/home/u/.orchestra/keepers/ws-1.docker.sock'), true);
  assert.equal(isRelaySocketPath('/tmp/okeeper-0123456789abcdef.docker.sock'), true);
  assert.equal(isRelaySocketPath('/home/u/.orchestra/keepers/ws-1.sock'), false);
  assert.equal(isRelaySocketPath('/var/run/docker.sock'), false);
  assert.equal(isRelaySocketPath('/run/user/1000/docker.sock'), false);
  assert.equal(isRelaySocketPath('/Users/u/.docker/run/docker.sock'), false);
});

test('maxSocketPathBytes: sun_path is 108 on Linux and 104 on macOS (NUL included)', () => {
  assert.equal(maxSocketPathBytes('linux'), 107);
  assert.equal(maxSocketPathBytes('darwin'), 103);
});

// ── app-side offer ───────────────────────────────────────────────────────────────────────────────────────────────

test('dockerRelayOffer: only a local, unix, switch-ON session with a run gets a spec', () => {
  const on = { remote: false, platform: 'linux', runId: 'run-1', switchOn: true };
  assert.deepEqual(dockerRelayOffer(on), { runId: 'run-1' });
  // must-FAIL arms — each clause alone withholds the relay
  assert.equal(dockerRelayOffer({ ...on, switchOn: false }), undefined);
  assert.equal(dockerRelayOffer({ ...on, remote: true }), undefined); // sandbox-hosted member
  assert.equal(dockerRelayOffer({ ...on, platform: 'win32' }), undefined);
  assert.equal(dockerRelayOffer({ ...on, runId: '' }), undefined);
  assert.equal(dockerRelayOffer({ ...on, runId: undefined }), undefined);
});

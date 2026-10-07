import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCKER_LABEL_RUN, DOCKER_LABEL_WS } from './docker-labels.ts';
import {
  dockerRelayOffer,
  isContainerCreate,
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

const deps = (over: Partial<UpstreamDeps> & { sockets?: string[] } = {}): UpstreamDeps => ({
  dockerContextHost: over.dockerContextHost ?? (() => 'unix:///var/run/docker.sock'),
  isSocket: over.isSocket ?? ((p) => (over.sockets ?? ['/var/run/docker.sock']).includes(p)),
});

test('upstream: default context → /var/run/docker.sock', () => {
  assert.deepEqual(resolveRelayUpstream({}, deps()), { ok: true, socketPath: '/var/run/docker.sock', via: 'docker context' });
});

test('upstream: no docker CLI → the default socket', () => {
  const r = resolveRelayUpstream({}, deps({ dockerContextHost: () => null }));
  assert.deepEqual(r, { ok: true, socketPath: '/var/run/docker.sock', via: 'default' });
});

test('upstream: the member DOCKER_HOST (unix) is the real socket; tcp/ssh is NOT silently swapped for the local daemon', () => {
  assert.deepEqual(resolveRelayUpstream({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, deps({ sockets: ['/run/user/1000/docker.sock'] })), {
    ok: true,
    socketPath: '/run/user/1000/docker.sock',
    via: 'DOCKER_HOST',
  });
  const tcp = resolveRelayUpstream({ DOCKER_HOST: 'tcp://10.0.0.5:2375' }, deps());
  assert.equal(tcp.ok, false);
  const ssh = resolveRelayUpstream({ DOCKER_HOST: 'ssh://me@box' }, deps());
  assert.equal(ssh.ok, false);
});

test('upstream: a non-unix docker context is refused (its member keeps its own endpoint)', () => {
  const r = resolveRelayUpstream({}, deps({ dockerContextHost: () => 'tcp://remote:2376' }));
  assert.equal(r.ok, false);
});

test('upstream: ORCHESTRA_DOCKER_SOCKET wins; a missing socket is a refusal, not a relay to nowhere', () => {
  assert.deepEqual(resolveRelayUpstream({ ORCHESTRA_DOCKER_SOCKET: '/tmp/x.sock', DOCKER_HOST: 'tcp://h:1' }, deps({ sockets: ['/tmp/x.sock'] })), {
    ok: true,
    socketPath: '/tmp/x.sock',
    via: 'ORCHESTRA_DOCKER_SOCKET',
  });
  assert.equal(resolveRelayUpstream({}, deps({ sockets: [] })).ok, false);
  assert.equal(resolveRelayUpstream({ ORCHESTRA_DOCKER_SOCKET: 'relative.sock' }, deps({ sockets: ['relative.sock'] })).ok, false);
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

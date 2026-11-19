// The pure half of the relay: which call is a container create, and how its body gets the run label (text surgery, never a JSON round trip).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isContainerCreate, stampContainerCreateBody, stampCreateBodyBytes } from '../src/relay-stamp.ts';

const L = { 'resctl.run': 'r1' };
const labelsOf = (s: string | null, key = 'Labels'): Record<string, string> => (JSON.parse(s!) as Record<string, Record<string, string>>)[key];

describe('isContainerCreate', () => {
  it('matches a create with or without the API version prefix and a query, nothing else', () => {
    for (const u of ['/containers/create', '/containers/create?name=x', '/v1.43/containers/create', '/v1.43/containers/create?name=x&platform=linux/amd64', '/v1/containers/create']) assert.ok(isContainerCreate('POST', u), u);
    for (const [m, u] of [['GET', '/containers/create'], ['POST', '/containers/abc/start'], ['POST', '/networks/create'], ['POST', '/volumes/create'], ['POST', '/containers/create/x'], ['POST', '/x/containers/create'], ['POST', undefined]] as const) {
      assert.ok(!isContainerCreate(m, u), `${m} ${u}`);
    }
  });
});

describe('isContainerCreate — the path the daemon routes, not the bytes the client sent', () => {
  it('sees through percent-encoding, doubled slashes, dot segments, a trailing slash and the absolute-form target', () => {
    for (const u of ['/containers/%63reate', '/%63ontainers/create', '//containers/create', '/v1.43//containers/./create', '/x/../containers/create', '/containers/create/', 'http://localhost/v1.43/containers/create?name=a', 'HTTP://h:2375/containers/create', '/containers/create%zz']) {
      assert.ok(isContainerCreate('POST', u), u);
    }
    for (const u of ['/containers/create2', '/containers/%63reate/x', 'http://localhost/containers/json', '/containers/../networks/create']) assert.ok(!isContainerCreate('POST', u), u);
  });
});

describe('isContainerCreate — the version segment is the daemon\'s `v[0-9.]+`', () => {
  it('accepts every spelling the daemon routes, including a trailing dot and a leading zero', () => {
    for (const u of ['/v1.54./containers/create', '/v1.54../containers/create', '/v01.54/containers/create', '/v1/containers/create', '/v1.54/containers/create?name=x', '/v1.2.3/containers/create']) assert.ok(isContainerCreate('POST', u), u);
    for (const u of ['/v/containers/create', '/vx1/containers/create', '/v1.54a/containers/create']) assert.ok(!isContainerCreate('POST', u), u);
  });
});

describe('stampContainerCreateBody', () => {
  it('adds a Labels member when there is none, keeps every other byte', () => {
    const body = '{"Image":"alpine","Cmd":["sleep","9"]}';
    const out = stampContainerCreateBody(body, L)!;
    assert.deepEqual(labelsOf(out), L);
    assert.deepEqual({ ...JSON.parse(out), Labels: undefined }, { ...JSON.parse(body), Labels: undefined });
  });
  it('merges into existing labels, ours LAST so a client-supplied resctl.run loses', () => {
    const out = stampContainerCreateBody('{"Labels":{"a":"1","resctl.run":"evil"}}', L)!;
    assert.deepEqual(labelsOf(out), { a: '1', 'resctl.run': 'r1' });
    assert.ok(out.lastIndexOf('"resctl.run":"r1"') > out.lastIndexOf('"resctl.run":"evil"'), 'our key is written after the client\'s');
  });
  it('handles null / empty / whitespace Labels and an empty object', () => {
    assert.deepEqual(labelsOf(stampContainerCreateBody('{"Labels":null,"Image":"x"}', L)), L);
    assert.deepEqual(labelsOf(stampContainerCreateBody('{ "Labels" : { } }', L)), L);
    assert.deepEqual(labelsOf(stampContainerCreateBody('{}', L)), L);
    assert.deepEqual(labelsOf(stampContainerCreateBody(' \n{"Image":"x"}\n', L)), L);
  });
  it('treats a lower-case `labels` member as Labels (the daemon decodes member names case-insensitively)', () => {
    const out = stampContainerCreateBody('{"labels":{"a":"1"},"Image":"x"}', L)!;
    assert.deepEqual(labelsOf(out, 'labels'), { a: '1', 'resctl.run': 'r1' });
    assert.equal(JSON.parse(out).Labels, undefined, 'no second member that the later one could shadow');
  });
  it('treats a member name the daemon folds onto Labels (long s, U+017F) as Labels — as raw UTF-8 bytes and as an escape', () => {
    const raw = stampCreateBodyBytes(Buffer.from('{"Labels":{"a":"1"},"Label\u017f":{"b":"2"},"Image":"x"}', 'utf8'), L)!.toString('utf8');
    assert.ok(raw.includes('"Label\u017f":{"b":"2","resctl.run":"r1"}'), raw);
    const esc = stampContainerCreateBody('{"Label\\u017f":{"b":"2"}}', L)!;
    assert.ok(esc.includes('"resctl.run":"r1"') && !esc.includes('"Labels"'), esc);
  });
  it('stamps the LAST Labels member (a later one wins in the daemon)', () => {
    const out = stampContainerCreateBody('{"Labels":{"first":"1"},"Image":"x","Labels":{"last":"2"}}', L)!;
    assert.ok(out.endsWith('"Labels":{"last":"2","resctl.run":"r1"}}'), out);
    assert.ok(out.includes('{"first":"1"}'), 'the earlier member is untouched');
  });
  it('finds Labels through an escaped member name and ignores a Labels key nested deeper', () => {
    assert.deepEqual(labelsOf(stampContainerCreateBody('{"Lab\\u0065ls":{"a":"1"}}', L), 'Labels'), { a: '1', 'resctl.run': 'r1' });
    const nested = stampContainerCreateBody('{"HostConfig":{"Labels":{"deep":"1"}},"Image":"x"}', L)!;
    assert.deepEqual(JSON.parse(nested).HostConfig.Labels, { deep: '1' });
    assert.deepEqual(labelsOf(nested), L);
  });
  it('never rewrites a number: integers above 2^53 survive byte for byte', () => {
    const body = '{"Image":"x","HostConfig":{"Memory":9223372036854775807,"Ulimits":[{"Name":"nofile","Hard":18446744073709551615}]}}';
    const out = stampContainerCreateBody(body, L)!;
    assert.ok(out.includes('9223372036854775807') && out.includes('18446744073709551615'), out);
    assert.equal(stampCreateBodyBytes(Buffer.from(body), L)!.toString().includes('9223372036854775807'), true);
  });
  it('returns null (caller refuses) for anything it cannot edit with certainty', () => {
    for (const bad of ['', '[]', 'null', '"x"', '{"Image":', '{"Image":"x"} trailing', '{"Image":"x",}', '{"Labels":"str"}', '{"Labels":[1]}', "{'a':1}", '{"a" 1}']) {
      assert.equal(stampContainerCreateBody(bad, L), null, JSON.stringify(bad));
    }
  });
  it('bytes that are not UTF-8 pass through untouched', () => {
    const body = Buffer.concat([Buffer.from('{"Env":["X='), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('"],"Image":"x"}')]);
    const out = stampCreateBodyBytes(body, L)!;
    assert.ok(out.includes(Buffer.from([0xff, 0xfe, 0xc3])), 'the raw bytes are still there');
    assert.ok(out.toString('latin1').includes('"Labels":{"resctl.run":"r1"}'));
  });
});

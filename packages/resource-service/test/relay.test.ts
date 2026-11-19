// The relay server in-process against a fake daemon: it stamps resctl.run on every container create (docker run, compose and client libraries all use that one call)
// and forwards everything else byte for byte. Acceptance 1 at the wire level; the real-docker half is docker-real.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createRelay, type Relay } from '../src/relay.ts';
import { FakeDocker } from './lib/fake-docker.ts';
import { request } from './lib/http.ts';
import { within } from './lib/rig.ts';

describe('docker relay', () => {
  let dir: string;
  let daemon: FakeDocker;
  let relay: Relay;
  const logs: string[] = [];
  const created = (n = 1) => daemon.calls.filter((c) => c.method === 'POST' && /containers\/create/.test(c.url)).slice(-n);

  before(async () => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'resctl-rly-'));
    daemon = await FakeDocker.start(dir);
    relay = createRelay({ sockPath: path.join(dir, 'r.sock'), upstream: daemon.sock, runId: 'run-a', token: 'tok-a', log: (m) => logs.push(m) });
    assert.equal(await relay.start(), true);
  });
  after(async () => {
    relay.stop();
    await daemon.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps resctl.run on a container create, keeps the client labels and every other field', async () => {
    const r = await request(relay.sockPath, 'POST', '/containers/create?name=x', { body: '{"Image":"alpine","Cmd":["sleep","1"],"Labels":{"mine":"1"}}', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 201, r.body);
    const got = JSON.parse(created()[0].body.toString());
    assert.deepEqual(got.Labels, { mine: '1', 'resctl.run': 'run-a', 'resctl.token': 'tok-a' });
    assert.deepEqual([got.Image, got.Cmd], ['alpine', ['sleep', '1']]);
    const id = JSON.parse(r.body).Id as string;
    assert.equal(daemon.containers.get(id)!.labels['resctl.run'], 'run-a', 'the daemon holds the container with the label');
  });

  it('stamps a create made under an API version prefix (docker CLI, compose)', async () => {
    const r = await request(relay.sockPath, 'POST', '/v1.43/containers/create?name=y', { body: '{"Image":"alpine"}' });
    assert.equal(r.status, 201);
    assert.equal(JSON.parse(created()[0].body.toString()).Labels['resctl.run'], 'run-a');
  });

  it('stamps a create streamed with chunked framing (a client library) and re-frames it', async () => {
    const r = await request(relay.sockPath, 'POST', '/v1.43/containers/create', { chunks: ['{"Image":"al', 'pine","Labels":{"k":"v"}', '}'] });
    assert.equal(r.status, 201, r.body);
    const call = created()[0];
    assert.deepEqual(JSON.parse(call.body.toString()).Labels, { k: 'v', 'resctl.run': 'run-a', 'resctl.token': 'tok-a' });
    assert.equal(call.headers['content-length'], String(call.body.length), 'the content-length matches the stamped body');
    assert.equal(call.headers['transfer-encoding'], undefined);
  });

  it('a client cannot override the label', async () => {
    await request(relay.sockPath, 'POST', '/containers/create', { body: '{"Image":"a","Labels":{"resctl.run":"other-run","resctl.token":"other-token"}}' });
    assert.equal(JSON.parse(created()[0].body.toString()).Labels['resctl.run'], 'run-a');
    assert.equal(JSON.parse(created()[0].body.toString()).Labels['resctl.token'], 'tok-a');
    await request(relay.sockPath, 'POST', '/containers/create', { body: '{"labels":{"resctl.run":"other-run"},"Image":"a"}' });
    const got = JSON.parse(created()[0].body.toString());
    assert.deepEqual(Object.keys(got).filter((k) => k.toLowerCase() === 'labels'), ['labels']);
    assert.equal(got.labels['resctl.run'], 'run-a');
  });

  it('does not rewrite numbers: an integer above 2^53 reaches the daemon intact', async () => {
    await request(relay.sockPath, 'POST', '/containers/create', { body: '{"Image":"a","HostConfig":{"Memory":9223372036854775807}}' });
    assert.ok(created()[0].body.toString().includes('"Memory":9223372036854775807'));
  });

  it('everything else is forwarded untouched — body, headers and answer', async () => {
    const payload = '{"Name":"n","Labels":{"keep":"me"}}';
    const r = await request(relay.sockPath, 'POST', '/v1.43/networks/create', { body: payload, headers: { 'x-extra': 'yes', 'content-type': 'application/json' } });
    assert.equal(r.status, 200);
    const call = daemon.calls.filter((c) => /networks\/create/.test(c.url)).pop()!;
    assert.equal(call.body.toString(), payload, 'a network create is not a container create: not stamped');
    assert.equal(call.headers['x-extra'], 'yes');
    const ping = await request(relay.sockPath, 'GET', '/_ping');
    assert.deepEqual([ping.status, ping.body], [200, 'OK']);
    const del = await request(relay.sockPath, 'DELETE', '/containers/nope?force=1');
    assert.equal(del.status, 404, 'the daemon\'s own status is relayed');
    const start = await request(relay.sockPath, 'POST', '/containers/abc/start', { body: '' });
    assert.equal(start.status, 200);
  });

  it('refuses a create body it cannot label (fail closed), and the daemon never sees it', async () => {
    const before = daemon.containers.size;
    const callsBefore = created(1000).length;
    const r = await request(relay.sockPath, 'POST', '/containers/create', { body: '{"Image":"a","Labels":"not-an-object"}' });
    assert.equal(r.status, 400);
    assert.match(r.body, /refused/);
    assert.equal(created(1000).length, callsBefore, 'nothing was forwarded');
    assert.equal(daemon.containers.size, before, 'no container, therefore no unlabelled one');
  });

  it('an Upgrade call (attach, exec start) becomes a raw byte pipe', async () => {
    const got = await within(
      'upgrade echo',
      new Promise<string>((resolve, reject) => {
        const s = net.connect(relay.sockPath);
        let buf = '';
        s.on('connect', () => s.write('POST /containers/abc/attach HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'));
        s.on('data', (d) => {
          buf += d.toString();
          if (buf.includes('101') && !buf.includes('echo:')) s.write('ping');
          if (buf.includes('echo:ping')) (s.destroy(), resolve(buf));
        });
        s.on('error', reject);
      }),
    );
    assert.match(got, /^HTTP\/1.1 101/);
  });

  it('stamps a create however its target is spelled (percent-encoded, doubled slash, absolute-form)', async () => {
    for (const target of ['/containers/%63reate', '//v1.43/containers/create', 'http://localhost/v1.43/containers/create?name=z']) {
      await request(relay.sockPath, 'POST', target, { body: '{"Image":"a"}' });
      assert.equal(JSON.parse(created(1)[0].body.toString()).Labels['resctl.run'], 'run-a', target);
    }
  });

  it('a create that arrives as an Upgrade request is refused, never piped through unlabelled', async () => {
    const callsBefore = daemon.calls.length;
    const answer = await within(
      'upgrade create',
      new Promise<string>((resolve, reject) => {
        const s = net.connect(relay.sockPath);
        let buf = '';
        s.on('connect', () => s.write('POST /containers/create HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 13\r\n\r\n{"Image":"x"}'));
        s.on('data', (d) => (buf += d.toString()));
        s.on('close', () => resolve(buf));
        s.on('error', reject);
      }),
    );
    assert.match(answer, /^HTTP\/1.1 400/);
    assert.equal(daemon.calls.length, callsBefore, 'the daemon saw nothing');
  });

  it('stamps a create under a version segment with a trailing dot (the daemon routes v[0-9.]+)', async () => {
    for (const target of ['/v1.54./containers/create', '/v1.54../containers/create', '/v01.54/containers/create']) {
      const r = await request(relay.sockPath, 'POST', target, { body: '{"Image":"a"}' });
      assert.equal(JSON.parse(created(1)[0].body.toString()).Labels['resctl.run'], 'run-a', target);
      assert.ok(r.status < 500);
    }
  });

  it('an Upgrade request the daemon does NOT hijack never turns the connection into a raw pipe: a create behind it is not forwarded unlabelled', async () => {
    const unlabelled = () => [...daemon.containers.values()].filter((c) => c.labels['resctl.run'] === undefined).length;
    const create = '{"Image":"sneaky"}';
    const post = `POST /containers/create HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${create.length}\r\n\r\n${create}`;
    const ping = 'GET /_ping HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n';
    const before = unlabelled();
    // (a) the create arrives in the same write as the Upgrade request; (b) only after the daemon answered
    for (const sameWrite of [true, false]) {
      const out = await within(
        `upgrade then create (${sameWrite ? 'same write' : 'after the answer'})`,
        new Promise<string>((resolve, reject) => {
          const s = net.connect(relay.sockPath);
          let buf = '';
          let sent = false;
          s.on('connect', () => s.write(sameWrite ? ping + post : ping));
          s.on('data', (d) => {
            buf += d.toString();
            if (!sameWrite && !sent && buf.includes('OK')) {
              sent = true;
              s.write(post, () => setTimeout(() => s.end(), 300));
            }
            if (sameWrite && buf.includes('OK')) setTimeout(() => s.end(), 300);
          });
          s.on('close', () => resolve(buf));
          s.on('error', () => resolve(buf));
        }),
      );
      assert.match(out, /^HTTP\/1.1 200/, 'the daemon\'s plain answer to the ping is relayed');
      assert.equal(unlabelled(), before, `no unlabelled container (${sameWrite ? 'same write' : 'after the answer'})`);
    }
  });

  /** One raw conversation with the relay: `first` is written at once, `then` after the first answer arrived; the socket is closed by the relay or after `holdMs`. */
  const converse = (first: string, o: { then?: string; holdMs?: number } = {}): Promise<{ out: string; closedByRelay: boolean }> =>
    within(
      'raw conversation',
      new Promise((resolve) => {
        const s = net.connect(relay.sockPath);
        let out = '';
        let sent = false;
        let done = false;
        const finish = (byRelay: boolean): void => {
          if (done) return;
          done = true;
          s.destroy();
          resolve({ out, closedByRelay: byRelay });
        };
        s.on('connect', () => s.write(first));
        s.on('data', (d) => {
          out += d.toString();
          if (o.then && !sent) {
            sent = true;
            s.write(o.then);
          }
        });
        s.on('close', () => finish(true));
        s.on('error', () => finish(true));
        setTimeout(() => finish(false), o.holdMs ?? 1500);
      }),
      10_000,
    );
  const sneaky = (): string => {
    const b = '{"Image":"sneaky"}';
    return `POST /containers/create HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${b.length}\r\n\r\n${b}`;
  };
  const unlabelledCount = (): number => [...daemon.containers.values()].filter((c) => c.labels['resctl.run'] === undefined).length;

  it('review (delta): docker exec — an Upgrade request WITH a body — reaches the daemon with its body and becomes a raw pipe after the 101', async () => {
    const body = '{"Detach":false,"Tty":true}';
    const out = await converse(`POST /exec/abc123/start HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${body.length}\r\n\r\n${body}`, { then: 'stdin-bytes', holdMs: 2500 });
    assert.match(out.out, /^HTTP\/1.1 101/, 'the daemon answered 101 (it read the body first)');
    assert.ok(out.out.includes('echo:stdin-bytes'), 'and the pipe carries the client\'s bytes');
    assert.equal(daemon.calls.filter((c) => /exec\/abc123\/start/.test(c.url)).length, 1);
  });

  it('review (delta): a 200 raw/multiplexed-stream answer on a NON-hijack endpoint (logs) is not a hijack: a create pipelined behind it is not forwarded', async () => {
    const before = unlabelledCount();
    for (const sameWrite of [true, false]) {
      const logs = 'GET /containers/abc/logs?stdout=1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n';
      const r = await converse(sameWrite ? logs + sneaky() : logs, sameWrite ? {} : { then: sneaky() });
      assert.match(r.out, /^HTTP\/1.1 200/);
      assert.equal(unlabelledCount(), before, sameWrite ? 'same write' : 'after the answer');
    }
  });

  it('review (delta): a plain answer without a Content-Length (chunked, 204) is relayed in full and the connection closed — no 30 s wait', async () => {
    const t0 = Date.now();
    const chunked = await converse('GET /_test/chunked HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n', { holdMs: 5000 });
    assert.ok(chunked.out.includes('onetwo') || (chunked.out.includes('3\r\none') && chunked.out.includes('3\r\ntwo')), chunked.out);
    assert.ok(chunked.closedByRelay, 'closed by the relay');
    const none = await converse('GET /_test/204 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n', { holdMs: 5000 });
    assert.match(none.out, /^HTTP\/1.1 204/);
    assert.ok(none.closedByRelay);
    assert.ok(Date.now() - t0 < 8000);
  });

  it('the socket is owner-only', () => {
    assert.equal(fs.statSync(relay.sockPath).mode & 0o777, 0o600);
  });

  it('answers 502 when the daemon is down, and recovers when it is back', async () => {
    await daemon.down();
    const r = await request(relay.sockPath, 'POST', '/containers/create', { body: '{"Image":"a"}' });
    assert.equal(r.status, 502);
    assert.match(r.body, /cannot reach the Docker daemon/);
    await daemon.up();
    assert.equal((await request(relay.sockPath, 'GET', '/_ping')).status, 200);
  });

  it('stop() closes the socket and removes the file', async () => {
    const r2 = createRelay({ sockPath: path.join(dir, 'r2.sock'), upstream: daemon.sock, runId: 'x', token: 'tok-x', log: () => {} });
    assert.equal(await r2.start(), true);
    assert.ok(fs.existsSync(r2.sockPath));
    r2.stop();
    assert.ok(!fs.existsSync(r2.sockPath));
    await assert.rejects(request(r2.sockPath, 'GET', '/_ping'));
  });
});

// #321 — the app half of the Docker relay hold (logic in docker-hold.ts, wiring in docker-hold-host.ts / index.ts / hooks-server.ts / the CLI). Core on injected deps; wiring by reading the shipped source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDockerHold, type DockerHoldDeps } from './docker-hold.ts';
import { parseAdmissionState, type HoldFile } from '../shared/docker-hold.ts';
import { GIB } from '../shared/memory-guard.ts';

const snap = (over: Record<string, unknown> = {}) => ({ admission: 'held' as const, admissionEnabled: true, heldSince: 1_000, episode: 4, availBytes: 5 * GIB, admissionBytes: 6 * GIB, releaseMarginBytes: GIB, ...over });

class Rig {
  t = 1_000_000;
  files = new Map<string, string>();
  notices: Array<{ wsId: string; text: string }> = [];
  warns: string[] = [];
  failWrite = false;
  holdFiles = [{ wsId: 'ws-a', file: '/k/a.docker.hold' }, { wsId: 'ws-b', file: '/k/b.docker.hold' }];
  deps: DockerHoldDeps = {
    stateFile: '/h/admission.state',
    holdFiles: () => this.holdFiles,
    now: () => this.t,
    readText: (f) => this.files.get(f) ?? null,
    writeFile: (f, text) => {
      if (this.failWrite) throw new Error('EROFS');
      this.files.set(f, text);
    },
    removeFile: (f) => void this.files.delete(f),
    notify: (wsId, text) => void this.notices.push({ wsId, text }),
    noticeAfterMs: 20_000,
    warn: (m) => void this.warns.push(m),
  };
  hold = createDockerHold(this.deps);
  setHold(file: string, over: Partial<HoldFile> = {}): void {
    const h: HoldFile = { v: 1, ts: this.t, create: 1, start: 0, since: this.t - 30_000, heldSince: this.t - 40_000, episode: 4, reason: 'Admission hold: …', ...over };
    this.files.set(file, JSON.stringify(h));
  }
}

test('publish writes the EFFECTIVE hold the keepers parse: held ⇒ held; toggle OFF ⇒ not held', () => {
  const r = new Rig();
  r.hold.publish(snap());
  assert.equal(parseAdmissionState(r.files.get('/h/admission.state')!)?.held, true);
  assert.equal(parseAdmissionState(r.files.get('/h/admission.state')!)?.ts, r.t);
  r.t += 10_000;
  r.hold.publish(snap({ admissionEnabled: false }));
  const s = parseAdmissionState(r.files.get('/h/admission.state')!)!;
  assert.equal(s.held, false);
  assert.equal(s.ts, r.t, 'refreshed at every sample');
  r.hold.publish(snap({ admission: 'open' }));
  assert.equal(parseAdmissionState(r.files.get('/h/admission.state')!)?.held, false);
});

test('a failed publish never throws into the guard and warns ONCE', () => {
  const r = new Rig();
  r.failWrite = true;
  r.hold.publish(snap());
  r.hold.publish(snap());
  assert.equal(r.warns.length, 1);
  assert.match(r.warns[0], /relays then never hold/);
});

test('stop removes the state file (a hold must not outlive the app that decides it)', () => {
  const r = new Rig();
  r.hold.publish(snap());
  r.hold.stop();
  assert.equal(r.files.has('/h/admission.state'), false);
  r.hold.stop(); // idempotent
});

test('holds() lists only LIVE, parseable hold files, oldest first', () => {
  const r = new Rig();
  r.setHold('/k/a.docker.hold', { since: r.t - 5_000 });
  r.setHold('/k/b.docker.hold', { since: r.t - 50_000 });
  assert.deepEqual(r.hold.holds().map((h) => h.wsId), ['ws-b', 'ws-a']);
  r.t += 40_000; // both files are now older than the keeper heartbeat TTL ⇒ a dead keeper's leftovers
  assert.deepEqual(r.hold.holds(), []);
  r.files.set('/k/a.docker.hold', 'garbage');
  assert.deepEqual(r.hold.holds(), []);
  r.setHold('/k/a.docker.hold', { create: 0, start: 0 });
  assert.deepEqual(r.hold.holds(), [], 'an empty hold is not a hold');
});

test('tick: ONE notice per member per Admission episode, only after the wait passed noticeAfterMs, with the "nothing is refused" text', () => {
  const r = new Rig();
  r.setHold('/k/a.docker.hold', { since: r.t - 5_000 });
  r.hold.tick();
  assert.equal(r.notices.length, 0, 'a brief wait sends nothing');
  r.t += 20_000;
  r.setHold('/k/a.docker.hold', { since: r.t - 25_000 });
  r.hold.tick();
  assert.equal(r.notices.length, 1);
  assert.equal(r.notices[0].wsId, 'ws-a');
  assert.match(r.notices[0].text, /BY THEMSELVES/);
  r.t += 10_000;
  r.setHold('/k/a.docker.hold', { since: r.t - 35_000 });
  r.hold.tick();
  r.hold.tick();
  assert.equal(r.notices.length, 1, 'same episode: not again');
  r.files.delete('/k/a.docker.hold');
  r.hold.tick();
  r.setHold('/k/a.docker.hold', { since: r.t - 35_000 });
  r.hold.tick();
  assert.equal(r.notices.length, 1, 'the hold file vanishing and returning inside the SAME episode is not a new notice');
  r.setHold('/k/a.docker.hold', { since: r.t - 35_000, episode: 5 });
  r.hold.tick();
  assert.equal(r.notices.length, 2, 'a NEW episode notifies again');
});

test('tick: members are independent, and a throwing notify is contained and does not mark the others', () => {
  const r = new Rig();
  r.setHold('/k/a.docker.hold');
  r.setHold('/k/b.docker.hold');
  let n = 0;
  r.deps.notify = (wsId, text) => {
    if (n++ === 0) throw new Error('bus down');
    r.notices.push({ wsId, text });
  };
  r.hold = createDockerHold(r.deps);
  r.hold.tick();
  assert.equal(r.notices.length, 1);
  assert.equal(r.warns.length, 1);
});

test('a notice that could NOT be delivered (no bus / unknown member → false, or a throw) is retried at the next tick and delivered exactly once', () => {
  const r = new Rig();
  r.setHold('/k/a.docker.hold');
  const results: Array<boolean | 'throw'> = [false, 'throw', true, true];
  let i = 0;
  r.deps.notify = (wsId, text) => {
    const res = results[i++];
    if (res === 'throw') throw new Error('bus down');
    if (res) r.notices.push({ wsId, text });
    return res;
  };
  r.hold = createDockerHold(r.deps);
  r.hold.tick();
  r.hold.tick();
  assert.equal(r.notices.length, 0, 'two failed attempts so far');
  r.hold.tick();
  r.hold.tick();
  r.hold.tick();
  assert.equal(r.notices.length, 1, 'delivered once, then remembered for the episode');
  assert.equal(i, 3, 'no further attempt after a delivery');
});

// ── wiring: the shipped source reaches the surfaces ──────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(path.join(here, p), 'utf8');
const live = (src: string, needle: string): boolean => src.split('\n').some((l) => l.includes(needle) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));

test('wiring: host subscribes to the guard samples BEFORE it publishes, and the app starts/stops it', () => {
  const host = read('docker-hold-host.ts');
  assert.ok(host.indexOf('subscribeMemoryGuardSamples(') > 0 && host.indexOf('subscribeMemoryGuardSamples(') < host.indexOf('h.publish(getMemoryGuardSnapshot())'), 'subscribe first, then reconcile');
  assert.ok(live(host, '    h.publish(snap);') && live(host, '    h.tick();'));
  assert.ok(live(host, '  hold?.stop();') && live(host, '  unsubscribe?.();'), 'stopping the app removes the state file and the subscription');
  const index = read('index.ts');
  assert.ok(live(index, '  startDockerHold();') && live(index, '  stopDockerHold();'));
  assert.ok(index.indexOf('startMemoryGuard();') < index.indexOf('startDockerHold();'), 'after the guard exists');
});

test('wiring: /busStatus carries dockerHolds and the CLI prints the line only through formatDockerHoldsLine', () => {
  assert.ok(live(read('hooks-server.ts'), 'dockerHolds: listDockerHolds().map('));
  const cli = readFileSync(path.join(here, '..', 'cli', 'index.ts'), 'utf8');
  assert.ok(live(cli, 'formatDockerHoldsLine(res.dockerHolds as DockerHoldView[], Date.now())'));
  assert.ok(live(cli, '        if (dh) process.stdout.write(`${dh}\\n`);'), 'nothing waiting prints no line at all');
});

test('wiring: the keeper-client sweeps the hold file with the other per-keeper sidecars (both sites)', () => {
  const kc = read('keeper-client.ts');
  assert.equal(kc.match(/relayHoldFile\(keeperSocketPath\(wsId\)\)/g)?.length, 2);
});

// #321 review M1 — the fleet-wide RELEASE SLOT: exclusive create, a dead or stuck holder's lease is taken over (no deadlock), an I/O failure fails OPEN, a keeper never removes a lease that is not its own.
// Each arm names the clause it protects (in-place mutants: scripts/docker-hold-mutants.list.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFleetLine, createReleaseLease, type LeaseIo } from './release-lease.ts';
import { admissionLeaseFile, leaseIsStale, parseLease, RELEASE_LEASE_TTL_MS } from '../shared/docker-hold.ts';

const FILE = '/h/admission.lease';

/** A fake directory shared by every keeper of a test (the point: they all see the SAME files). */
class Fs {
  files = new Map<string, { text: string; at: number }>();
  clock = 1_000_000;
  dead = new Set<number>();
  failCreate: Error | null = null;
  /** Runs inside rename (the window between a taker's read and its move). */
  onRename: (() => void) | null = null;
  io(): LeaseIo {
    return {
      now: () => this.clock,
      createExclusive: (f, text) => {
        if (this.failCreate) throw this.failCreate;
        if (this.files.has(f)) return false;
        this.files.set(f, { text, at: this.clock });
        return true;
      },
      readText: (f) => this.files.get(f)?.text ?? null,
      ageMs: (f) => (this.files.has(f) ? this.clock - this.files.get(f)!.at : null),
      rename: (a, b) => {
        this.onRename?.();
        const x = this.files.get(a);
        if (!x) throw new Error('ENOENT');
        this.files.delete(a);
        this.files.set(b, x);
      },
      remove: (f) => void this.files.delete(f),
      pidAlive: (pid) => !this.dead.has(pid),
      listDir: (d) => [...this.files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)).filter((n) => !n.includes('/')),
    };
  }
  lease(owner: string, pid: number, logs: string[] = []) {
    return createReleaseLease({ file: FILE, owner, pid, io: this.io(), log: (m) => logs.push(m) });
  }
}

test('exclusive: the first keeper takes the slot, a second one is told it is busy, and the slot is free again once the holder gives it back', () => {
  const fs = new Fs();
  const a = fs.lease('wsA', 100);
  const b = fs.lease('wsB', 200);
  assert.equal(a.tryAcquire(), true);
  assert.equal(b.tryAcquire(), false, 'ONE release at a time for the whole fleet');
  assert.deepEqual(parseLease(fs.files.get(FILE)!.text)?.owner, 'wsA');
  a.release();
  assert.equal(fs.files.has(FILE), false);
  assert.equal(b.tryAcquire(), true);
});

test('release is a no-op when the slot was never taken, and NEVER removes a lease another keeper holds now', () => {
  const fs = new Fs();
  const a = fs.lease('wsA', 100);
  const b = fs.lease('wsB', 200);
  a.release(); // never held
  assert.equal(b.tryAcquire(), true);
  a.release(); // still never held: b's lease untouched
  assert.equal(fs.files.has(FILE), true);
  // a holder whose lease was taken over (stuck past the TTL) must not delete its successor's
  const c = fs.lease('wsC', 300);
  fs.clock += RELEASE_LEASE_TTL_MS + 1;
  assert.equal(c.tryAcquire(), true, 'takes over the stuck b');
  b.release();
  assert.equal(parseLease(fs.files.get(FILE)!.text)?.owner, 'wsC', 'b (taken over) did not remove c\'s lease');
});

test('a DEAD holder never wedges the fleet: its lease is taken over at once (pid gone), logged', () => {
  const fs = new Fs();
  const logs: string[] = [];
  const a = fs.lease('wsA', 100);
  const b = fs.lease('wsB', 200, logs);
  assert.equal(a.tryAcquire(), true);
  assert.equal(b.tryAcquire(), false, 'alive: busy');
  fs.dead.add(100); // SIGKILL
  assert.equal(b.tryAcquire(), true);
  assert.equal(parseLease(fs.files.get(FILE)!.text)?.owner, 'wsB');
  assert.ok(logs.some((l) => /took over a stale release slot \(wsA, pid 100\)/.test(l)), logs.join('|'));
  assert.equal([...fs.files.keys()].some((k) => k.endsWith('.stale')), false, 'no tombstone left');
});

test('a STUCK (alive) holder is presumed gone after the TTL — and not a moment before', () => {
  const fs = new Fs();
  const a = fs.lease('wsA', 100);
  const b = fs.lease('wsB', 200);
  assert.equal(a.tryAcquire(), true);
  fs.clock += RELEASE_LEASE_TTL_MS;
  assert.equal(b.tryAcquire(), false, 'exactly the TTL: still held');
  fs.clock += 1;
  assert.equal(b.tryAcquire(), true);
});

test('an unparsable lease (a writer between its create and its write) is judged by the file age, not taken over at once', () => {
  const fs = new Fs();
  fs.files.set(FILE, { text: '', at: fs.clock });
  const b = fs.lease('wsB', 200);
  assert.equal(b.tryAcquire(), false, 'fresh, empty: someone is writing it');
  fs.clock += RELEASE_LEASE_TTL_MS + 1;
  assert.equal(b.tryAcquire(), true, 'old and empty: a dead writer\'s leftover');
});

test('two keepers racing on ONE stale lease: the second one finds the first one\'s FRESH lease where it expected the stale one, puts it back and reports busy', () => {
  const fs = new Fs();
  const dead = fs.lease('wsDead', 100);
  dead.tryAcquire();
  fs.dead.add(100);
  const a = fs.lease('wsA', 200);
  const b = fs.lease('wsB', 300);
  // b reads the stale lease, then — inside its rename window — a completes a whole takeover
  fs.onRename = () => {
    fs.onRename = null;
    assert.equal(a.tryAcquire(), true);
  };
  assert.equal(b.tryAcquire(), false);
  assert.equal(parseLease(fs.files.get(FILE)!.text)?.owner, 'wsA', 'a\'s lease survived b\'s clumsy move');
  assert.equal([...fs.files.keys()].some((k) => k.endsWith('.stale')), false);
});

test('fail OPEN: a lease directory that cannot be written (no dir, no permission) lets the line go on without the slot — logged ONCE, never stranding a member', () => {
  const fs = new Fs();
  fs.failCreate = Object.assign(new Error('ENOENT: no such directory'), { code: 'ENOENT' });
  const logs: string[] = [];
  const a = fs.lease('wsA', 100, logs);
  assert.equal(a.tryAcquire(), true);
  assert.equal(a.tryAcquire(), true);
  assert.equal(logs.filter((l) => /release slot .* unavailable/.test(l)).length, 1);
  a.release(); // nothing was held: no throw
});

test('the lease file sits beside the state file; the staleness rule: dead pid / past TTL / a lease from the far future', () => {
  assert.equal(admissionLeaseFile('/home/u/.orchestra/admission.state'), '/home/u/.orchestra/admission.lease');
  assert.equal(admissionLeaseFile('/x/state-file'), '/x/state-file.lease');
  const l = { v: 1 as const, owner: 'a', pid: 5, ts: 1000 };
  const alive = (): boolean => true;
  assert.equal(leaseIsStale(l, 0, 1000 + RELEASE_LEASE_TTL_MS, alive), false);
  assert.equal(leaseIsStale(l, 0, 1000 + RELEASE_LEASE_TTL_MS + 1, alive), true);
  assert.equal(leaseIsStale(l, 0, 1000, () => false), true, 'dead pid');
  assert.equal(leaseIsStale({ ...l, ts: 1000 + RELEASE_LEASE_TTL_MS * 3 }, 0, 1000, alive), true, 'a clock step must not wedge the slot');
  assert.equal(leaseIsStale(null, RELEASE_LEASE_TTL_MS, 0, alive), false);
  assert.equal(leaseIsStale(null, RELEASE_LEASE_TTL_MS + 1, 0, alive), true);
  assert.equal(parseLease('not json'), null);
  assert.equal(parseLease(JSON.stringify({ v: 2, owner: 'a', pid: 1, ts: 1 })), null);
});

// ── the fleet\'s line (round 2): who else waits, who is older ───────────────────────────────────────────────────────

const DIR = '/h/keepers';
const holdFile = (since: number, ts: number): string => JSON.stringify({ v: 1, ts, create: 1, start: 0, since, heldSince: null, episode: 1, reason: 'r' });

test('fleet line: another keeper\'s LIVE hold file makes the line busy and — if it began before ours — older; our own file, a dead keeper\'s leftover (past the TTL) and a file that is not a hold are ignored', () => {
  const fs = new Fs();
  const line = createFleetLine({ ownHoldFile: `${DIR}/wsA.docker.hold`, ownWs: 'wsA', pid: 100, leaseFile: FILE, io: fs.io() });
  assert.equal(line.busy(), false);
  assert.equal(line.olderWaiter(5_000), false);
  fs.files.set(`${DIR}/wsA.docker.hold`, { text: holdFile(1_000, fs.clock), at: fs.clock }); // our own
  fs.files.set(`${DIR}/wsC.docker.sock`, { text: 'x', at: fs.clock });
  fs.files.set(`${DIR}/wsD.docker.hold`, { text: 'not json', at: fs.clock });
  fs.files.set(`${DIR}/wsE.docker.hold`, { text: holdFile(1_000, fs.clock - 31_000), at: fs.clock }); // a dead keeper\'s leftover
  assert.equal(line.busy(), false);
  fs.files.set(`${DIR}/wsB.docker.hold`, { text: holdFile(2_000, fs.clock), at: fs.clock });
  assert.equal(line.busy(), true);
  assert.equal(line.olderWaiter(3_000), true, 'wsB began waiting at 2 000 < 3 000');
  assert.equal(line.olderWaiter(2_000), false, 'a tie: broken by workspace id — wsB > wsA, so wsA goes first');
  assert.equal(line.olderWaiter(1_500), false);
  const lineB = createFleetLine({ ownHoldFile: `${DIR}/wsZ.docker.hold`, ownWs: 'wsZ', pid: 101, leaseFile: FILE, io: fs.io() });
  assert.equal(lineB.olderWaiter(2_000), true, 'for wsZ the same tie goes to wsB');
});

test('fleet line: a slot held by ANOTHER live keeper makes the line busy; our own slot, a dead holder\'s and a stuck one\'s do not', () => {
  const fs = new Fs();
  const line = createFleetLine({ ownHoldFile: `${DIR}/wsA.docker.hold`, ownWs: 'wsA', pid: 100, leaseFile: FILE, io: fs.io() });
  const mine = fs.lease('wsA', 100);
  mine.tryAcquire();
  assert.equal(line.busy(), false, 'our own slot is not « another keeper in motion »');
  mine.release();
  const other = fs.lease('wsB', 200);
  other.tryAcquire();
  assert.equal(line.busy(), true);
  fs.dead.add(200);
  assert.equal(line.busy(), false, 'a dead holder');
  fs.dead.delete(200);
  fs.clock += RELEASE_LEASE_TTL_MS + 1;
  assert.equal(line.busy(), false, 'a stuck holder');
});

test('fleet line: a directory that cannot be listed fails OPEN (no ordering, no queueing behind a line we cannot see)', () => {
  const fs = new Fs();
  const io = fs.io();
  io.listDir = () => { throw new Error('EACCES'); };
  const line = createFleetLine({ ownHoldFile: `${DIR}/wsA.docker.hold`, ownWs: 'wsA', pid: 100, leaseFile: FILE, io });
  assert.equal(line.busy(), false);
  assert.equal(line.olderWaiter(9_999), false);
});

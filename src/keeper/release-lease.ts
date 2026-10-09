// The fleet-wide RELEASE SLOT of the Docker hold (#321 review M1). Admission is ONE line for the whole fleet; each keeper's relay has its own line, so the lines share this slot: a lease FILE beside the app's
// state file, taken with an exclusive create (`wx`). The holder does the fresh MemAvailable reading, releases ONE call and spends the settle before releasing the slot — whichever keeper takes it next
// then reads a MemAvailable that already shows the container just started.
//
// No deadlock: a holder that dies (SIGKILL) is told apart by its pid — the next taker removes its lease at once; a holder alive but stuck is presumed gone after the TTL. A lease I/O failure other than
// « already exists » (no directory, no permission) fails OPEN: the line goes on without the slot (logged once) — a missing arbiter must never strand a member. Electron-free, every effect injected.

import { holdIsLive, leaseIsStale, parseHoldFile, parseLease, RELEASE_LEASE_TTL_MS } from '../shared/docker-hold.ts';

export interface LeaseIo {
  now(): number;
  /** Create `file` with `text` only if it does not exist: true = created, false = it exists; any other failure THROWS. */
  createExclusive(file: string, text: string): boolean;
  readText(file: string): string | null;
  /** The file's age in ms (now − mtime); null = gone. */
  ageMs(file: string): number | null;
  rename(from: string, to: string): void;
  remove(file: string): void;
  pidAlive(pid: number): boolean;
  /** Names in `dir` (the keepers dir, where every keeper publishes its `<ws>.docker.hold`); a failure THROWS. */
  listDir(dir: string): string[];
}

/** What the gate asks of the slot. */
export interface HoldLease {
  /** Take the fleet's single release slot; false = another keeper holds it. */
  tryAcquire(): boolean;
  /** Give it back (a no-op when not held — and never removes a lease another keeper holds now). */
  release(): void;
}

export interface ReleaseLeaseOptions {
  file: string;
  owner: string;
  pid: number;
  io: LeaseIo;
  ttlMs?: number;
  log(msg: string): void;
}

export function createReleaseLease(o: ReleaseLeaseOptions): HoldLease {
  const ttl = o.ttlMs ?? RELEASE_LEASE_TTL_MS;
  let held = false;
  let warned = false;
  const mine = (text: string | null): boolean => {
    const l = parseLease(text);
    return !!l && l.pid === o.pid && l.owner === o.owner;
  };
  const failOpen = (e: unknown): boolean => {
    if (!warned) o.log(`docker hold: release slot ${o.file} unavailable (${e instanceof Error ? e.message : String(e)}) — releasing without the fleet-wide slot`);
    warned = true;
    return true; // fail open: no arbiter ⇒ the line goes on (held stays false: nothing to give back)
  };
  return {
    tryAcquire(): boolean {
      const text = JSON.stringify({ v: 1, owner: o.owner, pid: o.pid, ts: o.io.now() });
      try {
        if (o.io.createExclusive(o.file, text)) {
          held = true;
          return true;
        }
        const seen = o.io.readText(o.file);
        const age = o.io.ageMs(o.file);
        if (age === null) return false; // released between our create and our read: the next poll takes it
        if (!leaseIsStale(parseLease(seen), age, o.io.now(), o.io.pidAlive, ttl)) return false;
        // Take over a dead / stuck holder's lease. The stale file is moved to a name only we use and its content compared to what we judged: if another taker got there first, what we moved is THEIR
        // fresh lease — put it back and report busy. (Two takers racing on one stale lease can, in a microsecond window, both win once; the cost is one extra simultaneous release, never a wedge.)
        const tomb = `${o.file}.${o.pid}.stale`;
        try {
          o.io.rename(o.file, tomb);
        } catch {
          return false; // someone else took it over
        }
        const moved = o.io.readText(tomb);
        if (moved !== seen) {
          try {
            if (moved !== null) o.io.createExclusive(o.file, moved); // false = a newer lease already exists: ours is the one to drop
          } catch {
            /* best effort */
          }
          try {
            o.io.remove(tomb);
          } catch {
            /* best effort */
          }
          return false;
        }
        o.io.remove(tomb);
        o.log(`docker hold: took over a stale release slot (${(parseLease(seen)?.owner ?? 'unknown owner')}, pid ${parseLease(seen)?.pid ?? '?'})`);
        if (o.io.createExclusive(o.file, text)) {
          held = true;
          return true;
        }
        return false;
      } catch (e) {
        return failOpen(e);
      }
    },
    release(): void {
      if (!held) return;
      held = false;
      try {
        if (mine(o.io.readText(o.file))) o.io.remove(o.file);
      } catch {
        /* gone, or unreadable: the TTL / the pid check clears it */
      }
    },
  };
}

/** What the gate asks about the OTHER keepers' lines (review round 2: fairness + newcomers). */
export interface FleetLine {
  /** Is the fleet's line in motion — another keeper has calls waiting, or holds the release slot (a release just happened and is settling)? A newcomer then joins the line instead of passing. */
  busy(): boolean;
  /** Does another keeper have a call that began waiting BEFORE `since` (ties broken by workspace id)? Then it goes first: the fleet's line is oldest-first, and a keeper draining a long line cannot starve an older call elsewhere. */
  olderWaiter(since: number): boolean;
}

export interface FleetLineOptions {
  /** THIS keeper's own hold file (`<keepers>/<ws>.docker.hold`): its directory is where every keeper's file lives, its name is what identifies us (never a workspace id guessed from elsewhere). */
  ownHoldFile: string;
  /** The keeper's workspace id (the owner written in the lease). */
  ownWs: string;
  pid: number;
  leaseFile: string;
  io: LeaseIo;
  ttlMs?: number;
}

const HOLD_SUFFIX = '.docker.hold';

export function createFleetLine(o: FleetLineOptions): FleetLine {
  const ttl = o.ttlMs ?? RELEASE_LEASE_TTL_MS;
  const slash = o.ownHoldFile.lastIndexOf('/');
  const holdDir = slash >= 0 ? o.ownHoldFile.slice(0, slash) : '.';
  const ownName = o.ownHoldFile.slice(slash + 1);
  const ownId = ownName.endsWith(HOLD_SUFFIX) ? ownName.slice(0, -HOLD_SUFFIX.length) : ownName;
  /** The OTHER keepers' LIVE lines (a dead keeper's leftover file ages out: `holdIsLive`). */
  const waiters = (): Array<{ ws: string; since: number }> => {
    let names: string[];
    try {
      names = o.io.listDir(holdDir);
    } catch {
      return []; // cannot look: fail open (no ordering, no queueing behind a line we cannot see)
    }
    const now = o.io.now();
    const out: Array<{ ws: string; since: number }> = [];
    for (const n of names) {
      if (!n.endsWith(HOLD_SUFFIX)) continue;
      const ws = n.slice(0, -HOLD_SUFFIX.length);
      if (n === ownName) continue;
      const h = parseHoldFile(o.io.readText(`${holdDir}/${n}`));
      if (h && holdIsLive(h, now)) out.push({ ws, since: h.since });
    }
    return out;
  };
  const slotHeldByOther = (): boolean => {
    const text = o.io.readText(o.leaseFile);
    if (text === null) return false;
    const l = parseLease(text);
    if (l && l.pid === o.pid && l.owner === o.ownWs) return false;
    return !leaseIsStale(l, o.io.ageMs(o.leaseFile) ?? 0, o.io.now(), o.io.pidAlive, ttl);
  };
  return {
    busy: () => waiters().length > 0 || slotHeldByOther(),
    olderWaiter: (since) => waiters().some((w) => w.since < since || (w.since === since && w.ws < ownId)),
  };
}

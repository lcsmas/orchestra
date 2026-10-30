import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIMITS, backendOfPrefix, classifyRow, computeVerdict, emptyStats, isFullyEncrypted, isFullyPlain, median, squash, statsOf,
  type Build, type DbStats, type Keyring, type Partition, type Rec, type Scope,
} from './cookie-fuse-verdict.ts';

// ── a synthetic clean world: 3 runs, every arm measured, nothing lost, no stall, no cost ──
const N = 25;
const st = (o: Partial<DbStats>): DbStats => ({ ...emptyStats(), ...o });
const PLAIN = st({ total: N, plain: N });
const ENC11 = st({ total: N, encrypted: N, v11: N });
type Mut = (r: Rec) => Rec | null | void;

function boot(run: number, branch: string, step: string, build: Build, keyring: Keyring, readyMs: number, o: { scope?: Scope; timing?: boolean; crashed?: boolean; hung?: boolean; keyringOk?: boolean; backend?: string | null; backendExpected?: string | null } = {}): Rec {
  return { kind: 'boot', run, branch, step, build, keyring, scope: o.scope ?? 'host', timing: o.timing ?? true, readyMs, crashed: o.crashed ?? false, hung: o.hung ?? false, keyringOk: o.keyringOk ?? true,
    backend: o.backend ?? 'x', backendExpected: o.backendExpected ?? o.backend ?? 'x' };
}
/** step → branch: W1 → W · A1/A2/D1/D2 → A · C2L/C2U → C2 · CL1 → CL · GL1 → GL */
const branchOf = (step: string): string => (/^W/.test(step) ? 'W' : /^(A1|A2|D1|D2)$/.test(step) ? 'A' : /^C2/.test(step) ? 'C2' : step.replace(/\d+$/, ''));
function jar(run: number, step: string, p: Partition, o: { phase?: 'pre' | 'post'; oldR?: number; newE?: number; newR?: number; login?: boolean } = {}): Rec {
  return { kind: 'jar', run, branch: branchOf(step), step, phase: o.phase ?? 'pre', partition: p, oldExpected: N, oldReadable: o.oldR ?? N, newExpected: o.newE ?? 0, newReadable: o.newR ?? o.newE ?? 0, loginKept: o.login ?? true };
}
function db(run: number, step: string, p: Partition, oldS: DbStats, newS: DbStats): Rec {
  return { kind: 'db', run, branch: branchOf(step), step, partition: p, old: oldS, new: newS };
}

function world(): Rec[] {
  const out: Rec[] = [{ kind: 'meta', fuseWire: { off: 'disabled', on: 'enabled', byteDiff: 1 } },
    { kind: 'control', name: 'instrument/reads-a-known-stall', ok: true }, { kind: 'control', name: 'oracle/reads-a-synthetic-sealed-row-as-sealed', ok: true }];
  for (const run of [1, 2, 3]) {
    for (const p of ['profile', 'login'] as Partition[]) {
      out.push(db(run, 'W1', p, PLAIN, emptyStats()));
      out.push(db(run, 'A1', p, PLAIN, ENC11)); // (a)(b): old rows stay plain, new rows encrypted
      out.push(jar(run, 'A1', p, { newE: 0 }), jar(run, 'A2', p, { newE: N }));
      out.push(jar(run, 'D1', p, { newE: N, newR: N }), jar(run, 'D2', p, { newE: N }));
      for (const b of ['CL1', 'CN1', 'CB1']) out.push(jar(run, b, p, {}), db(run, b, p, PLAIN, st({ total: N, encrypted: N, v10: N }))); // basic_text start: old rows stay plain, new rows v10
      out.push(jar(run, 'C2L', p, { newE: N }), jar(run, 'C2U', p, { newE: N }));
    }
    // timing: the ON boots and the OFF baselines of the three host states; locked has same-arm pairs (null control) in every run
    out.push(boot(run, 'S', 'S-locked-1', 'off', 'locked', 5000), boot(run, 'CL', 'CL1', 'on', 'locked', 5200), boot(run, 'S', 'S-locked-2', 'off', 'locked', 5300));
    out.push(boot(run, 'S', 'S-none-1', 'off', 'none', 5000), boot(run, 'CN', 'CN1', 'on', 'none', 5100));
    out.push(boot(run, 'S', 'S-basic-1', 'off', 'basic', 5000), boot(run, 'CB', 'CB1', 'on', 'basic', 5100));
    out.push(boot(run, 'A', 'A1', 'on', 'unlocked', 6000, { timing: false }), boot(run, 'A', 'D1', 'off', 'unlocked', 5000, { timing: false }), boot(run, 'A', 'D2', 'on', 'unlocked', 5000, { timing: false }));
    out.push(boot(run, 'C2', 'C2L', 'on', 'locked', 5000, { timing: false }), boot(run, 'C2', 'C2U', 'on', 'unlocked', 5000, { timing: false }));
  }
  return out;
}
const mutate = (recs: Rec[], f: Mut): Rec[] => recs.map((r) => { const c = structuredClone(r); const o = f(c); return o === null ? null : (o ?? c); }).filter((r): r is Rec => r !== null);
const verdict = (recs: Rec[]) => computeVerdict(recs);

test('clean world → GO, nothing fired, every control present', () => {
  const v = verdict(world());
  assert.equal(v.verdict, 'GO', v.reasons.join(' | '));
  assert.deepEqual([v.hard.H1.fired, v.hard.H2.fired, v.hard.H3.fired, v.hard.H4.fired], [false, false, false, false]);
  assert.deepEqual([v.go.a.fired, v.go.b.fired, v.go.c.fired, v.go.d.fired], [false, false, false, false]);
  assert.equal(v.controls.ok, true);
  assert.equal(v.scopes.all, 'GO');
  assert.equal(v.scopes.host, 'GO');
});

test('GO-WITH-COST: encrypted-under-unlocked cookies are unreadable at a locked start and come back after unlock', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && r.step === 'C2L') r.newReadable = 0; }));
  assert.equal(v.verdict, 'GO-WITH-COST');
  assert.equal(v.cost.signedOutUntilUnlock, true);
  assert.equal(v.cost.permanentLoss, false);
});

test('cost that does NOT recover after unlock is no cost: NO-GO (permanent loss), not GO-WITH-COST', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && (r.step === 'C2L' || r.step === 'C2U') && r.partition === 'login') r.newReadable = 0; }));
  assert.equal(v.verdict, 'NO-GO');
  assert.equal(v.cost.permanentLoss, true);
});

test('H1: a pre-existing cookie unreadable after the flip → HARD-NO-GO; so is a lost login', () => {
  const a = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && r.step === 'A1' && r.run === 2 && r.partition === 'profile') r.oldReadable = N - 1; }));
  assert.equal(a.verdict, 'HARD-NO-GO');
  assert.equal(a.hard.H1.fired, true);
  const b = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && r.step === 'A1' && r.run === 1 && r.partition === 'profile') r.loginKept = false; }));
  assert.equal(b.verdict, 'HARD-NO-GO');
  assert.match(b.hard.H1.why.join(), /login LOST/);
});

test('H2: stall over baseline + 10 s (median) → HARD-NO-GO', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'boot' && r.branch === 'CL') r.readyMs = 5150 + 10_001; }));
  assert.equal(v.verdict, 'HARD-NO-GO');
  assert.match(v.hard.H2.why.join(), /median stall/);
});

test('H2: the median holds but ONE run beyond 1.5× the limit → HARD-NO-GO', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'boot' && r.branch === 'CN' && r.run === 3) r.readyMs = 5000 + 16_000; }));
  assert.equal(v.verdict, 'HARD-NO-GO');
  assert.match(v.hard.H2.why.join(), /1\.5×/);
});

test('H2 is judged on the MEDIAN stall: 8 s / 12 s / 14 s over baseline (all under 15 s) → median 12 s > 10 s → HARD-NO-GO', () => {
  const stalls: Record<number, number> = { 1: 8000, 2: 12_000, 3: 14_000 };
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'boot' && r.branch === 'CL') r.readyMs = 5150 + stalls[r.run]; }));
  assert.equal(v.verdict, 'HARD-NO-GO');
  assert.match(v.hard.H2.why.join(), /median stall 12000 ms/);
});

test('H2: a stall just under both limits is not a stall', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'boot' && r.branch === 'CL') r.readyMs = 5150 + 9000; }));
  assert.equal(v.verdict, 'GO');
});

test('H2: a crash or a hang of an ON boot in a locked/absent state → HARD-NO-GO', () => {
  assert.equal(verdict(mutate(world(), (r) => { if (r.kind === 'boot' && r.branch === 'CB' && r.run === 2) r.crashed = true; })).hard.H2.fired, true);
  const hung = verdict(mutate(world(), (r) => { if (r.kind === 'boot' && r.branch === 'CL' && r.run === 1) r.hung = true; }));
  assert.equal(hung.verdict, 'HARD-NO-GO');
  assert.match(hung.hard.H2.why.join(), /hang/);
});

test('H2: a pre-existing plaintext cookie lost under a locked keyring → HARD-NO-GO', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && r.step === 'CL1' && r.partition === 'profile' && r.run === 1) r.oldReadable = 3; }));
  assert.equal(v.verdict, 'HARD-NO-GO');
  assert.equal(v.hard.H2.fired, true);
});

test('H3: a claude-login cookie lost in ANY fuse-ON step → HARD-NO-GO (here: the absent-keyring arm)', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && r.step === 'CN1' && r.partition === 'login' && r.run === 3) r.oldReadable = N - 1; }));
  assert.equal(v.verdict, 'HARD-NO-GO');
  assert.equal(v.hard.H3.fired, true);
  assert.match(v.hard.H3.why.join(), /claude-login/);
});

test('H3: a login lost in /whoami although every old cookie reads back → HARD-NO-GO', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && r.step === 'C2U' && r.partition === 'login' && r.run === 2) r.loginKept = false; }));
  assert.equal(v.hard.H3.fired, true);
  assert.equal(v.verdict, 'HARD-NO-GO');
});

test('UNVERIFIED: the restore control A2 — the snapshot restored in the state it was written in must read back whole, else D1/C2* losses prove nothing', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && r.step === 'A2' && r.run === 2 && r.partition === 'login') r.newReadable = N - 1; }));
  assert.equal(v.verdict, 'UNVERIFIED');
  assert.match(v.reasons.join(), /restore control A2/);
  assert.equal(verdict(mutate(world(), (r) => (r.kind === 'jar' && r.step === 'A2' ? null : undefined))).verdict, 'UNVERIFIED');
});

test('H2 also covers the keyring-less (C2N) and basic_text (C2B) starts after an unlocked one: a lost pre-existing cookie → HARD-NO-GO', () => {
  const extra = (step: string, lost: boolean): Rec[] => [1, 2, 3].flatMap((run) => (['profile', 'login'] as Partition[]).flatMap((p) => [jar(run, step, p, { oldR: lost && run === 2 ? N - 5 : N, newE: N }), jar(run, `${step}U`, p, { newE: N })]));
  assert.equal(verdict([...world(), ...extra('C2N', false), ...extra('C2B', false)]).verdict, 'GO');
  const n = verdict([...world(), ...extra('C2N', true)]);
  assert.equal(n.verdict, 'HARD-NO-GO');
  assert.match(n.hard.H2.why.join(), /C2N run 2/);
  assert.match(verdict([...world(), ...extra('C2B', true)]).hard.H2.why.join(), /C2B run 2/);
});

test('a keyring-less / basic_text start measured WITHOUT its unlocked follow-up cannot be judged recoverable → UNVERIFIED', () => {
  const only = [1, 2, 3].flatMap((run) => (['profile', 'login'] as Partition[]).map((p) => jar(run, 'C2N', p, { newE: N })));
  assert.equal(verdict([...world(), ...only]).verdict, 'UNVERIFIED');
});

test('GO-WITH-COST also comes from the keyring-less start: sealed cookies unreadable there, back after the unlocked follow-up', () => {
  const pair = [1, 2, 3].flatMap((run) => (['profile', 'login'] as Partition[]).flatMap((p) => [jar(run, 'C2N', p, { newE: N, newR: 0 }), jar(run, 'C2NU', p, { newE: N })]));
  assert.equal(verdict([...world(), ...pair]).verdict, 'GO-WITH-COST');
});

test('deletion AFTER the startup read is loss too: rows missing from the Cookies DB, or a post-write jar missing cookies, fire the clause (a start-only reader would say GO)', () => {
  // (c): the jar read at start is whole, the DB lost rows afterwards
  const dbLoss = verdict(mutate(world(), (r) => { if (r.kind === 'db' && r.step === 'CL1' && r.run === 2 && r.partition === 'profile') r.old = st({ total: 3, plain: 3 }); }));
  assert.equal(dbLoss.verdict, 'HARD-NO-GO');
  assert.match(dbLoss.hard.H2.why.join(), /rows left in the Cookies DB/);
  // (c): the post-write jar lost cookies the start read still had
  const postLoss = verdict([...world(), jar(2, 'CN1', 'login', { phase: 'post', oldR: 4 })]);
  assert.equal(postLoss.verdict, 'HARD-NO-GO');
  assert.match(postLoss.hard.H2.why.join(), /readable after the boot's own writes/);
  // (b): the flip itself deleted rows from disk while the start read was fine
  const bLoss = verdict(mutate(world(), (r) => { if (r.kind === 'db' && r.step === 'A1' && r.run === 1 && r.partition === 'login') r.old = st({ total: 0 }); }));
  assert.equal(bLoss.hard.H1.fired, true);
});

test('UNVERIFIED: the instrument controls (a known injected stall read by the timer, a synthetic sealed row read as sealed) are required, not optional', () => {
  assert.equal(verdict(world().filter((r) => !(r.kind === 'control' && r.name === 'instrument/reads-a-known-stall'))).verdict, 'UNVERIFIED');
  assert.equal(verdict(world().filter((r) => !(r.kind === 'control' && r.name === 'oracle/reads-a-synthetic-sealed-row-as-sealed'))).verdict, 'UNVERIFIED');
  assert.equal(verdict(mutate(world(), (r) => { if (r.kind === 'control' && r.name === 'instrument/reads-a-known-stall') r.ok = false; })).verdict, 'UNVERIFIED');
});

test('an aborted attempt still contributes a recorded crash / hang of a fuse-ON boot (H2 evidence), nothing else', () => {
  const v = verdict([...world(), { kind: 'runAborted', run: 8, reason: 'toolbar' }, boot(8, 'CL', 'CL1', 'on', 'locked', 150_000, { hung: true }), boot(8, 'S', 'S-locked-1', 'off', 'locked', 150_000)]);
  assert.equal(v.hard.H2.fired, true);
  assert.match(v.hard.H2.why.join(), /hang/);
});

test('H3 does NOT fire on the documented one-way of (d): the fuse-OFF step may not read the old rows', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && r.step === 'D1') { r.oldReadable = 0; r.newReadable = 0; } }));
  assert.equal(v.hard.H3.fired, false);
  assert.equal(v.verdict, 'GO');
  assert.equal(v.oneWay.fuseOffReadsEncrypted, false);
});

test('H3 DOES fire when the re-flip D2 does not bring a login partition back', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && r.step === 'D2' && r.partition === 'login') r.oldReadable = 0; }));
  assert.equal(v.hard.H3.fired, true);
  assert.equal(v.verdict, 'HARD-NO-GO');
});

test('H4: the fuse wire of the two builds does not read back as disabled / enabled → HARD-NO-GO', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'meta') r.fuseWire.on = 'disabled'; }));
  assert.equal(v.verdict, 'HARD-NO-GO');
  assert.equal(v.hard.H4.fired, true);
});

test('(a) fails without any H clause → NO-GO (the flip does not encrypt)', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'db' && r.step === 'A1') r.new = st({ total: N, plain: N }); }));
  assert.equal(v.verdict, 'NO-GO');
  assert.equal(v.go.a.fired, true);
  assert.deepEqual([v.hard.H1.fired, v.hard.H2.fired, v.hard.H3.fired], [false, false, false]);
});

test('(a) needs ALL new cookies encrypted: 19 of 20 is a failure, 20 of 20 passes', () => {
  assert.equal(isFullyEncrypted(st({ total: 20, encrypted: 20 })), true);
  assert.equal(isFullyEncrypted(st({ total: 20, encrypted: 19, plain: 1 })), false);
  assert.equal(isFullyEncrypted(st({ total: 19, encrypted: 19 })), false);
  assert.equal(isFullyEncrypted(st({ total: 21, encrypted: 20, both: 1 })), false);
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'db' && r.step === 'A1' && r.run === 3 && r.partition === 'login') r.new = st({ total: N, encrypted: N - 1, plain: 1 }); }));
  assert.equal(v.go.a.fired, true);
});

test('UNVERIFIED: the positive control missing — the fuse-OFF build read as encrypted (an oracle stuck on GREEN)', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'db' && r.step === 'W1' && r.run === 1 && r.partition === 'profile') r.old = ENC11; }));
  assert.equal(v.verdict, 'UNVERIFIED');
  assert.match(v.reasons.join(), /positive control/);
});

test('UNVERIFIED: no positive-control rows at all (never a GO without the control)', () => {
  const v = verdict(mutate(world(), (r) => (r.kind === 'db' && r.step === 'W1' ? null : undefined)));
  assert.equal(v.verdict, 'UNVERIFIED');
});

test('UNVERIFIED: the null control — the same arm twice differs by more than 25 % of the 10 s limit', () => {
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'boot' && r.step === 'S-locked-2') r.readyMs += 2_501; }));
  assert.equal(v.verdict, 'UNVERIFIED');
  assert.match(v.reasons.join(), /null control/);
});

test('UNVERIFIED: fewer than 3 runs, fewer than 20 cookies, copies differing by more than the fuse byte', () => {
  assert.equal(verdict(world().filter((r) => r.kind === 'meta' || !('run' in r) || r.run !== 3)).verdict, 'UNVERIFIED');
  assert.equal(verdict(mutate(world(), (r) => { if (r.kind === 'db' && r.step === 'A1' && r.run === 1) r.new = st({ total: 19, encrypted: 19 }); })).verdict, 'UNVERIFIED');
  assert.equal(verdict(mutate(world(), (r) => { if (r.kind === 'meta') r.fuseWire.byteDiff = 2; })).verdict, 'UNVERIFIED');
});

test('UNVERIFIED: the private keyring was not in the state the arm claims, or Chromium picked another backend', () => {
  assert.equal(verdict(mutate(world(), (r) => { if (r.kind === 'boot' && r.step === 'CL1' && r.run === 1) r.keyringOk = false; })).verdict, 'UNVERIFIED');
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'boot' && r.step === 'CL1' && r.run === 1) { r.backend = 'gnome_libsecret'; r.backendExpected = 'basic_text'; } }));
  assert.equal(v.verdict, 'UNVERIFIED');
  assert.match(v.reasons.join(), /did not test the state it claims/);
});

test('UNVERIFIED: a red control record, an absent stall baseline, an absent required host state, an unmeasured (d)', () => {
  assert.equal(verdict([...world(), { kind: 'control', name: 'forged/real-xdg-is-refused', ok: false, detail: 'rc 0' }]).verdict, 'UNVERIFIED');
  assert.equal(verdict(mutate(world(), (r) => (r.kind === 'boot' && r.build === 'off' && r.keyring === 'none' ? null : undefined))).verdict, 'UNVERIFIED');
  assert.equal(verdict(mutate(world(), (r) => (r.kind !== 'meta' && r.kind !== 'control' && r.branch === 'CB' ? null : r.kind === 'boot' && r.branch === 'CB' ? null : undefined))).verdict, 'UNVERIFIED');
  assert.equal(verdict(mutate(world(), (r) => ((r.kind === 'jar' && (r.step === 'D1' || r.step === 'D2')) || (r.kind === 'boot' && r.step === 'D1') ? null : undefined))).verdict, 'UNVERIFIED');
});

test('scopes: a stall that only a recognised desktop (GNOME, libsecret) shows is HARD-NO-GO over all scopes and GO on the host scope', () => {
  const extra: Rec[] = [];
  for (const run of [1, 2, 3]) {
    extra.push(boot(run, 'S', 'S-gnome-locked-1', 'off', 'locked', 5000, { scope: 'recognised-desktop' }), boot(run, 'GL', 'GL1', 'on', 'locked', 120_000, { scope: 'recognised-desktop', hung: true }));
    for (const p of ['profile', 'login'] as Partition[]) extra.push(jar(run, 'GL1', p, {}));
  }
  const v = verdict([...world(), ...extra]);
  assert.equal(v.scopes.all, 'HARD-NO-GO');
  assert.equal(v.scopes.host, 'GO');
  assert.equal(v.verdict, 'HARD-NO-GO');
  assert.match(v.hard.H2.why.join(), /recognised-desktop\/locked/);
});

// ── the oracle's building blocks ──
test('classifyRow / statsOf: the four row classes and the os_crypt prefixes', () => {
  assert.equal(classifyRow('abc', 0), 'plain');
  assert.equal(classifyRow('', 31), 'encrypted');
  assert.equal(classifyRow('abc', 31), 'both');
  assert.equal(classifyRow('', 0), 'empty');
  assert.equal(backendOfPrefix('763130'), 'v10');
  assert.equal(backendOfPrefix('763131'), 'v11');
  assert.equal(backendOfPrefix('000000'), 'other');
  const s = statsOf([{ value: '', encLen: 40, prefix: '763131' }, { value: '', encLen: 40, prefix: '763130' }, { value: 'x', encLen: 0, prefix: '' }, { value: '', encLen: 0, prefix: '' }, { value: 'y', encLen: 9, prefix: '763131' }]);
  assert.deepEqual(s, { total: 5, plain: 1, encrypted: 2, both: 1, empty: 1, v10: 1, v11: 2, other: 0 });
  assert.equal(isFullyPlain(PLAIN), true);
  assert.equal(isFullyPlain(ENC11), false);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('squash: the same finding from several runs is one line naming the runs', () => {
  assert.deepEqual(squash(['run 1 profile: 0/26 lost', 'run 2 profile: 0/26 lost', 'run 3 login: 0/25 lost', 'no runs here']), ['runs 1,2 profile: 0/26 lost', 'run 3 login: 0/25 lost', 'no runs here']);
  const v = verdict(mutate(world(), (r) => { if (r.kind === 'jar' && r.step === 'CL1' && r.partition === 'profile') r.oldReadable = 0; }));
  assert.equal(v.hard.H2.why.filter((w) => /profile/.test(w)).length, 1, v.hard.H2.why.join(' | '));
  assert.match(v.hard.H2.why.join(), /runs 1,2,3/);
});

test('diagnostic branches (X, Y) explain a verdict, they never make one: a lost login in X1 does not fire H3', () => {
  const extra: Rec[] = [1, 2, 3].map((run) => jar(run, 'X1', 'login', { oldR: 0, login: false }));
  const v = verdict([...world(), ...extra]);
  assert.equal(v.hard.H3.fired, false);
  assert.equal(v.verdict, 'GO');
});

test('an ABORTED attempt (infrastructure) is no data point: its partial records are ignored, its count and reason are reported', () => {
  const partial: Rec[] = [{ kind: 'runAborted', run: 9, reason: 'timeout 90000ms waiting for the toolbar' }, db(9, 'W1', 'profile', ENC11, emptyStats()), jar(9, 'A1', 'profile', { oldR: 0, login: false }), { kind: 'control', name: 'run/9/completed', ok: false, detail: 'x', run: 9 }];
  const v = verdict([...world(), ...partial]);
  assert.equal(v.verdict, 'GO');
  assert.equal(v.numbers.abortedRuns, 1);
  assert.match(String((v.numbers.abortReasons as string[])[0]), /toolbar/);
  // …and the same partial records WITHOUT the abort marker are evidence (a lost login in a run that finished is H1)
  assert.equal(verdict([...world(), ...partial.slice(1)]).verdict !== 'GO', true);
});

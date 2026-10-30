// #406 — every branch of the mechanical go/no-go (src/shared/hidden-view-cost.ts) on a synthetic world. The generator builds the
// full matrix (arms interleaved with alternating order, 5 reps) with a configurable A1−A0 cost per page/metric, so each test
// states WHICH limit it breaks and the verdict must follow. A branch that cannot turn red here is not covered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict, computeChecks, isValid, linearFit, median, readControls, readMethod, LIMITS } from './hidden-view-cost.ts';
import type { CostArm, CostPage, CostRun } from './hidden-view-cost.ts';

const MB = 1e6;
type Fn = (n: number) => number;
interface World {
  rss?: Partial<Record<CostPage, Fn>>; // A1 − A0, bytes
  gpu?: Partial<Record<CostPage, Fn>>; // bytes
  cpu?: Partial<Record<CostPage, Fn>>; // % of a core
  frames?: Fn; // idle frames A1 − A0
  ns?: number[];
  skip160?: CostPage[]; // pages that were NOT measured at N=160 (projected only: they did not fit above the 8 GB floor)
  reps?: number;
  noPositive?: boolean; noNull?: boolean; nullNoise?: number; noCrashCtl?: boolean; noAbortCtl?: boolean; noGpuCtl?: boolean;
  a2?: Partial<Record<CostPage, Fn>>; // cpu cost of A2 over A0 (set 'a2', busy N=40/160)
  a2Drift?: number; // host drift between the main stage and the a2 stage: extra CPU % on EVERY a2-set run (A0 and A2 alike)
  nullNoiseOnly40?: number; // extra RSS noise on the A0b runs of the N=40 null cell ONLY
  crash?: (r: { arm: CostArm; page: CostPage; n: number }) => number;
  mutate?: (r: CostRun) => void;
}
const JIT = [-2, -1, 0, 1, 2]; // medians stay exact; the spread feeds the single-run rule

function world(o: World = {}): CostRun[] {
  const runs: CostRun[] = [];
  let seq = 0;
  const ns = o.ns ?? [1, 8, 40];
  const reps = o.reps ?? 5;
  const zero: Fn = () => 0;
  const mk = (arm: CostArm, page: CostPage, n: number, rep: number, set = 'main'): CostRun => {
    const isA1 = arm === 'A1' || arm === 'A2';
    const dRss = isA1 ? (o.rss?.[page] ?? zero)(n) : arm === 'A1x' ? 100 * MB : 0;
    const dGpu = isA1 ? (o.gpu?.[page] ?? zero)(n) : 0;
    const dCpu = arm === 'A2' ? (o.a2?.[page] ?? zero)(n) : isA1 ? (o.cpu?.[page] ?? zero)(n) : 0;
    const dFr = arm === 'A1' ? (o.frames ?? zero)(n) : 0;
    const noise = arm === 'A0b' ? (o.nullNoise ?? 0) + (n === 40 ? (o.nullNoiseOnly40 ?? 0) : 0) : 0;
    const j = JIT[rep % 5]!;
    return {
      kind: 'cell', set, arm, page, n, rep, seq, t: new Date(Date.UTC(2026, 9, 30, 12, 0, 0) + seq++ * 120_000).toISOString(), windowS: 60, settleS: 30, cpuWindowS: 60.1, distinctRenderers: n + 1, stateOk: true, treeMissing: 0, livenessFail: 0, framesCanary: 40,
      rssKB: (1_500_000 + n * 60_000 + (dRss + noise) / 1024 + j * 100) , gpuRssKB: 200_000 + n * 500 + (dGpu + noise) / 1024, cpuPct: 3 + n * 0.05 + dCpu + (arm === 'A0b' ? (o.nullNoise ?? 0) / MB : 0) + (set === 'a2' ? (o.a2Drift ?? 0) : 0) + j * 0.01,
      crashes: o.crash?.({ arm, page, n }) ?? 0, contextLost: 0, idleFrames: 3 + dFr, aborted: null,
    };
  };
  const rot = <T>(a: T[], k: number): T[] => [...a.slice(k % a.length), ...a.slice(0, k % a.length)];
  for (let rep = 0; rep < reps; rep++) for (const n of ns) for (const page of ['idle', 'busy', 'heavy'] as CostPage[]) {
    if (n === 160 && o.skip160?.includes(page)) continue;
    const arms: CostArm[] = ['A0', 'A1'];
    if (page === 'idle' && n === 8 && !o.noPositive) arms.push('A1x');
    if (page === 'idle' && (n === 8 || n === 40) && !o.noNull) arms.push('A0b');
    for (const arm of rot(arms, rep)) runs.push(mk(arm, page, n, rep));
  }
  if (o.a2) for (let rep = 0; rep < 5; rep++) for (const n of ns.filter((x) => x >= 40)) for (const arm of rot<CostArm>(['A0', 'A2'], rep)) for (const page of ['idle', 'busy'] as CostPage[]) runs.push(mk(arm, page, n, rep, 'a2'));
  if (!o.noCrashCtl) runs.push({ ...mk('A1', 'idle', 8, 0), kind: 'control-crash', crashes: 1 });
  if (!o.noGpuCtl) runs.push({ ...mk('A1', 'idle', 8, 0), kind: 'control-gpu-crash', crashes: 1, contextLost: 2 });
  if (!o.noAbortCtl) runs.push({ ...mk('A1', 'idle', 8, 0), kind: 'control-abort', aborted: 'memavail' });
  if (o.mutate) runs.forEach(o.mutate);
  return runs;
}
const ok = { rss: { idle: (n: number) => n * 3 * MB, heavy: (n: number) => n * 8 * MB }, cpu: { busy: (n: number) => n * 0.05, idle: (n: number) => n * 0.003 }, gpu: { idle: () => 20 * MB, busy: () => 20 * MB, heavy: () => 40 * MB } };
const failing = (v: ReturnType<typeof computeVerdict>) => v.checks.filter((c) => !c.ok).map((c) => `${c.id}/${c.page}/${c.n}`);

test('GO: every limit holds at N=160, measured', () => {
  const v = computeVerdict(world({ ...ok, ns: [1, 8, 40, 160] }));
  assert.deepEqual(failing(v), []);
  assert.equal(v.verdict, 'GO');
  assert.equal(v.policy, 'A1');
  assert.ok(v.checks.filter((c) => c.n === 160).every((c) => c.basis === 'measured'));
  assert.ok([...v.controls, ...v.method].every((c) => c.ok), JSON.stringify([...v.controls, ...v.method]));
});

test('N=160 measured for idle+busy, PROJECTED for heavy (did not fit above the floor): no phantom "no run" crash check, heavy rows projected', () => {
  const v = computeVerdict(world({ ...ok, ns: [1, 8, 40, 160], skip160: ['heavy'] }));
  assert.deepEqual(failing(v), []);
  assert.equal(v.verdict, 'GO');
  assert.equal(v.checks.find((c) => c.id === 'M2' && c.n === 160)!.basis, 'projected');
  assert.equal(v.checks.find((c) => c.id === 'M1' && c.n === 160)!.basis, 'measured');
  assert.ok(!v.checks.some((c) => c.id === 'G1-crash' && c.page === 'heavy' && c.n === 160));
});

test('GO may rest on a PROJECTED N=160 row when N=40 was measured (R² ≥ 0.98)', () => {
  const v = computeVerdict(world(ok));
  assert.equal(v.verdict, 'GO');
  const m1 = v.checks.find((c) => c.id === 'M1' && c.n === 160)!;
  assert.equal(m1.basis, 'projected');
  assert.ok(m1.r2! >= 0.98);
  assert.ok(Math.abs(m1.delta! - 160 * 3 * MB) < 1 * MB, `projected ${m1.delta}`); // the fit recovers the per-view slope
});

test('PARTIAL: all hold at N=40, the projected N=160 breaks M1 → cap 40', () => {
  const v = computeVerdict(world({ ...ok, rss: { ...ok.rss, idle: (n) => -100 * MB + n * 8.7 * MB } })); // 40: 248 MB ok, 160: 1292 MB over 1.0 GB
  assert.deepEqual(failing(v), ['M1/idle/160']);
  assert.equal(v.verdict, 'PARTIAL');
  assert.equal(v.cap, 40);
  assert.equal(v.unverified, false); // a limit READ to fail, not a gap
});

test('PARTIAL: a MEASURED N=160 row over the limit (C2 busy CPU 25 %)', () => {
  const v = computeVerdict(world({ ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, busy: (n) => (n === 160 ? 26 : n * 0.05) } }));
  assert.deepEqual(failing(v), ['C2/busy/160']);
  assert.equal(v.verdict, 'PARTIAL');
});

test('PARTIAL (unverified): an N=160 projection with R² < 0.98 is refused, never a GO', () => {
  const v = computeVerdict(world({ ...ok, rss: { ...ok.rss, idle: (n) => (n === 1 ? 100 * MB : n === 8 ? 20 * MB : 200 * MB) } })); // wild fit
  const m1 = v.checks.find((c) => c.id === 'M1' && c.n === 160)!;
  assert.equal(m1.ok, false);
  assert.match(m1.why!, /projection refused/);
  assert.ok(m1.r2! < 0.98);
  assert.equal(v.verdict, 'PARTIAL');
  assert.equal(v.unverified, true);
});

test('NO-GO: M1 over the limit at N=40 (250 MB)', () => {
  const v = computeVerdict(world({ ...ok, rss: { ...ok.rss, idle: (n) => (n === 40 ? 251 * MB : n * 3 * MB) } }));
  assert.equal(v.verdict, 'NO-GO');
  assert.ok(failing(v).includes('M1/idle/40'));
});

test('NO-GO: a failing limit at N=8 is not rescued by N=40 holding (the lift passes through 8)', () => {
  const v = computeVerdict(world({ ...ok, rss: { ...ok.rss, idle: (n) => (n === 8 ? 81 * MB : n * 3 * MB) } }));
  assert.equal(v.verdict, 'NO-GO');
  assert.ok(failing(v).includes('M1/idle/8'));
});

test('M2: P-heavy limit is 2× M1 at each N (500 MB @40)', () => {
  const pass = computeVerdict(world({ ...ok, rss: { ...ok.rss, heavy: (n) => (n === 40 ? 500 * MB : n * 8 * MB) } }));
  assert.ok(!failing(pass).includes('M2/heavy/40'));
  const red = computeVerdict(world({ ...ok, rss: { ...ok.rss, heavy: (n) => (n === 40 ? 501 * MB : n * 8 * MB) } }));
  assert.ok(failing(red).includes('M2/heavy/40'));
  assert.equal(red.verdict, 'NO-GO');
});

test('boundary: exactly 80 MB at N=8 holds (SI bytes), 80.01 MB does not', () => {
  const at = computeVerdict(world({ ...ok, rss: { ...ok.rss, idle: (n) => (n === 8 ? 80 * MB : n * 3 * MB) } }));
  assert.ok(!failing(at).includes('M1/idle/8'), JSON.stringify(at.checks.find((c) => c.id === 'M1' && c.n === 8)));
  const over = computeVerdict(world({ ...ok, rss: { ...ok.rss, idle: (n) => (n === 8 ? 80.01 * MB : n * 3 * MB) } }));
  assert.ok(failing(over).includes('M1/idle/8'));
});

test('single-run rule: median within the limit but ONE run beyond 1.5× the limit fails', () => {
  const rs = world({ ...ok });
  const idx = rs.findIndex((r) => r.arm === 'A1' && r.page === 'idle' && r.n === 40 && r.rep === 4);
  rs[idx]!.rssKB! += (1.5 * 250 * MB + 1 * MB) / 1024; // 4 other runs stay at the median
  const v = computeVerdict(rs);
  const c = v.checks.find((c) => c.id === 'M1' && c.n === 40)!;
  assert.ok(c.delta! <= 250 * MB, 'the median still holds');
  assert.equal(c.ok, false);
  assert.match(c.why!, /single run/);
  assert.equal(v.verdict, 'NO-GO');
});

test('C2: busy CPU over 10 % at N=40 → NO-GO when A2 was not measured', () => {
  const v = computeVerdict(world({ ...ok, cpu: { ...ok.cpu, busy: (n) => n * 0.3 } })); // 12 % @40
  assert.equal(v.verdict, 'NO-GO');
  assert.ok(failing(v).includes('C2/busy/40'));
  assert.equal(v.policy, 'A1');
});

test('C2: A1 breaches, A2 holds the CPU limits → the policy lifted is A2 and the verdict follows it', () => {
  const v = computeVerdict(world({ ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, busy: (n) => n * 0.3, idle: (n) => n * 0.003 }, a2: { busy: (n) => n * 0.01, idle: () => 0.1 } }));
  assert.equal(v.policy, 'A2');
  assert.equal(v.verdict, 'GO');
  assert.ok(v.reasons.some((r) => /policy lifted is A2/.test(r)));
  assert.ok(v.checks.filter((c) => c.id === 'C2').every((c) => c.arm === 'A2' && c.ok));
});

test('C2: A2 is needed (and measured) only for the page A1 breached; the limits A1 held stay on A1 rows', () => {
  const rs = world({ ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, busy: (n) => n * 0.3 }, a2: { busy: (n) => n * 0.01, idle: () => 0 } }).filter((r) => !(r.set === 'a2' && r.page === 'idle')); // no A2 data for P-idle
  const v = computeVerdict(rs);
  assert.equal(v.policy, 'A2');
  assert.equal(v.verdict, 'GO');
  assert.ok(v.checks.filter((c) => c.id === 'C2').every((c) => c.arm === 'A2'));
  assert.ok(v.checks.filter((c) => c.id === 'C1').every((c) => c.arm === 'A1'));
});

test('C2: A1 breaches AND A2 breaches → stays NO-GO on A1', () => {
  const v = computeVerdict(world({ ...ok, cpu: { ...ok.cpu, busy: (n) => n * 0.3 }, a2: { busy: (n) => n * 0.3, idle: () => 0 } }));
  assert.equal(v.verdict, 'NO-GO');
  assert.equal(v.policy, 'A1');
});

test('C1: idle CPU over 2 % at N=160 (measured) → PARTIAL', () => {
  const v = computeVerdict(world({ ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, idle: (n) => (n === 160 ? 2.5 : n * 0.003) } }));
  assert.deepEqual(failing(v), ['C1/idle/160']);
  assert.equal(v.verdict, 'PARTIAL');
});

test('G1: GPU-process RSS over 150 MB at N=160 → PARTIAL; no N≤40 limit exists for it', () => {
  const v = computeVerdict(world({ ...ok, ns: [1, 8, 40, 160], gpu: { ...ok.gpu, busy: (n) => (n === 160 ? 151 * MB : 20 * MB) } }));
  assert.deepEqual(failing(v), ['G1-gpu/busy/160']);
  assert.equal(v.verdict, 'PARTIAL');
  const big40 = computeVerdict(world({ ...ok, ns: [1, 8, 40, 160], gpu: { ...ok.gpu, busy: (n) => (n === 40 ? 400 * MB : 20 * MB) } }));
  assert.ok(!failing(big40).some((f) => f.startsWith('G1-gpu') && f.endsWith('/40')));
});

test('G1: any crash / context-lost in a run of N=160 → PARTIAL; at N=40 → NO-GO (valid or not)', () => {
  const at160 = computeVerdict(world({ ...ok, ns: [1, 8, 40, 160], crash: (r) => (r.n === 160 && r.arm === 'A1' && r.page === 'busy' ? 1 : 0) }));
  assert.deepEqual(failing(at160), ['G1-crash/busy/160']);
  assert.equal(at160.verdict, 'PARTIAL');
  const at40 = computeVerdict(world({ ...ok, crash: (r) => (r.n === 40 && r.arm === 'A0' && r.page === 'heavy' ? 1 : 0) }));
  assert.equal(at40.verdict, 'NO-GO');
  assert.ok(failing(at40).includes('G1-crash/heavy/40'));
  // a crashed run is invalid for the medians but STILL counted as a crash
  const rs = world({ ...ok });
  const r = rs.find((x) => x.arm === 'A1' && x.page === 'idle' && x.n === 8 && x.rep === 0)!;
  r.crashes = 2; r.livenessFail = 1;
  assert.equal(isValid(r), false);
  assert.ok(failing(computeVerdict(rs)).includes('G1-crash/idle/8'));
});

test('G1: idle frames from hidden views must equal A0 (±0): 1 extra frame at the median → NO-GO at N≤40', () => {
  const v = computeVerdict(world({ ...ok, frames: () => 1 }));
  assert.equal(v.verdict, 'NO-GO');
  assert.ok(failing(v).includes('G1-frames/idle/8'));
  const same = computeVerdict(world({ ...ok, frames: () => 0 }));
  assert.ok(!failing(same).some((f) => f.startsWith('G1-frames')));
});

test('controls: no positive control (A1x) → NO-GO, unverified', () => {
  const v = computeVerdict(world({ ...ok, noPositive: true }));
  assert.equal(v.verdict, 'NO-GO');
  assert.equal(v.unverified, true);
  assert.ok(v.reasons.some((r) => /UNVERIFIED positive-rss/.test(r)));
});

test('controls: the positive control must read ≥ 80 MB — a blind instrument (reads 40 MB) fails it', () => {
  const rs = world(ok);
  for (const r of rs) if (r.arm === 'A1x') r.rssKB! -= 60 * MB / 1024; // the instrument under-reads the 100 MB allocation
  const c = readControls(rs).find((x) => x.id === 'positive-rss')!;
  assert.equal(c.ok, false);
  assert.equal(computeVerdict(rs).verdict, 'NO-GO');
});

test('controls: null (A0b vs A0) beyond 25 % of the smallest limit (20 MB) → NO-GO; 19 MB passes', () => {
  assert.equal(computeVerdict(world({ ...ok, nullNoise: 21 * MB })).verdict, 'NO-GO');
  const pass = readControls(world({ ...ok, nullNoise: 0.5 * MB })).find((c) => c.id === 'null-A0-vs-A0')!;
  assert.equal(pass.ok, true, pass.detail);
  // the CPU leg: 0.6 % of a core (> 25 % of the 2 % limit) is over
  const rs = world(ok);
  for (const r of rs) if (r.arm === 'A0b') r.cpuPct! += 0.6;
  assert.equal(readControls(rs).find((c) => c.id === 'null-A0-vs-A0')!.ok, false);
});

test('controls: no null control / no crash-counter control / no memory-floor abort control → each alone is NO-GO', () => {
  for (const o of [{ noNull: true }, { noCrashCtl: true }, { noAbortCtl: true }, { noGpuCtl: true }]) {
    const v = computeVerdict(world({ ...ok, ...o }));
    assert.equal(v.verdict, 'NO-GO', JSON.stringify(o));
    assert.equal(v.unverified, true);
  }
});

test('method: fewer than 5 valid runs in a cell → NO-GO; invalid runs (arm not really built) do not count', () => {
  assert.equal(computeVerdict(world({ ...ok, reps: 4 })).verdict, 'NO-GO');
  const rs = world(ok);
  const r = rs.find((x) => x.arm === 'A1' && x.page === 'busy' && x.n === 8 && x.rep === 2)!;
  r.stateOk = false; // the arm assertion failed: the run is not an A1 run
  const m = readMethod(rs).find((c) => c.id === 'runs-per-cell>=5')!;
  assert.equal(m.ok, false);
  assert.match(m.detail, /A1\/busy\/8=4/);
});

test('method: arms that never alternate their lead (A0 always first) → NO-GO', () => {
  const rs = world(ok);
  for (const n of [1, 8, 40]) for (const page of ['idle', 'busy', 'heavy'] as CostPage[]) for (let rep = 0; rep < 5; rep++) {
    const a0 = rs.find((r) => r.arm === 'A0' && r.page === page && r.n === n && r.rep === rep)!;
    const mn = Math.min(...rs.filter((r) => r.page === page && r.n === n && r.rep === rep && r.set === 'main').map((r) => r.seq));
    a0.seq = mn - 0.5;
    a0.t = new Date(Math.min(...rs.filter((r) => r.page === page && r.n === n && r.rep === rep && r.set === 'main').map((r) => Date.parse(r.t!))) - 1000).toISOString(); // A0 always starts first
  }
  const m = readMethod(rs).find((c) => c.id === 'arms-interleaved-alternating')!;
  assert.equal(m.ok, false);
  assert.equal(computeVerdict(rs).verdict, 'NO-GO');
});

test('method: a dev-length run (window < 60 s, settle < 30 s) or an aborted run never enters the verdict', () => {
  const short = world(ok);
  for (const r of short) if (r.arm === 'A1' && r.page === 'idle') r.windowS = 10;
  assert.equal(computeVerdict(short).verdict, 'NO-GO');
  const r = world(ok)[0]!;
  assert.equal(isValid(r), true);
  assert.equal(isValid({ ...r, settleS: 5 }), false);
  assert.equal(isValid({ ...r, aborted: 'memavail' }), false);
});

test('isValid: each instrument fact that could be misleading invalidates the run', () => {
  const r = world(ok)[0]!;
  assert.equal(isValid(r), true);
  for (const patch of [{ distinctRenderers: r.n }, { stateOk: false }, { treeMissing: 1 }, { livenessFail: 1 }, { framesCanary: 0 }, { framesCanary: null }, { rssKB: 0 }, { cpuPct: NaN }, { idleFrames: null }, { kind: 'control-crash' as const }, { gpuRssKB: 0 }, { crashes: null }, { contextLost: null }, { cpuWindowS: 55 }, { cpuWindowS: null }])
    assert.equal(isValid({ ...r, ...patch }), false, JSON.stringify(patch));
});

test('a GO may not rest on a projected N=160 when N=40 was never measured', () => {
  const v = computeVerdict(world({ ...ok, ns: [1, 8] }));
  const m1 = v.checks.find((c) => c.id === 'M1' && c.n === 160)!;
  assert.equal(m1.ok, false);
  assert.match(m1.why!, /N=40 not measured/);
  assert.notEqual(v.verdict, 'GO');
});

test('linearFit / median helpers', () => {
  const f = linearFit([[1, 10], [8, 80], [40, 400]])!;
  assert.ok(Math.abs(f.b - 10) < 1e-9 && Math.abs(f.a) < 1e-9 && f.r2 === 1);
  assert.equal(linearFit([[1, 1], [8, 8]]), null);
  assert.ok(linearFit([[1, 100], [8, 20], [40, 200]])!.r2 < 0.98);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('computeChecks: only the limits written in §Go-no-go exist (no invented N=40 GPU / C1 limit)', () => {
  const ids = computeChecks(world({ ...ok, ns: [1, 8, 40, 160] })).filter((c) => c.id !== 'G1-crash' && c.id !== 'G1-frames').map((c) => `${c.id}/${c.page}/${c.n}`).sort();
  assert.deepEqual(ids, ['C1/idle/160', 'C2/busy/160', 'C2/busy/40', 'G1-gpu/busy/160', 'G1-gpu/heavy/160', 'G1-gpu/idle/160', 'M1/idle/160', 'M1/idle/40', 'M1/idle/8', 'M2/heavy/160', 'M2/heavy/40', 'M2/heavy/8'].sort());
  assert.deepEqual(LIMITS.m1RssBytes, { 8: 80 * MB, 40: 250 * MB, 160: 1000 * MB });
});

test('G1 crash: an A2-set run (the lifted policy) or an N=1 run counts — not only the main set at N∈{8,40,160}', () => {
  const a2 = computeVerdict(world({ ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, busy: (n) => n * 0.3 }, a2: { busy: (n) => n * 0.01, idle: () => 0 } }));
  assert.equal(a2.verdict, 'GO');
  const rs = world({ ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, busy: (n) => n * 0.3 }, a2: { busy: (n) => n * 0.01, idle: () => 0 } });
  rs.find((r) => r.set === 'a2' && r.arm === 'A2' && r.page === 'busy' && r.n === 40)!.crashes = 1;
  const v = computeVerdict(rs);
  assert.equal(v.verdict, 'NO-GO');
  assert.ok(failing(v).includes('G1-crash/busy/40'));
  const n1 = world(ok); n1.find((r) => r.arm === 'A1' && r.page === 'idle' && r.n === 1)!.contextLost = 1;
  const v1 = computeVerdict(n1);
  assert.equal(v1.verdict, 'NO-GO');
  assert.ok(failing(v1).includes('G1-crash/idle/1'));
});

test('G1 crash: a hung run (aborted "deadline") is a failure; a memory-floor abort is the guard working and is not', () => {
  const hung = world(ok); hung.find((r) => r.arm === 'A1' && r.page === 'busy' && r.n === 8 && r.rep === 3)!.aborted = 'deadline';
  assert.ok(failing(computeVerdict(hung)).includes('G1-crash/busy/8'));
  const floor = world(ok); const r = floor.find((x) => x.arm === 'A1' && x.page === 'heavy' && x.n === 40 && x.rep === 3)!; r.aborted = 'memavail'; r.crashes = null; r.contextLost = null;
  assert.ok(!failing(computeVerdict(floor)).includes('G1-crash/heavy/40'));
});

test('an N=160 row that was ATTEMPTED but has fewer than 5 valid runs is not silently turned into a projection', () => {
  const rs = world({ ...ok, ns: [1, 8, 40, 160] });
  const r = rs.find((x) => x.arm === 'A1' && x.page === 'busy' && x.n === 160 && x.rep === 4)!; r.stateOk = false; // 4 valid A1 runs left
  const gpu = rs.filter((x) => x.arm === 'A1' && x.page === 'busy' && x.n === 160 && x.rep < 4); for (const g of gpu) g.gpuRssKB! += 400 * MB / 1024; // and they read +400 MB GPU RSS
  const v = computeVerdict(rs);
  const c = v.checks.find((x) => x.id === 'G1-gpu' && x.page === 'busy' && x.n === 160)!;
  assert.equal(c.ok, false);
  assert.equal(c.basis, 'missing');
  assert.match(c.why!, /attempted/);
  assert.notEqual(v.verdict, 'GO');
});

test('controls: the GPU-process kill must read crashes ≥ 1 AND context-lost ≥ 1 (a reader that never matches fails the control)', () => {
  const rs = world(ok);
  for (const r of rs) if (r.kind === 'control-gpu-crash') r.contextLost = 0;
  assert.equal(readControls(rs).find((c) => c.id === 'gpu-crash-and-context-lost-counters-fire')!.ok, false);
  assert.equal(computeVerdict(rs).verdict, 'NO-GO');
});

test('G1 frames: the single-run rule applies with limit 0 — two A1 runs with 999 frames fail although the median is 0', () => {
  const rs = world(ok);
  for (const r of rs.filter((x) => x.arm === 'A1' && x.page === 'idle' && x.n === 40 && x.rep < 2)) r.idleFrames = 999;
  const c = computeVerdict(rs).checks.find((x) => x.id === 'G1-frames' && x.n === 40)!;
  assert.equal(c.delta, 0);
  assert.equal(c.ok, false);
});

test('policy A2 must hold the idle-frames limit too: A2 hidden views producing frames → not GO', () => {
  const rs = world({ ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, busy: (n) => n * 0.3 }, a2: { busy: (n) => n * 0.01, idle: () => 0 } });
  for (const r of rs.filter((x) => x.set === 'a2' && x.arm === 'A2' && x.page === 'busy' && x.n === 40)) r.idleFrames = 500;
  const v = computeVerdict(rs);
  assert.equal(v.policy, 'A2');
  assert.notEqual(v.verdict, 'GO');
  assert.ok(failing(v).includes('G1-frames/busy/40'));
});

test('boundaries pin every written limit: C2@40 10 % holds / 10.01 fails, C1 2 % / 2.01, window 60 s, R² 0.98, positive control 80 MB', () => {
  const c2 = (x: number) => computeVerdict(world({ ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, busy: (n) => (n === 40 ? x : n * 0.05) }, a2: { busy: () => 99, idle: () => 99 } })).checks.find((c) => c.id === 'C2' && c.n === 40)!;
  assert.equal(c2(10).ok, true); assert.equal(c2(10.01).ok, false);
  const c1 = (x: number) => computeVerdict(world({ ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, idle: (n) => (n === 160 ? x : n * 0.003) } })).checks.find((c) => c.id === 'C1')!;
  assert.equal(c1(2).ok, true); assert.equal(c1(2.01).ok, false);
  const r = world(ok)[0]!;
  assert.equal(isValid({ ...r, windowS: 60 }), true); assert.equal(isValid({ ...r, windowS: 59 }), false); assert.equal(isValid({ ...r, settleS: 29 }), false);
  assert.equal(isValid({ ...r, cpuWindowS: 58 }), true); assert.equal(isValid({ ...r, cpuWindowS: 57.9 }), false);
  const proj = (pts: Array<[number, number]>) => computeVerdict(world({ ...ok, rss: { ...ok.rss, idle: (n) => pts.find((p) => p[0] === n)?.[1] ?? 0 } })).checks.find((c) => c.id === 'M1' && c.n === 160)!;
  const good = proj([[1, 0], [8, 8 * MB], [40, 41 * MB]]), bad = proj([[1, 30 * MB], [8, 0], [40, 41 * MB]]);
  assert.ok(good.r2! >= 0.98 && good.basis === 'projected'); assert.ok(bad.r2! < 0.98 && bad.basis === 'missing');
  const pos = (mb: number) => { const rs = world(ok); for (const x of rs) if (x.arm === 'A1x') x.rssKB = rs.find((y) => y.arm === 'A0' && y.page === 'idle' && y.n === 8 && y.rep === x.rep)!.rssKB! + mb * MB / 1024; return readControls(rs).find((c) => c.id === 'positive-rss')!.ok; };
  assert.equal(pos(80.5), true); assert.equal(pos(79.5), false);
  assert.equal(LIMITS.memFloorKB, 8 * 1024 * 1024); assert.equal(LIMITS.minRuns, 5); assert.equal(LIMITS.singleRunFactor, 1.5);
});

test('method: alternation is read off the wall clock (t), not the schedule seq', () => {
  const rs = world(ok);
  for (const n of [1, 8, 40]) for (const page of ['idle', 'busy', 'heavy'] as CostPage[]) for (let rep = 0; rep < 5; rep++) {
    const cell = rs.filter((r) => r.page === page && r.n === n && r.rep === rep && r.set === 'main');
    const a0 = cell.find((r) => r.arm === 'A0')!;
    a0.t = new Date(Math.min(...cell.map((r) => Date.parse(r.t!))) - 1000).toISOString(); // seq untouched: only the clock says A0 went first every time
  }
  assert.equal(readMethod(rs).find((c) => c.id === 'arms-interleaved-alternating')!.ok, false);
});

test('method: the a2 set and a measured N=160 group need ≥ 5 valid runs per compared arm', () => {
  const rs = world({ ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, busy: (n) => n * 0.3 }, a2: { busy: (n) => n * 0.01, idle: () => 0 } });
  const a2 = rs.find((r) => r.set === 'a2' && r.arm === 'A2' && r.page === 'busy' && r.n === 40 && r.rep === 1)!; a2.stateOk = false;
  assert.match(readMethod(rs).find((c) => c.id === 'runs-per-cell>=5')!.detail, /a2\/A2\/busy\/40=4/);
  const rs2 = world({ ...ok, ns: [1, 8, 40, 160] });
  rs2.find((r) => r.arm === 'A0' && r.page === 'idle' && r.n === 160 && r.rep === 0)!.stateOk = false;
  assert.match(readMethod(rs2).find((c) => c.id === 'runs-per-cell>=5')!.detail, /main\/A0\/idle\/160=4/);
});

test('X7: the N=40 null cell is pinned on its own — noise only on A0b@idle/40 (21 MB RSS) fails the null control', () => {
  const v = computeVerdict(world({ ...ok, nullNoiseOnly40: 21 * MB }));
  const c = readControls(world({ ...ok, nullNoiseOnly40: 21 * MB })).find((x) => x.id === 'null-A0-vs-A0')!;
  assert.equal(c.ok, false);
  assert.match(c.detail, /rss@idle\/40/);
  assert.doesNotMatch(c.detail, /idle\/8:/);
  assert.equal(v.verdict, 'NO-GO');
  assert.equal(readControls(world({ ...ok, nullNoiseOnly40: 19 * MB })).find((x) => x.id === 'null-A0-vs-A0')!.ok, true);
});

test('X14b: A2 rows are compared against the a2-SET A0, not the main-set A0 (host drift between the stages must not read as an A2 cost)', () => {
  const o = { ...ok, ns: [1, 8, 40, 160], cpu: { ...ok.cpu, busy: (n: number) => n * 0.3 }, a2: { busy: (n: number) => n * 0.01, idle: () => 0 }, a2Drift: 30 };
  const v = computeVerdict(world(o));
  assert.equal(v.policy, 'A2');
  assert.equal(v.verdict, 'GO');
  const c2 = v.checks.find((c) => c.id === 'C2' && c.n === 40)!;
  assert.equal(c2.arm, 'A2');
  assert.ok(Math.abs(c2.delta!) < 1, `A2 − a2-set A0 = ${c2.delta}`); // 30 % of drift cancels
  // the same for C1: A1 breaches the idle CPU limit at N=160, A2 (idle) holds it against ITS OWN stage's A0
  const v1 = computeVerdict(world({ ...o, cpu: { busy: (n: number) => n * 0.3, idle: (n: number) => (n === 160 ? 2.5 : n * 0.003) } }));
  assert.equal(v1.policy, 'A2');
  assert.equal(v1.verdict, 'GO');
  const c1 = v1.checks.find((c) => c.id === 'C1' && c.n === 160)!;
  assert.equal(c1.arm, 'A2');
  assert.ok(Math.abs(c1.delta!) < 1, `C1: A2 − a2-set A0 = ${c1.delta}`);
});

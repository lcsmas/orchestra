// Unit tests for the soak campaign's PURE half (C5 #212): D7 caps, slope math, the report builder and the judge. Every assertion uses LITERALS
// (never the constants under test) so a budget that shrinks or a rule that is deleted cannot shrink the test with it. The judge's must-FAIL arms
// (a seeded leak, a seeded wedge, a leftover process) are driven over SYNTHETIC campaigns whose truth is known by construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSoakReport, decideAbort, emptyRaw, formatSoakText, ingestSoakLine, judgeSoak, median, olsSlope, percentile, preflight, soakExitCode, soakTerminator, theilSenSlope, tightenCaps,
  type SoakRaw, type SoakReport,
} from './soak-campaign.ts';
import { SOAK_BUDGETS, soakSlopeBudget } from './session-budget.ts';

const GB = 1048576;
const CAPS = { minMemAvailKB: 6 * GB, maxLoad1: 20 };

test('SOAK_BUDGETS pins the D7 numbers as literals', () => {
  assert.equal(SOAK_BUDGETS.maxSessions, 10);
  assert.equal(SOAK_BUDGETS.minMemAvailKB, 6 * 1024 * 1024);
  assert.equal(SOAK_BUDGETS.maxLoad1, 20);
  assert.deepEqual({ ...SOAK_BUDGETS.wedge }, { wedgedTurns: 0, wedgedSessions: 0, errorTurns: 0 });
  assert.deepEqual({ ...SOAK_BUDGETS.processes }, { survivorsAfterDelete: 0, strayAtEnd: 0 });
  assert.equal(SOAK_BUDGETS.memory.minWarmupSec, 180, 'a fresh session climbs ~25 MB in its first 3 min: that is warm-up, not a leak');
  assert.equal(SOAK_BUDGETS.memory.warmupFraction, 0.25);
  assert.equal(SOAK_BUDGETS.memory.minWindowSec, 120);
  assert.equal(SOAK_BUDGETS.memory.minSamples, 8);
  assert.ok(Object.isFrozen(SOAK_BUDGETS) && Object.isFrozen(SOAK_BUDGETS.memory) && Object.isFrozen(SOAK_BUDGETS.wedge));
});

// ── D7: abort + preflight ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('decideAbort: RAM floor and load ceiling, both boundaries, fail closed on unreadable', () => {
  assert.equal(decideAbort({ memAvailKB: 6 * GB, load1: 20 }, CAPS), null, 'exactly at both caps is allowed');
  assert.equal(decideAbort({ memAvailKB: 6 * GB - 1, load1: 1 }, CAPS)?.reason, 'low-ram');
  assert.equal(decideAbort({ memAvailKB: 30 * GB, load1: 20.01 }, CAPS)?.reason, 'high-load');
  assert.equal(decideAbort({ memAvailKB: NaN, load1: 1 }, CAPS)?.reason, 'unreadable-resources');
  assert.equal(decideAbort({ memAvailKB: 30 * GB, load1: NaN }, CAPS)?.reason, 'unreadable-resources');
  assert.match(decideAbort({ memAvailKB: 5 * GB, load1: 1 }, CAPS)!.detail, /5\.0 GB < 6\.0 GB/);
});

const P = { sessions: 3, durationSec: 300, turnIntervalSec: 20, sampleSec: 10, turnDeadlineSec: 60, replyDelayMs: 500 };

test('preflight: the 10-session cap, sane timings, and the projected footprint against the 6 GB floor', () => {
  assert.deepEqual(preflight({ params: P, memAvailKB: 11 * GB, load1: 5 }), [], '3 sessions fit in 11 GB free');
  assert.match(preflight({ params: { ...P, sessions: 11 }, memAvailKB: 100 * GB, load1: 0 }).join('|'), /exceeds the D7 cap of 10/);
  assert.deepEqual(preflight({ params: { ...P, sessions: 10 }, memAvailKB: 100 * GB, load1: 0 }), [], '10 is allowed when the RAM is there');
  assert.match(preflight({ params: { ...P, sessions: 10 }, memAvailKB: 11 * GB, load1: 5 }).join('|'), /projected footprint of 10 session/, '10 sessions do not fit in 11 GB free');
  assert.match(preflight({ params: P, memAvailKB: 5 * GB, load1: 5 }).join('|'), /machine not fit to start: free RAM 5\.0 GB/);
  assert.match(preflight({ params: P, memAvailKB: 30 * GB, load1: 21 }).join('|'), /machine not fit to start: load 21\.0 > 20/);
  assert.match(preflight({ params: { ...P, durationSec: 30 }, memAvailKB: 30 * GB, load1: 0 }).join('|'), /duration must be ≥ 60 s/);
  assert.match(preflight({ params: { ...P, sessions: 0 }, memAvailKB: 30 * GB, load1: 0 }).join('|'), /sessions must be an integer ≥ 1/);
  assert.match(preflight({ params: P, memAvailKB: NaN, load1: 0 }).join('|'), /unreadable|cannot judge/);
});

test('tightenCaps can only tighten the D7 caps, never loosen them', () => {
  assert.deepEqual(tightenCaps(CAPS, { minMemAvailKB: 1, maxLoad1: 999 }), CAPS, 'a looser override is ignored');
  assert.deepEqual(tightenCaps(CAPS, { minMemAvailKB: 8 * GB, maxLoad1: 5 }), { minMemAvailKB: 8 * GB, maxLoad1: 5 });
  assert.deepEqual(tightenCaps(CAPS, null), CAPS);
  assert.deepEqual(tightenCaps(CAPS), CAPS);
});

// ── statistics ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('slopes: exact on a line, Theil–Sen shrugs off a spike that drags OLS, null without a spread', () => {
  const line: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => [i * 10, 500 + i * 10 * 0.5]); // 0.5 MB/s
  assert.ok(Math.abs((theilSenSlope(line) as number) - 0.5) < 1e-9);
  assert.ok(Math.abs((olsSlope(line) as number) - 0.5) < 1e-9);
  const spiky = line.map(([t, v], i): [number, number] => [t, i === 19 ? v + 400 : v]);
  assert.ok(Math.abs((theilSenSlope(spiky) as number) - 0.5) < 0.05, 'the median of pairwise slopes ignores one spike');
  assert.ok((olsSlope(spiky) as number) > 1.0, 'OLS is dragged well above the true 0.5 by the same spike');
  assert.equal(olsSlope([[1, 1]]), null);
  assert.equal(theilSenSlope([]), null);
  assert.equal(olsSlope([[5, 1], [5, 2]]), null, 'no x spread');
  assert.equal(olsSlope(Array.from({ length: 10 }, (_, i): [number, number] => [i, 7])), 0, 'flat is 0');
});

test('soakSlopeBudget: floor + noise/window — a short window is allowed noise, a long one is held to the floor', () => {
  assert.equal(soakSlopeBudget(120, 0.5, 8), 4.5);
  assert.equal(soakSlopeBudget(300, 0.5, 8), 2.1);
  assert.equal(soakSlopeBudget(3600, 0.5, 8), 0.63);
  assert.equal(soakSlopeBudget(0, 0.5, 8), 8.5, 'a degenerate window is clamped to 1 minute, never divides by zero');
});

test('median and percentile (nearest rank)', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(s, 50), 50);
  assert.equal(percentile(s, 95), 95);
  assert.equal(percentile(s, 99), 99);
  assert.equal(percentile([], 50), null);
});

// ── a synthetic campaign whose truth is known ─────────────────────────────────────────────────────────────────────────────────
interface Synth { sessions?: number; durationSec?: number; sampleSec?: number; leak?: { session: number; mbPerMin: number }; wedge?: { session: number; atSec: number }; survivors?: number; noFinal?: boolean; abort?: boolean; mountedCli?: boolean; errorTurns?: number; runnerLeakMBPerMin?: number }
function synth(o: Synth = {}): SoakRaw {
  const N = o.sessions ?? 4, dur = o.durationSec ?? 300, step = o.sampleSec ?? 10;
  const raw = emptyRaw();
  raw.start = {
    at: '2026-09-30T06:00:00.000Z', sessions: N, durationMs: dur * 1000, turnIntervalMs: 20000, sampleMs: step * 1000, turnDeadlineMs: 60000, replyDelayMs: 500, containment: 'netns+pidns', pidns: true,
    cli: { version: '2.1.284 (Claude Code)', path: '/x/claude' }, fixture: { skills: 60, memoryFiles: 50, mcpServers: 4, toolsPerServer: 15, claudeMdKB: 48 },
    seedLeak: o.leak ?? null, faultPlan: null, caps: CAPS, pageKB: 16, nproc: 10,
  };
  const noise = (i: number, t: number) => ((i * 7 + t) % 5) - 2; // deterministic ±2 MB jitter
  for (let t = 0; t <= dur; t += step) {
    raw.samples.push({
      tSec: t, phase: t === 0 ? 'boot' : t === dur ? 'end' : 'run', memAvailKB: 10 * GB, load1: 8, runnerRssKB: (160 + (o.runnerLeakMBPerMin ?? 0) * (t / 60)) * 1024, apiRssKB: 60 * 1024, strays: 0, strayKinds: [],
      s: Array.from({ length: N }, (_, i) => ({
        i, rssKB: t < 30 ? 300 * 1024 : (520 + noise(i, t) + (o.leak?.session === i ? o.leak.mbPerMin * (t / 60) : 0)) * 1024, swapKB: 0, procs: 6,
        k: { cli: o.mountedCli === false ? 0 : 1, keeper: 1, mcp: 4, hook: 0, other: 0 }, apiMain: 1, apiHeld: 0,
      })),
    });
  }
  for (let i = 0; i < N; i++) {
    for (let n = 0, t = 5; t < dur - 10; n++, t += 20) {
      const wedged = o.wedge?.session === i && t >= o.wedge.atSec;
      if (wedged && raw.turns.some((x) => x.i === i && x.outcome === 'wedged')) break;
      const err = !wedged && i === 0 && n < (o.errorTurns ?? 0);
      raw.turns.push({ i, n, tSec: t, ms: wedged ? 60000 : 600 + ((n * 37) % 400), outcome: wedged ? 'wedged' : err ? 'error' : 'ok', phase: n === 0 ? 'startup' : 'steady', ...(err ? { err: 'boom' } : {}) });
    }
  }
  if (o.abort) raw.abort = { reason: 'low-ram', detail: 'free RAM 5.0 GB < 6.0 GB', tSec: 100 };
  if (!o.noFinal) {
    const list = Array.from({ length: o.survivors ?? 0 }, (_, k) => ({ pid: 900 + k, kind: k === 0 ? 'mcp' : 'other', session: 1, rssKB: 51200, cmd: 'node fake-mcp-server.mjs' }));
    raw.final = {
      cli: raw.start.cli, containment: 'netns+pidns', aborted: raw.abort, tSec: dur + 20,
      init: Array.from({ length: N }, (_, i) => ({ i, mcpConnected: 4, tools: 92 })),
      sessions: Array.from({ length: N }, (_, i) => ({ i, sent: 10, turnEnds: 10, errors: 0, lastError: null, wedged: o.wedge?.session === i })),
      survivors: { total: list.length, zombies: 0, list, teardownErrors: [] },
      api: { totals: { main: 40, side: 4, count_tokens: 100, other: 0, held: 0, egress: 5 }, sessions: Object.fromEntries(Array.from({ length: N }, (_, i) => [`s${i}`, { model: 11, main: 10, side: 1, count_tokens: 25, other: 0, held: 0 }])), rssKB: 61440 },
      endTree: [],
    };
  }
  return raw;
}
const judged = (o: Synth = {}) => {
  const report = buildSoakReport(synth(o), { codeId: 'abc' }, SOAK_BUDGETS, '2026-09-30T06:05:00.000Z');
  const j = judgeSoak(report);
  return { report, j, term: soakTerminator(report, j), byId: (id: string) => j.verdicts.find((v) => v.id === id) };
};

test('a healthy synthetic campaign PASSES: every verdict ok, slopes ~0, terminator PASS, rc 0', () => {
  const { report, j, term, byId } = judged();
  assert.equal(report.status, 'COMPLETE');
  assert.equal(j.void, false, j.verdicts.filter((v) => !v.ok).map((v) => v.message).join(' | '));
  assert.equal(j.ok, true);
  assert.equal(term, 'PASS');
  assert.equal(soakExitCode(term), 0);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(byId(`soak.memory.slopeMBPerMin.s${i}`)!.actual as number) < 1, `s${i} slope ~0`);
  assert.equal(byId('soak.wedge.wedgedTurns')!.actual, 0);
  assert.equal(byId('soak.processes.survivorsAfterDelete')!.actual, 0);
  assert.ok(byId('soak.instrument.memoryWindow')!.ok);
});

test('MUST-FAIL: a seeded leak (60 MB/min in s1) is named by its session, the controls stay green', () => {
  const { j, term, byId } = judged({ leak: { session: 1, mbPerMin: 60 } });
  const leak = byId('soak.memory.slopeMBPerMin.s1')!;
  assert.equal(leak.ok, false);
  assert.ok((leak.actual as number) > 55 && (leak.actual as number) < 65, `slope ${leak.actual} ≈ the seeded 60 MB/min`);
  assert.match(leak.message, /BUDGET BROKEN soak\.memory\.slopeMBPerMin\.s1/);
  for (const i of [0, 2, 3]) assert.equal(byId(`soak.memory.slopeMBPerMin.s${i}`)!.ok, true, `control s${i} is not flagged`);
  assert.equal(j.void, false);
  assert.equal(term, 'FAIL');
  assert.equal(soakExitCode(term), 1);
});

test('MUST-FAIL: a leak too small to see is NOT a false alarm — 1 MB/min stays under the 2 MB/min budget', () => {
  const { byId, term } = judged({ leak: { session: 1, mbPerMin: 1 } });
  assert.equal(byId('soak.memory.slopeMBPerMin.s1')!.ok, true);
  assert.equal(term, 'PASS');
});

test('the slope budget SHRINKS with the window: 1 MB/min hides in 5 minutes but is caught over an hour', () => {
  const hour = judged({ durationSec: 3600, sampleSec: 30, leak: { session: 1, mbPerMin: 1 } });
  const v = hour.byId('soak.memory.slopeMBPerMin.s1')!;
  assert.equal(v.ok, false, v.message);
  assert.match(v.limit, /at most 0\.68/, 'warm-up 25% of 3600 s = 900 s → window 2700 s = 45 min → 0.5 + 8/45');
  assert.equal(hour.byId('soak.memory.slopeMBPerMin.s0')!.ok, true);
  assert.equal(hour.term, 'FAIL');
  assert.equal(judged({ leak: { session: 1, mbPerMin: 1 } }).byId('soak.memory.slopeMBPerMin.s1')!.ok, true, 'the same leak over the 2-minute window is inside its noise allowance');
});

test('VOID: a wall-clock jump against the monotonic clock (suspend/resume, clock step) — nothing comparable was measured', () => {
  const raw = synth();
  raw.events.push({ tSec: 120, kind: 'clock-jump', sec: 2400, detail: 'x' } as any);
  const report = buildSoakReport(raw, {}, SOAK_BUDGETS, '2026-09-30T06:05:00.000Z');
  const j = judgeSoak(report);
  assert.deepEqual(report.clockJumps, [{ atSec: 120, sec: 2400 }]);
  assert.equal(j.void, true);
  const v = j.verdicts.find((x) => x.id === 'soak.instrument.noClockStep')!;
  assert.equal(v.ok, false);
  assert.match(v.message, /2400 s at 120 s/);
  assert.equal(soakTerminator(report, j), 'VOID');
  assert.equal(judged().byId('soak.instrument.noClockStep')!.ok, true, 'a healthy run has none');
});

test('MUST-FAIL: a seeded app-process (runner) leak is named on the runner series', () => {
  const { byId, term } = judged({ runnerLeakMBPerMin: 30 });
  assert.equal(byId('soak.memory.slopeMBPerMin.runner')!.ok, false);
  assert.ok((byId('soak.memory.slopeMBPerMin.runner')!.actual as number) > 25);
  assert.equal(term, 'FAIL');
});

test('MUST-FAIL: a seeded wedge (s2 stops answering at 100 s) is named per session and in the rate, with its split', () => {
  const { report, j, term, byId } = judged({ wedge: { session: 2, atSec: 105 } });
  assert.equal(byId('soak.wedge.session.s2')!.ok, false);
  assert.equal(byId('soak.wedge.session.s0')!.ok, true);
  assert.equal(byId('soak.wedge.wedgedTurns')!.ok, false);
  assert.equal(byId('soak.wedge.wedgedSessions')!.actual, 1);
  assert.deepEqual(report.wedge.wedgedSessions, [2]);
  assert.equal(report.wedge.bySession[2].firstWedgeAtSec, 105);
  // the split adds back up to the whole
  assert.equal(report.wedge.byPhase.startup.turns + report.wedge.byPhase.steady.turns, report.wedge.turns);
  assert.equal(report.wedge.byThird.reduce((a, t) => a + t.turns, 0), report.wedge.turns);
  assert.equal(report.wedge.byPhase.steady.wedged, 1);
  assert.equal(j.void, false);
  assert.equal(term, 'FAIL');
});

test('MUST-FAIL: a process left after deleting the workspaces, and error turns, each break their own budget', () => {
  const s = judged({ survivors: 2 });
  assert.equal(s.byId('soak.processes.survivorsAfterDelete')!.ok, false);
  assert.equal(s.byId('soak.processes.survivorsAfterDelete')!.actual, 2);
  assert.deepEqual(s.report.processes.survivorsAfterDelete.byKind, { mcp: 1, other: 1 });
  assert.deepEqual(s.report.processes.survivorsAfterDelete.bySession, { s1: 2 });
  assert.equal(s.term, 'FAIL');
  const e = judged({ errorTurns: 2 });
  assert.equal(e.byId('soak.errors.turns')!.ok, false);
  assert.equal(e.byId('soak.errors.turns')!.actual, 2);
});

test('VOID, never a pass: sessions that never mounted, a window too short to slope, a runner that died', () => {
  const m = judged({ mountedCli: false });
  assert.equal(m.j.void, true);
  assert.equal(m.byId('soak.instrument.sessionsMounted')!.ok, false);
  assert.equal(m.term, 'VOID');
  const short = judged({ durationSec: 100 });
  assert.equal(short.byId('soak.instrument.memoryWindow')!.ok, false);
  assert.equal(short.term, 'VOID');
  const broke = judged({ noFinal: true });
  assert.equal(broke.report.status, 'BROKE');
  assert.equal(broke.term, 'BROKE');
  assert.equal(soakExitCode(broke.term), 1);
});

test('an ABORTED campaign (D7 cap) is judged nothing: status, reason and rc 4 — partial rates are still reported', () => {
  const { report, j, term } = judged({ abort: true });
  assert.equal(report.status, 'ABORTED');
  assert.equal(report.aborted?.reason, 'low-ram');
  assert.equal(j.aborted, true);
  assert.deepEqual(j.verdicts, []);
  assert.equal(term, 'ABORTED');
  assert.equal(soakExitCode(term), 4);
  assert.ok(report.wedge.turns > 0, 'the partial rates are still there');
  assert.match(formatSoakText(report).join('\n'), /status ABORTED \(low-ram: free RAM 5\.0 GB < 6\.0 GB at 100 s\)/);
});

test('the report carries rates AND their split (per session, phase, third), the conditions, and every session\'s series', () => {
  const { report } = judged({ leak: { session: 1, mbPerMin: 60 } });
  assert.equal(report.wedge.bySession.length, 4);
  assert.equal(report.memory.sessions.length, 4);
  assert.equal(report.series.sessions.length, 4);
  assert.ok(report.series.sessions[1].length >= 30, 'the whole series is kept, not one number');
  assert.equal(report.conditions.memAvailKB.min, 10 * GB);
  assert.equal(report.conditions.load1.max, 8);
  assert.equal(report.memory.warmupSec, 180, 'warm-up = max(180 s, 25% of 300 s)');
  assert.equal(report.memory.worstSession?.i, 1);
  assert.equal(report.latency.n, report.wedge.ok);
  const text = formatSoakText(report).join('\n');
  assert.match(text, /WEDGE RATE: 0\/\d+ turns = 0\.00%/);
  assert.match(text, /MEMORY SLOPE/);
  assert.match(text, /LEFT AFTER DELETING ALL 4 WORKSPACES: 0/);
});

test('ingestSoakLine: parses each line kind, ignores everything else', () => {
  const raw = emptyRaw();
  assert.equal(ingestSoakLine(raw, 'plain log line'), false);
  assert.equal(ingestSoakLine(raw, '{"other":1}'), false);
  assert.equal(ingestSoakLine(raw, '{"soak":"sample","tSec":1,"s":[]}'), true);
  assert.equal(ingestSoakLine(raw, '{"soak":"turn","i":0,"n":0,"tSec":1,"ms":5,"outcome":"ok","phase":"startup"}'), true);
  assert.equal(ingestSoakLine(raw, '{"soak":"event","tSec":1,"kind":"started"}'), true);
  assert.equal(ingestSoakLine(raw, '{"soak":"abort","reason":"signal","detail":"SIGTERM","tSec":9}'), true);
  assert.equal(ingestSoakLine(raw, '{"soak":"bogus"}'), false);
  assert.equal(ingestSoakLine(raw, '{"soak":"sample", torn'), false, 'a torn line is dropped, not thrown');
  assert.deepEqual([raw.samples.length, raw.turns.length, raw.events.length, raw.abort?.reason], [1, 1, 1, 'signal']);
});

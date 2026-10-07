#!/usr/bin/env node
// #293 (pre-review #2) — BEHAVIOURAL proof of the container pass's budget in the REAL src/main/resource-monitor.ts `sampleTick` (no Docker needed): a pass that never finishes
// cannot delay the tick (the line still goes out, carrying the LAST result, with one warn); a pass that throws cannot break it; a pass that finishes in time is awaited.
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-container-budget.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'container-budget-rig-'));
process.env.ORCHESTRA_HOME = HOME;
process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true })); // every exit path (a failing arm, a throw) removes the scratch dir
const M = await import('../src/main/resource-monitor.ts');
let failures = 0;
const check = (name, ok, detail) => { if (ok) console.log(`  ✓ ${name}`); else { failures++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ''}`); } };
const results = [];
async function arm(name, fn) {
  console.log(`== arm ${name}`);
  const before = failures;
  try { await fn(); } catch (e) { failures++; console.log(`  ✗ arm threw — ${e?.stack ?? e}`); }
  results.push([name, failures === before]);
}
const VIEW = { docker: 'ok', sampledAt: 1, attributed: [], unattributed: { count: 0, ids: [], names: [] }, unmeasured: 0, daemonsDown: 0 };
const mk = (over) => {
  const lines = [];
  const warns = [];
  const d = { ...M.realResourceMonitorDeps(), procTable: async () => [], keeperRoots: () => [], keeperProcs: () => [], trackedKeeperPid: () => null, liveWorkspaceIds: () => new Set(), statusFor: () => 'idle', storeLoadedFromDisk: () => true, electronProcs: () => [], signal: () => false, appendLine: (l) => lines.push(l), warn: (m) => warns.push(m), containerView: () => VIEW, ...over };
  return { d, lines, warns };
};

await arm('overrun_does_not_delay_the_tick', async () => {
  const { d, lines, warns } = mk({ refreshContainers: () => new Promise(() => {}), containerBudgetMs: 80 });
  const t0 = Date.now();
  await M.sampleTick(d);
  const took = Date.now() - t0;
  check(`a pass that never finishes costs the tick ≈ its budget (took ${took} ms, budget 80 ms)`, took >= 70 && took < 2000, String(took));
  check('the line still went out, carrying the LAST accounting view', lines.length === 1 && lines[0].containers?.docker === 'ok', JSON.stringify(lines[0]?.containers));
  check('exactly ONE warn names the overrun', warns.filter((w) => /container accounting pass exceeded/.test(w)).length === 1, JSON.stringify(warns));
});

await arm('failure_does_not_break_the_tick', async () => {
  const { d, lines, warns } = mk({ refreshContainers: async () => { throw new Error('boom'); }, containerBudgetMs: 5000 });
  await M.sampleTick(d);
  check('the line still went out', lines.length === 1);
  check('the failure is warned, not thrown', warns.some((w) => /container accounting pass failed/.test(w)), JSON.stringify(warns));
});

await arm('in_time_pass_is_awaited', async () => {
  let done = false;
  const { d, lines, warns } = mk({ refreshContainers: async () => { await new Promise((r) => setTimeout(r, 40)); done = true; }, containerBudgetMs: 5000 });
  await M.sampleTick(d);
  check('the pass finished BEFORE the line was built (awaited)', done && lines.length === 1);
  check('no overrun warn for a pass inside its budget', !warns.some((w) => /exceeded/.test(w)), JSON.stringify(warns));
});

await arm('no_hook_no_docker', async () => {
  const { d, lines } = mk({ refreshContainers: undefined, containerView: undefined });
  await M.sampleTick(d);
  check('a deps object without the container hook measures nothing and the line carries no containers (every older rig)', lines.length === 1 && lines[0].containers === undefined);
});

console.log(`arms: ${results.map(([n, ok]) => `${n}=${ok ? 'ok' : 'FAIL'}`).join(' ')}`);
console.log(failures === 0 ? 'CONTAINER-BUDGET: PASS' : `CONTAINER-BUDGET: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

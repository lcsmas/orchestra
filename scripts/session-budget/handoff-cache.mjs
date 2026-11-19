// Handoff cache-read measurement (#466): the SAME N-turn conversation through Orchestra's real session path (sdkSend → keeper → real `claude`) against the
// local fake API (zero tokens), WITHOUT a handoff (`baseline`: the nudge bound is off) and WITH the production handoff (`handoff`: bound K turns → the host nudges
// once → the agent runs `orchestra handoff` → the context ends at the turn end → the summary opens a fresh session). The fake API reports `cache_read_input_tokens` from a
// SIMULATED prefix cache (fake-anthropic-api.mjs `cacheModel`: reads the longest prefix shared with the previous main request, creates the rest; no TTL; 4 chars ≈ 1 token).
// SIMULATED: that cache and the model's replies. REAL: the session path, the CLI's request bodies, the host, the bus run row, the key registry, the restart.
//   node scripts/session-budget/handoff-cache.mjs [--proof] [--turns N] [--bound K] [--keep-going]
// `--proof` adds the must-FAIL arms: `handoff-noop-clear` (context never ended) and `handoff-no-nudge` (agent never told) — each must NOT show the drop.
import path from 'node:path';
import { runHandoffCacheArm, ensureBuilt } from './harness.mjs';
import { judgeHandoffCache, weighted } from './handoff-cache-judge.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const argv = process.argv;
const num = (flag, d) => { const i = argv.indexOf(flag); return i > 0 ? Number(argv[i + 1]) || d : d; };
const turns = num('--turns', 24);
const bound = num('--bound', 6);
const proof = argv.includes('--proof');
// Per-turn growth of the conversation (chars of prompt filler + reply). `light` ≈ 0.75k tokens/turn, `heavy` ≈ 4k tokens/turn (a turn with tool output / file reads).
const PROFILES = { light: { fillerChars: 1800, replyChars: 1200 }, heavy: { fillerChars: 10000, replyChars: 6000 } };
const profileName = argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : 'light';
if (!PROFILES[profileName]) throw new Error(`unknown --profile ${profileName} (light|heavy)`);

ensureBuilt(repo);
const reports = {};
let bad = 0;
async function arm(label, kind, mutant, wantFail) {
  const res = await runHandoffCacheArm({ repo, arm: label, mutant, turns, bound: kind === 'baseline' ? 0 : bound, ...PROFILES[profileName], timeoutMs: 600_000 });
  const r = res.handoffCache;
  if (res.void || res.error || !r || r.error) {
    bad++;
    console.log(`${label}: BROKEN ${res.error ?? r?.error ?? 'no result'}${res.root ? ` (root ${res.root})` : ''}`);
    return null;
  }
  reports[label] = r;
  const v = judgeHandoffCache(kind, r, reports.baseline);
  const failed = Object.entries(v).filter(([, ok]) => !ok).map(([k]) => k);
  const ok = JSON.stringify(failed) === JSON.stringify(wantFail);
  if (!ok) bad++;
  console.log(`${label}: ${failed.length ? `FAIL [${failed.join(', ')}]` : 'PASS'} (${ok ? 'expected' : `UNEXPECTED — wanted ${wantFail.length ? `FAIL [${wantFail.join(', ')}]` : 'PASS'}`})`
    + ` | main requests ${r.mainRequests}, cache_read ${r.cacheReadTokens}, cache_creation ${r.cacheCreationTokens}, weighted ${weighted(r)}, last request ${r.lastRequestTokens} tok, max ${r.maxRequestTokens}`
    + ` | nudges ${r.nudgeRequests}, handoffs ${r.handoffsDispatched}, openings ${r.openingRequests}, fresh ${r.freshContextAfterHandoff}`);
  return r;
}

const base = await arm('baseline', 'baseline', null, []);
if (base) {
  await arm('handoff', 'handoff', null, []);
  if (proof) {
    await arm('handoff-noop-clear', 'handoff', 'handoff-noop-clear', ['opened', 'drop']);
    await arm('handoff-no-nudge', 'handoff', 'handoff-no-nudge', ['nudged', 'handedOff', 'opened', 'drop']);
  }
  const h = reports.handoff;
  if (h) {
    const pct = (a, b) => `${(((b - a) / b) * 100).toFixed(1)}%`;
    console.log(`\nprofile ${profileName}: N=${turns} user turns, bound K=${bound}: cache_read ${base.cacheReadTokens} → ${h.cacheReadTokens} (${pct(h.cacheReadTokens, base.cacheReadTokens)} lower); weighted base-input-token equivalents ${weighted(base)} → ${weighted(h)} (${pct(weighted(h), weighted(base))} lower); final context ${base.lastRequestTokens} → ${h.lastRequestTokens} tok`);
    console.log(`SENSITIVITY (only the previous request reusable): cache_read ${base.prevOnly.cacheReadTokens} → ${h.prevOnly.cacheReadTokens} (${pct(h.prevOnly.cacheReadTokens, base.prevOnly.cacheReadTokens)} lower); creation ${base.prevOnly.cacheCreationTokens} → ${h.prevOnly.cacheCreationTokens}; weighted ${weighted(base, true)} → ${weighted(h, true)} (${pct(weighted(h, true), weighted(base, true))} lower)`);
    console.log(`per-request cache_read, baseline: ${base.perRequest.map((p) => p.read).join(' ')}`);
    console.log(`per-request cache_read, handoff : ${h.perRequest.map((p) => p.read).join(' ')}`);
  }
}
console.log(bad ? `handoff-cache: DIRTY (${bad})` : 'handoff-cache: CLEAN');
process.exit(bad ? 1 : 0);

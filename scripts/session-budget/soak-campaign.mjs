#!/usr/bin/env node
// THE soak command (C5 #212):  pnpm run soak:campaign -- [--sessions 3] [--duration 5m] …
// N concurrent REAL sessions (agent-sdk → keeper → real `claude`, heavy fixture each) against the LOCAL FAKE API for a while; writes a dated
// report (`<out-dir>/soak-<UTC stamp>-<label>.{json,md}`) with RATES and their split — wedge rate, per-session memory slope over time,
// processes left after deleting the workspaces — never a single verdict. Zero tokens (D6). D7: ≤ 10 sessions; aborts itself if free RAM
// < 6 GB or load > 20; never while another campaign runs; scratch HOME/config, everything killed at the end.
// Exit: 0 PASS · 1 FAIL/BROKE · 2 usage/refused · 3 VOID · 4 ABORTED. Last line: `SOAK-CAMPAIGN: <terminator>`.
//   --sessions N (default 3, max 10) --duration <n>[s|m|h] (5m) --turn-interval 20s --sample 10s --turn-deadline 60s --reply-delay-ms 500
//   --tool-every N (default 3: every Nth turn is a TOOL turn — a Bash call, then a fixture MCP call; 0 = text-only turns)
//   --out-dir DIR --label NAME --json (final report as one JSON line) --identity (print the code id JSON and exit) --skip-build
//   --parent-pid PID (abort + tear down if that process dies — the app's scheduler passes its own pid)
//   --seed-leak <session>:<MB/min>   --seed-wedge <session>:<afterMainRequests>     (the must-FAIL seeds; see soak-selftest.mjs)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCampaign, codeIdentity, cliVersion, DEFAULT_OUT_DIR, formatSoakText } from './soak-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dur = (v, dflt) => { if (v == null) return dflt; const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v); if (!m) { console.error(`bad duration: ${v}`); process.exit(2); } return (Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600, undefined: 1 }[m[2]]); };

if (args.includes('--identity')) { console.log(JSON.stringify({ ...codeIdentity(REPO), cli: cliVersion() })); process.exit(0); }

const params = {
  sessions: Number(opt('sessions', 3)), durationSec: dur(opt('duration'), 300), turnIntervalSec: dur(opt('turn-interval'), 20), sampleSec: dur(opt('sample'), 10),
  turnDeadlineSec: dur(opt('turn-deadline'), 60), replyDelayMs: Number(opt('reply-delay-ms', 500)), toolEvery: Number(opt('tool-every', 3)),
};
const seedLeak = opt('seed-leak') ? (([s, m]) => ({ session: Number(s), mbPerMin: Number(m) }))(opt('seed-leak').split(':')) : null;
const seedWedge = opt('seed-wedge') ? (([s, n]) => ({ session: Number(s), after: Number(n) }))(opt('seed-wedge').split(':')) : null;
const faultPlan = seedWedge ? { rules: [{ match: { session: `s${seedWedge.session}`, main: true }, after: seedWedge.after, action: { kind: 'hang' } }] } : null;
const JSON_OUT = args.includes('--json');

const ac = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => ac.abort({ reason: 'signal', detail: sig }));
// The app's scheduler passes its pid: if the app is killed hard, an hour-long campaign must not outlive it.
if (opt('parent-pid')) {
  const pp = Number(opt('parent-pid'));
  setInterval(() => { try { process.kill(pp, 0); } catch { ac.abort({ reason: 'parent-died', detail: `parent process ${pp} is gone` }); } }, 5000).unref();
}
let lastMin = -1;
const res = await runCampaign({
  repo: REPO, params, faultPlan, seedLeak, outDir: opt('out-dir', DEFAULT_OUT_DIR), label: opt('label', 'soak'), skipBuild: args.includes('--skip-build'), signal: ac.signal,
  onLine: (l) => { // a one-line heartbeat per minute (stderr keeps stdout for the report)
    if (!l.startsWith('{"soak":"sample"')) return;
    const o = JSON.parse(l); const m = Math.floor(o.tSec / 60);
    if (m !== lastMin) { lastMin = m; console.error(`  [${o.tSec} s] free ${(o.memAvailKB / 1048576).toFixed(1)} GB load ${o.load1} · tree MB ${o.s.map((x) => Math.round((x.rssKB ?? 0) / 1024)).join('/')} · app ${Math.round((o.runnerRssKB ?? 0) / 1024)} MB`); }
  },
});
if (res.refused) { console.error(`soak-campaign: REFUSED — ${res.refused.join(' | ')}`); process.exit(2); }
if (JSON_OUT) console.log(JSON.stringify({ terminator: res.terminator, ...res.report }));
else for (const l of formatSoakText(res.report)) console.log(l);
console.log(`report: ${res.files.json} · ${res.files.md}`);
console.log(`SOAK-CAMPAIGN: ${res.terminator}`);
process.exit(res.rc);

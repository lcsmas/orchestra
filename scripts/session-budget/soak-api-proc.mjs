// The soak campaign's FAKE-API PROCESS (C5 #212). Runs the fake Anthropic API + refusing egress proxy in its OWN process so the
// app-process analog (soak-runner.mjs, which hosts agent-sdk.ts) carries no instrument state: its memory slope is the app's, not the
// API's request bookkeeping. Config in SB_API_CONFIG (JSON): { apiPort, proxyPort, replyDelayMs, faultPlan, retain, markers }.
// IPC (fork channel): child → `{t:'ready', url, proxyUrl}`; parent → `{t:'stats', id}` → `{t:'stats', id, ...api.stats(), rssKB}`;
// parent → `{t:'stop'}`. The fault plan (fault-plan.mjs) is the injection point C6 #213 extends. Zero tokens: nothing here leaves loopback.
import fs from 'node:fs';
import { startFakeApi } from './fake-anthropic-api.mjs';
import { compileFaultPlan } from './fault-plan.mjs';

const cfg = JSON.parse(process.env.SB_API_CONFIG ?? '{}');
const fault = compileFaultPlan(cfg.faultPlan ?? null); // throws (→ the parent sees the exit) on a malformed / unimplemented plan
const rssKB = () => { try { return Number(/^VmRSS:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1] ?? 0); } catch { return 0; } };
const api = await startFakeApi({
  apiPort: cfg.apiPort, proxyPort: cfg.proxyPort, replyDelayMs: cfg.replyDelayMs ?? 500, markers: cfg.markers ?? {}, retain: cfg.retain ?? 200,
  // Each soak session presents its own fake API key `…-soak-s<N>`: the request's owner without any path or cwd guessing.
  sessionTag: (h) => /soak-(s\d+)/.exec(String(h['x-api-key'] ?? ''))?.[1] ?? 'unknown',
  fault,
});
process.on('message', async (m) => {
  if (m?.t === 'stats') process.send({ t: 'stats', id: m.id, ...api.stats(), rssKB: rssKB() });
  if (m?.t === 'stop') { await api.stop().catch(() => {}); process.exit(0); }
});
process.on('disconnect', () => process.exit(0)); // the runner died: never outlive it
process.send({ t: 'ready', url: api.url, proxyUrl: api.proxyUrl });

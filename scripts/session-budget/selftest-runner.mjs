// Host-dependent self-tests of the session-budget INSTRUMENTS, run INSIDE the suite's containment (harness
// `runSelfTest`) so `pnpm run test` never needs bwrap or a real `claude` (review F8). Config in SB_CONFIG; the last
// stdout line is `{"selftest": <mode>, "ok": bool, ...}`. Modes:
//   census — in the pid namespace the census is EXACTLY the runner's tree: one spawned `sleep`, nothing else
//            (not pid 1, not the runner). A mutant that counts the runner or the namespace init reddens it.
//   smoke  — the optional real-API smoke's FLAG PATH end to end with the REAL `claude` and the FAKE API: one tiny
//            cheap-model turn, exactly one request, tool-less, a haiku model, no egress. Never the real API.
import path from 'node:path';
import { spawn } from 'node:child_process';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
const { REPO, root, mode } = cfg;
const HERE = path.join(REPO, 'scripts', 'session-budget');
const out = (o) => { console.log(JSON.stringify({ selftest: mode, ...o })); process.exit(o.ok ? 0 : 1); };

if (!cfg.pidns) out({ ok: false, why: 'self-tests run only under net+pid namespaces (containment was ' + cfg.containment + ')' });

if (mode === 'census') {
  const { census } = await import(`${HERE}/proc-census.mjs`);
  const k = spawn('sleep', ['30'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  const c = census({ pidns: true });
  k.kill('SIGKILL');
  const ok = c.total === 1 && c.byKind.other === 1 && !c.procs.some((p) => p.pid === process.pid || p.pid === 1);
  out({ ok, total: c.total, byKind: c.byKind, pids: c.procs.map((p) => p.pid), self: process.pid, why: ok ? undefined : `census counted ${c.total} processes (want exactly the one child)` });
}

if (mode === 'smoke') {
  const fs = await import('node:fs');
  const { startFakeApi } = await import(`${HERE}/fake-anthropic-api.mjs`);
  const api = await startFakeApi();
  const acct = path.join(root, 'smoke-acct');
  fs.mkdirSync(acct, { recursive: true });
  const child = spawn(process.execPath, [`${HERE}/smoke-real.mjs`, '--real-api', '--config-dir', acct, '--api-base', api.url], {
    env: { PATH: process.env.PATH, HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, NO_PROXY: '127.0.0.1,localhost' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let so = '', se = '';
  child.stdout.on('data', (d) => (so += d));
  child.stderr.on('data', (d) => (se += d));
  const rc = await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r('TIMEOUT'); }, 60_000); child.on('close', (c) => { clearTimeout(t); r(c); }); });
  const line = (() => { try { return JSON.parse(so.split('\n')[0]); } catch { return null; } })();
  const models = api.requests.filter((r) => r.type === 'model');
  const ok = rc === 0 && line?.ok === true && /^REAL-API-SMOKE: PASS$/m.test(so) && api.requests.length === 1 && models.length === 1 &&
    /haiku/.test(models[0].model ?? '') && models[0].tools === 0 && api.egress.length === 0;
  await api.stop();
  out({ ok, rc, line, requests: api.requests.length, model: models[0]?.model ?? null, tools: models[0]?.tools ?? null, egress: api.egress.map((e) => e.target), why: ok ? undefined : `smoke flag path broke: rc=${rc} stderr=${se.slice(-200)}` });
}

out({ ok: false, why: `unknown self-test mode: ${mode}` });

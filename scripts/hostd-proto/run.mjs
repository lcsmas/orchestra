#!/usr/bin/env node
// PROTOTYPE #139 (map #136) — THROWAWAY rig, never merged. Run inside the contained sway:
//   bash scripts/e2e-contained-rig.sh "$(command -v node)" --no-warnings scripts/hostd-proto/run.mjs --app <release>/orchestra --claude <claude> --base ~/.cache/hostd-proto [--arms a,b,c]
// Reuses the pause-canary rig (scratch HOME / ORCHESTRA_HOME / CLAUDE_CONFIG_DIR, LEAD ⊃ OPS ⊃ w1 seeded in store.json + bus, REAL keeper + REAL claude CLI
// against a scripted local fake API — zero tokens). Every line starting `HP ` is a measurement; the findings doc quotes them.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { initBase, preflight, startApi, makeRig, seedRuns, startBusReader, launchApp, census, kindOf, teardown, runCli, cdpConnect, say, sleep, textOf } from '../pause-canary/lib.mjs';
import { fleetSpec } from '../pause-canary/ids.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const APP = opt('app'), CLAUDE = opt('claude'), REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const ARMS = opt('arms', 'inapp,hostd,client,keeper,spoolgate,forcehost').split(',');
const KIND = opt('kind', 'status');
const N = Number(opt('samples', '4'));
initBase(path.resolve(opt('base')));
preflight();
const HP = (k, v) => say(`HP ${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`);

// ── scripted member: a wake ("lot pending") → `orchestra check`; every lot read → `orchestra ack` (an unacked lot keeps the latch) ──
const userTexts = (ms) => ms.filter((m) => m.role === 'user').map((m) => textOf(m.content));
const cmdsOf = (ms) => ms.filter((m) => m.role === 'assistant' && Array.isArray(m.content)).flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => String(b.input?.command ?? '')));
const bash = (command) => ({ tool: { name: 'Bash', input: { command, description: 'hp' } } });
/** every main request the fake API decided on: who, when, and whether its NEW tail (after the last assistant turn) carries a wake order */
const seen = [];
const decide = ({ role, messages }) => {
  let la = -1; for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') { la = i; break; }
  const tail = messages.slice(la + 1).map((m) => textOf(m.content)).join('\n');
  seen.push({ t: Date.now(), role, wake: /lot pending|orchestra check/.test(tail), tail: tail.slice(0, 300) });
  if (role !== 'w1') return { text: 'ok' };
  const ut = userTexts(messages), cmds = cmdsOf(messages);
  const wakes = ut.filter((t) => /lot pending/.test(t)).length;
  if (wakes > cmds.filter((c) => /orchestra check/.test(c)).length) return bash('orchestra check --run "$ORCHESTRA_RUN_ID"');
  const tr = JSON.stringify(messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')));
  const pairs = [...new Set([...tr.matchAll(/\\"run\\":\\"([0-9a-f-]{36})\\",\\"reader\\":\\"[0-9a-f-]*\\",\\"lot\\":(\d+)/g)].map((x) => `${x[1]} ${x[2]}`))];
  const un = pairs.find((pr) => !cmds.some((c) => c.includes(`orchestra ack --run ${pr}`)));
  if (un) return bash(`orchestra ack --run ${un}`);
  return { text: 'ok' };
};

// ── attach-socket instrument: speak the hostd protocol from the rig (the same NDJSON the client app uses) ──
function attach(H) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(path.join(H, 'hostd-attach.sock'));
    let buf = '', id = 0; const pend = new Map(); const pushes = [];
    s.setEncoding('utf8');
    s.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.push) pushes.push({ t: Date.now(), ch: m.push, args: m.args }); else { pend.get(m.id)?.(m); pend.delete(m.id); } } });
    s.once('error', reject);
    s.once('connect', () => resolve({ pushes, call: (method, ...args) => new Promise((r) => { const i = ++id; pend.set(i, r); s.write(`${JSON.stringify({ id: i, method, args })}\n`); }), close: () => s.destroy() }));
  });
}

function startHostd(rig, baseEnv, extra = {}) {
  const logf = path.join(rig.H, `hostd-${Date.now()}.log`);
  const p = spawn(rig.appBin, ['--ozone-platform=wayland'], { cwd: rig.H, env: { ...baseEnv, ORCHESTRA_ROLE: 'hostd', ORCHESTRA_SELF_TUNE_CMD: '/bin/true', ...extra }, stdio: ['ignore', fs.openSync(logf, 'w'), fs.openSync(logf, 'a')], detached: true });
  return { p, logf };
}
async function waitFile(f, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fs.existsSync(f)) return true; await sleep(100); } return false; }
/** every orchestra.log under the rig home (the logger writes <ORCHESTRA_HOME>/logs + Electron's logs dir) */
const appLog = (rig) => { const out = []; const walk = (d, depth) => { if (depth > 4) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory() && !/^(wt-|repo|remote|home|cfg|keepers|events)/.test(e.name)) walk(f, depth + 1); else if (e.name === 'orchestra.log') { try { out.push(fs.readFileSync(f, 'utf8')); } catch { /* */ } } } }; walk(rig.H, 0); return [...new Set(out)].join('\n'); };
const logLines = (rig, re) => appLog(rig).split('\n').filter((l) => re.test(l));

/** One wake sample: OPS sends a row to w1; latency = CLI send exit → the fake API's first w1 request carrying "lot pending" after it. */
async function wakeSample(rig, api, cli, label, i) {
  const before = seen.length;
  const r = await cli(rig.spec.ops, ['send', '--type', KIND, '--to', rig.spec.workers[0].id, `hp ${label} sample ${i}`], { run: rig.spec.ops });
  const tCliExit = Date.now();
  const busr = startBusReader(rig, REPO);
  const row = (await busr.q("SELECT created_at FROM messages WHERE body LIKE ? ORDER BY sequence DESC LIMIT 1", `%hp ${label} sample ${i}%`))?.[0];
  busr.close();
  const tSent = row ? Number(row.created_at) : null;
  let hit = null;
  for (let k = 0; k < 600 && !hit; k++) { await sleep(100); hit = seen.slice(before).find((q) => q.role === 'w1' && q.wake); }
  await sleep(4000); // let the member check + ack so the next sample starts from a drained latch
  const ms = hit && tSent ? hit.t - tSent : null;
  HP(`wake.${label}.${i}`, { rowCreatedAt: tSent, cliStartToRowMs: tSent ? tSent - r.tStart : null, cliRunMs: tCliExit - r.tStart, sendRc: r.code, sendErr: r.err.slice(0, 160), latencyMs: ms, cold: i === 0, reqsAfter: seen.slice(before).map((q) => `${q.role}:${q.wake ? 'WAKE' : '-'}`).join(' '), firstTail: seen.slice(before)[0]?.tail?.slice(0, 160) ?? null });
  return ms;
}
const median = (a) => { const b = a.filter((x) => x !== null).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };

async function newRig(label, seedMode = 'none') {
  const spec = fleetSpec(1);
  const api = await startApi({ decide });
  const rig = await makeRig({ label, spec, apiUrl: api.url, appBin: APP, claudeBin: CLAUDE });
  HP(`${label}.seed`, seedRuns(rig, REPO, seedMode));
  const baseEnv = {
    PATH: `${rig.H}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: path.join(rig.H, 'home'), XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, SWAYSOCK: process.env.SWAYSOCK ?? '', ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: rig.H, CLAUDE_CONFIG_DIR: rig.cfg,
  };
  const cli = (who, args, o = {}) => runCli(rig, baseEnv, who, args, o);
  return { spec, api, rig, baseEnv, cli };
}
const keepers = (rig) => census(rig).filter((p) => kindOf(p) === 'keeper').map((p) => `${p.pid}@${p.startTicks}`);
const claudes = (rig) => census(rig).filter((p) => kindOf(p) === 'claude').map((p) => `${p.pid}@${p.startTicks}`);
const appProcs = (rig) => census(rig).filter((p) => kindOf(p) === 'app' && !/--type=/.test(p.cmd)).map((p) => `${p.pid}:${/ORCHESTRA_ROLE/.test(fs.readFileSync(`/proc/${p.pid}/environ`, 'utf8')) ? 'hostd' : 'app'}`);

// ═══ arm inapp: today's app = host; wake latency baseline ═══
if (ARMS.includes('inapp')) {
  const { api, rig, cli } = await newRig('inapp');
  const app = await launchApp(rig);
  await sleep(4000);
  HP('inapp.role', logLines(rig, /hostd-proto: role=/).pop() ?? 'MISSING');
  const lat = []; for (let i = 0; i < N; i++) lat.push(await wakeSample(rig, api, cli, 'inapp', i));
  HP('inapp.wake', { cold: lat[0], warmMedian: median(lat.slice(1)), all: lat });
  app.cdp.close(); HP('inapp.survivors', (await teardown(rig, app)).length); await api.stop();
}

// ═══ arms hostd + client + keeper: one rig, the daemon runs the host; then the app attaches; then app quit / hostd stop ═══
if (ARMS.some((a) => ['hostd', 'client', 'keeper'].includes(a))) {
  const { api, rig, baseEnv, cli } = await newRig('hostd');
  let hd = startHostd(rig, baseEnv);
  HP('hostd.attachSocketUp', await waitFile(path.join(rig.H, 'hostd-attach.sock')));
  await sleep(3000);
  HP('hostd.role', logLines(rig, /hostd-proto: role=|hostd ready/).slice(-2));
  HP('hostd.swayWindowsOfHostdPid', (() => { try { return (execFileSync('swaymsg', ['-t', 'get_tree'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SWAYSOCK: process.env.SWAYSOCK, XDG_RUNTIME_DIR: '/run/user/1000' } }).match(new RegExp(`"pid": ${hd.p.pid}\\b`, 'g')) ?? []).length; } catch (e) { return `n/a ${e}`; } })());
  HP('hostd.procs', appProcs(rig));
  const who = await cli(rig.spec.lead, ['whoami'], { run: rig.spec.lead });
  HP('hostd.cliWhoami', { rc: who.code, out: who.out.slice(0, 120), err: who.err.slice(0, 160) });
  const lat = []; for (let i = 0; i < N; i++) lat.push(await wakeSample(rig, api, cli, 'hostd', i));
  HP('hostd.wake', { cold: lat[0], warmMedian: median(lat.slice(1)), all: lat });
  const ins = await attach(rig.H);
  const ws = await ins.call('listWorkspaces');
  HP('hostd.listWorkspacesOverAttach', { n: ws.result?.length, statuses: ws.result?.map((w) => `${w.name}:${w.status}`), err: ws.error });
  HP('hostd.keepersAfterWakes', keepers(rig));

  let app = null;
  if (ARMS.includes('client') || ARMS.includes('keeper')) {
    // the app launched while hostd is up must become a CLIENT (decideRole: live lock + attach socket)
    app = await launchApp(rig);
    await sleep(5000);
    HP('client.role', logLines(rig, /hostd-proto: role=client|attached to hostd/).slice(-2));
    HP('client.procs', appProcs(rig));
    const rows = await app.cdp.eval(`window.orchestra.listWorkspaces().then((w) => w.map((x) => x.name + ':' + x.status))`).catch((e) => `ERR ${e}`);
    HP('client.listWorkspaces', rows);
    const domNames = await app.cdp.eval(`[...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /^pc-(lead|ops|w1)$/.test(e.textContent.trim())).map((e) => e.textContent.trim())`).catch((e) => `ERR ${e}`);
    HP('client.sidebarDomNames', domNames);
    const snap = await app.cdp.eval(`window.orchestra.busSnapshot(null).then((s) => ({ available: s.available, runs: (s.runs ?? []).length, err: s.error ?? null }))`).catch((e) => `ERR ${e}`);
    HP('client.busPaneSnapshot', snap);
    // live push: subscribe in the page, wake w1 through the hostd, count workspace:update pushes the page received
    await app.cdp.eval(`(window.__hp = [], window.orchestra.onWorkspaceUpdate((w) => window.__hp.push(Date.now() + ' ' + (w?.name ?? '?') + ':' + (w?.status ?? '?'))), 'ok')`).catch((e) => `ERR ${e}`);
    const l = await wakeSample(rig, api, cli, 'client', 1);
    await sleep(1500);
    HP('client.pushesSeenByRenderer', await app.cdp.eval(`window.__hp.slice(-8)`).catch((e) => `ERR ${e}`));
    HP('client.wakeWithClientAttached', l);
    // frontend-local methods forwarded to the windowless host — what breaks
    for (const [m, expr] of [['browserNavigate', `window.orchestra.browserNavigate?.(${JSON.stringify(rig.spec.workers[0].id)}, 'about:blank')`], ['revealLogs', 'window.orchestra.revealLogs?.()'], ['getAppVersion', 'window.orchestra.getAppVersion?.()']]) {
      HP(`client.frontendLocal.${m}`, await app.cdp.eval(`Promise.resolve(${expr}).then((r) => 'OK ' + JSON.stringify(r)?.slice(0, 120), (e) => 'ERR ' + String(e).slice(0, 200))`).catch((e) => `ERR ${e}`));
    }
    const shot = await app.cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) { fs.writeFileSync(path.join(rig.H, 'client.png'), Buffer.from(shot.result.data, 'base64')); HP('client.screenshot', path.join(rig.H, 'client.png')); }
    const errs = await app.cdp.eval(`(window.__errs ?? []).length`).catch(() => null);
    HP('client.consoleErrs', errs);
  }

  if (ARMS.includes('keeper')) {
    const k0 = keepers(rig), c0 = claudes(rig);
    HP('keeper.beforeAppQuit', { keepers: k0, claudes: c0 });
    app.cdp.close(); app.kill(); await sleep(3000);
    HP('keeper.afterAppQuit', { keepers: keepers(rig), claudes: claudes(rig), sameKeeper: JSON.stringify(keepers(rig)) === JSON.stringify(k0), procs: appProcs(rig) });
    HP('keeper.wakeAfterAppQuit', await wakeSample(rig, api, cli, 'afterAppQuit', 1));
    process.kill(-hd.p.pid, 'SIGTERM'); await sleep(4000);
    HP('keeper.afterHostdStop', { keepers: keepers(rig), claudes: claudes(rig), sameKeeper: JSON.stringify(keepers(rig)) === JSON.stringify(k0), procs: appProcs(rig), lockLeft: fs.existsSync(path.join(rig.H, 'hostd.lock')), attachSockLeft: fs.existsSync(path.join(rig.H, 'hostd-attach.sock')) });
    // a send while NO host runs: the row is durable; the next host's wake loop must deliver it
    const before = seen.length;
    const r = await cli(rig.spec.ops, ['send', '--type', KIND, '--to', rig.spec.workers[0].id, 'hp sent while no host'], { run: rig.spec.ops });
    const tSent = Date.now();
    HP('keeper.sendWithNoHost', { rc: r.code, err: r.err.slice(0, 200) });
    hd = startHostd(rig, baseEnv);
    await waitFile(path.join(rig.H, 'hostd-attach.sock'));
    let hit = null; for (let k = 0; k < 600 && !hit; k++) { await sleep(100); hit = seen.slice(before).find((q) => q.role === 'w1' && q.wake); }
    HP('keeper.deliveredByNextHostd', { latencyFromSendMs: hit ? hit.t - tSent : null, keepers: keepers(rig), sameKeeper: JSON.stringify(keepers(rig)) === JSON.stringify(k0) });
  }
  ins.close();
  try { process.kill(-hd.p.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(3000);
  HP('hostd.survivors', (await teardown(rig, null)).length); await api.stop();
}

// ═══ must-FAIL arm spoolgate: hostd with today's gate (`hasAttachedUi` = a client is attached) and NO client — does activity freeze? ═══
if (ARMS.includes('spoolgate')) {
  for (const gate of ['attached', 'off']) {
    const { api, rig, baseEnv, cli } = await newRig(`spool-${gate}`);
    const hd = startHostd(rig, baseEnv, gate === 'attached' ? { ORCHESTRA_PROTO_SPOOL_GATE: 'attached' } : {});
    await waitFile(path.join(rig.H, 'hostd-attach.sock')); await sleep(3000);
    await wakeSample(rig, api, cli, `spool-${gate}`, 0);
    await sleep(2000);
    // read the hostd's activity view WITHOUT attaching (attaching would open the gate): store.json is the hostd's persisted view
    const st = JSON.parse(fs.readFileSync(path.join(rig.H, 'userData/orchestra/store.json'), 'utf8')).workspaces.find((w) => w.name === 'pc-w1');
    const spoolDir = path.join(rig.H, 'events');
    const spool = (() => { try { return fs.readdirSync(spoolDir).map((f) => `${f}:${fs.statSync(path.join(spoolDir, f)).size}`); } catch (e) { return `ERR ${e.code}`; } })();
    HP(`spoolgate.${gate}`, { w1Status: st?.status, lastActivityAt: st?.lastActivityAt ?? st?.lastActiveAt ?? null, spool, livenessLines: logLines(rig, /spool|events-spool/).slice(-3) });
    try { process.kill(-hd.p.pid, 'SIGTERM'); } catch { /* gone */ }
    await sleep(3000); await teardown(rig, null); await api.stop();
  }
}

// ═══ must-FAIL arm forcehost: an app that IGNORES the hostd and tries to be the host too ═══
if (ARMS.includes('forcehost')) {
  const { api, rig, baseEnv } = await newRig('forcehost');
  const hd = startHostd(rig, baseEnv);
  await waitFile(path.join(rig.H, 'hostd-attach.sock')); await sleep(3000);
  const sock0 = fs.readFileSync(path.join(rig.H, 'sock'), 'utf8');
  const logf = path.join(rig.H, 'forcehost.log');
  const p = spawn(rig.appBin, ['--ozone-platform=wayland'], { cwd: rig.H, env: { ...baseEnv, ORCHESTRA_PROTO_FORCE_HOST: '1' }, stdio: ['ignore', fs.openSync(logf, 'w'), fs.openSync(logf, 'a')] });
  const code = await new Promise((r) => { const t = setTimeout(() => r('still-running-after-20s'), 20000); p.on('exit', (c) => { clearTimeout(t); r(c); }); });
  HP('forcehost.secondHost', { exit: code, lockLine: logLines(rig, /another Orchestra instance/).pop() ?? null, sockPointerUnchanged: fs.readFileSync(path.join(rig.H, 'sock'), 'utf8') === sock0, roles: logLines(rig, /hostd-proto: role=/).slice(-3) });
  try { p.kill(); } catch { /* gone */ }
  try { process.kill(-hd.p.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(3000); await teardown(rig, null); await api.stop();
}
// ═══ must-FAIL arm wakeoff: the same hostd + instrument with the run's frozen `wake` switch OFF — no wake may be measured ═══
if (ARMS.includes('wakeoff')) {
  const { api, rig, baseEnv, cli } = await newRig('wakeoff', 'wake-off');
  const hd = startHostd(rig, baseEnv);
  await waitFile(path.join(rig.H, 'hostd-attach.sock')); await sleep(3000);
  HP('wakeoff.wake', await wakeSample(rig, api, cli, 'wakeoff', 0));
  try { process.kill(-hd.p.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(3000); await teardown(rig, null); await api.stop();
}

// ═══ must-FAIL arm hostdgone: the client's data must come FROM the hostd — kill the hostd under an attached client ═══
if (ARMS.includes('hostdgone')) {
  const { api, rig, baseEnv } = await newRig('hostdgone');
  const hd = startHostd(rig, baseEnv);
  await waitFile(path.join(rig.H, 'hostd-attach.sock')); await sleep(3000);
  const app = await launchApp(rig); await sleep(5000);
  const ls = () => app.cdp.eval(`window.orchestra.listWorkspaces().then((w) => 'OK ' + w.length, (e) => 'ERR ' + String(e).slice(0, 160))`).catch((e) => `ERR ${e}`);
  HP('hostdgone.before', await ls());
  process.kill(-hd.p.pid, 'SIGKILL'); await sleep(2000);
  HP('hostdgone.after', { list: await ls(), clientAlive: (() => { try { process.kill(app.app.pid, 0); return true; } catch { return false; } })(), orphanLine: logLines(rig, /orphaned/).pop() ?? null, lockLeft: fs.existsSync(path.join(rig.H, 'hostd.lock')), attachSockLeft: fs.existsSync(path.join(rig.H, 'hostd-attach.sock')) });
  app.cdp.close(); await teardown(rig, app); await api.stop();
}
say('HP-DONE');

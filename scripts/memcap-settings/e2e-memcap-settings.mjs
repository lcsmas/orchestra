// #323 (wave H, ledger #329; D-Q10 = A + A) — the Plafond mémoire levels in the Memory guard window and the usage-vs-cap bar on Resources, driven on the BUILT app inside the contained rig's own headless sway
// (scripts/memcap-settings/e2e-memcap-settings.sh), REAL keepers in REAL disposable user scopes (prefix `orchestra-rig-wh-h2c-…`, ≤ 300 MB: the hard level is typed down to 0.25 GB through the window), a stub `claude`.
//   levels    ★ the window: the Plafond section is there with the stored 3 / 6 GB and the READ-ONLY switch line; soft 0.1 + hard 0.25 commit through the UI; a pair with soft ≥ hard is REFUSED inline and NOTHING is written
//                (store.json on disk + the settings read back by IPC unchanged)
//   members   ★ the next started member gets the levels: w1 started after (0.1 / 0.25) → its scope holds MemoryMax = 0.25 GiB; the levels are then changed (0.15 / 0.3) and w2 started → 0.3 GiB, while w1 keeps 0.25
//   resources ★ the Resources page shows each capped member's usage against ITS cap: the bar under MEM (fill = bill / the kernel's hard level), the tooltip naming both figures + « settings now say hard 0.3 GB » for w1, the dim summary line;
//                a member crossing the soft level (working set, a real 130 MB allocation) turns AMBER; a member with no scope has no bar
// State assertions AND decoded screenshots. Containment as scripts/pause-ui: scratch ORCHESTRA_HOME/HOME/CLAUDE_CONFIG_DIR, nothing live touched; every scope and process of the rig is stopped BY NAME / IDENTITY at the end and the survivors printed (G5).
// Usage (via the .sh): <app-dir | --packaged <bin>> --live-home <real $HOME> [--out dir] [--label name] [--expect-red]
//   --expect-red  the must-FAIL arm: against a build WITHOUT the feature (master) every G-clause must be RED and every ctl/* clause GREEN.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FLEET, IDS, buildWorld, crop, decodePng, diffPx, distinctColours, launchApp, liveBusOpenedBy, liveCanary, makeGuard, makeRecorder, pixelsNear, sh, sleep, waitFor } from '../pause-ui/lib.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PACKAGED = flag('--packaged', null);
const APP_DIR = !PACKAGED && argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', PACKAGED ? path.basename(path.dirname(PACKAGED)) : APP_DIR ? path.basename(APP_DIR) : 'app');
const EXPECT_RED = argv.includes('--expect-red');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!APP_DIR && !PACKAGED) { console.log('REFUSED: no <app-dir> / --packaged'); process.exit(3); }
const guard = makeGuard({ liveHome: LIVE_HOME, rigDir: RIG_DIR, rigWayland: RIG_WAYLAND });
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
const rec = makeRecorder(OUT);
const { clause, saveShot } = rec;
const J = JSON.stringify;
const arm = 'cap';
const GIB = 1024 ** 3;
const PFX = `orchestra-rig-wh-h2c-${process.pid.toString(36)}-`;
const AMBER = [255, 200, 87];

const units = (glob) => spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', '--plain', glob], { encoding: 'utf8' }).stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
const unitProp = (u, p) => (spawnSync('systemctl', ['--user', 'show', '-p', p, u], { encoding: 'utf8' }).stdout.trim().split('=')[1] ?? '');

// the stub CLI: speaks just enough stream-json for one turn; `SCN:hog` allocates 130 MB INSIDE its own process tree (a tool-like child, not detached), `SCN:hello` just answers
const STUB = `#!/usr/bin/env node
const fs = require('fs'), cp = require('child_process');
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('2.1.291 (Claude Code)'); process.exit(0); }
const ws = process.env.ORCHESTRA_WS_ID || require('path').basename(process.cwd());
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const log = (o) => fs.appendFileSync(process.env.ORCHESTRA_HOME + '/stub-' + ws + '.log', JSON.stringify({ t: Date.now(), ...o }) + '\\n');
log({ ev: 'start', pid: process.pid, cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8').trim(), runId: process.env.ORCHESTRA_RUN_ID || null });
let buf = '';
process.stdin.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.type === 'control_request') out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: m.request?.subtype === 'initialize' ? { commands: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } : {} } });
  if (m.type === 'user') {
    const text = JSON.stringify(m.message || m);
    if (text.includes('SCN:hog')) { cp.spawn('python3', ['-c', "import time\\nb=bytearray(b'\\\\xa5')*(130*1024*1024)\\ntime.sleep(900)\\n", 'h2c-hog'], { stdio: 'ignore' }); log({ ev: 'hog' }); }
    out({ type: 'system', subtype: 'init', session_id: 'stub-' + ws, cwd: process.cwd(), model: 'stub', tools: [], mcp_servers: [], permissionMode: 'default' });
    out({ type: 'assistant', message: { id: 'm1', type: 'message', role: 'assistant', model: 'stub', content: [{ type: 'text', text: 'stub ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, session_id: 'stub-' + ws });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'stub ok', session_id: 'stub-' + ws, num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  }
} });
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
`;

const key = (cdp, k, code) => cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code }).then(() => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code }));
const typeInto = async (cdp, sel, text, how) => {
  const r = await cdp.eval(`(() => { const e = document.querySelector(${J(sel)}); e.focus(); e.select(); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await cdp.click(r.x, r.y);
  await cdp.eval(`document.querySelector(${J(sel)}).select()`);
  await cdp.send('Input.insertText', { text });
  if (how === 'enter') await key(cdp, 'Enter', 13);
  else { const t = await cdp.eval(`(() => { const b = document.querySelector('[aria-label="Memory guard"] h2').getBoundingClientRect(); return { x: b.left + 6, y: b.top + b.height / 2 }; })()`); await cdp.click(t.x, t.y); }
  await sleep(500);
};
const dom = (cdp) => cdp.eval(`(() => {
  const q = (s) => document.querySelector(s);
  return { open: !!q('[aria-label="Memory guard"]'), soft: q('[data-mg-cap-soft]')?.value ?? null, hard: q('[data-mg-cap-hard]')?.value ?? null, admission: q('[data-mg-admission]')?.value ?? null, critical: q('[data-mg-critical]')?.value ?? null,
    error: q('[data-mg-error]')?.textContent.trim() ?? null, sw: q('[data-mg-cap-switch]')?.textContent.trim() ?? null, swAttr: q('[data-mg-cap-switch]')?.getAttribute('data-mg-cap-switch') ?? null, section: !!q('[data-mg-cap-section]'),
    toggles: document.querySelectorAll('[aria-label="Memory guard"] input[type=checkbox]').length, applies: q('[data-mg-cap-applies]')?.textContent.trim() ?? null };
})()`);
const readStore = (world) => { try { return JSON.parse(fs.readFileSync(path.join(world.ohome, 'userData', 'orchestra', 'store.json'), 'utf8')).memoryGuard ?? null; } catch { return null; } };
const capRows = (cdp) => cdp.eval(`[...document.querySelectorAll('.res-agent-row')].map((r) => { const b = r.querySelector('[data-res-cap]'); return { name: r.querySelector('.res-agent-branch')?.textContent ?? '', pct: b ? Number(b.getAttribute('data-res-cap')) : null, tone: b?.getAttribute('data-res-cap-tone') ?? null, title: b?.getAttribute('title') ?? null, hasTick: !!b?.querySelector('.res-capbar-soft'), hasWs: !!b?.querySelector('.res-capbar-ws') }; })`);

async function armCap() {
  const armDir = path.join(RIG_DIR, `arm-${LABEL}-${arm}`);
  fs.mkdirSync(armDir, { recursive: true });
  const world = buildWorld(armDir, guard);
  const startedUnits = new Set();
  console.log(`\n== arm ${LABEL}/${arm} == scratch ${armDir} · scope prefix ${PFX}`);
  fs.writeFileSync(path.join(world.bin, 'claude'), STUB, { mode: 0o755 });
  // the guard's Admission hold must not interfere with an explicit session start on a loaded host; the LEVELS are set through the window, not here
  const sp = path.join(world.ohome, 'userData', 'orchestra', 'store.json');
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  st.memoryGuard = { admissionGb: 6, criticalGb: 3, admissionEnabled: false, capSoftGb: 3, capHardGb: 6 };
  fs.writeFileSync(sp, JSON.stringify(st, null, 2));
  const before = new Set(units(`${PFX}*`));
  let a = null;
  try {
    a = await launchApp({ appDir: APP_DIR, packaged: PACKAGED, world, guard, rigWayland: RIG_WAYLAND, size: [1440, 900], tag: arm, extraEnv: { ORCHESTRA_MEMORY_SCOPE_PREFIX: PFX } });
    const cdp = a.cdp;
    const where = a.target.url;
    clause(arm, 'ctl/app-identity-path', PACKAGED ? where.includes(path.dirname(PACKAGED)) : where.includes(APP_DIR) && !where.includes('app.asar'), `target url ${where}`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-item').length`).then((n) => n >= FLEET.length), 60000, 'workspace rows');
    clause(arm, 'ctl/no-rig-scope-before', units(`${PFX}*`).length === 0, `rig scopes at start: ${units(`${PFX}*`).join(',') || 'none'}`);

    // ─── 1. the window ────────────────────────────────────────────────────────────────────────────
    const btn = await cdp.eval(`(() => { const e = document.querySelector('[aria-label="Memory guard settings"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await cdp.click(btn.x, btn.y);
    const d0 = await waitFor(async () => { const d = await dom(cdp); return d.open && d.soft !== null && d.soft !== '' ? d : null; }, 20000, 'the Memory guard window with its values');
    clause(arm, 'G1/window-has-the-plafond-section-with-the-stored-levels', d0.section && d0.soft === '3' && d0.hard === '6' && d0.admission === '6' && d0.critical === '3', J(d0));
    clause(arm, 'G1/activation-is-shown-read-only-from-the-frozen-run-switches', /^Cap is (ON|OFF) for new runs · ON on \d+ of \d+ open runs/.test(d0.sw ?? '') && /ON on [1-9]/.test(d0.sw ?? '') && d0.toggles === 1, `"${d0.sw}" (the seeded runs froze memory_cap ON); checkboxes in the window: ${d0.toggles} (the Admission toggle only — no control for the switch)`);
    clause(arm, 'G1/window-says-levels-apply-to-members-started-from-now-on', /started from now on/.test(d0.applies ?? ''), `"${d0.applies}"`);
    await cdp.mouse(5, 890); await sleep(300); await cdp.eval('document.fonts.ready.then(() => true)');
    const winClip = await cdp.eval(`(() => { const b = document.querySelector('[aria-label="Memory guard"]').getBoundingClientRect(); return { x: Math.max(0, b.left - 8), y: Math.max(0, b.top - 8), width: Math.min(1440, b.width + 16), height: Math.min(900, b.height + 16) }; })()`);
    const shotWin0 = await cdp.shot(winClip); saveShot(`${LABEL}-1-window-defaults.png`, shotWin0);
    clause(arm, 'ctl/window-frame-painted', distinctColours(decodePng(shotWin0)) > 30, `${distinctColours(decodePng(shotWin0))} colours`);

    // soft FIRST (0.1 < the stored hard 6 is a valid pair), then hard 0.25 (> 0.1)
    await typeInto(cdp, '[data-mg-cap-soft]', '0.1', 'enter');
    const d1 = await waitFor(async () => { const d = await dom(cdp); return d.soft === '0.1' && readStore(world)?.capSoftGb === 0.1 ? d : null; }, 10000, 'soft 0.1 committed');
    clause(arm, 'G2/soft-level-commits-through-the-ui-and-is-persisted', d1.error === null && readStore(world)?.capSoftGb === 0.1 && readStore(world)?.capHardGb === 6, `window ${J({ soft: d1.soft, hard: d1.hard, error: d1.error })}; store.json memoryGuard ${J(readStore(world))}`);
    await typeInto(cdp, '[data-mg-cap-hard]', '0.25', 'blur');
    await waitFor(async () => readStore(world)?.capHardGb === 0.25, 10000, 'hard 0.25 committed');
    clause(arm, 'G2/hard-level-commits-on-blur', readStore(world)?.capHardGb === 0.25 && readStore(world)?.capSoftGb === 0.1, J(readStore(world)));

    // ─── 2. the refusal: soft ≥ hard — inline, nothing written ──────────────────────────────────
    const storeBefore = J(readStore(world));
    const viewBefore = await cdp.eval(`window.orchestra.memoryGuard().then((v) => JSON.stringify(v.settings))`);
    await typeInto(cdp, '[data-mg-cap-soft]', '0.3', 'blur');
    await sleep(800);
    const dBad = await dom(cdp);
    const viewAfter = await cdp.eval(`window.orchestra.memoryGuard().then((v) => JSON.stringify(v.settings))`);
    clause(arm, 'G3/invalid-pair-refused-inline-with-the-reason', /soft level \(0\.3 GB\) must be above 0 and below the hard level \(0\.25 GB\)/.test(dBad.error ?? ''), `error line: "${dBad.error}"`);
    clause(arm, 'G3/invalid-pair-writes-nothing', J(readStore(world)) === storeBefore && viewBefore === viewAfter && JSON.parse(viewAfter).capSoftGb === 0.1, `store.json before ${storeBefore} after ${J(readStore(world))}; settings by IPC before ${viewBefore} after ${viewAfter}`);
    const winClipBad = await cdp.eval(`(() => { const b = document.querySelector('[aria-label="Memory guard"]').getBoundingClientRect(); return { x: Math.max(0, b.left - 8), y: Math.max(0, b.top - 8), width: Math.min(1440, b.width + 16), height: Math.min(900, b.height + 16) }; })()`);
    const shotBad = await cdp.shot(winClipBad); saveShot(`${LABEL}-2-window-refusal.png`, shotBad);
    clause(arm, 'G3/refusal-is-visible-red-text-in-the-frame', pixelsNear(decodePng(shotBad), [255, 107, 107], 40) > 40, `${pixelsNear(decodePng(shotBad), [255, 107, 107], 40)} red px in the window frame`);
    await typeInto(cdp, '[data-mg-cap-soft]', '0.1', 'enter'); // back to the committed value: the refusal clears
    await waitFor(async () => (await dom(cdp)).error === null, 8000, 'the refusal to clear');
    const shotOk = await cdp.shot(winClipBad); saveShot(`${LABEL}-3-window-levels-set.png`, shotOk);

    // close the window (Done) and start the first member
    await cdp.eval(`[...document.querySelectorAll('[aria-label="Memory guard"] button')].find((b) => /Done/.test(b.textContent))?.click(); true`);

    // ─── 3. the next started member gets the levels ──────────────────────────────────────────────
    const stubLog = (k) => { try { return fs.readFileSync(path.join(world.ohome, `stub-${IDS[k]}.log`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
    const scopeOf = (k) => units(`${PFX}${IDS[k]}-*`);
    const send = (k, text) => cdp.eval(`window.orchestra.agentSdkSend(${J(IDS[k])}, ${J(text)})`).catch((e) => `ERR ${e}`);
    await send('w1', 'SCN:hello');
    await waitFor(() => stubLog('w1').some((e) => e.ev === 'start'), 40000, 'w1 stub started by its keeper');
    await sleep(2500);
    const w1u = scopeOf('w1'); for (const u of w1u) startedUnits.add(u);
    clause(arm, 'G4/member-started-after-the-change-gets-the-new-hard-level', w1u.length === 1 && Math.abs(Number(unitProp(w1u[0], 'MemoryMax')) - 0.25 * GIB) <= 65536, `scopes ${J(w1u)}; MemoryMax ${w1u[0] ? unitProp(w1u[0], 'MemoryMax') : '—'} (want ${0.25 * GIB} ±1 page); MemorySwapMax ${w1u[0] ? unitProp(w1u[0], 'MemorySwapMax') : '—'}`);

    // change the levels again (soft 0.15 < the stored hard 0.25 is valid; then hard 0.3)
    await cdp.click(btn.x, btn.y);
    await waitFor(async () => (await dom(cdp)).open, 10000, 'the window again');
    await typeInto(cdp, '[data-mg-cap-soft]', '0.15', 'enter');
    await waitFor(async () => readStore(world)?.capSoftGb === 0.15, 10000, 'soft 0.15');
    await typeInto(cdp, '[data-mg-cap-hard]', '0.3', 'enter');
    await waitFor(async () => readStore(world)?.capHardGb === 0.3, 10000, 'hard 0.3');
    await cdp.eval(`[...document.querySelectorAll('[aria-label="Memory guard"] button')].find((b) => /Done/.test(b.textContent))?.click(); true`);
    await send('w2', 'SCN:hello');
    await waitFor(() => stubLog('w2').some((e) => e.ev === 'start'), 40000, 'w2 stub started by its keeper');
    await sleep(2500);
    const w2u = scopeOf('w2'); for (const u of w2u) startedUnits.add(u);
    clause(arm, 'G4/the-next-member-gets-the-changed-level-and-the-running-one-keeps-its-own', w2u.length === 1 && Math.abs(Number(unitProp(w2u[0], 'MemoryMax')) - 0.3 * GIB) <= 65536 && Math.abs(Number(unitProp(scopeOf('w1')[0], 'MemoryMax')) - 0.25 * GIB) <= 65536, `w2 MemoryMax ${w2u[0] ? unitProp(w2u[0], 'MemoryMax') : '—'} (want ${Math.round(0.3 * GIB)}); w1 still ${scopeOf('w1')[0] ? unitProp(scopeOf('w1')[0], 'MemoryMax') : '—'} (want ${0.25 * GIB})`);
    clause(arm, 'ctl/a-member-without-a-session-has-no-scope', scopeOf('w3').length === 0, `w3 scopes: ${J(scopeOf('w3'))}`);

    // ─── 4. the Resources page ───────────────────────────────────────────────────────────────────
    const resBtn = await cdp.eval(`(() => { const e = document.querySelector('[aria-label="Open the Resources page"]'); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await cdp.click(resBtn.x, resBtn.y);
    const rows = await waitFor(async () => { const r = await capRows(cdp); return r.filter((x) => x.pct !== null).length >= 2 ? r : null; }, 40000, 'two capped rows with a bar');
    const w1r = rows.find((r) => r.name === FLEET.find((f) => f[0] === 'w1')[1]), w2r = rows.find((r) => r.name === FLEET.find((f) => f[0] === 'w2')[1]), w3r = rows.find((r) => r.name === FLEET.find((f) => f[0] === 'w3')?.[1]);
    clause(arm, 'G5/capped-members-show-a-bar-against-the-limit-the-kernel-holds', w1r?.pct != null && w2r?.pct != null && w1r.hasTick && w1r.hasWs && /hard 0\.25 GB \(held by the kernel for this session\)/.test(w1r.title ?? '') && /hard 0\.3 GB \(held by the kernel for this session\)/.test(w2r.title ?? ''), J({ w1: w1r, w2: w2r }));
    clause(arm, 'G5/tooltip-says-the-settings-moved-since-w1-started', /settings now say hard 0\.3 GB/.test(w1r?.title ?? '') && !/settings now say/.test(w2r?.title ?? ''), `w1: ${w1r?.title}; w2: ${w2r?.title}`);
    clause(arm, 'G5/a-member-with-no-scope-has-no-bar', !w3r || w3r.pct === null, J(w3r ?? 'no row'));
    const note = await cdp.eval(`document.querySelector('[data-res-cap-note]')?.textContent ?? null`);
    clause(arm, 'G5/dim-summary-line-counts-the-capped-members', /^2 capped members · closest: /.test(note ?? ''), `"${note}"`);
    await cdp.mouse(5, 890); await sleep(500); await cdp.eval('document.fonts.ready.then(() => true)');
    const tbl = await cdp.eval(`(() => { const b = document.querySelector('.res-table').getBoundingClientRect(); return { x: Math.max(0, b.left), y: Math.max(0, b.top - 4), width: Math.min(1440 - b.left, b.width), height: Math.min(380, b.height + 60) }; })()`);
    const shotRes0 = await cdp.shot(tbl); saveShot(`${LABEL}-4-resources-capped-rows.png`, shotRes0);
    clause(arm, 'ctl/resources-frame-painted', distinctColours(decodePng(shotRes0)) > 30, `${distinctColours(decodePng(shotRes0))} colours`);

    // the soft level crossed: w1's working set (a real 130 MB allocation in its tree) ≥ the soft level NOW (0.15 GB) ⇒ AMBER
    await send('w1', 'SCN:hog');
    const amber = await waitFor(async () => { const r = (await capRows(cdp)).find((x) => x.name === FLEET.find((f) => f[0] === 'w1')[1]); return r && r.tone === 'warn' ? r : null; }, 30000, 'w1 bar amber').catch(() => null);
    clause(arm, 'G6/working-set-over-the-soft-level-turns-the-bar-amber', !!amber, J((await capRows(cdp)).find((x) => x.name === FLEET.find((f) => f[0] === 'w1')[1])));
    await cdp.mouse(5, 890); await sleep(600);
    const shotRes1 = await cdp.shot(tbl); saveShot(`${LABEL}-5-resources-amber.png`, shotRes1);
    clause(arm, 'G6/amber-pixels-in-the-capture', pixelsNear(decodePng(shotRes1), AMBER, 28) > pixelsNear(decodePng(shotRes0), AMBER, 28) + 8, `amber px ${pixelsNear(decodePng(shotRes0), AMBER, 28)} → ${pixelsNear(decodePng(shotRes1), AMBER, 28)}`);
    clause(arm, 'G6/the-capture-changed-between-ok-and-amber', diffPx(decodePng(shotRes0), decodePng(shotRes1), 12) > 40, `${diffPx(decodePng(shotRes0), decodePng(shotRes1), 12)} px differ`);
    const live = liveBusOpenedBy(world.ohome, LIVE_HOME);
    clause(arm, 'ctl/live-bus-never-opened', live.holders.length === 0 && live.opened === path.join(world.ohome, 'bus.sqlite'), `the app opened ${live.opened}; rig processes holding ~/.orchestra/bus.sqlite: ${live.holders.join(',') || 'none'}`);
  } catch (e) {
    clause(arm, 'G0/arm-completed', false, `ARM ABORTED: ${e.stack || e}`);
  } finally {
    if (a) { a.cdp.close(); const left = await a.kill(); clause(arm, 'ctl/teardown-no-survivor-processes', left.length === 0, `processes still carrying ${world.ohome}: ${left.join(',') || 'none'}`); }
    // the scopes THIS rig created (its own prefix), stopped by name; anything else is untouched
    for (const u of units(`${PFX}*`)) if (!before.has(u)) spawnSync('systemctl', ['--user', 'stop', u], { encoding: 'utf8' });
    await sleep(1500);
    const lefts = units(`${PFX}*`).filter((u) => !before.has(u));
    clause(arm, 'ctl/teardown-no-leftover-scope', lefts.length === 0, `leftover rig scopes: ${lefts.join(',') || 'none'}`);
    clause(arm, 'ctl/rig-created-only-its-prefix', [...startedUnits].every((u) => u.startsWith(PFX)), J([...startedUnits]));
  }
}

const canaryBefore = liveCanary(LIVE_HOME);
console.log(`[rig] app ${APP_DIR ?? PACKAGED} label ${LABEL} expect-red=${EXPECT_RED} out=${OUT}`);
await armCap();
clause('rig', 'ctl/live-dirs-untouched', J(canaryBefore) === J(liveCanary(LIVE_HOME)), `${Object.keys(canaryBefore).length} live ~/.claude* dirs checked before/after`);
console.log('\n== shots (md5) ==');
for (const s of rec.shots) console.log(`  ${s.md5}  ${s.file}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR ?? PACKAGED, label: LABEL, results: rec.results, shots: rec.shots }, null, 2));
const isCtl = (c) => c.clause.startsWith('ctl/');
const ctlRed = rec.results.filter((c) => isCtl(c) && !c.ok), gAll = rec.results.filter((c) => !isCtl(c)), gRed = gAll.filter((c) => !c.ok);
let verdict, rc;
if (EXPECT_RED) {
  ({ verdict, rc } = ctlRed.length === 0 && gAll.length > 0 && gRed.length === gAll.length ? { verdict: `EXPECTED-RED CONFIRMED: ${gRed.length}/${gAll.length} G-clauses red, every ctl/* green`, rc: 0 } : { verdict: `EXPECTED-RED NOT MET: ${gRed.length}/${gAll.length} G-clauses red; controls red: ${ctlRed.map((c) => c.clause).join('; ') || 'none'}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && gRed.length === 0 && gAll.length > 0 ? { verdict: `ALL GREEN: ${rec.results.length} clauses (${gAll.length} G, ${rec.results.length - gAll.length} control)`, rc: 0 } : { verdict: `RED: ${rec.results.filter((c) => !c.ok).map((c) => c.clause).join('; ')}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(rc);

// #341 — built-in command output (`/recap` …) rendered as a `command-output` row, LIVE and after reopen, in the BUILT app under the contained rig's own headless sway.
// Real path end to end: composer → agentSdkSend → SDK query() → detached keeper → the REAL `claude` CLI → a LOCAL FAKE Anthropic API (zero tokens, no login), inside bwrap net+pid namespaces
// (scripts/command-output/e2e-command-output.sh). The backfill arm opens a workspace whose on-disk transcript is the REAL capture (scripts/fixtures/payloads/local-command.capture.json).
// Usage (via the .sh): <app-dir> --live-home <real $HOME> --claude <abs path of the real CLI> --containment netns+pidns [--out dir] [--label name] [--expect fixed|master]
//   --expect master = the must-FAIL arm against a build WITHOUT the fix: the bubble shows, the output row does NOT (the ticket's symptom, reproduced on the real app).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Cdp, REPO, crop, decodePng, distinctColours, git, launchApp, liveBusOpenedBy, liveCanary, makeGuard, makeRecorder, md5, sh, sleep, waitFor } from '../pause-ui/lib.mjs';
import { startFakeApi } from '../session-budget/fake-anthropic-api.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const EXPECT = flag('--expect', 'fixed');
const CLAUDE_ABS = flag('--claude', null);
const CONTAINMENT = flag('--containment', '<unset>');
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!APP_DIR) { console.log('REFUSED: no <app-dir>'); process.exit(3); }
if (!['fixed', 'master'].includes(EXPECT)) { console.log(`REFUSED: --expect ${EXPECT}`); process.exit(3); }
const guard = makeGuard({ liveHome: LIVE_HOME, rigDir: RIG_DIR, rigWayland: RIG_WAYLAND });
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
const rec = makeRecorder(OUT);
const { clause } = rec;
const FIXED = EXPECT === 'fixed';

const CAPTURE = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/fixtures/payloads/local-command.capture.json'), 'utf8'));
const RECAP_TEXT = 'Goal: ship the fix for the checkout bug.\nDone: reproduced it, wrote the failing test.\nNext: patch the rounding in totals.ts and rerun the suite.';
const HIST_SID = CAPTURE.transcript.find((l) => l.sessionId).sessionId;
const XML_RE = /<\/?local-command|<command-(name|message|args)>/;
const mangle = (p) => fs.realpathSync(p).replace(/[^A-Za-z0-9]/g, '-');

// ── the containment evidence: the fake API's own view of what the CLI reached for ──────────────────────
const api = await startFakeApi({ reply: (r) => ({ text: r.messages < 3 ? 'Fake assistant reply for the probe.' : RECAP_TEXT }) });

function buildWorld(armDir) {
  const home = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repo = path.join(armDir, 'repo'), bin = path.join(armDir, 'bin');
  for (const d of [home, ohome, cfg, repo, bin, path.join(ohome, 'userData', 'orchestra')]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: home, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo })) guard.mustBeScratch(k, v);
  if (!CLAUDE_ABS) { console.log('REFUSED: --claude <abs path> missing'); process.exit(3); }
  const realClaude = fs.realpathSync(CLAUDE_ABS);
  fs.symlinkSync(realClaude, path.join(bin, 'claude'));
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5 }));
  git(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  const wts = {};
  for (const k of ['hist', 'live']) { wts[k] = path.join(armDir, `wt-${k}`); git(repo, 'worktree', 'add', '-q', '-b', `cmd-${k}`, wts[k]); }
  // The REAL transcript, filed exactly where the app's sdkHistory() looks: <account configDir>/projects/<mangled worktree>/<session>.jsonl.
  const projDir = path.join(cfg, 'projects', mangle(wts.hist));
  fs.mkdirSync(projDir, { recursive: true });
  const lines = CAPTURE.transcript.map((l) => ({ ...l, cwd: fs.realpathSync(wts.hist) }));
  fs.writeFileSync(path.join(projDir, `${HIST_SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // The account is the app's OWN per-account env mechanism: key + base URL point the REAL CLI at the fake API; the proxy records (and refuses) any other egress.
  const account = { id: 'rig-341', label: 'rig 341 (scratch)', configDir: cfg, env: { ANTHROPIC_API_KEY: 'sk-ant-dummy-341', ANTHROPIC_BASE_URL: api.url, HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, NO_PROXY: '127.0.0.1,localhost' } };
  const mk = (k, i, extra = {}) => ({ id: `ws-341-${k}`, name: `cmd-${k}`, repoPath: repo, worktreePath: wts[k], branch: `cmd-${k}`, baseBranch: 'master', createdAt: Date.now() - (2 - i) * 60000, status: 'idle', agent: 'claude', accountId: account.id, ...extra });
  const workspaces = [mk('hist', 0, { sdkSessionId: HIST_SID, hasInput: true }), mk('live', 1)];
  fs.writeFileSync(path.join(ohome, 'userData', 'orchestra', 'store.json'), JSON.stringify({ repos: [{ path: repo, name: 'repo341', defaultBranch: 'master', scripts: {}, accountId: account.id }], workspaces, accounts: [account], selfTuneRuns: [] }, null, 2));
  return { home, ohome, cfg, repo, bin, workspaces, account, realClaude, histTranscript: path.join(projDir, `${HIST_SID}.jsonl`) };
}

// ── drive helpers (trusted input; DOM = state oracle, screenshots = paint oracle) ─────────────────────
const ROWS_JS = `(() => {
  const l = [...document.querySelectorAll('.av-message-list')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 50 && r.height > 50; });
  if (!l) return null;
  return [...l.querySelectorAll('[data-notice], .av-message')].filter((e) => !(e.matches('.av-message') && e.closest('[data-notice]'))).map((e) => {
    const n = e.getAttribute('data-notice');
    const r = e.getBoundingClientRect();
    if (n) { const pre = e.querySelector('pre'); return { k: 'notice:' + n, text: (pre ? pre.innerText : e.innerText).trim(), x: r.x, y: r.y, w: r.width, h: r.height }; }
    const role = [...e.classList].find((c) => /^av-message-(user|assistant|error|tool|system)$/.test(c));
    const t = e.querySelector('.av-message-text');
    return { k: 'msg:' + (role || '?').replace('av-message-', ''), text: (t ? t.innerText : e.innerText).trim(), x: r.x, y: r.y, w: r.width, h: r.height };
  });
})()`;
const rows = (cdp) => cdp.eval(ROWS_JS);
const cmdOut = (rs) => (rs ?? []).filter((r) => r.k === 'notice:command-output');
const brief = (rs) => (rs ?? []).map((r) => `${r.k}:${JSON.stringify(r.text.slice(0, 40))}`).join(' | ');

async function activate(cdp, name) {
  const row = await waitFor(() => cdp.eval(`(() => { const e = [...document.querySelectorAll('.ws-item')].find(x => x.textContent.includes(${JSON.stringify(name)})); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { cx: r.x + r.width / 2, cy: r.y + r.height / 2 } : null; })()`), 30000, `sidebar row ${name}`);
  await cdp.click(row.cx, row.cy);
  await waitFor(() => cdp.eval(`[...document.querySelectorAll('.ws-item.active')].some(x => x.textContent.includes(${JSON.stringify(name)}))`), 8000, `${name} active`, 100);
}
async function openAgentTab(cdp) {
  const tab = await waitFor(() => cdp.eval(`(() => { const b = [...document.querySelectorAll('.toolbar .tabs .tab')].find((x) => /^(Agent|Structured)/.test(x.textContent.trim())); if (!b) return null; const r = b.getBoundingClientRect(); return r.width > 0 ? { cx: r.x + r.width / 2, cy: r.y + r.height / 2, active: b.classList.contains('active') } : null; })()`), 30000, 'the Agent-view tab');
  if (!tab.active) await cdp.click(tab.cx, tab.cy);
  await waitFor(() => cdp.eval(`[...document.querySelectorAll('.av-message-list, .av-composer, .cm-content')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 50 && r.height > 5; })`), 30000, 'the Agent view mounted');
}
const composerBox = (cdp) => cdp.eval(`(() => { for (const e of document.querySelectorAll('.cm-content')) { const r = e.getBoundingClientRect(); if (r.width > 50 && r.height > 5) return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, text: e.innerText }; } return null; })()`);
/** Type through the real composer and press Enter until the prompt is consumed (a slash autocomplete may take the first Enter). */
async function send(cdp, text, userMsgs) {
  const box = await waitFor(() => composerBox(cdp), 20000, 'visible composer');
  await cdp.click(box.cx, box.cy);
  await cdp.send('Input.insertText', { text });
  for (let i = 0; i < 4; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(700);
    const n = ((await rows(cdp)) ?? []).filter((r) => r.k === 'msg:user' && r.text.trim() === text).length;
    if (n > userMsgs) return i + 1;
  }
  throw new Error(`prompt ${JSON.stringify(text)} never produced a user bubble`);
}
const userCount = async (cdp, text) => ((await rows(cdp)) ?? []).filter((r) => r.k === 'msg:user' && r.text.trim() === text).length;

async function shot(arm, cdp, name, region) {
  await cdp.eval('document.fonts.ready.then(() => true)');
  await sleep(400);
  const buf = await cdp.shot();
  const file = rec.saveShot(`${LABEL}-${name}.png`, buf);
  const png = decodePng(buf);
  clause(arm, `paint/${name}`, png.w > 800 && png.h > 500 && distinctColours(png) > 40, `${file} ${png.w}x${png.h}, ${distinctColours(png)} colours, md5 ${md5(buf).slice(0, 10)}`);
  if (region) {
    const dpr = await cdp.eval('window.devicePixelRatio');
    const sub = crop(png, Math.round(region.x * dpr), Math.round(region.y * dpr), Math.round(region.w * dpr), Math.round(region.h * dpr));
    // INK = pixels whose colour differs from the row's own background (its modal colour) by a visible margin. Iterates by `sub.ch` (3 or 4 channels: a stride mismatch reads garbage).
    const counts = new Map();
    for (let i = 0; i < sub.data.length; i += sub.ch) { const k = (sub.data[i] << 16) | (sub.data[i + 1] << 8) | sub.data[i + 2]; counts.set(k, (counts.get(k) ?? 0) + 1); }
    const [bgKey] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
    const bg = [(bgKey >> 16) & 255, (bgKey >> 8) & 255, bgKey & 255];
    let ink = 0;
    for (let i = 0; i < sub.data.length; i += sub.ch) if (Math.abs(sub.data[i] - bg[0]) + Math.abs(sub.data[i + 1] - bg[1]) + Math.abs(sub.data[i + 2] - bg[2]) > 90) ink++;
    const total = sub.w * sub.h;
    clause(arm, `paint/${name}/row-has-glyph-pixels`, total > 0 && ink > 150 && ink < total * 0.25, `row region ${sub.w}x${sub.h} (${sub.ch}ch), background rgb(${bg}): ${ink} ink px = ${(ink / total * 100).toFixed(1)}% (text painted: > 150 px and < 25% of the row; an empty slab or a garbled region fails)`);
  }
  try {
    const g = path.join(OUT, `${LABEL}-${name}-grim.png`);
    sh('grim', ['-o', 'HEADLESS-1', g], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG_WAYLAND } });
    rec.shots.push({ file: g, md5: md5(fs.readFileSync(g)) });
  } catch (e) { console.log(`  (grim capture skipped: ${String(e.message).split('\n')[0]})`); }
  return file;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────
const arm = 'cmdout';
const armDir = path.join(RIG_DIR, `arm-${LABEL}`);
fs.mkdirSync(armDir, { recursive: true });
const liveBefore = liveCanary(LIVE_HOME);
const world = buildWorld(armDir);
console.log(`\n== ${LABEL} (expect ${EXPECT}) == scratch ${armDir}\n   real claude: ${world.realClaude}   fake API: ${api.url}   containment: ${CONTAINMENT}`);

// Containment: inside the namespaces a connect to a public address MUST fail (and does, instantly) — an instrument that can say "reachable".
const reach = await new Promise((res) => { const s = net.connect({ host: '1.1.1.1', port: 443, timeout: 2500 }); s.on('connect', () => { s.destroy(); res('REACHABLE'); }); s.on('error', (e) => res(`refused:${e.code}`)); s.on('timeout', () => { s.destroy(); res('timeout'); }); });
clause(arm, 'ctl/egress-contained', CONTAINMENT === 'netns+pidns' && reach.startsWith('refused'), `containment=${CONTAINMENT}; connect 1.1.1.1:443 -> ${reach}`);

const a = await launchApp({ appDir: APP_DIR, world, guard, rigWayland: RIG_WAYLAND, size: [1440, 900], tag: LABEL });
const cdp = a.cdp;
let failed = false;
try {
  clause(arm, 'ctl/app-identity-path', a.target.url.includes(APP_DIR) && !a.target.url.includes('app.asar'), `target url ${a.target.url} ⊇ ${APP_DIR}`);
  const environ = fs.readFileSync(`/proc/${a.app.pid}/environ`, 'utf8').split('\0');
  const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
  clause(arm, 'ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.home && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND,
    `app environ (read back): ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}; seeded account configDir=${world.account.configDir}, ws.accountId=${world.workspaces[0].accountId}=${world.account.id}`);
  const inSway = await waitFor(() => new RegExp(`"pid":\\s*${a.app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), 20000, 'the app window in my sway', 500).catch(() => false);
  clause(arm, 'ctl/app-in-my-sway', inSway, `app pid ${a.app.pid} in my sway's get_tree`);
  const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  const running = await cdp.eval('window.orchestra.getAppVersion()');
  clause(arm, 'ctl/app-version', running === ver, `version read out of the RUNNING app: ${running}; package.json of ${APP_DIR}: ${ver}`);
  const gitHead = (() => { try { return sh('git', ['-C', APP_DIR, 'rev-parse', '--short=8', 'HEAD']).trim(); } catch { return 'no-git'; } })();
  const mainChunk = (fs.readFileSync(path.join(APP_DIR, 'dist-electron/main.js'), 'utf8').match(/require\(["']\.\/([^"']+)["']\)/) ?? [])[1];
  const rendererJs = fs.readdirSync(path.join(APP_DIR, 'dist/assets')).filter((f) => /^index-.*\.js$/.test(f)).map((f) => `${f}:${md5(fs.readFileSync(path.join(APP_DIR, 'dist/assets', f))).slice(0, 10)}`);
  console.log(`   IDENTITY app-dir=${APP_DIR} git=${gitHead} main-chunk=${mainChunk ?? '?'}:${mainChunk ? md5(fs.readFileSync(path.join(APP_DIR, 'dist-electron', mainChunk))).slice(0, 10) : '?'} renderer=${rendererJs.join(',')}`);
  await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-item').length`).then((n) => n >= 2), 60000, 'two workspace rows');

  // ── arm 1: BACKFILL — reopen a workspace whose on-disk transcript is the REAL capture ───────────────
  const histPre = cmdOut(await rows(cdp).catch(() => null)).length;
  await activate(cdp, 'cmd-hist');
  await openAgentTab(cdp);
  const histRows = await waitFor(async () => { const r = await rows(cdp); return r && r.some((x) => x.k === 'msg:user' && x.text === '/recap') ? r : null; }, 60000, 'the backfilled /recap bubble');
  await sleep(1200);
  const hr = (await rows(cdp)) ?? histRows;
  const hOut = cmdOut(hr);
  console.log(`   backfilled rows: ${brief(hr)}`);
  clause(arm, 'backfill/bubble-shown', hr.some((r) => r.k === 'msg:user' && r.text === '/recap') && hr.some((r) => r.k === 'msg:user' && r.text === '/model'), 'the /recap and /model user bubbles are on screen (the symptom\'s only visible half)');
  if (FIXED) {
    clause(arm, 'backfill/output-rows', hOut.length === 3 && hOut[0].text === RECAP_TEXT && /^Current model: `Opus 5\.5 \(default\)`\nUsage: \/model <name>\./.test(hOut[1].text) && hOut[2].text === "/help isn't available in this environment.", `command-output rows pre→post: ${histPre} → ${hOut.length}; recap row text === the capture's recap (3 lines): ${hOut[0]?.text === RECAP_TEXT}`);
    const order = hr.map((r) => r.k + ':' + r.text.slice(0, 12));
    const iBub = order.findIndex((s) => s.startsWith('msg:user:/recap')), iOut = order.findIndex((s) => s.startsWith('notice:command-output:Goal'));
    clause(arm, 'backfill/order', iBub >= 0 && iOut === iBub + 1, `the recap row sits right under its /recap bubble (indexes ${iBub}, ${iOut})`);
    clause(arm, 'backfill/no-invocation-echo-row', !hOut.some((r) => r.text === '/help'), 'the bare "/help" invocation echo is not rendered as an output row');
  } else {
    clause(arm, 'backfill/output-rows-ABSENT-on-master', hOut.length === 0, `MUST-FAIL ARM: command-output rows pre→post: ${histPre} → ${hOut.length} (the bug: only the bubbles render)`);
  }
  const body = await cdp.eval('document.body.innerText');
  clause(arm, 'backfill/no-raw-xml', !XML_RE.test(body), `no <local-command-…>/<command-…> text anywhere in the page (${body.length} chars scanned)`);
  await shot(arm, cdp, 'backfill', FIXED && hOut[0] ? hOut[0] : null);

  // ── arm 2: LIVE — the real composer → real session → real CLI → fake API ────────────────────────────
  await activate(cdp, 'cmd-live');
  await openAgentTab(cdp);
  await send(cdp, 'hello', 0);
  await waitFor(async () => ((await rows(cdp)) ?? []).some((r) => r.k === 'msg:assistant' && /Fake assistant reply/.test(r.text)), 90000, 'the assistant reply through the real session');
  clause(arm, 'live/real-session-works', true, 'hello → the CLI answered through keeper + fake API (positive control: a /recap with no row can only mean the row is missing)');
  const preLive = cmdOut(await rows(cdp)).length;
  await send(cdp, '/recap', 0);
  if (FIXED) {
    const live = await waitFor(async () => { const r = await rows(cdp); return r && cmdOut(r).length ? r : null; }, 60000, 'the live /recap output row');
    await sleep(800);
    const lr = (await rows(cdp)) ?? live;
    const lOut = cmdOut(lr);
    console.log(`   live rows: ${brief(lr)}`);
    clause(arm, 'live/recap-row', lOut.length === 1 && lOut[0].text === RECAP_TEXT, `command-output rows pre→post: ${preLive} → ${lOut.length}; text === recap (3 lines): ${lOut[0]?.text === RECAP_TEXT}`);
    const iBub = lr.findIndex((r) => r.k === 'msg:user' && r.text === '/recap');
    clause(arm, 'live/under-its-bubble', iBub >= 0 && lr[iBub + 1]?.k === 'notice:command-output', `row after the /recap bubble: ${lr[iBub + 1]?.k}`);
    await shot(arm, cdp, 'live-recap', lOut[0]);
    // /compact right after /recap: the CLI re-emits the LAST local-command message (same uuid) after the compaction — it must NOT render twice (captured: compactReemit in the fixture).
    await send(cdp, '/compact', 0);
    await waitFor(async () => ((await rows(cdp)) ?? []).some((r) => r.k === 'notice:compact-boundary'), 90000, 'the compaction boundary row');
    await sleep(3000);
    const cr = (await rows(cdp)) ?? [];
    const recapRows = cmdOut(cr).filter((r) => r.text === RECAP_TEXT).length;
    console.log(`   after /compact: ${brief(cr)}`);
    clause(arm, 'live/compact-reemit-not-duplicated', recapRows === 1, `recap rows after /recap → /compact (the CLI re-emits the recap message with the same uuid): ${recapRows} (must be 1)`);
    await send(cdp, '/model', 0);
    await waitFor(async () => cmdOut(await rows(cdp)).filter((r) => /^Current model:/.test(r.text)).length === 1, 30000, 'the /model row');
    const fr = (await rows(cdp)) ?? [];
    clause(arm, 'live/second-builtin', cmdOut(fr).length === 3 && cmdOut(fr).filter((r) => r.text === RECAP_TEXT).length === 1, `command-output rows: ${cmdOut(fr).map((r) => JSON.stringify(r.text.slice(0, 24))).join(', ')} (recap, "Compacted", model — each once)`);
    await shot(arm, cdp, 'live-after-compact', null);
  } else {
    await sleep(9000);
    const lr = (await rows(cdp)) ?? [];
    clause(arm, 'live/output-row-ABSENT-on-master', cmdOut(lr).length === 0 && lr.some((r) => r.k === 'msg:user' && r.text === '/recap'), `MUST-FAIL ARM: after /recap — bubble present, command-output rows ${preLive} → ${cmdOut(lr).length}; rows: ${brief(lr)}`);
    await shot(arm, cdp, 'live-recap-master', null);
  }
  const bodyLive = await cdp.eval('document.body.innerText');
  clause(arm, 'live/no-raw-xml', !XML_RE.test(bodyLive), 'no raw <local-command-…> text in the page after the live commands');
} catch (e) {
  failed = true;
  console.log(`  ABORT  ${e.stack || e}`);
  try { rec.saveShot(`${LABEL}-abort.png`, await cdp.shot()); } catch { /* no frame */ }
} finally {
  const survivors = await a.kill();
  clause(arm, 'ctl/teardown', survivors.length === 0, `processes still carrying this boot's ORCHESTRA_HOME: ${survivors.length ? survivors.join(',') : 'none'}`);
}
// containment & isolation evidence, after teardown
const sum = api.summary?.() ?? {};
console.log(`   fake API saw: ${JSON.stringify(sum.byType ?? {})}  paths=${JSON.stringify(sum.paths ?? [])}  refused egress=${(api.egress ?? []).length} (${[...new Set((api.egress ?? []).map((e) => e.target))].join(',') || 'none'})`);
clause(arm, 'ctl/cli-reached-only-the-fake-api', (sum.byType?.model ?? 0) >= 1 && (api.egress ?? []).every((e) => /api\.anthropic\.com/.test(e.target ?? '')), `model requests ${sum.byType?.model ?? 0}; every refused egress target is the CLI's own hard-coded host`);
const liveAfter = liveCanary(LIVE_HOME);
clause(arm, 'ctl/live-config-untouched', JSON.stringify(liveBefore) === JSON.stringify(liveAfter), `live ~/.claude* inheritance surface before/after: ${JSON.stringify(liveBefore) === JSON.stringify(liveAfter) ? 'identical' : 'CHANGED ' + JSON.stringify({ liveBefore, liveAfter })}`);
const bus = liveBusOpenedBy(world.ohome, LIVE_HOME);
clause(arm, 'ctl/live-bus-never-opened', bus.holders.length === 0, `app opened ${bus.opened ?? '<none logged>'}; rig processes holding ~/.orchestra/bus.sqlite: ${bus.holders.length ? bus.holders.join(',') : 'none'}`);
const hashes = rec.shots.map((s) => s.md5);
clause(arm, 'ctl/captures-distinct', new Set(hashes).size === hashes.length, `${hashes.length} captures, ${new Set(hashes).size} distinct md5`);
api.stop?.();
const bad = rec.results.filter((r) => !r.ok);
console.log(`\nScreenshots:\n${rec.shots.map((s) => `  ${s.file}  md5=${s.md5.slice(0, 10)}`).join('\n')}`);
console.log(`\ne2e-command-output ${LABEL} (expect ${EXPECT}): ${rec.results.length - bad.length}/${rec.results.length} clauses pass${bad.length ? ` — FAILED: ${bad.map((r) => r.clause).join(', ')}` : ''}${failed ? ' (aborted)' : ''}`);
process.exit(bad.length || failed ? 1 : 0);

// #429 — the human step of the Vague endormie, driven in the BUILT app inside the contained rig's own headless sway (scripts/e2e-vague-human.sh), scratch HOME / ORCHESTRA_HOME / CLAUDE_CONFIG_DIR.
//   L1 (organic, the real sweep): a fleet of two vagues — OPS-A (has a parent: its Relance goes first, the human is told after the second delay) and OPS-B (a promoted top-level coordinator, NO parent: the
//        human step starts at the declaration). The two delays are edited in the REAL Settings dialog (10/15 → 1/1) and apply with no restart. Members end a turn through the production event funnel (the spool).
//        Asserted on the rendered DOM + a pixel probe + two screenshots: the pill / sub-line (the right time and pending count) / Relancer on the coordinator's row, the members dimmed, nothing on a bystander,
//        no Relancer on the parentless coordinator, the mark surviving a click on a sleeping member and a folded vague, the Relancer nudging the coordinator and nothing reaching the parentless one.
//   L2 (a restart of the SAME ORCHESTRA_HOME): the marks are back at once with their true time, NO second notification; a member resuming (spool `submit`) takes OPS-A's mark and dimming down while OPS-B's stays; then OPS-B's.
//   L3m (must-FAIL arm, a COPY of the build with the renderer's dimming class renamed): the same persisted episode — the dimming clause must read RED while the pill is still there.
// What is NOT here: the OS toast itself (no notification daemon in the rig's private bus) — the call is proven by the app log line written just before it and by `humanAt` on disk; see the report.
//
// Usage (via scripts/e2e-vague-human.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, decodePng, crop, git, launchApp, listProcsByHome, liveBusOpenedBy, liveCanary, makeGuard, makeRecorder, md5, sleep, waitFor } from './pause-ui/lib.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', 'vh');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!APP_DIR) { console.log('REFUSED: no <app-dir>'); process.exit(3); }
const guard = makeGuard({ liveHome: LIVE_HOME, rigDir: RIG_DIR, rigWayland: RIG_WAYLAND });
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
const rec = makeRecorder(OUT);
const { clause, saveShot } = rec;
const TZ = 'Asia/Kolkata'; // +05:30 — neither UTC nor the host's zone: the rendered time must be the READER's, computed below by hand
const TZ_OFFSET_MIN = 330;
const hhmm = (ms) => { const d = new Date(ms + TZ_OFFSET_MIN * 60_000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

// ── the scratch fleet ────────────────────────────────────────────────────────────────────────────────────
const ID = { lead: 'a1000000-0000-4000-8000-000000000001', opsA: 'a1000000-0000-4000-8000-000000000002', i1: 'a1000000-0000-4000-8000-000000000003', i2: 'a1000000-0000-4000-8000-000000000004', h1: 'a1000000-0000-4000-8000-000000000005', opsB: 'a1000000-0000-4000-8000-000000000006', iB: 'a1000000-0000-4000-8000-000000000007', by: 'a1000000-0000-4000-8000-000000000008' };
const FLEET = [
  // key, name, parent, kind, lastTask
  ['lead', 'lead-vague', null, 'orchestrator', ''],
  ['opsA', 'ops-bloc-html', 'lead', 'orchestrator', ''],
  ['i1', 'impl-budget', 'opsA', 'worktree', 'budget de cadres vivants et taille maximale'],
  ['i2', 'verif-seconde', 'opsA', 'worktree', 'seconde vérification du bloc'],
  ['h1', 'notes-main', 'opsA', 'worktree', ''], // hand-made, no task: a member of the vague (dimmed) that is never « pending »
  ['opsB', 'ops-solo', null, 'orchestrator', ''], // a promoted top-level coordinator: NO parent — its conversation is the human's
  ['iB', 'impl-solo', 'opsB', 'worktree', 'tâche de la vague sans parent'],
  ['by', 'bystander', null, 'worktree', ''],
];
const NAME = Object.fromEntries(FLEET.map(([k, n]) => [k, n]));
const SPOOL_SEQ = {};

function buildWorld(armDir) {
  const home = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repo = path.join(armDir, 'repo'), bin = path.join(armDir, 'stub-bin');
  for (const d of [home, ohome, cfg, repo, bin, path.join(ohome, 'userData', 'orchestra')]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: home, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo })) guard.mustBeScratch(k, v);
  const stubLog = path.join(armDir, 'stub-claude.log');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$(date +%s) $PWD $*" >> ${JSON.stringify(stubLog)}\nsleep 3600\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5 }));
  git(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  const account = { id: 'rig-vh', label: 'rig (scratch config dir)', configDir: cfg };
  const workspaces = FLEET.map(([k, name, parent, kind], i) => {
    const wt = path.join(armDir, `wt-${k}`);
    const orch = kind === 'orchestrator';
    if (orch) fs.mkdirSync(wt, { recursive: true });
    else git(repo, 'worktree', 'add', '-q', '-b', name, wt);
    const task = FLEET[i][4];
    return { id: ID[k], name, repoPath: orch ? '' : repo, worktreePath: wt, branch: name, baseBranch: orch ? '' : 'master', createdAt: Date.now() - (FLEET.length - i) * 3_600_000, status: 'idle', agent: 'claude', accountId: account.id, sdkSessionId: '', ...(orch ? { kind: 'orchestrator', canOrchestrate: true } : {}), ...(parent ? { parentId: ID[parent] } : {}), ...(task ? { lastTask: task } : {}) };
  });
  fs.writeFileSync(path.join(ohome, 'userData', 'orchestra', 'store.json'), JSON.stringify({ repos: [{ path: repo, name: 'vh-repo', defaultBranch: 'master', accountId: account.id }], workspaces, accounts: [account], selfTuneRuns: [] }, null, 2));
  return { home, ohome, cfg, repo, bin, stubLog, workspaces, storeFile: path.join(ohome, 'userData', 'orchestra', 'store.json'), vagueFile: path.join(ohome, 'vague-endormie.json'), appLog: path.join(ohome, 'logs', 'orchestra.log') };
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const logSince = (world, offset) => { try { return fs.readFileSync(world.appLog, 'utf8').slice(offset); } catch { return ''; } };
const logSize = (world) => { try { return fs.statSync(world.appLog).size; } catch { return 0; } };
const spool = (world, key, event) => { // what the CLI's hook script appends — the production funnel into `applyAgentEvent`
  fs.mkdirSync(path.join(world.ohome, 'events'), { recursive: true });
  SPOOL_SEQ[key] = (SPOOL_SEQ[key] ?? 1000) + 1;
  fs.appendFileSync(path.join(world.ohome, 'events', `${ID[key]}.jsonl`), JSON.stringify({ seq: SPOOL_SEQ[key], event, tool: '', toolUseId: '', transcript: '', crons: '' }) + '\n');
};
const turnEnded = (world, key) => { spool(world, key, 'submit'); spool(world, key, 'stop'); }; // a member ran a turn and ended it: it is quiet, nothing waits for anyone

// ── page probes ────────────────────────────────────────────────────────────────────────────────────────
const probe = (cdp) => cdp.eval(`(() => {
  const out = {};
  for (const r of document.querySelectorAll('.ws-item')) {
    const n = r.querySelector('.ws-name')?.textContent.trim(); if (!n) continue;
    const b = r.getBoundingClientRect(), note = r.querySelector('[data-vague-note]'), pill = r.querySelector('[data-vague-pill]'), btn = r.querySelector('[data-vague-relance]');
    const nb = note ? note.getBoundingClientRect() : null;
    out[n] = { cls: r.className, opacity: +getComputedStyle(r).opacity, dim: r.classList.contains('vague-dim'), visible: b.height > 2 && !r.closest('[inert]'),
      pill: pill ? pill.textContent : null, sub: note ? note.querySelector('.vague-note-text').textContent : null, since: note ? +note.querySelector('.vague-note-text').dataset.vagueSince : null, pending: note ? +note.querySelector('.vague-note-text').dataset.vaguePending : null,
      btn: !!btn, btnRect: btn ? (({ left, top, width, height }) => ({ left, top, width, height }))(btn.getBoundingClientRect()) : null, result: r.querySelector('[data-vague-result]')?.getAttribute('data-vague-result') ?? null,
      noteInside: nb ? nb.left >= b.left - 1 && nb.right <= b.right + 1 && nb.height > 4 : null,
      hint: !!r.querySelector('[data-vague-hint]'), hintTitle: r.querySelector('[data-vague-hint]')?.getAttribute('title') ?? null, relancerName: btn ? btn.getAttribute('aria-label') : null,
      resultRegion: (() => { const x = r.querySelector('[data-vague-note] [role=status]'); return x ? { live: x.getAttribute('aria-live'), text: x.textContent } : null; })(),
      // the name row must not spill: nothing of it right of the chevron's left edge, nothing past the row
      nameRow: (() => { const nr = r.querySelector('.ws-name-row'), ch = r.querySelector('.ws-chevron'); if (!nr) return null; const rr = r.getBoundingClientRect(), cl = ch ? ch.getBoundingClientRect().left : rr.right; let maxRight = 0; for (const c of nr.children) { const cb = c.getBoundingClientRect(); if (cb.width > 0) maxRight = Math.max(maxRight, cb.right); } return { maxRight, chevronLeft: cl, rowRight: rr.right, overChevron: maxRight > cl + 1, pastRow: maxRight > rr.right + 1 }; })(),
      rect: { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } };
  }
  const wl = document.querySelector('.ws-list');
  return { vw: innerWidth, vh: innerHeight, listOverflowX: wl ? wl.scrollWidth - wl.clientWidth : null, rows: out };
})()`);
const settled = (cdp, pred, what, ms = 30000) => waitFor(async () => { const d = await probe(cdp); return pred(d) ? d : null; }, ms, what, 250);
const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
const chevronOf = (cdp, name) => cdp.eval(`(() => { const b = [...document.querySelectorAll('button[aria-label]')].find((x) => new RegExp('^(Collapse|Expand) agents (spawned by|nested under) ${name}$').test(x.getAttribute('aria-label') || '')); if (!b) return null; const r = b.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, label: b.getAttribute('aria-label') }; })()`);
async function fold(cdp, name, want) { // want = 'folded' | 'open' — a trusted click on the row's chevron, then wait for the layout
  const c = await chevronOf(cdp, name);
  if (!c) throw new Error(`no chevron on ${name}`);
  if (c.label.startsWith(want === 'folded' ? 'Expand' : 'Collapse')) return probe(cdp); // already there
  await cdp.click(...centre(c));
  await sleep(600);
  return settled(cdp, (d) => (want === 'folded' ? !d.rows[NAME.i1]?.visible || d.rows[NAME.i1] === undefined : d.rows[NAME.i1]?.visible), `${name} to be ${want}`, 10000);
}

/** yellow-ish pixels (the pill / sub-line colour, rgb ≈ 255,200,87) in a screen rect — a paint oracle independent of the DOM */
function yellowIn(png, rect) {
  const I = decodePng(png), C = crop(I, rect.left, rect.top, rect.width, rect.height);
  let n = 0;
  for (let p = 0; p < C.w * C.h; p++) { const o = p * C.ch, r = C.data[o], g = C.data[o + 1], b = C.data[o + 2]; if (r > 200 && g > 150 && g < 235 && b < 140 && r - b > 80) n++; }
  return n;
}
const shotOf = (cdp, name) => cdp.shot().then((b) => { saveShot(`${LABEL}-${name}.png`, b); return b; });

// ── launching ───────────────────────────────────────────────────────────────────────────────────────────
async function launch(world, tag, { appDir = APP_DIR, size = [1400, 1000], mutantNote = false } = {}) {
  const off = logSize(world);
  const a = await launchApp({ appDir, world, guard, rigWayland: RIG_WAYLAND, size, tag, extraEnv: { TZ } });
  const arm = tag;
  clause(arm, 'ctl/app-identity-path', a.target.url.includes(appDir) && !a.target.url.includes('app.asar'), `target url ${a.target.url} ⊇ ${appDir}`);
  const environ = fs.readFileSync(`/proc/${a.app.pid}/environ`, 'utf8').split('\0');
  const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
  clause(arm, 'ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.home && ev('TZ') === TZ && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND, `app environ: ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} TZ=${ev('TZ')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
  const inSway = await waitFor(() => new RegExp(`"pid":\\s*${a.app.pid}\\b`).test(execFileSync('swaymsg', ['-t', 'get_tree'], { encoding: 'utf8' })), 20000, "the app window in my sway's tree", 500).catch(() => false);
  clause(arm, 'ctl/app-in-my-sway', inSway, `app pid ${a.app.pid} in my sway's get_tree`);
  await waitFor(() => a.cdp.eval(`document.querySelectorAll('.ws-item').length`).then((n) => n >= FLEET.length), 60000, `${FLEET.length} workspace rows`);
  const ver = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
  const running = await a.cdp.eval('window.orchestra.getAppVersion()').catch((e) => `ERR ${e.message}`);
  const bundle = await a.cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src).find((s) => /assets\\/index-.*\\.js/.test(s))`);
  const served = (() => { try { return fs.readFileSync(path.join(appDir, 'dist', bundle.split('/dist/')[1]), 'utf8'); } catch { return ''; } })(); // the page's own script, read from the build it was loaded from
  clause(arm, 'ctl/app-identity-version-and-bundle', running === ver && served.includes('data-vague-pill') && (mutantNote ? served.includes('vague-dlm') && !served.includes('vague-dim') : served.includes('vague-dim')), `running app says ${running}, built tree ${ver}; the renderer bundle it serves contains the mark's markers (data-vague-pill, vague-dim)`);
  return { ...a, off, world, arm };
}
async function stop(L) {
  const left = await L.kill();
  clause(L.arm, 'teardown-no-survivors', left.length === 0, `processes still carrying ${L.world.ohome}: ${left.length ? left.join(',') : 'none'}`);
}

const world = buildWorld(path.join(RIG_DIR, 'arm-vh'));
const canary0 = liveCanary(LIVE_HOME);

// ═════════════════════════════════ L1 — organic ═════════════════════════════════
async function launch1() {
  const L = await launch(world, 'L1');
  const { cdp } = L;
  let t0 = 0;
  try {
    const p0 = await probe(cdp);
    const anyMark = Object.values(p0.rows).some((r) => r.pill || r.sub || r.dim);
    clause('L1', 'ctl/no-mark-on-a-fleet-that-is-awake', !anyMark && p0.rows[NAME.opsA].opacity === 1 && p0.rows[NAME.i1].opacity === 1, `before anything: marks/dims on any of ${Object.keys(p0.rows).length} rows: ${anyMark}; members' opacity ${p0.rows[NAME.i1].opacity}`);
    await cdp.shot().then((b) => saveShot(`${LABEL}-L1-0-awake.png`, b));
    // A/B control for the folded rows: the SAME fold, no mark yet — measured once, so the folded-with-mark clause below has a baseline
    const awakeFold = await fold(cdp, 'ops-bloc-html', 'folded');
    const af = awakeFold.rows[NAME.opsA];
    clause('L1', 'ctl/folded-row-without-a-mark-does-not-spill', awakeFold.listOverflowX <= 0 && af.nameRow && !af.nameRow.overChevron && !af.nameRow.pastRow, `no mark, OPS-A folded: list overflow-x ${awakeFold.listOverflowX}px, name row right edge ${af.nameRow?.maxRight} vs chevron ${af.nameRow?.chevronLeft} / row ${af.nameRow?.rowRight}`);
    await fold(cdp, 'ops-bloc-html', 'open');

    // ── Settings: the two delays, in the real dialog ──
    const d = await cdp.eval(`window.orchestra.vagueDelays()`);
    clause('L1', 'settings/defaults-are-10-and-15', d.asleepMin === 10 && d.humanMin === 15, `host answers ${JSON.stringify(d)} on a fresh store (store.json has no vagueDelays: ${readJson(world.storeFile).vagueDelays === undefined})`);
    const btn = await cdp.eval(`(() => { const b = document.querySelector('[data-vague-open]'); if (!b) return null; const r = b.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    if (!btn) throw new Error('the Settings button [data-vague-open] is not in the sidebar header');
    await cdp.click(...centre(btn));
    const dlg = await waitFor(() => cdp.eval(`(() => { const m = document.querySelector('[data-vague-settings]'); if (!m) return null; const a = document.querySelector('[data-vague-asleep-min]'), h = document.querySelector('[data-vague-human-min]'); const r = m.getBoundingClientRect(); const ra = a.getBoundingClientRect(), rh = h.getBoundingClientRect(); return { a: a.value, h: h.value, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, ra: { left: ra.left, top: ra.top, width: ra.width, height: ra.height }, rh: { left: rh.left, top: rh.top, width: rh.width, height: rh.height } }; })()`), 10000, 'the Settings dialog');
    clause('L1', 'settings/dialog-shows-the-two-delays-inside-the-window', dlg.a === '10' && dlg.h === '15' && dlg.inside, `inputs read ${dlg.a} / ${dlg.h} min, dialog inside the window: ${dlg.inside}`);
    await cdp.shot().then((b) => saveShot(`${LABEL}-L1-1-settings-defaults.png`, b));
    // a trusted click focuses the field, the text is selected in the page, then CDP inserts the typed text (React sees a real input event)
    const typeInto = async (rect, text, sel) => { await cdp.click(...centre(rect)); await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.select(); return 1; })()`); await cdp.send('Input.insertText', { text }); };
    // an invalid value is refused inline and NOTHING is written (the must-FAIL arm of the write path)
    await typeInto(dlg.ra, '0', '[data-vague-asleep-min]');
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const err = await waitFor(() => cdp.eval(`document.querySelector('[data-vague-error]')?.textContent ?? null`), 5000, 'the inline refusal');
    clause('L1', 'settings/invalid-value-refused-nothing-written', /entre 1 et 1440/.test(err) && readJson(world.storeFile).vagueDelays === undefined, `« ${err} » · store.json vagueDelays still ${JSON.stringify(readJson(world.storeFile).vagueDelays)}`);
    await typeInto(dlg.ra, '1', '[data-vague-asleep-min]');
    await typeInto(dlg.rh, '1', '[data-vague-human-min]');
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const stored = await waitFor(() => { const v = readJson(world.storeFile).vagueDelays; return v && v.asleepMin === 1 && v.humanMin === 1 ? v : null; }, 10000, 'store.json to hold 1 / 1').catch(async (e) => { throw new Error(`${e.message} — it holds ${JSON.stringify(readJson(world.storeFile).vagueDelays)}; the fields read ${JSON.stringify(await cdp.eval(`[...document.querySelectorAll('.vague-settings input')].map((i) => i.value)`))}`); });
    const echo = await cdp.eval(`window.orchestra.vagueDelays()`);
    clause('L1', 'settings/edit-persists-and-applies-without-restart', stored.asleepMin === 1 && echo.humanMin === 1 && L.app.pid > 0, `typed 1 and 1 in the dialog: store.json ${JSON.stringify(stored)}, host answers ${JSON.stringify(echo)}, same app pid ${L.app.pid} (no restart)`);
    await cdp.shot().then((b) => saveShot(`${LABEL}-L1-2-settings-1-and-1.png`, b));
    await cdp.eval(`[...document.querySelectorAll('.vague-settings .modal-actions button')][0].click(); 1`);
    await waitFor(() => cdp.eval(`!document.querySelector('[data-vague-settings]')`), 5000, 'the dialog to close');

    // ── bring both vagues into play the way the incident did: members end a turn, then NOTHING can wake anyone ──
    turnEnded(world, 'i1'); turnEnded(world, 'i2'); turnEnded(world, 'iB');
    t0 = Date.now();
    console.log('  … members ended their turns; waiting for the sweep to declare the vagues asleep (delays 1 min / 1 min)');
    // OPS-B has no parent: its human step starts at the DECLARATION; OPS-A's Relance goes first, the human is told a delay later
    const seenB = await settled(cdp, (d) => d.rows[NAME.opsB]?.pill, 'the mark on OPS-B (no parent)', 240000);
    const tB = Date.now() - t0;
    const aAtB = seenB.rows[NAME.opsA];
    clause('L1', 'human-step/parentless-starts-at-the-declaration-parented-waits', !aAtB.pill && !aAtB.dim, `OPS-B's mark is up ${Math.round(tB / 1000)} s after the turns ended while OPS-A's (parented) is not yet: pill ${aAtB.pill}, members dimmed ${seenB.rows[NAME.i1].dim}`);
    const seenA = await settled(cdp, (d) => d.rows[NAME.opsA]?.pill, 'the mark on OPS-A', 240000);
    const tA = Date.now() - t0;
    clause('L1', 'human-step/parented-told-after-the-second-delay', tA - tB >= 20_000, `OPS-A's mark came ${Math.round((tA - tB) / 1000)} s after OPS-B's (delay 1 min after the Relance / declaration, sweep every 30 s)`);
    const ep = readJson(world.vagueFile);
    const epA = ep[ID.opsA]?.episode, epB = ep[ID.opsB]?.episode;
    clause('L1', 'persisted/episode-and-humanAt-on-disk', !!epA && !!epB && typeof epA.humanAt === 'number' && typeof epB.humanAt === 'number' && epB.nudgedAt === undefined, `vague-endormie.json: OPS-A ${JSON.stringify(epA)} · OPS-B ${JSON.stringify(epB)} (no nudgedAt: nothing was ever sent to the parentless coordinator)`);
    const log1 = logSince(world, L.off);
    const told = (id) => (log1.match(new RegExp(`the human is told — vague ${id}`, 'g')) ?? []).length;
    clause('L1', 'notification/one-per-episode-logged-before-the-toast', told(ID.opsA) === 1 && told(ID.opsB) === 1, `app log: « the human is told » for OPS-A ×${told(ID.opsA)}, OPS-B ×${told(ID.opsB)}`);

    // ── the rendered state ── (the dimming is a CSS transition: wait for it to settle before reading an opacity)
    await settled(cdp, (d) => ['i1', 'i2', 'h1'].every((k) => d.rows[NAME[k]].opacity === 0.5), 'the dimming transition to settle', 10000).catch(() => null);
    const P = await probe(cdp);
    const A = P.rows[NAME.opsA], B = P.rows[NAME.opsB];
    clause('L1', 'mark/pill-on-the-coordinator-row', A.pill === '☾ endormie' && B.pill === '☾ endormie' && P.rows[NAME.i1].pill === null && P.rows[NAME.lead].pill === null && P.rows[NAME.by].pill === null, `pill « ${A.pill} » on OPS-A and « ${B.pill} » on OPS-B; on a member ${P.rows[NAME.i1].pill}, on the LEAD ${P.rows[NAME.lead].pill}, on the bystander ${P.rows[NAME.by].pill}`);
    clause('L1', 'mark/true-time-and-pending-count', A.sub === `depuis ${hhmm(epA.since)} · 2 tâches en attente` && B.sub === `depuis ${hhmm(epB.since)} · 1 tâche en attente` && A.pending === 2 && B.pending === 1 && A.since === epA.since, `OPS-A « ${A.sub} » (persisted since ${new Date(epA.since).toISOString()} = ${hhmm(epA.since)} in ${TZ}, 2 unfinished + 1 hand-made) · OPS-B « ${B.sub} »`);
    clause('L1', 'mark/relancer-only-where-a-relance-can-go', A.btn && !B.btn && !P.rows[NAME.lead].btn, `Relancer on OPS-A: ${A.btn}; on the parentless OPS-B: ${B.btn}`);
    const dimOf = (k) => P.rows[NAME[k]];
    clause('L1', 'mark/members-dimmed-the-rest-untouched', ['i1', 'i2', 'h1'].every((k) => dimOf(k).dim && dimOf(k).opacity === 0.5) && dimOf('iB').dim && ['opsA', 'opsB', 'lead', 'by'].every((k) => !dimOf(k).dim && dimOf(k).opacity === 1), `dimmed (class + opacity 0.5): ${['i1', 'i2', 'h1'].map((k) => `${NAME[k]}=${dimOf(k).opacity}`).join(', ')} · OPS-B's member (its vague is folded, row hidden) carries the class: ${dimOf('iB').dim} · full strength: ${['opsA', 'opsB', 'lead', 'by'].map((k) => `${NAME[k]}=${dimOf(k).opacity}`).join(', ')}`);
    clause('L1', 'mark/inside-the-row-and-the-window', A.noteInside && B.noteInside && A.rect.right <= P.vw && A.btnRect.left + A.btnRect.width <= A.rect.right + 1, `sub-line inside its row (A ${A.noteInside}, B ${B.noteInside}); Relancer ${JSON.stringify(A.btnRect)} inside row right edge ${A.rect.right}`);
    const png1 = await shotOf(cdp, 'L1-3-asleep');
    const yA = yellowIn(png1, A.rect), yBy = yellowIn(png1, P.rows[NAME.by].rect);
    clause('L1', 'pixels/the-mark-paints-yellow-on-the-coordinator-row-only', yA > 60 && yBy === 0, `yellow-ish pixels in OPS-A's row rect: ${yA}; in the bystander's row: ${yBy}`);

    // ── a click on a sleeping member does not take the mark down; folded, the coordinator's row is still readable ──
    const i1r = P.rows[NAME.i1].rect;
    await cdp.click(i1r.left + 60, i1r.top + i1r.height / 2);
    await sleep(1500);
    const afterClick = await probe(cdp);
    clause('L1', 'resume/a-click-on-the-sleeping-workspace-is-not-a-resume', !!afterClick.rows[NAME.opsA].pill && afterClick.rows[NAME.i1].dim, `after selecting « ${NAME.i1} »: pill ${afterClick.rows[NAME.opsA].pill}, member still dimmed ${afterClick.rows[NAME.i1].dim}`);
    const folded = await fold(cdp, 'ops-bloc-html', 'folded');
    const F = folded.rows[NAME.opsA];
    clause('L1', 'collapsed/the-coordinator-row-stays-readable', F.visible && F.pill === '☾ endormie' && F.sub === A.sub && F.noteInside && F.btn && !folded.rows[NAME.i1].visible, `vague folded: members hidden (${['i1', 'i2', 'h1'].map((k) => folded.rows[NAME[k]].visible).join('/')}), the coordinator's row still shows « ${F.pill} » « ${F.sub} » + Relancer`);
    clause('L1', 'collapsed/no-scrollbar-and-no-chip-over-the-chevron', folded.listOverflowX <= 0 && F.nameRow && !F.nameRow.overChevron && !F.nameRow.pastRow, `folded WITH the pill (+ the folded-members chip and any stall chip): list overflow-x ${folded.listOverflowX}px (control without a mark: ${awakeFold.listOverflowX}px); name row right edge ${F.nameRow?.maxRight} ≤ chevron ${F.nameRow?.chevronLeft} (over: ${F.nameRow?.overChevron}), ≤ row ${F.nameRow?.rowRight} (past: ${F.nameRow?.pastRow})`);
    await shotOf(cdp, 'L1-4-folded');

    // ── Relancer: nudges the coordinator again; nothing reaches the parentless one or the LEAD ──
    const stubBefore = fs.existsSync(world.stubLog) ? fs.readFileSync(world.stubLog, 'utf8') : '';
    const logOff = logSize(world);
    const a11y0 = await probe(cdp);
    await cdp.eval(`document.querySelector('[data-vague-note] [role=status]').__rigNode = 'same'; 1`);
    await cdp.click(...centre((await probe(cdp)).rows[NAME.opsA].btnRect));
    const relanced = await waitFor(() => /relanced by the human \(Relancer\)|delivery to .* threw|could not deliver|Relancer/.test(logSince(world, logOff)) || null, 60000, 'the Relancer to reach the coordinator delivery').catch(() => null);
    const resultText = await waitFor(async () => (await probe(cdp)).rows[NAME.opsA].result, 45000, 'the Relancer\'s result on the row').catch(() => null);
    const stubAfter = fs.existsSync(world.stubLog) ? fs.readFileSync(world.stubLog, 'utf8') : '';
    const newStarts = stubAfter.slice(stubBefore.length).split('\n').filter(Boolean);
    const cwdOf = (k) => world.workspaces.find((w) => w.id === ID[k]).worktreePath;
    const startedIn = (k) => stubAfter.split('\n').some((l) => l.split(' ')[1] === cwdOf(k));
    const selectedStill = await cdp.eval(`document.querySelector('.ws-item.active .ws-name')?.textContent.trim() ?? null`);
    const noParent = await cdp.eval(`window.orchestra.relanceVague(${JSON.stringify(ID.opsB)})`);
    const unknown = await cdp.eval(`window.orchestra.relanceVague('nope')`);
    await sleep(1500);
    const stubFinal = fs.existsSync(world.stubLog) ? fs.readFileSync(world.stubLog, 'utf8') : '';
    const startedInFinal = (k) => stubFinal.split('\n').some((l) => l.split(' ')[1] === cwdOf(k));
    clause('L1', 'relancer/nudges-the-parented-coordinator-and-reports', !!resultText && ['sent', 'failed', 'held', 'pending', 'not-wakeable'].includes(resultText), `click on Relancer → the row reports « ${resultText} » (host outcome); app log: ${JSON.stringify((logSince(world, logOff).match(/vague-endormie: [^\n]*/g) ?? []).slice(0, 3))}; the click did not select another workspace (active row: ${selectedStill})`);
    const region = await cdp.eval(`(() => { const x = document.querySelector('[data-vague-note] [role=status]'); return x ? { same: x.__rigNode === 'same', text: x.textContent, live: x.getAttribute('aria-live') } : null; })()`);
    const headerLabel = await cdp.eval(`document.querySelector('[data-vague-open]')?.getAttribute('aria-label') ?? null`);
    clause('L1', 'a11y/relancer-named-live-region-updated-french-header', a11y0.rows[NAME.opsA].relancerName === 'Relancer ops-bloc-html' && a11y0.rows[NAME.opsA].resultRegion?.live === 'polite' && !!region && region.same && /Relancé|Échec|Mémoire|Démarrage/.test(region.text) && headerLabel === 'Réglages de la vague endormie', `button name « ${a11y0.rows[NAME.opsA].relancerName} »; the status region was mounted before the click (aria-live ${a11y0.rows[NAME.opsA].resultRegion?.live}) and the SAME node now reads « ${region?.text} » (updated, not remounted); header button « ${headerLabel} »`);
    clause('L1', 'relancer/nothing-reaches-the-parentless-coordinator-or-the-lead', noParent === 'no-parent' && unknown === 'not-asleep' && !startedInFinal('lead') && !startedInFinal('opsB') && !startedInFinal('iB'), `relanceVague(OPS-B) → ${noParent} (refused before any delivery) · relanceVague('nope') → ${unknown} · stub claude started in: ${[...new Set(stubFinal.split('\n').filter(Boolean).map((l) => path.basename(l.split(' ')[1] ?? '')))].join(', ') || 'nowhere'} — LEAD ${startedInFinal('lead')}, OPS-B ${startedInFinal('opsB')}, its member ${startedInFinal('iB')}`);
    const stillMarked = await probe(cdp);
    clause('L1', 'relancer/the-mark-stays-only-a-resume-ends-it', !!stillMarked.rows[NAME.opsA].pill && !!stillMarked.rows[NAME.opsB].pill, `after the Relancer both marks are still up (OPS-A ${stillMarked.rows[NAME.opsA].pill}, OPS-B ${stillMarked.rows[NAME.opsB].pill})`);
    // folded ANCESTOR: fold the LEAD's tree — the sleeping coordinator is hidden, the LEAD row (the nearest visible ancestor) carries a small hint
    await fold(cdp, 'ops-bloc-html', 'open');
    const lead0 = await probe(cdp);
    const leadFolded = await (async () => { const c = await chevronOf(cdp, 'lead-vague'); if (!c) throw new Error('no chevron on the LEAD'); await cdp.click(...centre(c)); await sleep(600); return settled(cdp, (d) => !d.rows[NAME.opsA]?.visible, 'the LEAD tree to fold', 10000); })();
    const LD = leadFolded.rows[NAME.lead];
    clause('L1', 'folded-ancestor/hint-on-the-visible-ancestor-only', !lead0.rows[NAME.lead].hint && LD.hint && LD.hintTitle === `Vague endormie repliée : ops-bloc-html (depuis ${hhmm(epA.since)})` && !LD.btn && !LD.dim && !leadFolded.rows[NAME.opsB].hint && !leadFolded.rows[NAME.by].hint, `LEAD tree unfolded: hint ${lead0.rows[NAME.lead].hint}; folded: hint ${LD.hint} « ${LD.hintTitle} », Relancer on the LEAD row ${LD.btn}, LEAD dimmed ${LD.dim}; ops-solo (not hidden) ${leadFolded.rows[NAME.opsB].hint}, bystander ${leadFolded.rows[NAME.by].hint}`);
    await shotOf(cdp, 'L1-5-lead-folded-hint');
    const reopened = await (async () => { const c = await chevronOf(cdp, 'lead-vague'); await cdp.click(...centre(c)); await sleep(600); return settled(cdp, (d) => d.rows[NAME.opsA]?.visible, 'the LEAD tree to unfold', 10000); })();
    clause('L1', 'folded-ancestor/no-hint-when-unfolded', !reopened.rows[NAME.lead].hint, `LEAD tree unfolded again: hint ${reopened.rows[NAME.lead].hint}`);
    // a whole sweep later (30 s) the episode is still the same one
    await sleep(35_000);
    const ep2 = readJson(world.vagueFile);
    const P2 = await probe(cdp);
    clause('L1', 'episode/still-the-same-after-a-sweep-and-a-click', ep2[ID.opsA].episode.declaredAt === epA.declaredAt && ep2[ID.opsB].episode.humanAt === epB.humanAt && !!P2.rows[NAME.opsA].pill, `declaredAt ${ep2[ID.opsA].episode.declaredAt} == ${epA.declaredAt}, humanAt unchanged, mark up`);
  } catch (e) { clause('L1', 'completed', false, `ABORTED: ${e.stack || e}`); } finally { await stop(L); }
}

// ═════════════════════════════════ L2 — restart, then real resumes ═════════════════════════════════
async function launch2() {
  const before = readJson(world.vagueFile);
  const L = await launch(world, 'L2');
  const { cdp } = L;
  try {
    // the marks are back with their true time — and nobody is notified again
    const P = await settled(cdp, (d) => d.rows[NAME.opsA]?.pill && d.rows[NAME.opsB]?.pill, 'the marks after the restart', 60000);
    const A = P.rows[NAME.opsA], B = P.rows[NAME.opsB];
    const sinceA = before[ID.opsA].episode.since, sinceB = before[ID.opsB].episode.since;
    clause('L2', 'restart/the-mark-survives-with-its-true-time', A.sub === `depuis ${hhmm(sinceA)} · 2 tâches en attente` && B.sub === `depuis ${hhmm(sinceB)} · 1 tâche en attente` && A.btn && !B.btn && ['i1', 'i2', 'h1', 'iB'].every((k) => P.rows[NAME[k]].dim), `after killing and relaunching the SAME ORCHESTRA_HOME: OPS-A « ${A.sub} », OPS-B « ${B.sub} », members dimmed`);
    await sleep(35_000); // a full sweep after the first one
    const log2 = logSince(world, L.off);
    const after = readJson(world.vagueFile);
    clause('L2', 'restart/no-second-notification', !/the human is told/.test(log2) && after[ID.opsA].episode.humanAt === before[ID.opsA].episode.humanAt && after[ID.opsB].episode.humanAt === before[ID.opsB].episode.humanAt, `this launch's log has ${(log2.match(/the human is told/g) ?? []).length} « the human is told » line(s); humanAt on disk unchanged (A ${after[ID.opsA].episode.humanAt}, B ${after[ID.opsB].episode.humanAt})`);
    clause('L2', 'restart/no-second-relance-to-the-coordinator', !/coordinator [0-9a-f-]+ relanced — vague/.test(log2) && !/to be told/.test(log2), `this launch's log: no new « ASLEEP » declaration and no « relanced » line (the episode was already nudged before the restart)`);
    const png = await shotOf(cdp, 'L2-1-asleep-after-restart');
    const rA = (await probe(cdp)).rows[NAME.opsA];
    clause('L2', 'pixels/the-mark-paints-after-the-restart', yellowIn(png, rA.rect) > 60, `yellow-ish pixels in OPS-A's row: ${yellowIn(png, rA.rect)}`);

    // ── a real resume: a member's turn STARTS (the production event funnel) → OPS-A's mark and dimming go, OPS-B's stay ──
    spool(world, 'i1', 'submit');
    const resumedA = await settled(cdp, (d) => !d.rows[NAME.opsA].pill && ['i1', 'i2', 'h1'].every((k) => d.rows[NAME[k]].opacity === 1), 'OPS-A\'s mark to disappear after a member resumed', 120000);
    const a2 = resumedA.rows[NAME.opsA], b2 = resumedA.rows[NAME.opsB];
    clause('L2', 'resume/mark-disappears-when-a-member-resumes', !a2.pill && !a2.sub && !a2.btn && ['i1', 'i2', 'h1'].every((k) => !resumedA.rows[NAME[k]].dim && resumedA.rows[NAME[k]].opacity === 1) && !!b2.pill && resumedA.rows[NAME.iB].dim, `OPS-A: pill ${a2.pill}, sub ${a2.sub}, button ${a2.btn}; its members back to opacity ${['i1', 'i2', 'h1'].map((k) => resumedA.rows[NAME[k]].opacity).join('/')}; OPS-B (nobody resumed there) still « ${b2.pill} » with its member dimmed`);
    const ep3 = readJson(world.vagueFile);
    clause('L2', 'resume/the-episode-is-closed-on-disk-and-nobody-was-notified', ep3[ID.opsA]?.episode === undefined && !!ep3[ID.opsB]?.episode && !/the human is told/.test(logSince(world, L.off)), `vague-endormie.json: OPS-A episode ${JSON.stringify(ep3[ID.opsA]?.episode ?? null)}, OPS-B episode kept`);
    const png2 = await shotOf(cdp, 'L2-2-resumed-A-asleep-B');
    clause('L2', 'pixels/resumed-row-has-no-yellow-the-other-still-has', yellowIn(png2, a2.rect) < 20 && yellowIn(png2, b2.rect) > 60, `yellow-ish pixels: OPS-A (resumed) ${yellowIn(png2, a2.rect)}, OPS-B (asleep) ${yellowIn(png2, b2.rect)}`);
    spool(world, 'iB', 'submit');
    const allGone = await settled(cdp, (d) => !d.rows[NAME.opsB].pill, 'OPS-B\'s mark to disappear', 120000);
    clause('L2', 'resume/the-parentless-vague-resumes-too', !allGone.rows[NAME.opsB].pill && !Object.values(allGone.rows).some((r) => r.dim || r.pill), `no pill and no dimmed row anywhere (${Object.keys(allGone.rows).length} rows)`);
    await shotOf(cdp, 'L2-3-all-resumed');
  } catch (e) { clause('L2', 'completed', false, `ABORTED: ${e.stack || e}`); } finally { await stop(L); }
}

// ═════════════════════════════════ L3m — the must-FAIL arm ═════════════════════════════════
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
function mutantCopy(armDir, dir, from, to) {
  const copy = path.join(armDir, 'app'); fs.mkdirSync(copy, { recursive: true });
  for (const d of ['dist', 'dist-electron']) fs.cpSync(path.join(APP_DIR, d), path.join(copy, d), { recursive: true });
  fs.copyFileSync(path.join(APP_DIR, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(copy, 'node_modules'));
  for (const extra of ['build']) if (fs.existsSync(path.join(APP_DIR, extra))) fs.symlinkSync(path.join(APP_DIR, extra), path.join(copy, extra));
  const hit = walk(path.join(copy, dir)).filter((f) => f.endsWith('.js')).map((f) => ({ f, n: fs.readFileSync(f, 'utf8').split(from).length - 1 })).filter((x) => x.n > 0);
  if (hit.length !== 1) throw new Error(`mutation string ${JSON.stringify(from)} found in ${JSON.stringify(hit.map((h) => [path.basename(h.f), h.n]))} — must be exactly 1 file`);
  const text = fs.readFileSync(hit[0].f, 'utf8'); fs.writeFileSync(hit[0].f, text.split(from).join(to));
  return { copy, file: path.relative(copy, hit[0].f), n: hit[0].n };
}
async function launch3m() {
  // a fresh world whose persisted episode already carries `humanAt`: the marks are up at the first sweep, no waiting
  const w3 = buildWorld(path.join(RIG_DIR, 'arm-vh-3m'));
  const now = Date.now();
  fs.writeFileSync(w3.vagueFile, JSON.stringify({ [ID.opsA]: { everSeen: true, episode: { since: now - 40 * 60_000, declaredAt: now - 30 * 60_000, nudgedAt: now - 29 * 60_000, humanAt: now - 14 * 60_000 } } }));
  let proof;
  try {
    proof = mutantCopy(path.join(RIG_DIR, 'arm-vh-3m'), 'dist/assets', "vague-dim", 'vague-dlm');
    // second must-FAIL: the pill stops shrinking (a 240 px floor) — the folded-row overflow oracle must read RED
    const css = walk(path.join(proof.copy, 'dist/assets')).filter((f) => f.endsWith('.css')).filter((f) => fs.readFileSync(f, 'utf8').includes('.vague-pill{'));
    if (css.length !== 1) throw new Error(`.vague-pill rule found in ${css.length} css files (want 1)`);
    fs.writeFileSync(css[0], fs.readFileSync(css[0], 'utf8').replace('.vague-pill{', '.vague-pill{flex-shrink:0!important;min-width:240px!important;'));
  } catch (e) { clause('L3m', 'mutant-built', false, String(e.message)); return; }
  const L = await launch(w3, 'L3m', { appDir: proof.copy, mutantNote: true }).catch((e) => { clause('L3m', 'completed', false, `ABORTED: ${e.stack || e}`); return null; });
  if (!L) return;
  try {
    const P = await settled(L.cdp, (d) => d.rows[NAME.opsA]?.pill, 'the mark from the persisted episode', 90000);
    clause('L3m', 'must-fail/dimming-clause-reads-RED-when-the-class-is-wrong', !!P.rows[NAME.opsA].pill && ['i1', 'i2', 'h1'].every((k) => !P.rows[NAME[k]].dim && P.rows[NAME[k]].opacity === 1), `mutant copy (${proof.file}, ×${proof.n}: the dimming class renamed): the pill is up (${P.rows[NAME.opsA].pill}) but the members read opacity ${['i1', 'i2', 'h1'].map((k) => P.rows[NAME[k]].opacity).join('/')} — the real build reads 0.5 (L1/mark/members-dimmed…), so that clause would be RED here`);
    await shotOf(L.cdp, 'L3m-1-mutant-no-dimming');
    const mf = await fold(L.cdp, 'ops-bloc-html', 'folded');
    const mr = mf.rows[NAME.opsA];
    clause('L3m', 'must-fail/folded-overflow-oracle-reads-RED-when-the-pill-cannot-shrink', !!mr.nameRow && (mr.nameRow.overChevron || mr.nameRow.pastRow || mf.listOverflowX > 0), `mutant copy (pill min-width 240px), OPS-A folded: name row right edge ${mr.nameRow?.maxRight} vs chevron ${mr.nameRow?.chevronLeft} / row ${mr.nameRow?.rowRight}, list overflow-x ${mf.listOverflowX}px — the real build reads none (L1/collapsed/no-scrollbar…), so that clause would be RED here`);
  } catch (e) { clause('L3m', 'completed', false, `ABORTED: ${e.stack || e}`); } finally { await stop(L); }
}

await launch1();
await launch2();
await launch3m();

// ── global controls ──
const canary1 = liveCanary(LIVE_HOME);
clause('ctl', 'live-config-never-touched', JSON.stringify(canary0) === JSON.stringify(canary1), `live ~/.claude* canary before == after: ${JSON.stringify(canary1)}`);
const busCheck = liveBusOpenedBy(world.ohome, LIVE_HOME);
clause('ctl', 'live-bus-never-opened', busCheck.holders.length === 0 && busCheck.opened === path.join(world.ohome, 'bus.sqlite'), `the app opened ${busCheck.opened} (its scratch bus); rig processes holding the live bus: ${busCheck.holders.length ? busCheck.holders.join(',') : 'none'}`);
const shotMd5 = (n) => rec.shots.find((s) => path.basename(s.file) === `${LABEL}-${n}.png`)?.md5;
for (const [a, b] of [['L1-0-awake', 'L1-3-asleep'], ['L1-4-folded', 'L1-5-lead-folded-hint'], ['L2-1-asleep-after-restart', 'L2-2-resumed-A-asleep-B'], ['L2-2-resumed-A-asleep-B', 'L2-3-all-resumed'], ['L1-3-asleep', 'L3m-1-mutant-no-dimming']]) {
  clause('ctl', `captures-differ ${a} vs ${b}`, !!shotMd5(a) && !!shotMd5(b) && shotMd5(a) !== shotMd5(b), `${shotMd5(a)} vs ${shotMd5(b)}`);
}
console.log('\n== shots (md5) ==');
for (const s of rec.shots) console.log(`  ${s.md5}  ${s.file}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, results: rec.results, shots: rec.shots }, null, 2));
const red = rec.results.filter((r) => !r.ok);
console.log(`\nVERDICT: ${red.length === 0 ? `ALL GREEN: ${rec.results.length} clauses` : `RED: ${red.map((r) => `${r.arm}/${r.clause}`).join(', ')}`}`);
process.exit(red.length === 0 ? 0 : 1);

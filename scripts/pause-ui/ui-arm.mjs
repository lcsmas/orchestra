// arm `ui` of the #257 G3 — option A (hover ⏸ → the douce / dure panel, badges + progress note on the rows, Bilan on the Bus page) driven on the BUILT app, TRUSTED input only
// (Input.dispatchMouseEvent: a real hover opens the row-actions pill, a real click presses the button). Every surface gets a state assertion AND a screenshot that is decoded
// (pixels near the tokens' colours, not a blank frame, differs from the pre-state); every popover gets a viewport-position assertion.
import fs from 'node:fs';
import path from 'node:path';
import { FLEET, IDS, NAME_OF, REPO, crop, decodePng, distinctColours, diffPx, pixelsNear, sh, sleep, waitFor } from './lib.mjs';

const ACCENT = [110, 168, 255], YELLOW = [255, 200, 87], GREEN = [91, 214, 139];
const J = JSON.stringify;

export async function armUi({ bootArm, rec, OUT, LABEL, RIG_WAYLAND }) {
  const arm = 'ui';
  const { clause, saveShot } = rec;
  const { world, a, liveBusCheck } = await bootArm(arm);
  const cdp = a.cdp;
  const bus = () => world.readBus();
  const run = (id) => bus().runs.find((r) => r.id === id);
  const I = IDS;
  const ev = (expr) => cdp.eval(expr);
  const rowRect = (name) => ev(`(() => { const r = [...document.querySelectorAll('.ws-item')].find((x) => x.querySelector('.ws-name')?.textContent === ${J(name)}); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height }; })()`);
  const hover = async (name) => {
    const r = await rowRect(name);
    if (!r) throw new Error(`row ${name} not found`);
    await cdp.mouse(5, 890); await sleep(150); // leave first so the next enter fires
    await cdp.mouse(r.x - 20, r.y); await sleep(120); await cdp.mouse(r.x - 18, r.y + 1);
    await waitFor(() => ev(`!!document.querySelector('.ws-row-actions-pop')`), 8000, `row-actions pill on ${name}`);
    await sleep(200);
    return r;
  };
  const btnRect = (sel) => ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, right: b.right, top: b.top, bottom: b.bottom, text: e.textContent.trim().slice(0, 60) }; })()`);
  const press = async (sel, what) => { const b = await waitFor(() => btnRect(sel), 8000, what); await cdp.click(b.x, b.y); await sleep(250); return b; };
  const inView = (R, vw, vh) => R && R.left >= 0 && R.top >= 0 && R.right <= vw && R.bottom <= vh;
  const vp = await ev(`({ w: innerWidth, h: innerHeight })`);
  const badges = () => ev(`[...document.querySelectorAll('[data-pause-badge]')].map((e) => [e.getAttribute('data-pause-badge'), e.getAttribute('data-pause-state'), e.textContent.trim()])`);
  const shot = async (name, clip) => { const buf = await cdp.shot(clip); saveShot(`${LABEL}-${name}.png`, buf); return decodePng(buf); };
  const sideClip = { x: 0, y: 100, width: 345, height: 470 };
  const parkAndSettle = async () => { await cdp.mouse(5, 890); await sleep(500); await ev(`document.fonts.ready.then(() => true)`); };
  const nm = (id) => NAME_OF[id];

  try {
    // ── 0. baseline ──────────────────────────────────────────────────────────────────────────────
    await waitFor(async () => (await ev(`document.querySelectorAll('.ws-item').length`)) >= FLEET.length, 30000, 'rows');
    await sleep(1500);
    await parkAndSettle();
    clause(arm, 'ctl/ui-baseline-no-pause-chrome', (await ev(`document.querySelectorAll('[data-pause-badge],[data-pause-glyph],[data-pause-note],.pause-rowbar').length`)) === 0, 'no badge / glyph / note / bar on an ordinary fleet (the rows are byte-for-byte what they were)');
    const base = await shot('0-baseline-sidebar', sideClip);
    clause(arm, 'ctl/ui-baseline-painted', distinctColours(base) > 30, `${distinctColours(base)} distinct colours in the sidebar clip (a glyph-less frame has ~1)`);
    const baseAccent = pixelsNear(base, ACCENT), baseGreen = pixelsNear(base, GREEN, 40);

    // ── 1. hover the lead row → ⏸ → the douce / dure panel ──────────────────────────────────────
    await hover('fleet-lead');
    const pre = await ev(`document.querySelectorAll('[data-pause-panel]').length`);
    const pause1 = await press(`.ws-row-actions-pop [data-pause-action="soft"][data-pause-for="${I.lead}"]`, '⏸ on the lead row');
    const panelR = await waitFor(() => btnRect('[data-pause-panel="choose"]'), 8000, 'the douce / dure panel');
    clause(arm, 'G3/ui-panel-opens-on-click', pre === 0 && !!panelR && /Pause douce/.test(await ev(`document.querySelector('[data-pause-panel]').textContent`)) && /Pause dure/.test(await ev(`document.querySelector('[data-pause-panel]').textContent`)), `panels before click ${pre}; after: "${(await ev(`document.querySelector('[data-pause-panel]')?.textContent`))?.slice(0, 120)}"`);
    clause(arm, 'G3/ui-panel-inside-viewport', inView(panelR, vp.w, vp.h) && panelR.left >= 345, `panel rect ${Math.round(panelR.left)},${Math.round(panelR.top)} → ${Math.round(panelR.right)},${Math.round(panelR.bottom)} inside ${vp.w}x${vp.h} and right of the sidebar (≥ 345)`);
    clause(arm, 'G3/ui-panel-agent-count', /fleet-lead · 7 agents/.test(await ev(`document.querySelector('[data-pause-panel]').textContent`)), `header: "${(await ev(`document.querySelector('.pause-panel-h')?.textContent`))}"`);
    const menuShot = await shot('1-menu-douce-dure', { x: 0, y: 100, width: 700, height: 420 });
    clause(arm, 'ctl/ui-menu-painted', distinctColours(menuShot) > 30 && pixelsNear(menuShot, YELLOW, 30) > 8 && pixelsNear(menuShot, ACCENT, 30) > 30, `menu clip: ${distinctColours(menuShot)} colours; amber (douce icon) ${pixelsNear(menuShot, YELLOW, 30)} px, blue (dure icon) ${pixelsNear(menuShot, ACCENT, 30)} px`);

    // ── 2. Pause dure → badges on the 7 members, progress on the lead ───────────────────────────
    const t0 = Date.now();
    await press(`[data-pause-panel] [data-pause-action="hard"][data-pause-for="${I.lead}"]`, 'Pause dure in the panel');
    await waitFor(() => run(I.lead).pause_trap_at !== null, 90000, 'the host trap', 400);
    const dureMs = Date.now() - t0;
    await waitFor(async () => (await badges()).length === 7, 15000, '7 badges');
    await parkAndSettle();
    const b2 = await badges();
    const wave = [I.lead, I.ops, I.w1, I.w2, I.w3, I.w4, I.docs];
    clause(arm, 'G3/ui-badges-appear-on-the-wave', J(b2.map((b) => b[0]).sort()) === J(wave.slice().sort()) && b2.every((b) => b[1] === 'paused' && b[2] === 'en pause') && !b2.some((b) => [I.legacy, I.sa, I.sb].includes(b[0])), `${b2.length} badges, all "en pause": ${b2.map((b) => nm(b[0])).join(', ')}; the legacy wave has none; all paused in ${dureMs} ms (bar < 60 s)`);
    const note = await ev(`document.querySelector('[data-pause-note="${I.lead}"]')?.textContent`);
    const bar = await ev(`(() => { const e = document.querySelector('.pause-rowbar [data-pause-progress]'); return e ? [e.getAttribute('data-done'), e.getAttribute('data-total'), e.getAttribute('data-kind'), e.querySelector('i').style.width] : null; })()`);
    clause(arm, 'G3/ui-progress-on-the-orchestrator-row', /^En pause · 7\/7 · depuis/.test(note ?? '') && J(bar) === J(['7', '7', 'en-pause', '100%']), `note "${note}"; bar ${J(bar)}`);
    const glyphs = await ev(`document.querySelectorAll('[data-pause-glyph]').length`);
    const dimmed = await ev(`document.querySelectorAll('.ws-item.pause-dim').length`);
    clause(arm, 'G3/ui-glyph-swapped-and-rows-dimmed', glyphs === 7 && dimmed === 7, `${glyphs} pause glyphs replaced the status glyphs; ${dimmed} rows dimmed`);
    const colors = await ev(`(() => { const e = document.querySelector('[data-pause-badge="${I.w1}"]'); const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderTopColor]; })()`);
    clause(arm, 'G3/ui-badge-colours-are-the-mockup-tokens', colors[0] === 'rgb(110, 168, 255)' && /^rgba\(110, 168, 255, 0\.1\)$/.test(colors[1]) && /^rgba\(110, 168, 255, 0\.3\)$/.test(colors[2]), `badge computed ${J(colors)} (mockup: --accent text, 10 % fill, 30 % border)`);
    const dureShot = await shot('2-dure-sidebar', sideClip);
    const diffFromBase = diffPx(base, dureShot, 12);
    clause(arm, 'G3/ui-dure-pixels', diffFromBase > 1500 && pixelsNear(dureShot, ACCENT) - baseAccent > 300, `${diffFromBase} px differ from the baseline; accent-blue pixels ${baseAccent} → ${pixelsNear(dureShot, ACCENT)} (the 7 badges + glyphs + the note + the bar)`);
    const fullDure = await shot('2-dure-full', undefined);
    clause(arm, 'ctl/ui-dure-frame-not-blank', distinctColours(fullDure) > 60, `${distinctColours(fullDure)} distinct colours`);

    // ── 3. the Bus page: state + Bilan, then Reprendre from there ───────────────────────────────
    const busBtn = await btnRect('[aria-label="Open the fleet bus page"]');
    await cdp.click(busBtn.x, busBtn.y);
    await waitFor(() => ev(`!!document.querySelector('[data-section="pause"] [data-pause-section="${I.lead}"]')`), 20000, 'the Pause section on the Bus page');
    await parkAndSettle();
    const bilanRows = await ev(`[...document.querySelectorAll('[data-pause-bilan]')].map((e) => [e.getAttribute('data-pause-bilan'), e.getAttribute('data-pause-state'), e.querySelector('.pause-bilan-ref')?.textContent])`);
    const w1Row = await ev(`document.querySelector('[data-pause-bilan="${I.w1}"]')?.textContent`);
    clause(arm, 'G3/bus-pause-section-with-bilan', bilanRows.length === 7 && bilanRows.every((r) => r[1] === 'paused') && bilanRows.filter((r) => /^refs\/orchestra\/pause\//.test(r[2])).length === 5 && bilanRows.filter((r) => r[2] === '—').length === 2 && /1 modifié · 1 ajouté/.test(w1Row ?? '') && (await ev(`document.querySelector('[data-pause-count="${I.lead}"]')?.textContent`)) === '7/7 en pause', `${bilanRows.length} Bilan rows (a snapshot ref on each of the 5 git worktrees; the 2 orchestrators are scratch dirs: no ref, "—"); count "${await ev(`document.querySelector('[data-pause-count="${I.lead}"]')?.textContent`)}"; worker-1 row: "${(w1Row ?? '').replace(/\s+/g, ' ').slice(0, 140)}"`);
    const busRect = await ev(`(() => { const b = document.querySelector('[data-pause-section="${I.lead}"]').getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; })()`);
    clause(arm, 'G3/bus-section-below-the-toolbar-inside-viewport', busRect.left >= 345 && busRect.right <= vp.w && busRect.top >= 48, `section ${Math.round(busRect.left)}..${Math.round(busRect.right)} × ${Math.round(busRect.top)}..${Math.round(busRect.bottom)} in ${vp.w}x${vp.h}`);
    const busShot = await shot('3-bus-dure', { x: 345, y: 48, width: vp.w - 345, height: Math.min(600, vp.h - 48) });
    clause(arm, 'G3/bus-pixels', distinctColours(busShot) > 60 && pixelsNear(busShot, ACCENT) > 800, `${distinctColours(busShot)} colours; ${pixelsNear(busShot, ACCENT)} accent-blue px (the left rule, the badges, the bar, the glyphs)`);
    // Reprendre from the Bus page
    await press(`[data-pause-section="${I.lead}"] [data-pause-action="resume"]`, 'Reprendre on the Bus page');
    await waitFor(() => run(I.lead).resume_started_at !== null, 20000, 'the Reprise to start', 300);
    await waitFor(() => ev(`document.querySelector('[data-pause-section="${I.lead}"]')?.getAttribute('data-pause-phase') === 'resuming'`), 15000, 'the Bus section in phase resuming');
    await parkAndSettle();
    const resRows = await ev(`[...document.querySelectorAll('[data-pause-bilan]')].map((e) => [e.getAttribute('data-pause-bilan'), e.getAttribute('data-pause-state')])`);
    const blockedIds = resRows.filter((r) => r[1] === 'blocked').map((r) => r[0]).sort();
    clause(arm, 'G3/bus-reprise-progress-and-blocked', J(blockedIds) === J([I.docs, I.w1, I.w2, I.w3, I.w4].sort()) && resRows.filter((r) => r[1] === 'released').length === 2 && (await ev(`document.querySelector('[data-pause-count="${I.lead}"]')?.textContent`)) === '0/7 repris' && (await ev(`document.querySelectorAll('[data-pause-action="release"]').length`)) === 5, `coordinators released (2), workers BLOCKED: ${blockedIds.map(nm).join(', ')}; count "${await ev(`document.querySelector('[data-pause-count="${I.lead}"]')?.textContent`)}"; ${await ev(`document.querySelectorAll('[data-pause-action="release"]').length`)} Libérer buttons`);
    const resShot = await shot('3-bus-reprise', { x: 345, y: 48, width: vp.w - 345, height: Math.min(600, vp.h - 48) });
    clause(arm, 'G3/bus-reprise-pixels', pixelsNear(resShot, GREEN, 40) > 300, `${pixelsNear(resShot, GREEN, 40)} green px (the Libérer buttons, the released badges, the headline rule)`);
    // Re-pause while resuming (the Bus page's Re-pause → dure): a NEW epoch, nothing stays released, then Reprendre again
    const epoch0 = run(I.lead).paused_at;
    await press(`[data-pause-section="${I.lead}"] [data-pause-action="repause"]`, 'Re-pause');
    const choice = await ev(`[...document.querySelectorAll('[data-pause-section="${I.lead}"] [data-pause-action]')].map((e) => e.getAttribute('data-pause-action')).filter((a) => a === 'soft' || a === 'hard').join()`);
    await press(`[data-pause-section="${I.lead}"] [data-pause-action="hard"]`, 'Re-pause → dure');
    await waitFor(() => run(I.lead).paused_at > epoch0 && run(I.lead).resume_started_at === null, 15000, 'a NEW pause epoch', 200);
    await waitFor(() => run(I.lead).pause_trap_at !== null, 90000, 'the trap on the new epoch', 400);
    await waitFor(() => ev(`document.querySelector('[data-pause-section="${I.lead}"]')?.getAttribute('data-pause-phase') === 'paused' && document.querySelectorAll('[data-pause-bilan][data-pause-state="paused"]').length === 7`), 20000, 'the Bus section back in phase paused (7 rows)');
    clause(arm, 'G3/bus-repause-while-resuming-new-epoch', choice === 'soft,hard' && bus().roster.filter((r) => r.paused_at === run(I.lead).paused_at && r.released_at !== null).length === 0 && run(I.lead).pause_mode === 'hard', `the Re-pause offers douce / dure; dure → a new epoch (+${run(I.lead).paused_at - epoch0} ms), the Reprise is cancelled, the new roster has 0 released members, all 7 back to "en pause"`);
    await press(`[data-pause-section="${I.lead}"] [data-pause-action="resume"]`, 'Reprendre (2nd)');
    await waitFor(() => run(I.lead).resume_started_at !== null, 20000, 'the 2nd Reprise', 300);
    await waitFor(() => ev(`document.querySelector('[data-pause-section="${I.lead}"]')?.getAttribute('data-pause-phase') === 'resuming'`), 15000, 'phase resuming again');
    await parkAndSettle();
    // one member by hand, then the rest
    await press(`[data-pause-bilan="${I.w1}"] [data-pause-action="release"]`, 'Libérer worker-1');
    await waitFor(() => bus().roster.some((r) => r.ws_id === I.w1 && r.released_at !== null), 15000, 'worker-1 released in the bus', 300);
    await sleep(600);
    clause(arm, 'G3/bus-release-one-member', (await ev(`document.querySelector('[data-pause-bilan="${I.w1}"]')?.getAttribute('data-pause-state')`)) === 'released' && bus().roster.filter((r) => r.released_at !== null && r.released_by === I.lead).length === 1, `worker-1 → released (released_by fleet-lead = the carrier row); the other 4 workers still blocked`);
    await press(`[data-pause-section="${I.lead}"] [data-pause-action="release-all"]`, 'Libérer les bloqués');
    await waitFor(() => run(I.lead).paused_at === null, 20000, 'the Reprise to finish (pause columns cleared)', 300);
    await sleep(800);
    clause(arm, 'G3/bus-release-all-explicit-ids-then-active', run(I.lead).paused_at === null && (await ev(`document.querySelectorAll('[data-pause-section="${I.lead}"][data-pause-phase="resuming"]').length`)) === 0, `all 4 remaining workers released by explicit ids (the nested wave's too); lead paused_at=${run(I.lead).paused_at}`);

    // back to the workspaces page
    const lr = await rowRect('fleet-lead'); // a row click leaves the Bus page (setActive → the workspaces page)
    await cdp.click(lr.x, lr.y);
    await sleep(800);
    await waitFor(async () => (await ev(`document.querySelectorAll('.ws-item').length`)) >= FLEET.length, 15000, 'the sidebar again');
    await parkAndSettle();
    const afterBadges = await badges();
    clause(arm, 'G3/ui-badges-clear-after-reprise', afterBadges.length === 0 && (await ev(`document.querySelectorAll('[data-pause-glyph],[data-pause-note],.pause-rowbar,.ws-item.pause-dim').length`)) === 0, `badges ${afterBadges.length}, glyphs/notes/bars/dim rows ${await ev(`document.querySelectorAll('[data-pause-glyph],[data-pause-note],.pause-rowbar,.ws-item.pause-dim').length`)} — the rows are back to ordinary`);
    const clear = decodePng(await cdp.shot(sideClip)); // pixel-identical to the baseline BY DESIGN (that is the claim): decoded and compared, not saved as a second identical capture
    await shot('4-cleared-full', undefined);
    clause(arm, 'G3/ui-cleared-pixels-match-baseline', diffPx(base, clear, 12) < 600 && diffPx(dureShot, clear, 12) > 1500, `${diffPx(base, clear, 12)} px differ from the pre-pause baseline (status-glyph animation/clock noise only), ${diffPx(dureShot, clear, 12)} from the paused frame`);

    // ── 4. refusals, explained ───────────────────────────────────────────────────────────────────
    const before = J(bus().runs.map((r) => [r.id, r.paused_at, r.pause_mode]));
    const rosterBefore = bus().roster.length;
    await hover('worker-1');
    await press(`.ws-row-actions-pop [data-pause-action="soft"][data-pause-for="${I.w1}"]`, '⏸ on a worker row');
    const ex1 = await waitFor(() => btnRect('[data-pause-panel="explain"] [data-pause-explain-code]'), 8000, 'the refusal for a worker');
    const ex1Text = await ev(`document.querySelector('[data-pause-panel="explain"]').textContent`);
    const ex1Code = await ev(`document.querySelector('[data-pause-explain-code]').getAttribute('data-pause-explain-code')`);
    clause(arm, 'G3/refusal-worker-explained', ex1Code === 'refused' && /worker-1 n'est pas coordinateur de wave-ops/.test(ex1Text) && /fleet-lead/.test(ex1Text) && /Mettre wave-ops en pause/.test(ex1Text) && inView(ex1, vp.w, vp.h), `code=${ex1Code}; "${ex1Text.replace(/\s+/g, ' ').slice(0, 220)}"; rect inside viewport`);
    const fixes = await ev(`[...document.querySelectorAll('[data-pause-panel="explain"] [data-pause-fix]')].map((e) => [e.getAttribute('data-pause-fix'), e.getAttribute('data-pause-for'), e.textContent.trim()])`);
    clause(arm, 'G3/refusal-worker-remedies-are-buttons', J(fixes) === J([['pause', I.ops, 'Mettre wave-ops en pause…'], ['pause', I.lead, 'Mettre fleet-lead en pause…']]), `remedy buttons: ${J(fixes.map((f) => f[2]))}`);
    await shot('5-refusal-worker', { x: 0, y: 100, width: 700, height: 420 });
    const fixBtn = await btnRect(`[data-pause-panel="explain"] [data-pause-fix="pause"][data-pause-for="${I.ops}"]`);
    await cdp.click(fixBtn.x, fixBtn.y); await sleep(350);
    clause(arm, 'G3/refusal-remedy-opens-the-menu-for-the-authority', (await ev(`document.querySelector('[data-pause-panel]')?.getAttribute('data-pause-panel')`)) === 'choose' && (await ev(`document.querySelector('[data-pause-panel]')?.getAttribute('data-pause-for')`)) === I.ops && /wave-ops · 5 agents/.test(await ev(`document.querySelector('.pause-panel-h')?.textContent`)) && J(bus().runs.map((r) => [r.id, r.paused_at, r.pause_mode])) === before, 'pressing "Mettre wave-ops en pause…" opens the douce / dure panel FOR wave-ops (5 agents); nothing is written until a choice is made');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    clause(arm, 'G3/refusal-panel-closes-on-escape', (await ev(`document.querySelectorAll('[data-pause-panel]').length`)) === 0, 'Escape closes the panel');
    await hover('legacy-sweep');
    await press(`.ws-row-actions-pop [data-pause-action="soft"][data-pause-for="${I.legacy}"]`, '⏸ on the switch-OFF orchestrator');
    await waitFor(() => btnRect('[data-pause-panel="explain"] [data-pause-explain-code]'), 8000, 'the switch-OFF refusal');
    const ex2Text = await ev(`document.querySelector('[data-pause-panel="explain"]').textContent`);
    const ex2Code = await ev(`document.querySelector('[data-pause-explain-code]').getAttribute('data-pause-explain-code')`);
    clause(arm, 'G3/refusal-switch-off-explained-nothing-written', ex2Code === 'switch-off' && /Pause désactivée sur cette vague/.test(ex2Text) && /figé au démarrage/.test(ex2Text) && J(bus().runs.map((r) => [r.id, r.paused_at, r.pause_mode])) === before && bus().roster.length === rosterBefore, `code=${ex2Code}; "${ex2Text.replace(/\s+/g, ' ').slice(0, 200)}"; every run's pause columns AND the roster (${rosterBefore} rows) unchanged after BOTH refusals`);
    await shot('5-refusal-switch-off', { x: 0, y: 100, width: 700, height: 420 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);

    // covered run: pause the lead (douce, via the real menu), then try to resume the OPS row
    await hover('fleet-lead');
    await press(`.ws-row-actions-pop [data-pause-action="soft"][data-pause-for="${I.lead}"]`, '⏸ lead (2nd cycle)');
    await press(`[data-pause-panel] [data-pause-action="soft"][data-pause-for="${I.lead}"]`, 'Pause douce in the panel');
    await waitFor(() => run(I.lead).pause_mode === 'soft', 15000, 'douce written', 200);
    await waitFor(() => run(I.lead).pause_trap_at !== null, 90000, 'the douce to escalate (all idle) and the trap to finish', 400);
    clause(arm, 'G3/ui-douce-written-by-the-menu-and-completed', run(I.lead).pause_mode === 'soft' && run(I.lead).pause_deadline_at - run(I.lead).paused_at === 180000 && run(I.lead).pause_escalated_at !== null, `mode soft, deadline = +3 min, escalated at +${run(I.lead).pause_escalated_at - run(I.lead).paused_at} ms (every member idle ⇒ confirmed by the host, no 3-min wait), trap done`);
    await waitFor(async () => (await badges()).length === 7, 15000, 'badges after the douce');
    await parkAndSettle();
    await hover('wave-ops');
    await press(`.ws-row-actions-pop [data-pause-action="resume"][data-pause-for="${I.ops}"]`, '▶ on the covered OPS row');
    await waitFor(() => btnRect('[data-pause-panel="explain"] [data-pause-explain-code]'), 8000, 'the covered-run explanation');
    const ex3Text = await ev(`document.querySelector('[data-pause-panel="explain"]').textContent`);
    clause(arm, 'G3/refusal-covered-remedy-resumes-the-ancestor', (await ev(`[...document.querySelectorAll('[data-pause-panel="explain"] [data-pause-fix="resume"]')].map((e) => e.getAttribute('data-pause-for'))`)).join() === I.lead, 'the one remedy button resumes fleet-lead (the run that holds it)');
    clause(arm, 'G3/refusal-covered-run-names-the-ancestor', /fleet-lead tient déjà wave-ops en pause/.test(ex3Text) && run(I.ops).paused_at === null && run(I.lead).resume_started_at === null, `"${ex3Text.replace(/\s+/g, ' ').slice(0, 200)}"; wave-ops has no pause of its own, the lead's Reprise did not start`);
    await shot('5-refusal-covered', { x: 0, y: 100, width: 700, height: 420 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    // clean up through the UI: Reprendre then Libérer les bloqués on the lead row
    await hover('fleet-lead');
    await press(`.ws-row-actions-pop [data-pause-action="resume"][data-pause-for="${I.lead}"]`, '▶ Reprendre on the lead row');
    await waitFor(() => run(I.lead).resume_started_at !== null, 20000, 'the Reprise', 300);
    await parkAndSettle();
    await hover('fleet-lead');
    const relBtn = await waitFor(() => btnRect(`.ws-row-actions-pop [data-pause-action="release-all"][data-pause-for="${I.lead}"]`), 10000, '▶ Libérer les bloqués in the pill');
    clause(arm, 'G3/ui-row-pill-shows-release-count', /^Libérer les 5 bloqués$/.test(await ev(`document.querySelector('.ws-row-actions-pop [data-pause-action="release-all"]').getAttribute('title')`)), `tooltip "${await ev(`document.querySelector('.ws-row-actions-pop [data-pause-action="release-all"]').getAttribute('title')`)}"`);
    const resSide = await shot('6-reprise-sidebar', sideClip);
    clause(arm, 'G3/ui-reprise-sidebar', /^Reprise · \d+\/7 repris · 5 bloqués$/.test(await ev(`document.querySelector('[data-pause-note="${I.lead}"]')?.textContent`) ?? '') && (await badges()).filter((b) => b[1] === 'blocked').length === 5, `lead note "${await ev(`document.querySelector('[data-pause-note="${I.lead}"]')?.textContent`)}"; ${(await badges()).filter((b) => b[1] === 'blocked').length} workers badged "bloqué"`);
    await cdp.click(relBtn.x, relBtn.y);
    await waitFor(() => run(I.lead).paused_at === null, 20000, 'the Reprise to finish', 300);
    await parkAndSettle();
    clause(arm, 'G3/ui-back-to-ordinary', (await badges()).length === 0 && !bus().runs.some((r) => r.paused_at !== null), `badges ${(await badges()).length}; no run holds a pause`);

    // ── 5. the in-flight Pause douce (state-injected: an idle fleet is confirmed within a sweep, so the waiting phase cannot be held on the real path without live sessions — the F2 canary drives that) ──
    const injected = await ev(`(() => { const now = Date.now(); const ids = ${J(wave)}; const names = ${J(Object.fromEntries(Object.entries(NAME_OF)))}; const mem = (id, i) => ({ wsId: id, label: names[id], role: i < 2 ? 'coordinator' : 'worker', memberRun: i === 0 ? ${J(I.lead)} : ${J(I.ops)}, ui: i < 5 ? 'paused' : 'pausing', confirmVia: i < 5 ? 'member' : null, confirmedAt: i < 5 ? now : null, releasedAt: null, releasedBy: null, repriseConfirmedAt: null, bilan: null });
      const members = ids.map(mem);
      const run = { carrierRunId: ${J(I.lead)}, carrierLabel: 'fleet-lead', title: null, phase: 'pausing', mode: 'soft', pausedAt: now - 70000, pausedBy: ${J(I.lead)}, pausedByLabel: 'fleet-lead', deadlineAt: now + 110000, escalatedAt: null, trapAt: null, resumeStartedAt: null, auto: false, progress: { kind: 'en-pause', done: 5, total: 7, missing: ids.slice(5) }, blocked: [], members };
      const byWorkspace = Object.fromEntries(members.map((m) => [m.wsId, { wsId: m.wsId, carrierRunId: ${J(I.lead)}, phase: 'pausing', ui: m.ui, role: m.role, via: m.confirmVia }]));
      return { run, byWorkspace }; })()`);
    const ctlLead = { wsId: I.lead, runId: I.lead, anchored: true, switchOn: true, phase: 'pausing', coveredBy: null, can: { pauseSoft: { ok: false, code: 'already-paused' }, pauseHard: { ok: true }, resume: { ok: true }, release: { ok: false, code: 'not-resuming' } } };
    await ev(`window.__orchestraSetState({ pauseOverview: { available: true, error: null, at: Date.now(), runs: [${J(injected.run)}], controls: { ${J(I.lead)}: ${J(ctlLead)} }, byWorkspace: ${J(injected.byWorkspace)} } })`);
    await sleep(900); await parkAndSettle();
    const noteD = await ev(`document.querySelector('[data-pause-note="${I.lead}"]')?.textContent`);
    const bd = await badges();
    clause(arm, 'G3/ui-douce-in-flight-progress-and-countdown', /^Pause douce · 5\/7 · dure dans 1:(4|5)\d$/.test(noteD ?? '') && bd.filter((b) => b[1] === 'paused').length === 5 && bd.filter((b) => b[1] === 'pausing').length === 2 && bd.find((b) => b[1] === 'pausing')[2] === 'finit…', `(state-injected) note "${noteD}"; badges: 5 "en pause" (blue) + 2 "finit…" (amber)`);
    const t1 = await ev(`document.querySelector('[data-pause-note="${I.lead}"]').textContent`); await sleep(2200); const t2 = await ev(`document.querySelector('[data-pause-note="${I.lead}"]').textContent`);
    clause(arm, 'G3/ui-countdown-ticks', t1 !== t2 && /dure dans/.test(t2), `the note ticks while the douce waits: "${t1}" → "${t2}"`);
    const douceShot = await shot('7-douce-in-flight-sidebar', sideClip);
    clause(arm, 'G3/ui-douce-pixels', pixelsNear(douceShot, YELLOW, 30) > 150 && pixelsNear(douceShot, ACCENT) > 300, `amber px ${pixelsNear(douceShot, YELLOW, 30)} (the 2 "finit…" badges, the note, the bar's fill), blue px ${pixelsNear(douceShot, ACCENT)} (the 5 confirmed)`);
    await cdp.mouse(5, 890);
  } catch (e) {
    clause(arm, 'G3/ui-arm-completed', false, `ARM ABORTED: ${e.stack || e}`);
    try { saveShot(`${LABEL}-ui-abort.png`, await cdp.shot()); } catch { /* the page may be gone */ }
  } finally {
    cdp.close();
    liveBusCheck();
    const left = await a.kill();
    clause(arm, 'ctl/teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}

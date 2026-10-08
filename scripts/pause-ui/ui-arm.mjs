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
    clause(arm, 'G3/bus-says-a-human-paused-it', run(I.lead).paused_by === 'humain' && /posée par un humain/.test(await ev(`document.querySelector('[data-pause-section="${I.lead}"] .pause-run-sub')?.textContent ?? ''`)), `bus paused_by=${run(I.lead).paused_by}; header "${await ev(`document.querySelector('[data-pause-section="${I.lead}"] .pause-run-sub')?.textContent`)}"`);
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
    const rowGlyphs = await ev(`[...document.querySelectorAll('.ws-item [data-pause-badge]')].map((b) => { const r = b.closest('.ws-item'); return [b.getAttribute('data-pause-state'), !!r.querySelector('[data-pause-glyph]'), !!r.querySelector('.ws-glyph')]; })`);
    clause(arm, 'G3/ui-reprise-working-rows-keep-activity-glyph', rowGlyphs.filter((g) => g[0] === 'released').length === 2 && rowGlyphs.filter((g) => g[0] === 'blocked').length === 5 && rowGlyphs.every((g) => (g[0] === 'blocked' ? g[1] && !g[2] : !g[1] && g[2])), `sidebar rows [state, pause glyph, activity glyph]: ${J(rowGlyphs)} — libéré/repris rows keep the activity glyph, bloqué rows show ⏸`);
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
    const heldOutcome = world.hold(I.lead).outcome; // an `orchestra run hold` on the lead's run: Reprendre must lift it, as `orchestra run resume` does
    const heldBefore = run(I.lead).held_at;
    await press(`[data-pause-section="${I.lead}"] [data-pause-action="resume"]`, 'Reprendre (2nd)');
    await waitFor(() => run(I.lead).resume_started_at !== null, 20000, 'the 2nd Reprise', 300);
    await waitFor(() => run(I.lead).held_at === null, 10000, 'the liveness hold to be lifted', 200);
    clause(arm, 'G3/ui-reprendre-lifts-the-liveness-hold', heldOutcome === 'held' && heldBefore !== null && run(I.lead).held_at === null && run(I.lead).resume_started_at !== null, `hold seeded (${heldOutcome}, held_at ${heldBefore}) → after Reprendre held_at ${run(I.lead).held_at}, resume_started_at set: the UI's Reprendre = \`orchestra run resume\` (beginReprise + hold lift)`);
    await waitFor(() => ev(`document.querySelector('[data-pause-section="${I.lead}"]')?.getAttribute('data-pause-phase') === 'resuming'`), 15000, 'phase resuming again');
    await parkAndSettle();
    // one member by hand, then the rest
    await press(`[data-pause-bilan="${I.w1}"] [data-pause-action="release"]`, 'Libérer worker-1');
    await waitFor(() => bus().roster.some((r) => r.ws_id === I.w1 && r.released_at !== null), 15000, 'worker-1 released in the bus', 300);
    await sleep(600);
    clause(arm, 'G3/bus-release-one-member', (await ev(`document.querySelector('[data-pause-bilan="${I.w1}"]')?.getAttribute('data-pause-state')`)) === 'released' && bus().roster.filter((r) => r.paused_at === run(I.lead).paused_at && r.role === 'worker' && r.released_at !== null && r.released_by === 'humain').length === 1 && bus().roster.filter((r) => r.paused_at === run(I.lead).paused_at && r.role === 'coordinator' && r.released_by === 'humain').length === 2 && !bus().roster.some((r) => r.paused_at === run(I.lead).paused_at && r.released_by === 'host'), `worker-1 → released (released_by « humain » — the human, Q1, not the carrier row; the 2 coordinators of this human Reprise are the human's too); the other 4 workers still blocked`);
    const busRelLabel = await ev(`document.querySelector('[data-pause-section="${I.lead}"] [data-pause-action="release-all"]')?.textContent.trim()`);
    await press(`[data-pause-section="${I.lead}"] [data-pause-action="release-all"]`, 'Libérer 1 bloqué (+3 plus bas, à part)');
    await waitFor(() => bus().roster.some((r) => r.ws_id === I.docs && r.released_at !== null), 15000, 'docs released by « tout libérer »', 300);
    await waitFor(() => ev(`!!document.querySelector('[data-pause-section="${I.lead}"] [data-pause-fix="release"]')`), 10000, 'the « libérer aussi » follow-up', 200);
    await sleep(500);
    const relRoster = bus().roster.filter((r) => r.run_id === I.lead && r.paused_at === run(I.lead).paused_at);
    const belowIds = (await ev(`document.querySelector('[data-pause-section="${I.lead}"] [data-pause-fix="release"]').getAttribute('data-pause-ids')`)).split(',').sort();
    clause(arm, 'G3/bus-release-all-is-own-run-only', busRelLabel === 'Libérer 1 bloqué (+3 plus bas, à part)' && relRoster.find((r) => r.ws_id === I.docs).released_at !== null && [I.w2, I.w3, I.w4].every((id) => relRoster.find((r) => r.ws_id === id).released_at === null) && run(I.lead).paused_at !== null && J(belowIds) === J([I.w2, I.w3, I.w4].sort()), `label "${busRelLabel}"; « tout libérer » = \`release --all\`: docs (the lead's own) released, the 3 workers of wave-ops (${belowIds.map(nm).join(', ')}) left blocked and NAMED in the explanation; the Reprise is not finished (paused_at ${run(I.lead).paused_at})`);
    await shot('3-bus-release-below', { x: 345, y: 48, width: vp.w - 345, height: Math.min(600, vp.h - 48) });
    await press(`[data-pause-section="${I.lead}"] [data-pause-fix="release"]`, 'Libérer aussi ces 3');
    await waitFor(() => run(I.lead).paused_at === null, 20000, 'the Reprise to finish (pause columns cleared)', 300);
    await sleep(800);
    clause(arm, 'G3/bus-second-gesture-releases-below-then-active', run(I.lead).paused_at === null && (await ev(`document.querySelectorAll('[data-pause-section="${I.lead}"][data-pause-phase="resuming"]').length`)) === 0, `the explicit second gesture released the 3 below (explicit ids, carrier authority); lead paused_at=${run(I.lead).paused_at}`);

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
    clause(arm, 'G3/refusal-worker-explained', ex1Code === 'refused' && /worker-1 est un agent, pas une vague/.test(ex1Text) && /depuis la ligne de son orchestrateur \(wave-ops\)/.test(ex1Text) && !/fleet-lead/.test(ex1Text) && inView(ex1, vp.w, vp.h), `code=${ex1Code}; "${ex1Text.replace(/\s+/g, ' ').slice(0, 220)}"; rect inside viewport; the wider run (fleet-lead) is NOT offered (Q5: no shortcut)`);
    const linkSel = `[data-pause-panel="explain"] [data-pause-fix="goto"][data-pause-for="${I.ops}"]`;
    const nBtns = await ev(`document.querySelectorAll('[data-pause-panel="explain"] button').length`);
    clause(arm, 'G3/refusal-worker-links-to-its-orchestrator-nothing-else', nBtns === 1 && !!(await btnRect(linkSel)) && /Aller à wave-ops/.test(await ev(`document.querySelector(${J(linkSel)}).textContent`)) && (await ev(`document.querySelectorAll('[data-pause-panel="explain"] .pause-explain-fix li').length`)) === 0 && J(bus().runs.map((r) => [r.id, r.paused_at, r.pause_mode])) === before, `${nBtns} button in the refusal: the link "Aller à wave-ops →" (navigation) — no remedy that pauses anything; nothing written`);
    await shot('5-refusal-worker', { x: 0, y: 100, width: 700, height: 420 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    clause(arm, 'G3/refusal-panel-closes-on-escape', (await ev(`document.querySelectorAll('[data-pause-panel]').length`)) === 0, 'Escape closes the panel');
    // the LINK: navigation — the orchestrator's row becomes the active one, the panel closes, NOTHING is written
    await hover('worker-1');
    await press(`.ws-row-actions-pop [data-pause-action="soft"][data-pause-for="${I.w1}"]`, '⏸ on a worker row (again, for the link)');
    const linkBtn = await waitFor(() => btnRect(linkSel), 8000, 'the link to the orchestrator');
    const activeBefore = await ev(`document.querySelector('.ws-item.active .ws-name')?.textContent`);
    await cdp.click(linkBtn.x, linkBtn.y); await sleep(600);
    const activeAfter = await ev(`document.querySelector('.ws-item.active .ws-name')?.textContent`);
    clause(arm, 'G3/refusal-link-navigates-and-writes-nothing', activeBefore !== 'wave-ops' && activeAfter === 'wave-ops' && (await ev(`document.querySelectorAll('[data-pause-panel]').length`)) === 0 && J(bus().runs.map((r) => [r.id, r.paused_at, r.pause_mode])) === before && bus().roster.length === rosterBefore, `active row "${activeBefore}" → "${activeAfter}"; the panel closed; every run's pause columns and the roster (${rosterBefore} rows) unchanged`);
    await parkAndSettle();
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
    const heldOpsOutcome = world.hold(I.ops).outcome; // `orchestra run hold --run wave-ops` (the shipped setRunHold): a ▶ on the covered row still lifts it — as the CLI verb does — and must SAY so (R2-1)
    const heldOpsBefore = run(I.ops).held_at;
    await hover('wave-ops');
    await press(`.ws-row-actions-pop [data-pause-action="resume"][data-pause-for="${I.ops}"]`, '▶ on the covered OPS row');
    await waitFor(() => btnRect('[data-pause-panel="explain"] [data-pause-explain-code]'), 8000, 'the covered-run explanation');
    const ex3Text = await ev(`document.querySelector('[data-pause-panel="explain"]').textContent`);
    clause(arm, 'G3/refusal-covered-remedy-names-the-ancestor-no-button', (await ev(`document.querySelectorAll('[data-pause-panel="explain"] button').length`)) === 0 && /Reprendre fleet-lead/.test(await ev(`document.querySelector('[data-pause-panel="explain"] .pause-explain-fix')?.textContent ?? ''`)), 'the remedy names fleet-lead (the run that holds the pause) as text: no button resumes a wider run');
    clause(arm, 'G3/refusal-covered-run-names-the-ancestor', /fleet-lead tient déjà wave-ops en pause/.test(ex3Text) && run(I.ops).paused_at === null && run(I.lead).resume_started_at === null, `"${ex3Text.replace(/\s+/g, ' ').slice(0, 200)}"; wave-ops has no pause of its own, the lead's Reprise did not start`);
    clause(arm, 'G3/refusal-covered-resume-says-the-hold-was-lifted', heldOpsOutcome === 'held' && heldOpsBefore !== null && run(I.ops).held_at === null && /hold de liveness/.test(ex3Text) && /wave-ops/.test(ex3Text), `hold seeded (${heldOpsOutcome}, held_at ${heldOpsBefore}) → held_at ${run(I.ops).held_at} after ▶ on the covered row; the explanation says so: "${ex3Text.replace(/\s+/g, ' ').slice(0, 260)}"`);
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
    clause(arm, 'G3/ui-row-pill-shows-release-count', /^Libérer 1 bloqué \(\+4 plus bas, à part\)$/.test(await ev(`document.querySelector('.ws-row-actions-pop [data-pause-action="release-all"]').getAttribute('title')`)), `tooltip "${await ev(`document.querySelector('.ws-row-actions-pop [data-pause-action="release-all"]').getAttribute('title')`)}"`);
    const resSide = await shot('6-reprise-sidebar', sideClip);
    clause(arm, 'G3/ui-reprise-sidebar', /^Reprise · \d+\/7 repris · 5 bloqués$/.test(await ev(`document.querySelector('[data-pause-note="${I.lead}"]')?.textContent`) ?? '') && (await badges()).filter((b) => b[1] === 'blocked').length === 5, `lead note "${await ev(`document.querySelector('[data-pause-note="${I.lead}"]')?.textContent`)}"; ${(await badges()).filter((b) => b[1] === 'blocked').length} workers badged "bloqué"`);
    await cdp.click(relBtn.x, relBtn.y);
    const second = await waitFor(() => btnRect(`[data-pause-panel="explain"] [data-pause-fix="release"]`), 15000, 'the « libérer aussi » button in the floating panel');
    clause(arm, 'G3/ui-row-release-all-leaves-below-to-a-second-gesture', bus().roster.filter((r) => r.run_id === I.lead && r.paused_at === run(I.lead).paused_at && r.released_at !== null && r.role === 'worker').map((r) => r.ws_id).join() === I.docs && run(I.lead).paused_at !== null && inView(second, vp.w, vp.h) && /^Libérer aussi ces 4/.test(await ev(`document.querySelector('[data-pause-panel="explain"] [data-pause-fix="release"]').textContent.trim()`)), `row ▶ released only docs (the lead's own); the panel offers "${await ev(`document.querySelector('[data-pause-panel="explain"] [data-pause-fix="release"]').textContent.trim()`)}" inside the viewport; the Reprise is not finished`);
    await cdp.click(second.x, second.y);
    await waitFor(() => run(I.lead).paused_at === null, 20000, 'the Reprise to finish', 300);
    await parkAndSettle();
    clause(arm, 'G3/ui-back-to-ordinary', (await badges()).length === 0 && !bus().runs.some((r) => r.paused_at !== null), `badges ${(await badges()).length}; no run holds a pause`);

    // ── 5. the in-flight Pause douce (state-injected: an idle fleet is confirmed within a sweep, so the waiting phase cannot be held on the real path without live sessions — the F2 canary drives that) ──
    const injected = await ev(`(() => { const now = Date.now(); const ids = ${J(wave)}; const names = ${J(Object.fromEntries(Object.entries(NAME_OF)))}; const mem = (id, i) => ({ wsId: id, label: names[id], role: i < 2 ? 'coordinator' : 'worker', memberRun: i === 0 ? ${J(I.lead)} : ${J(I.ops)}, ui: i < 5 ? 'paused' : 'pausing', confirmVia: i < 5 ? 'member' : null, confirmedAt: i < 5 ? now : null, releasedAt: null, releasedBy: null, repriseConfirmedAt: null, bilan: null });
      const members = ids.map(mem);
      const run = { carrierRunId: ${J(I.lead)}, carrierLabel: 'fleet-lead', title: null, phase: 'pausing', mode: 'soft', pausedAt: now - 70000, pausedBy: 'humain', pausedByLabel: 'un humain', deadlineAt: now + 110000, escalatedAt: null, trapAt: null, resumeStartedAt: null, auto: false, progress: { kind: 'en-pause', done: 5, total: 7, missing: ids.slice(5) }, blocked: [], members };
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
    // ── 6. an UNREADABLE overview (state-injected: the bus read throwing cannot be provoked on the real path without breaking the rig's bus): said out loud, never "nothing is paused"
    await ev(`window.__orchestraSetState({ pauseOverview: { available: false, error: 'pause overview failed: SQLITE_BUSY (G3 injected)', at: Date.now(), runs: [], controls: {}, byWorkspace: {} } })`);
    await sleep(700); await parkAndSettle();
    const strip = await ev(`(() => { const e = document.querySelector('.sidebar [data-pause-unreadable]'); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, text: e.textContent, badges: document.querySelectorAll('[data-pause-badge]').length }; })()`);
    clause(arm, 'G3/ui-unreadable-overview-says-so', !!strip && /état illisible/.test(strip.text) && /SQLITE_BUSY/.test(strip.text) && strip.badges === 0 && inView(strip, vp.w, vp.h), `sidebar strip "${(strip?.text ?? '').slice(0, 120)}" inside the viewport, ${strip?.badges} badges (the rows show none — and now the user is told why)`);
    const stripShot = await shot('8-unreadable-sidebar', { x: 0, y: Math.max(0, Math.round(strip.top) - 90), width: 345, height: Math.min(vp.h - Math.max(0, Math.round(strip.top) - 90), 220) }); // the strip sits above the footer, outside the rows clip
    clause(arm, 'G3/ui-unreadable-pixels', pixelsNear(stripShot, YELLOW, 30) > 40, `amber px ${pixelsNear(stripShot, YELLOW, 30)} (the strip's rule + icon)`);
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

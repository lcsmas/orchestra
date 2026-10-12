// arm `gone` — a member DELETED during a Reprise: it leaves every count (note "Reprise · N/M repris · K bloqués") and the host releases it, so the Reprise closes
// once the LIVE members are released. Must-FAIL on a build without the fix: the note keeps the deleted member and the Reprise never closes.
import { IDS, NAME_OF, decodePng, diffPx, sleep, waitFor } from './lib.mjs';

const J = JSON.stringify;

export async function armGone({ bootArm, rec, LABEL }) {
  const arm = 'gone';
  const { clause, saveShot } = rec;
  const { world, a, liveBusCheck } = await bootArm(arm);
  const cdp = a.cdp;
  const I = IDS;
  const ev = (expr) => cdp.eval(expr);
  const call = (expr) => cdp.eval(`(async () => JSON.parse(JSON.stringify((await (${expr})) ?? null)))()`);
  const bus = () => world.readBus();
  const run = (id) => bus().runs.find((r) => r.id === id);
  const note = () => ev(`document.querySelector('[data-pause-note="${I.lead}"]')?.textContent ?? null`);
  const sideClip = { x: 0, y: 100, width: 345, height: 470 };
  const shot = async (name) => { await cdp.mouse(5, 890); await sleep(500); await ev(`document.fonts.ready.then(() => true)`); const buf = await cdp.shot(sideClip); saveShot(`${LABEL}-${name}.png`, buf); return decodePng(buf); };
  try {
    const p = await call(`window.orchestra.pausePause(${J(I.lead)}, 'hard')`);
    await waitFor(() => run(I.lead).pause_trap_at !== null, 120_000, 'the host trap', 500);
    const rs = await call(`window.orchestra.pauseResume(${J(I.lead)})`);
    await waitFor(async () => /^Reprise · /.test((await note()) ?? ''), 20_000, 'the Reprise note', 300);
    const pre = await note();
    clause(arm, 'ctl/gone-pre-state', p.outcome === 'paused' && rs.outcome === 'resuming' && /^Reprise · 0\/7 repris · 5 bloqués$/.test(pre ?? ''), `pause=${p.outcome}, resume=${rs.outcome}; lead note BEFORE the delete: "${pre}"`);
    const preImg = await shot('gone-0-before-delete');

    // the user's act: delete a blocked worker mid-Reprise
    const del = await call(`window.orchestra.deleteWorkspace(${J(I.w4)})`).catch((e) => `ERR ${e.message}`);
    await waitFor(async () => !(await ev(`[...document.querySelectorAll('.ws-item .ws-name')].some((n) => n.textContent === 'worker-4')`)), 20_000, 'the worker-4 row to disappear', 300);
    const post = await waitFor(async () => { const n = await note(); return /· 4 bloqués$/.test(n ?? '') ? n : null; }, 45_000, 'the note to drop the deleted member', 500).catch(async () => note());
    clause(arm, 'G/gone-note-drops-deleted-member', post === 'Reprise · 0/6 repris · 4 bloqués', `deleteWorkspace(worker-4) → ${J(del)}; lead note "${pre}" → "${post}"`);
    const row = bus().roster.find((r) => r.run_id === I.lead && r.ws_id === I.w4);
    clause(arm, 'G/gone-host-released', row?.released_by === 'host:supprimé' && row.released_at !== null, `worker-4 roster row: released_by=${row?.released_by} released_at=${row?.released_at}`);
    const postImg = await shot('gone-1-after-delete');
    const d = diffPx(preImg, postImg);
    clause(arm, 'ctl/gone-delete-painted', d > 200, `${d} px differ between the before/after sidebar captures (the worker-4 row and the note)`);

    // the live members released ⇒ the Reprise closes (the deleted one no longer holds it)
    const ra = await call(`window.orchestra.pauseRelease(${J(I.ops)}, ${J([I.w1, I.w2, I.w3])})`);
    const rb = await call(`window.orchestra.pauseRelease(${J(I.lead)}, ${J([I.docs])})`);
    const closed = await waitFor(() => run(I.lead).paused_at === null, 45_000, 'the Reprise to close', 500).then(() => true).catch(() => false);
    clause(arm, 'G/gone-reprise-closes', closed, `released ${ra.result?.released?.length ?? 0} + ${rb.result?.released?.length ?? 0} live members; lead paused_at=${run(I.lead).paused_at} (null = active again); note now "${await note()}"`);
  } catch (e) {
    clause(arm, 'G/gone-arm-completed', false, `ARM ABORTED: ${e.stack || e}`);
  } finally {
    cdp.close();
    liveBusCheck();
    const left = await a.kill();
    clause(arm, 'ctl/teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
  void NAME_OF;
}

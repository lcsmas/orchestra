// #419 — Bloc HTML live-frame budget rig. Boots a BUILT Orchestra (argv[2] = app dir) in the contained rig, replays a long reply full of blocs and measures what a human
// sees while scrolling: how many frames are live, whether the layout moves when a bloc unmounts / remounts, whether scripts restart, whether a looping bloc stops freezing
// its siblings once it is unmounted, and whether a healthy bloc survives a starved renderer. Arms (each = one app boot):
//   real              the build as is — every clause GREEN
//   no-keep-eviction  a COPY whose slots are never evicted by the keep margin → B1 (bound) must go RED
//   no-ceiling        a COPY without the live-frame ceiling               → B7 (dense blocs) must go RED
//   no-placeholder    a COPY whose unmounted slot has no height          → B2 (no scroll jump) must go RED
//   no-slot-pin       a COPY whose open overlay does not pin its slot (the live-frame budget unmounts the bloc under it) → B9 must go RED
//   no-focus-keep     a COPY whose slot does not stay mounted while focus is inside it (closing an overlay of a pinned-but-unloaded bloc drops focus to <body>) → B9 must go RED
//   bare-focus-pin    a COPY that takes a ROW pin on a bare focus (the chrome-rig flake's cause) → B12 must go RED
//   no-row-pin        a COPY whose open overlay does not pin its transcript row (the windowed list unmounts it) → B10 must go RED
//   no-box            a COPY whose placeholder is not the rendered (clipped) box of a TALL bloc → B11 must go RED
//   box-old           a COPY without the unmount-time box capture AND the mount-time guard (what db0506bd had: a remounted EXPANDED bloc recorded its 28 px button as its box → a 904 px jump on the next unload) → B11 must go RED
//   no-expanded       a COPY that forgets « Afficher tout » on remount (the box changes under the reader) → B11 must go RED
//   failed-height     a COPY that does not remember the CODE FALLBACK's height (its unloaded slot falls back to the 80 px initial height) → B8 must go RED
//   watchdog-mount    a COPY whose watchdog fails a frame 6 s after MOUNT, `load` ignored, the report's clear one task late (the #415 behaviour, review M3) → W1 must go RED
// A mutant passes only if its named clause is RED, every control GREEN and its OTHER clauses GREEN (allowed follow-ons listed). The mutation is ONE regex (counted == 1) on a disposable COPY;
// the built dir is md5-compared before/after.
import fs from 'node:fs';
import path from 'node:path';
import { contain, launch, sleep, waitFor, events, fence, md5, treeHash, walk } from './lib/bloc-rig.mjs';

const argv = process.argv.slice(2);
const ctx = contain(argv);
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : ctx.refuse('no <app-dir>');
const ARMS = ctx.flag('--arms', 'real,no-keep-eviction,no-ceiling,no-placeholder,no-box,no-expanded,box-old,failed-height,no-slot-pin,no-focus-keep,bare-focus-pin,no-row-pin,watchdog-mount').split(',');
const ONLY = ctx.flag('--only', null); // debug: run one section of `real` (main|B7|B9|B11|B8|W1|M1)
const run = (name) => !ONLY || ONLY.split(',').includes(name);
const OUT = ctx.flag('--out', path.join(ctx.RIG_DIR, 'shots'));
fs.mkdirSync(OUT, { recursive: true });
console.log(`[guard] ${ctx.selfTest}`);

// the shipped figures, read from the source the app was built from (src/shared/bloc-live-budget.ts)
const budgetSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/shared/bloc-live-budget.ts'), 'utf8');
const num = (n) => Number(new RegExp(`export const ${n} = ([\\d_]+)`).exec(budgetSrc)[1].replace(/_/g, ''));
const MOUNT = num('BLOC_MOUNT_MARGIN_PX'), KEEP = num('BLOC_KEEP_MARGIN_PX'), LIVE_MAX = num('BLOC_LIVE_MAX');
const results = [];
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }

// ── mutants: ONE regex on a disposable COPY (name-independent: the bundle is minified) ──
const MUTANTS = {
  'no-keep-eviction': { clause: 'B1', dir: 'dist/assets', re: /(\w+)=>\{(\w+)\.kept=\1\}/, to: (m) => `${m[1]}=>{${m[2]}.kept=!0}`, allowed: ['M1'] },
  'no-ceiling': { clause: 'B7', dir: 'dist/assets', re: /live:\w+\.live\}\}\),(\w+)\);for\(const \w+ of \w+\)\{const \w+=\w+\.has/, to: (m) => m[0].replace(`}),${m[1]});`, '}),1e9);'), allowed: [] },
  'bare-focus-pin': { clause: 'B12', dir: 'dist/assets', re: /(\w+)=\w+\.useContext\(\w+\),(\w+)=\w+\.useRef\(!1\),\w+=\w+\.useRef\(!0\),(\w+)=\w+\.useRef\(null\)[\s\S]{0,1600}?onFocus:\(\)=>\{\2\.current=!0,(\w+)\(!0\)\}/, to: (m) => m[0].replace(/onFocus:\(\)=>\{(\w+)\.current=!0,(\w+)\(!0\)\}$/, (x, a, b) => `onFocus:()=>{${a}.current=!0,${b}(!0),${m[3]}.current||(${m[3]}.current=(${m[1]}==null?void 0:${m[1]}())??null)}`), allowed: [] },
  'no-slot-pin': { clause: 'B9', dir: 'dist/assets', re: /const (\w+)=(\w+)\|\|\w+>0\|\|(\w+);(return \w+\.jsx\("div",\{ref:\w+,className:"av-bloc-slot")/, to: (m) => `const ${m[1]}=${m[2]}||${m[3]};${m[4]}`, allowed: [] },
  'no-focus-keep': { clause: 'B9', dir: 'dist/assets', re: /const (\w+)=(\w+)\|\|(\w+)>0\|\|\w+;(return \w+\.jsx\("div",\{ref:\w+,className:"av-bloc-slot")/, to: (m) => `const ${m[1]}=${m[2]}||${m[3]}>0;${m[4]}`, allowed: ['B10'] },
  'no-row-pin': { clause: 'B10', dir: 'dist/assets', re: /(const \w+=)\w+==null\?void 0:\w+\(\);(return\(\)=>\{\w+\(\w+=>\w+-1\),)/, to: (m) => `${m[1]}void 0;${m[2]}`, allowed: ['B12'] },
  'box-old': { clause: 'B11', dir: 'dist/assets', re: /useLayoutEffect\(\(\)=>\(\)=>\{const\{failed:[\s\S]{0,420}?querySelector\("\.av-bloc-frame"\)\)return;/, to: (m) => m[0].replace(/(\w+)>0&&(\w+\(\w+,\1\)\},\[\w+\]\),)/, '!1&&$2').replace(/\|\|!(\w+)\.querySelector\("\.av-bloc-frame"\)/, ''), allowed: [] },
  'no-box': { clause: 'B11', dir: 'dist/assets', re: /(const (\w+)=Math\.ceil\((\w+)\.getBoundingClientRect\(\)\.height\);)(\2>0&&\w+\(\w+,)\2\)/, to: (m) => `${m[1]}${m[4]}80)`, allowed: [] },
  'no-expanded': { clause: 'B11', dir: 'dist/assets', re: /useState\(\(\)=>\w+\(\w+\)\),(\[\w+,\w+\]=\w+\.useState\(!1\),\w+=\w+\.useMemo\(\(\)=>\w+\("inline",\w+\),\[\w+\]\))/, to: (m) => `useState(!1),${m[1]}`, allowed: [] },
  'failed-height': { clause: 'B8', dir: 'dist/assets', re: /(\w+)&&(\w+)\.current&&(\w+)\((\w+),Math\.ceil\(\2\.current\.getBoundingClientRect\(\)\.height\)\)/, to: (m) => `${m[1]}&&${m[2]}.current&&${m[3]}(${m[4]},80)`, also: [{ re: /const ([\w$]+)=([\w$]+)\?([\w$]+)\.current:([\w$]+)\.current;if\(!\1\)return;/, to: (m) => `const ${m[1]}=${m[2]}?null:${m[4]}.current;if(!${m[1]})return;` }], allowed: [] },
  'no-placeholder': { clause: 'B2', dir: 'dist/assets', re: /(av-bloc-idle",role:"img","aria-label":[\w$]+,children:[\w$]+\.jsx\("div",\{style:\{height:)[\w$]+\([\w$]+\)\}/, to: (m) => `${m[1]}0}`, allowed: ['B1'] },
  'watchdog-mount': { clause: 'W1', dir: 'dist/assets', re: /start:\(\)=>\{(\w+)\|\|(\w+)\([\w$]+\)\},loaded:\(\)=>\{\1\|\|\2\([\w$]+\)\},reported:\(\)=>\{\1=!0,(\w+)\(\)\}/, to: (m) => `start:()=>{${m[1]}||${m[2]}(6e3)},loaded:()=>{},reported:()=>{setTimeout(()=>{${m[1]}=!0,${m[3]}()},50)}`, allowed: [] },
};
function makeMutantCopy(armDir, m) {
  const copy = path.join(armDir, 'app'); fs.mkdirSync(copy, { recursive: true });
  for (const d of ['dist', 'dist-electron']) fs.cpSync(path.join(APP_DIR, d), path.join(copy, d), { recursive: true });
  fs.copyFileSync(path.join(APP_DIR, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(copy, 'node_modules'));
  const proofs = [];
  for (const mm of [m, ...(m.also ?? [])]) { // `also`: a guard that has a redundant twin needs BOTH removed to be killable
    const files = walk(path.join(copy, m.dir)).filter((f) => f.endsWith('.js'));
    const hit = files.map((f) => ({ f, n: (fs.readFileSync(f, 'utf8').match(new RegExp(mm.re.source, 'g')) ?? []).length })).filter((x) => x.n > 0);
    if (hit.length !== 1 || hit[0].n !== 1) throw new Error(`mutation ${mm.re} matched ${JSON.stringify(hit)} — must be exactly 1 match in 1 file`);
    const before = fs.readFileSync(hit[0].f, 'utf8'); const mt = mm.re.exec(before);
    const after = before.replace(mm.re, mm.to(mt));
    fs.writeFileSync(hit[0].f, after);
    proofs.push({ match: mt[0], became: mm.to(mt), file: path.relative(copy, hit[0].f), beforeMd5: md5(before), afterMd5: md5(after), changed: before !== after });
  }
  return { copy, proof: { match: proofs.map((x) => x.match).join(' + '), became: proofs.map((x) => x.became).join(' + '), file: proofs.map((x) => x.file).join(' + '), beforeMd5: proofs[0].beforeMd5, afterMd5: proofs.at(-1).afterMd5, changed: proofs.every((x) => x.changed) } };
}

// ── the blocs ──
const PONG = `addEventListener('message',function(e){if(e.data==='go'){for(;;){}}});`;
const hbBloc = (i, h) => `<div style="height:${h}px;background:var(--bloc-surface);color:var(--bloc-fg)">BLOC-${i}</div><script>parent.postMessage({__probe:'boot',i:${i}},'*');var n=0;setInterval(function(){parent.postMessage({__hb:${i},n:++n},'*')},100);${PONG}</script>`;
const N = 40;
const longReply = 'INTRO\n' + Array.from({ length: N }, (_, i) => fence(`html-render title="bloc ${i}"`, hbBloc(i, 400)) + `\n\nMARK-${i} a paragraph after bloc ${i}\n`).join('\n');

async function runArm(arm) {
  const H = 1000;
  console.log(`\n== arm ${arm} ==`);
  const armDir = path.join(ctx.RIG_DIR, `arm-${arm}`); fs.mkdirSync(armDir, { recursive: true });
  const origHash = treeHash([path.join(APP_DIR, 'dist'), path.join(APP_DIR, 'dist-electron')]);
  let appDir = APP_DIR, proof = null; const mut = MUTANTS[arm];
  if (mut) { const mc = makeMutantCopy(armDir, mut); appDir = mc.copy; proof = mc.proof; }
  const h = await launch(ctx, { appDir, armDir, tag: 'bb419', w: 1400, h: H });
  const { cdp } = h; const ev = events();
  try {
    const scrollOnly = arm === 'no-placeholder'; // its collapsed layout makes every later zone meaningless: the clause under test is B2
    if (mut) clause(arm, 'ctl/mutation-applied', proof.changed, `${JSON.stringify(proof.match)} -> ${JSON.stringify(proof.became)} exactly once in ${proof.file} (md5 ${proof.beforeMd5} -> ${proof.afterMd5}), disposable COPY`);
    const target = (await (await fetch(`http://127.0.0.1:${h.port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html'));
    clause(arm, 'ctl/app-identity-path', target.url.includes(appDir) && !target.url.includes('app.asar'), `target ${target.url}`);
    await cdp.eval(`window.__boots = {}; window.__hb = {};
      window.addEventListener('message', (e) => { const d = e.data; if (!d) return; if (d.__probe === 'boot') window.__boots[d.i] = (window.__boots[d.i] || 0) + 1; if (typeof d.__hb === 'number') window.__hb[d.__hb] = (window.__hb[d.__hb] || 0) + 1; }); 1`);
    const list = `document.querySelector('.av-message-list')`;
const slotDiag = () => cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); return JSON.stringify({ top: L.scrollTop, sh: L.scrollHeight, ch: L.clientHeight, frames: document.querySelectorAll('iframe.av-bloc-frame').length, live: document.querySelectorAll('.av-bloc-slot[data-live="1"]').length, near: [...document.querySelectorAll('.av-bloc-slot')].map((s, i) => { const r = s.getBoundingClientRect(); return [i, Math.round(r.top - lr.top), Math.round(r.height), s.dataset.live, !!s.querySelector('iframe')]; }).filter((x) => x[1] > -1700 && x[1] < 2600) }); })()`);
    const withDiag = async (what, f) => { try { return await f(); } catch (e) { throw new Error(`${e.message} :: ${await slotDiag().catch(() => '?')}`); } };
    // the slot count of ONE reply (found by its marker text): robust to rows the windowed list mounts/unmounts elsewhere while the sections run
    const replySlots = (marker) => cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes(${JSON.stringify(marker)})); return m ? m.querySelectorAll('.av-bloc-slot').length : -1; })()`);
    // A/B diagnostics: scrollTop + every slot's [data-live, top rel. to the list, height] (+ the first row's box) at one instant
    const slotDump = () => cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); return { st: Math.round(L.scrollTop), sh: L.scrollHeight, s: [...document.querySelectorAll('.av-bloc-slot')].map((x) => { const r = x.getBoundingClientRect(); return [x.dataset.live, Math.round(r.top - lr.top), Math.round(r.height)]; }).filter((a) => a[1] > -4000 && a[1] < 5000) }; })()`);
    const state = () => cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const slots = [...document.querySelectorAll('.av-bloc-slot')];
      return { top: L.scrollTop, sh: L.scrollHeight, ch: L.clientHeight, slots: slots.length, live: slots.filter((s) => s.dataset.live === '1').length, frames: document.querySelectorAll('iframe.av-bloc-frame').length,
        liveDist: Math.max(0, ...slots.filter((s) => s.dataset.live === '1').map((s) => { const r = s.getBoundingClientRect(); return Math.max(0, lr.top - r.bottom, r.top - lr.bottom); })),
        inView: slots.map((s, i) => ({ i, r: s.getBoundingClientRect(), live: s.dataset.live === '1' })).filter((x) => x.r.bottom > lr.top && x.r.top < lr.bottom).map((x) => ({ i: x.i, live: x.live })),
        slotH: slots.slice(0, 40).map((s) => Math.round(s.getBoundingClientRect().height)), slotL: slots.slice(0, 40).map((s) => s.dataset.live),
        marks: [...document.querySelectorAll('.av-md-p')].filter((p) => /^MARK-/.test(p.textContent)).map((p) => ({ k: p.textContent.slice(0, 9), y: Math.round(p.getBoundingClientRect().top - lr.top + L.scrollTop) })) }; })()`);
    // instant: the transcript's stylesheet says `scroll-behavior: smooth`, which would animate a programmatic scroll under the measurement
    const scrollTo = async (y, ms = 160) => { await cdp.eval(`${list}.scrollTo({ top: ${y}, behavior: 'instant' }); 1`); await sleep(ms); };

    const lite = ['watchdog-mount', 'failed-height', 'no-slot-pin', 'no-focus-keep', 'bare-focus-pin', 'no-row-pin', 'no-box', 'no-expanded', 'box-old'].includes(arm); // these arms drive only their own clause
    if (!lite && run('main')) {
      await h.inject(ev.text(longReply));
      await waitFor(async () => { const s = await state(); return s.slots === N; }, 120000, `${N} bloc slots (the typewriter drains the reply)`);
      await scrollTo(0, 800);
      // ── FIRST SWEEP down (blocs never measured: placeholders carry the 80 px initial height) ──
      // the blocs already on screen at the start are measured for the first time as they mount (80 → 400 px: a first-measurement growth, not an unmount/remount): let them settle before the sweep
      await withDiag('first screen', () => waitFor(() => cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const v = [...document.querySelectorAll('.av-bloc-slot')].filter((s) => { const r = s.getBoundingClientRect(); return r.bottom > lr.top && r.top < lr.bottom + 800; }); return v.length > 0 && v.every((s) => s.getBoundingClientRect().height >= 300); })()`), 30000, 'the first screen of blocs to report'));
      { // the layout must be still before the sweep reads a reference: wait until scrollHeight holds for 1.5 s
        let last = -1, since = Date.now();
        for (let t = 0; t < 120 && Date.now() - since < 1500; t++) { const sh = await cdp.eval(`${list}.scrollHeight`); if (sh !== last) { last = sh; since = Date.now(); } await sleep(250); }
      }
      const STEP = 150; let jump = 0, steps = 0, maxLive1 = 0; const jumpAt = [];
      let s0 = await state();
      for (let y = 0; y + s0.ch < s0.sh - 5 && steps < 400; y += STEP, steps++) {
        await scrollTo(y, 60);
        const before = await cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const m = [...document.querySelectorAll('.av-md-p')].filter((p) => /^MARK-/.test(p.textContent) && p.getBoundingClientRect().bottom > lr.top + 20 && p.getBoundingClientRect().top < lr.bottom - 20)[0]; window.__ref = m; return m ? { k: m.textContent.slice(0, 9), t: m.getBoundingClientRect().top } : null; })()`);
        await scrollTo(y + STEP, 80);
        const after = before ? await cdp.eval(`(() => ({ k: window.__ref.textContent.slice(0, 9), t: window.__ref.getBoundingClientRect().top }))()`) : null;
        if (before && after && y + STEP + s0.ch <= s0.sh - 40 && Math.abs(after.t - before.t + STEP) > 2) /* not within 40 px of the end: the scroll range itself grows/shrinks a few px there and the step is CLAMPED (a rig artifact: the same -15 px at step 112 on every tip) */ { jump++; jumpAt.push({ step: steps, y, moved: Math.round(after.t - before.t + STEP), dump: jumpAt.length < 2 ? JSON.stringify(await slotDump()) : undefined }); }
        const s = await state(); maxLive1 = Math.max(maxLive1, s.frames); s0 = s;
      }
      // every bloc gets measured once (a frame must mount and report) so the next sweeps run on known heights
      for (let i = 0; i < N; i++) {
        // re-centre on the slot at every poll: a neighbour mounting or unmounting moves it (that is exactly what the no-placeholder mutant does)
        const centre = `(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const s = document.querySelectorAll('.av-bloc-slot')[${i}].getBoundingClientRect(); L.scrollTo({ top: L.scrollTop + (s.top + s.bottom) / 2 - (lr.top + lr.bottom) / 2, behavior: 'instant' }); return document.querySelectorAll('.av-bloc-slot')[${i}].getBoundingClientRect().height; })()`;
        await waitFor(async () => (await cdp.eval(centre)) >= 300, 30000, `bloc ${i} to mount and report`);
      }
      await sleep(600);
      const sFirst = await state();
      // ── SECOND + THIRD SWEEP (every height known, each stop SETTLED): bound + layout invariance ──
      const m0 = sFirst.marks; let baseSh = null, baseSlotH = null, shDiag = null; let maxSh = 0, minSh = 1e9, movedMarks = 0, maxDrift = 0, maxLive = 0, minLive = 1e9, notLiveInView = 0, maxLiveDist = 0, stops = 0;
      const byK = new Map(m0.map((m) => [m.k, m.y]));
      for (const dir of [-1, 1]) {
        const top0 = dir < 0 ? sFirst.sh : 0;
        for (let k = 0; k * 400 <= sFirst.sh + 400; k++) {
          await scrollTo(Math.max(0, Math.min(sFirst.sh, top0 + dir * k * 400)), 450);
          const s = await state(); stops++;
          if (stops === 1) baseSlotH = s.slotH; if (!shDiag && baseSh != null && Math.abs(s.sh - baseSh) > 2) shDiag = { stop: stops, top: s.top, sh: s.sh, baseSh, live: s.slotL.map((l, i) => [i, l]).filter(([i]) => Math.abs(s.slotH[i] - baseSlotH[i]) > 2), odd: s.slotH.map((h, i) => [i, h, baseSlotH[i]]).filter(([, h, b]) => Math.abs(h - b) > 2).slice(0, 8) }; if (baseSh == null) baseSh = s.sh;
          maxSh = Math.max(maxSh, s.sh); minSh = Math.min(minSh, s.sh);
          for (const m of s.marks) { const d = Math.abs(m.y - (byK.get(m.k) ?? m.y)); maxDrift = Math.max(maxDrift, d); if (d > 2) movedMarks++; }
          maxLive = Math.max(maxLive, s.frames); maxLiveDist = Math.max(maxLiveDist, s.liveDist);
          if (s.top > 3000 && s.top + s.ch < s.sh - 3000) minLive = Math.min(minLive, s.frames);
          notLiveInView += s.inView.filter((x) => !x.live).length;
        }
      }
      const pitch = sFirst.sh / N; // px per (bloc + paragraph), measured
      const bound = Math.min(LIVE_MAX, Math.floor((sFirst.ch + 2 * KEEP) / (pitch - 40)) + 3);
      clause(arm, 'B1/live-frames-stay-bounded-while-scrolling', maxLive <= bound && maxLive1 <= LIVE_MAX && maxLiveDist <= KEEP + 5 && minLive < N && minLive >= 1 && notLiveInView === 0,
        `${N} blocs of ~400 px, ${stops} settled stops: max live frames ${maxLive} (bound ${bound} = min(ceiling ${LIVE_MAX}, ⌊(viewport ${sFirst.ch} + 2×${KEEP}) / pitch ${Math.round(pitch)}⌋ + 3); first sweep, unmeasured heights, max ${maxLive1} ≤ ${LIVE_MAX}); farthest live frame ${maxLiveDist} px from the viewport (keep margin ${KEEP}); mid-list min ${minLive} < ${N}; blocs intersecting the viewport but not live: ${notLiveInView}`);
      clause(arm, 'B2/no-scroll-jump-when-a-bloc-unmounts-and-remounts', jump === 0 && maxSh - minSh <= 2 && movedMarks === 0,
        `down-sweep through never-measured blocs: ${steps} steps, ${jump} viewport jump(s) ${JSON.stringify(jumpAt)} (a reference paragraph moved other than by the scroll step, tol 2 px); two full sweeps with every height known: scrollHeight ${minSh}…${maxSh} (Δ ${maxSh - minSh}), ${movedMarks} paragraph(s) moved >2 px (max drift ${maxDrift} px)${shDiag ? ' first layout change: ' + JSON.stringify(shDiag) : ''}`);
      // scripts restart: bloc 0 mounted at the start, unmounted while scrolled away, mounted again at the end
      await scrollTo(0, 1200);
      const boots = await cdp.eval('window.__boots[0] || 0');
      clause(arm, 'B3/an-unmounted-bloc-remounts-and-its-scripts-restart', boots >= 2, `bloc 0 booted ${boots}x over the sweeps (≥2 = it was unmounted and mounted again with a fresh script)`);
      await sleep(300);
      const png = await cdp.shot(); fs.writeFileSync(path.join(OUT, `${arm}-after-sweeps.png`), png);
      clause(arm, 'ctl/blocs-live-at-the-end', (await state()).frames >= 1, `frames live after the sweeps: ${(await state()).frames}`);

    }

    if (!lite && !scrollOnly && arm !== 'no-keep-eviction' && run('B7')) {
      // ── B7: blocs so small that dozens sit inside one screen — the ceiling, not the margins, bounds the live frames ──
      const D = 40;
      const dense = 'DENSE\n' + Array.from({ length: D }, (_, i) => fence(`html-render title="dense ${i}"`, hbBloc(200 + i, 36))).join('\n');
      await h.inject(ev.text(dense));
      await waitFor(async () => { await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); return (await replySlots('DENSE')) === D; }, 120000, 'the dense slots');
      // measure the stack first (an unmeasured slot is an 80 px placeholder: it would sit beyond the mount margin and hide the ceiling), then centre it
      for (let i = 0; i < D; i++) {
        const centre = `(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const s = [...document.querySelectorAll('.av-bloc-slot')].slice(-${D})[${i}]; const r = s.getBoundingClientRect(); L.scrollTo({ top: L.scrollTop + (r.top + r.bottom) / 2 - (lr.top + lr.bottom) / 2, behavior: 'instant' }); return [...document.querySelectorAll('.av-bloc-slot')].slice(-${D})[${i}].getBoundingClientRect().height; })()`;
        await withDiag('dense', () => waitFor(async () => (await cdp.eval(centre)) < 70, 30000, `dense bloc ${i} to report its height`));
      }
      // put the middle of the dense stack at the viewport centre (the last D slots), let the budget settle
      await cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const s = [...document.querySelectorAll('.av-bloc-slot')].slice(-${D})[${D / 2}].getBoundingClientRect(); L.scrollTop += (s.top + s.bottom) / 2 - (lr.top + lr.bottom) / 2; return 1; })()`);
      await waitFor(() => cdp.eval(`document.querySelectorAll('iframe.av-bloc-frame').length === ${LIVE_MAX}`), 20000, 'the live frames to settle at the ceiling').catch(() => null);
      await sleep(800);
      const dn = await cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const mid = (lr.top + lr.bottom) / 2;
        const last = [...document.querySelectorAll('.av-bloc-slot')].slice(-${D}).map((s) => ({ s, r: s.getBoundingClientRect() }));
        const centre = last.sort((a, b) => Math.abs((a.r.top + a.r.bottom) / 2 - mid) - Math.abs((b.r.top + b.r.bottom) / 2 - mid))[0];
        const dist = (r) => Math.max(0, lr.top - r.bottom, r.top - lr.bottom);
        return { frames: document.querySelectorAll('iframe.av-bloc-frame').length, nearestLive: centre.s.dataset.live === '1',
          diag: { withinMount: last.filter((x) => dist(x.r) <= ${MOUNT}).length, withinKeep: last.filter((x) => dist(x.r) <= ${KEEP}).length, liveWithinMount: last.filter((x) => dist(x.r) <= ${MOUNT} && x.s.dataset.live === '1').length, top: L.scrollTop, sh: L.scrollHeight, ch: L.clientHeight, heights: [...new Set(last.map((x) => Math.round(x.r.height)))] } }; })()`);
      clause(arm, 'B7/the-live-frame-ceiling-holds-with-dozens-of-blocs-in-one-screen', dn.frames === LIVE_MAX && dn.nearestLive === true && dn.diag.withinMount > LIVE_MAX,
        `${D} blocs of 36 px stacked in the transcript (${dn.diag.withinMount} within the ${MOUNT} px mount margin, measured heights): live frames = ${dn.frames} (ceiling ${LIVE_MAX}); the bloc nearest the viewport centre is live: ${dn.nearestLive}; diag ${JSON.stringify(dn.diag)}`);
    }

    if ((arm === 'real' || arm === 'no-slot-pin' || arm === 'no-focus-keep' || arm === 'bare-focus-pin' || arm === 'no-row-pin') && run('B9')) {
      // ── B9 / B10 (#417 review MINOR 2): a bloc with an OPEN enlarge overlay is never unmounted — not by the live-frame budget, not by the windowed transcript ──
      const press = async (key, code, vk) => { for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk }); };
      const enlarge = async (title) => { await waitFor(() => cdp.eval(`!!document.querySelector('iframe[title="${title}"]')`), 30000, `the ${title} frame to be mounted`); return enlargeNow(title); };
      const enlargeNow = (title) => cdp.eval(`(() => { const f = document.querySelector('iframe[title="${title}"]'); const b = f && f.closest('.av-bloc').querySelector('button[aria-label^="Agrandir"]'); if (!b) return false; b.click(); return true; })()`);
      const overlay = () => cdp.eval(`(() => { const o = document.querySelector('.av-bloc-overlay'); return o ? { open: true, frame: !!o.querySelector('iframe'), focusInside: o.contains(document.activeElement) } : { open: false }; })()`);
      const baseP = await cdp.eval(`document.querySelectorAll('.av-bloc-slot').length`);
      await h.inject(ev.text('PINPAD\n' + Array.from({ length: 12 }, (_, i) => fence(`html-render title="pin ${i}"`, hbBloc(400 + i, 400))).join('\n\n') + '\n'));
      await waitFor(() => cdp.eval(`document.querySelectorAll('.av-bloc-slot').length === ${baseP} + 12`), 120000, 'the pin-zone slots');
      for (let i = 0; i < 12; i++) {
        const centre = `(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const s = document.querySelectorAll('.av-bloc-slot')[${baseP + i}].getBoundingClientRect(); L.scrollTo({ top: L.scrollTop + (s.top + s.bottom) / 2 - (lr.top + lr.bottom) / 2, behavior: 'instant' }); return document.querySelectorAll('.av-bloc-slot')[${baseP + i}].getBoundingClientRect().height; })()`;
        await waitFor(async () => (await cdp.eval(centre)) >= 300, 30000, `pin-zone bloc ${i} to report`);
      }
      // B9: enlarge the FIRST bloc of a 12-bloc row, then go far past the keep margin — its slot must stay mounted under the overlay
      await cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const s = document.querySelectorAll('.av-bloc-slot')[${baseP}].getBoundingClientRect(); L.scrollTo({ top: L.scrollTop + s.top - lr.top - 60, behavior: 'instant' }); return 1; })()`);
      await sleep(600);
      const opened = await enlarge('pin 0');
      await waitFor(async () => (await overlay()).open && (await overlay()).frame, 30000, 'the enlarged overlay');
      await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); await sleep(2500);
      const o9 = await overlay();
      await press('Escape', 'Escape', 27); await sleep(400);
      const closed = !(await overlay()).open;
      const focus9 = await cdp.eval(`(document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label')) || (document.activeElement ? document.activeElement.tagName : 'none')`); // the bloc was FAR (pinned, not live): focus must still come back to its « Agrandir » button
      await cdp.eval(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); 1`); // release the slot: nothing holds it any more
      await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); // closing hands focus back to the bloc's button, which scrolls it into view: go far again
      await sleep(2500); // released: the budget decides again — the slot, far above the viewport, unmounts
      const slotAfter = await cdp.eval(`(() => { const s = document.querySelectorAll('.av-bloc-slot')[${baseP}]; return s ? s.dataset.live : 'gone'; })()`);
      // the SOURCE view of another bloc (non-modal) is pinned the same way
      await cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const s = document.querySelectorAll('.av-bloc-slot')[${baseP + 1}].getBoundingClientRect(); L.scrollTo({ top: L.scrollTop + s.top - lr.top - 60, behavior: 'instant' }); return 1; })()`);
      await waitFor(() => cdp.eval(`!!document.querySelector('iframe[title="pin 1"]')`), 30000, 'the pin 1 frame');
      await sleep(300);
      const srcOpened = await cdp.eval(`(() => { const f = document.querySelector('iframe[title="pin 1"]'); const b = f && f.closest('.av-bloc').querySelector('button[aria-label^="Afficher le source"]'); if (!b) return false; b.click(); return true; })()`);
      await sleep(600);
      await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); await sleep(2500);
      const srcSurvives = await cdp.eval(`(() => { const s = document.querySelectorAll('.av-bloc-slot')[${baseP + 1}]; return !!s && s.dataset.live === '1' && !!s.querySelector('.av-code-block, .av-code-lang') && !s.querySelector('iframe'); })()`);
      await cdp.eval(`(() => { const s = document.querySelectorAll('.av-bloc-slot')[${baseP + 1}]; const b = s && s.querySelector('button[aria-label^="Rendu"]'); if (b) b.click(); return 1; })()`);
      await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); await sleep(2500);
      const srcReleased = await cdp.eval(`(() => { const s = document.querySelectorAll('.av-bloc-slot')[${baseP + 1}]; return s ? s.dataset.live : 'gone'; })()`);
      clause(arm, 'B9/an-open-overlay-survives-the-live-frame-budget', opened && o9.open && o9.frame && o9.focusInside && closed && focus9 === 'Agrandir : pin 0' && slotAfter === '0' && srcOpened && srcSurvives && srcReleased === '0',
        `enlarged the first bloc of a 12-bloc row, scrolled the transcript to its end (≫ the ${KEEP} px keep margin): overlay still open ${o9.open}, its frame live ${o9.frame}, focus inside it ${o9.focusInside}; Escape closes it (${closed}) and focus returns to «${focus9}»; 2.5 s later the slot is released and unmounted again (data-live=${slotAfter}) — a pin that never let go would stay '1'; the SOURCE view of another bloc (opened ${srcOpened}) survives the same scroll as code, no frame (${srcSurvives}) and is released on « Rendu » (data-live=${srcReleased})`);
      // B10: enlarge the LAST bloc, then stream rows until its row leaves the windowed list — the overlay must survive
      await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`);
      await h.inject(ev.text('PINLAST\n' + fence('html-render title="pin last"', hbBloc(500, 60)) + '\n'));
      await waitFor(() => cdp.eval(`!!document.querySelector('iframe[title="pin last"]')`), 60000, 'the last bloc');
      await sleep(800);
      // B12 (review MINOR 3): a BARE focus on a bloc's control pins nothing — its row must show data-row-pins=0; control: an OPEN overlay shows ≥ 1 (the instrument reads a real pin)
      const rowPins = (title) => cdp.eval(`(() => { const b = document.querySelector('button[aria-label="Agrandir : ${title}"]'); const row = b && b.closest('.av-row'); return row ? Number(row.getAttribute('data-row-pins')) : -1; })()`); // by the control: while the overlay is open the inline frame is not in the row
      const focusBtn = (title) => cdp.eval(`(() => { const f = document.querySelector('iframe[title="${title}"]'); const b = f && f.closest('.av-bloc').querySelector('button[aria-label^="Agrandir"]'); if (!b) return false; b.focus(); return document.activeElement === b; })()`);
      const pre12 = await rowPins('pin last');
      const focused12 = await focusBtn('pin last'); await sleep(400);
      const bare12 = await rowPins('pin last');
      await cdp.eval(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); 1`); await sleep(300);
      const opened10 = await enlarge('pin last');
      await waitFor(async () => (await overlay()).open && (await overlay()).frame, 30000, 'the overlay on the last bloc');
      const open12 = await rowPins('pin last');
      const ROWS = 26;
      for (let i = 0; i < ROWS; i++) await h.inject(ev.text(`filler row ${i}`));
      await waitFor(() => cdp.eval(`document.body.innerText.includes('filler row ${ROWS - 1}')`), 60000, 'the filler rows');
      await sleep(2500);
      const o10 = await overlay();
      await press('Escape', 'Escape', 27); await sleep(500);
      const closed10 = !(await overlay()).open;
      const focus10 = await cdp.eval(`(document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label')) || (document.activeElement ? document.activeElement.tagName : 'none')`);
      await cdp.eval(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); 1`); await sleep(500); // focus held the ROW; let go so later sections see a normal window
      clause(arm, 'B10/an-open-overlay-survives-the-windowed-list', opened10 && o10.open && o10.frame && o10.focusInside && closed10 && focus10 === 'Agrandir : pin last',
        `enlarged the last bloc, then streamed ${ROWS} rows under it (its row leaves the ±6-row window): overlay still open ${o10.open}, its frame live ${o10.frame}, focus inside it ${o10.focusInside}; Escape closes it (${closed10}) and focus returns to «${focus10}»`);
      const end12 = await rowPins('pin last'); // -1 = the row left the window: nothing holds it
      clause(arm, 'B12/a-bare-focus-pins-no-row', focused12 && pre12 === 0 && bare12 === 0 && open12 >= 1 && end12 <= 0,
        `row pin count of the bloc's row (data-row-pins): before ${pre12}; a bare focus on « Agrandir » (focused: ${focused12}) → ${bare12}; control: overlay open → ${open12} (≥ 1: the instrument reads a real pin); overlay closed + blurred → ${end12}`);
    }

    if ((arm === 'real' || arm === 'no-box' || arm === 'no-expanded' || arm === 'box-old') && run('B11')) {
      // ── B11 (pre-review MAJOR): a TALL bloc (> BLOC_CLIP_PX) is clipped when mounted — its placeholder must be that box, and « Afficher tout » must survive an unload ──
      const T = 8;
      await h.inject(ev.text('TALLPAD\n' + Array.from({ length: T }, (_, i) => fence(`html-render title="tall ${i}"`, hbBloc(600 + i, 900)) + `\n\nMARK-T${i} after tall ${i}\n`).join('\n')));
      await waitFor(async () => { await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); return (await replySlots('TALLPAD')) === T; }, 120000, 'the tall slots');
      const tallSlots = (i) => `[...document.querySelectorAll('.av-bloc-slot')].slice(-${T})[${i}]`; // the last T slots are this reply's
      const centreT = (i) => `(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const s = ${tallSlots(i)}.getBoundingClientRect(); L.scrollTo({ top: L.scrollTop + (s.top + s.bottom) / 2 - (lr.top + lr.bottom) / 2, behavior: 'instant' }); return ${tallSlots(i)}.getBoundingClientRect().height; })()`;
      for (let i = 0; i < T; i++) await waitFor(async () => { const hgt = await cdp.eval(centreT(i)); return hgt >= 400 && hgt <= 450; }, 30000, `tall bloc ${i} to report and clip`);
      const marksT = () => cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); return [...document.querySelectorAll('.av-md-p')].filter((p) => /^MARK-T/.test(p.textContent)).map((p) => [p.textContent.slice(0, 7), Math.round(p.getBoundingClientRect().top - lr.top + L.scrollTop)]); })()`);
      // expand the FIRST tall bloc (« Afficher tout »), record the layout, go far past the keep margin and back, record again
      await waitFor(async () => (await cdp.eval(centreT(0))) >= 400, 30000, 'tall bloc 0 centred');
      await waitFor(() => cdp.eval(`(() => { const f = document.querySelector('iframe[title="tall 0"]'); return !!(f && f.closest('.av-bloc').querySelector('.av-bloc-more')); })()`), 30000, 'tall bloc 0 mounted with its « Afficher tout »');
      // click until it is expanded (a click that lands on an instance the budget is about to replace is lost — a user clicks again): never toggle it back
      let expandedOk = false;
      for (let t = 0; t < 8 && !expandedOk; t++) {
        expandedOk = await cdp.eval(`(() => { const f = document.querySelector('iframe[title="tall 0"]'); const b = f && f.closest('.av-bloc').querySelector('.av-bloc-more'); if (!b) return false; if (b.getAttribute('aria-expanded') === 'true') return true; b.click(); return false; })()`);
        await sleep(500);
        if (!expandedOk) expandedOk = await cdp.eval(`(() => { const f = document.querySelector('iframe[title="tall 0"]'); const b = f && f.closest('.av-bloc').querySelector('.av-bloc-more'); return !!b && b.getAttribute('aria-expanded') === 'true'; })()`);
      }
      const trace = [];
      for (let t = 0; t < 8; t++) { await sleep(150); trace.push(await cdp.eval(`(() => { const sl = ${tallSlots(0)}; const b = sl.querySelector('.av-bloc-more'); const r = sl.querySelector('.av-bloc'); return [sl.dataset.live, b ? b.getAttribute('aria-expanded') : 'nobtn', r ? Math.round(r.getBoundingClientRect().height) : 0]; })()`)); }
      const ariaNow = await cdp.eval(`(() => { const f = document.querySelector('iframe[title="tall 0"]'); const b = f && f.closest('.av-bloc').querySelector('.av-bloc-more'); return b ? b.getAttribute('aria-expanded') : 'none'; })()`);
      const dumpBefore = await slotDump();
      const before = new Map(await marksT());
      await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); await sleep(2500);
      const dumpAway = await slotDump();
      const awayMarks = await marksT(); // WHILE the first bloc is an unmounted placeholder: its box must equal what it was
      const away = await cdp.eval(`(() => ({ live0: ${tallSlots(0)}.dataset.live, live1: ${tallSlots(1)}.dataset.live }))()`);
      await waitFor(async () => (await cdp.eval(centreT(0))) >= 400, 30000, 'back to tall bloc 0');
      await sleep(2000);
      const dumpAfter = await slotDump();
      // SECOND unload of the same (expanded, remounted) bloc: its placeholder now comes from what the REMOUNT recorded
      await sleep(1500);
      await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); await sleep(2500);
      const away2Marks = await marksT();
      await waitFor(async () => (await cdp.eval(centreT(0))) >= 400, 30000, 'back to tall bloc 0 (2nd time)');
      await sleep(1500);
      const after = await marksT();
      const stillExpanded = await cdp.eval(`(() => { const f = document.querySelector('iframe[title="tall 0"]'); const b = f && f.closest('.av-bloc').querySelector('.av-bloc-more'); return b ? b.getAttribute('aria-expanded') : 'none'; })()`);
      const dbg = JSON.stringify({ before: [...before], away: awayMarks, after, dumps: { before: dumpBefore, away: dumpAway, after: dumpAfter } });
      let moved = 0, maxDrift = 0; for (const [k, y] of [...after, ...awayMarks, ...away2Marks]) { const d = Math.abs(y - (before.get(k) ?? y)); maxDrift = Math.max(maxDrift, d); if (d > 2) moved++; }
      clause(arm, 'B11/a-tall-bloc-unloads-without-a-layout-shift-and-stays-expanded', expandedOk && ariaNow === 'true' && away.live0 === '0' && moved === 0 && stillExpanded === 'true',
        `${T} blocs of 900 px (clipped to 420 when mounted); the first one expanded via « Afficher tout » (aria-expanded=${ariaNow}); transcript scrolled to its end (past the keep margin; first bloc's slot data-live=${away.live0}) and back: ${moved} paragraph reading(s) moved >2 px — measured both while it is an unmounted placeholder and after it remounted (max drift ${maxDrift} px); the first bloc is still expanded (aria-expanded=${stillExpanded})${moved || ariaNow !== 'true' ? ' trace ' + JSON.stringify(trace) + ' ' + dbg : ''}`);
    }

    if ((arm === 'real' || arm === 'failed-height') && run('B8')) {
      // ── B8: a bloc that FAILED (its frame never reports) is a code block; scrolling away and back must not move the layout ──
      await cdp.eval(`window.addEventListener('message', (e) => { const f = document.querySelector('iframe[title="failing"]'); if (f && e.source === f.contentWindow) e.stopImmediatePropagation(); }); 1`); // registered BEFORE the frame's own listener: its height reports never arrive
      const failing = 'FAILING-MARK\n' + fence('html-render title="failing"', '<div style="height:300px">FAILING-CODE-MARK</div>' + '\n<!-- padding line -->'.repeat(14)) + '\n\n' + Array.from({ length: 8 }, (_, i) => fence(`html-render title="fpad ${i}"`, hbBloc(300 + i, 400))).join('\n\n') + '\n\nMARK-F after the failing bloc\n';
      await h.inject(ev.text(failing));
      await waitFor(async () => (await replySlots('FAILING-MARK')) === 9, 120000, 'the failing-bloc slots');
      await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); await sleep(300);
      await cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('FAILING-MARK')); const r = m.getBoundingClientRect(); L.scrollTo({ top: L.scrollTop + r.top - lr.top - 40, behavior: 'instant' }); return 1; })()`);
      await waitFor(() => cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('FAILING-MARK')); return !!m && !!m.querySelector('.av-code-lang') && !m.querySelector('iframe[title="failing"]'); })()`), 60000, 'the failing bloc to fall back to code (no report ⇒ code)');
      await sleep(1500);
      const markY = () => cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const p = [...document.querySelectorAll('.av-md-p')].find((x) => x.textContent.startsWith('MARK-F')); return p ? Math.round(p.getBoundingClientRect().top - lr.top + L.scrollTop) : null; })()`);
      // the paragraph is 9 slots below: bring it into the mount margin once so its slot heights are measured, then record
      const y0 = await markY();
      const sh0 = await cdp.eval(`${list}.scrollHeight`);
      await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); await sleep(1500);   // the end of the transcript: ~8 blocs below the failing one, past the keep margin
      const awayLive = await cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('FAILING-MARK')); return m.querySelector('.av-bloc-slot').dataset.live; })()`);
      await cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('FAILING-MARK')); const r = m.getBoundingClientRect(); L.scrollTo({ top: L.scrollTop + r.top - lr.top - 40, behavior: 'instant' }); return 1; })()`); await sleep(1500); // back to the failing bloc: it remounts
      const yMid = await markY(); // the frame is back (retrying) and has not failed again yet: its box is still the code block's size
      await waitFor(() => cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('FAILING-MARK')); return !!m && !!m.querySelector('.av-code-lang') && !m.querySelector('iframe[title="failing"]'); })()`), 90000, 'the retried frame to fail again (code)');
      await sleep(500);
      const y1 = await markY(); const sh1 = await cdp.eval(`${list}.scrollHeight`);
      const st = await cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('FAILING-MARK')); return { code: !!m.querySelector('.av-code-lang'), frames: m.querySelectorAll('iframe[title="failing"]').length }; })()`);
      clause(arm, 'B8/a-failed-bloc-unloads-without-a-layout-shift-and-retries-on-remount', y0 != null && awayLive === '0' && Math.abs(yMid - y0) <= 2 && Math.abs(y1 - y0) <= 2 && st.code && st.frames === 0,
        `a bloc whose frame never reports → code block; after scrolling to the end of the transcript (the failing bloc's slot unloaded: ${awayLive === '0'}; tolerance 2 px) and back (the frame retries; it fails again after load + 5 s): the paragraph below it at ${y0} → ${yMid} (retrying) → ${y1} (code again) px (content coordinates), scrollHeight ${sh0} → ${sh1} (informational: it counts the list's own tail below the paragraph); still a code block: ${st.code}, iframes ${st.frames}`);
    }

    if ((arm === 'real' || arm === 'watchdog-mount') && run('W1')) {
      // ── W1: a starved renderer (its main thread busy for 9 s right after the frames mount) must not turn healthy blocs into code ──
      const M = 16; // inside the mount margin even as 80 px placeholders: all of them mount at once
      const small = Array.from({ length: M }, (_, i) => fence(`html-render title="starve ${i}"`, `<div style="height:36px">STARVE-${i}</div>`)).join('\n');
      await cdp.eval(`window.__starve = { armed: true, blockedAt: 0, framesAtBlock: 0 };
        new MutationObserver((_, ob) => { const n = document.querySelectorAll('iframe[title^="starve "]').length; if (n < ${M}) return; ob.disconnect();
          window.__starve.blockedAt = Date.now(); window.__starve.framesAtBlock = n; const t = Date.now(); while (Date.now() - t < 9000); /* the commit's layout effects (watchdog start) already ran; no frame has reported yet */ }).observe(document.body, { childList: true, subtree: true }); 1`);
      await h.inject(ev.text('STARVE-INTRO\n' + small));
      await waitFor(async () => (await replySlots('STARVE-INTRO')) === M, 120000, 'the starve slots');
      await scrollTo(1e9, 100); // to the end of the transcript: the frames mount now
      await waitFor(() => cdp.eval(`window.__starve.blockedAt > 0`), 180000, 'the starved-renderer block to start');
      await sleep(11000);
      const w = await cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('STARVE-INTRO')); return { frames: m ? m.querySelectorAll('iframe').length : -1, code: m ? m.querySelectorAll('.av-code-lang').length : -1, blockedFrames: window.__starve.framesAtBlock }; })()`);
      clause(arm, 'W1/healthy-blocs-survive-a-starved-renderer', w.frames === M && w.code === 0, `${w.blockedFrames} frames mounted, then the page's main thread blocked 9 s (> the old 6 s mount timer); 11 s later: ${w.frames}/${M} frames still frames, ${w.code} turned into code`);
    }
    if (!lite && !scrollOnly && run('M1')) {
      // ── M1: a looping bloc freezes its siblings (one shared frame process); does unmounting it free them? (measured, not assumed) ──
      const reply2 = 'LOOPZONE\n' + [fence('html-render title="looper"', hbBloc(100, 100)), ...Array.from({ length: 6 }, (_, i) => fence(`html-render title="gap ${i}"`, hbBloc(110 + i, 400))), fence('html-render title="sibling"', hbBloc(101, 100))].join('\n\n') + '\n';
      await h.inject(ev.text(reply2));
      await waitFor(async () => { await cdp.eval(`${list}.scrollTo({ top: 1e9, behavior: 'instant' }); 1`); return (await replySlots('LOOPZONE')) === 8; }, 120000, 'the loop-zone slots');
      // measure the zone first (each bloc mounts and reports once) so the positions below are the settled ones
      for (let i = 0; i < 8; i++) {
        await cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const s = [...document.querySelectorAll('.av-bloc-slot')].slice(-8)[${i}]; const r = s.getBoundingClientRect(); L.scrollTo({ top: L.scrollTop + (r.top + r.bottom) / 2 - (lr.top + lr.bottom) / 2, behavior: 'instant' }); return 1; })()`);
        await waitFor(() => cdp.eval(`[...document.querySelectorAll('.av-bloc-slot')].slice(-8)[${i}].getBoundingClientRect().height >= 95`), 15000, `loop-zone bloc ${i} to report`);
      }
      await sleep(500);
      const pos = await cdp.eval(`(() => { const L = ${list}; const lr = L.getBoundingClientRect(); const slots = [...document.querySelectorAll('.av-bloc-slot')]; const at = (i) => { const r = slots[i].getBoundingClientRect(); return { top: r.top - lr.top + L.scrollTop, bottom: r.bottom - lr.top + L.scrollTop }; }; return { looper: at(slots.length - 8), sibling: at(slots.length - 1), ch: L.clientHeight }; })()`);
      await scrollTo(Math.max(0, pos.looper.top - 100), 1500); // the looper (and its follower gaps) mounted: it boots
      // walk down until the sibling is within the mount margin while the looper is still within the keep margin
      const target = pos.sibling.top - pos.ch - MOUNT + 150; // sibling 150 px inside the mount margin
      for (let y = pos.looper.top; y < target; y += 300) await scrollTo(y, 120);
      await scrollTo(target, 1500);
      const r2 = async (s) => { const a = await cdp.eval('JSON.stringify(window.__hb)').then(JSON.parse); await sleep(s * 1000); const b = await cdp.eval('JSON.stringify(window.__hb)').then(JSON.parse); return (i) => ((b[i] ?? 0) - (a[i] ?? 0)) / s; };
      const live0 = await cdp.eval(`({ looper: !!document.querySelector('iframe[title="looper"]'), sibling: !!document.querySelector('iframe[title="sibling"]') })`);
      const before = await r2(4);
      const rB = { looper: before(100), sibling: before(101) };
      await cdp.eval(`document.querySelector('iframe[title="looper"]').contentWindow.postMessage('go', '*'); 1`);
      await sleep(1500);
      const frozen = await r2(4);
      const rF = { looper: frozen(100), sibling: frozen(101) };
      // scroll on: the looper's distance to the viewport passes the keep margin → it unmounts → the sibling's frame process is free
      const away = pos.sibling.top - 150; // viewport top just above the sibling: looper far above
      for (let y = target; y < away; y += 300) await scrollTo(Math.min(y, away), 120);
      await scrollTo(away, 2500);
      const live1 = await cdp.eval(`({ looper: !!document.querySelector('iframe[title="looper"]'), sibling: !!document.querySelector('iframe[title="sibling"]') })`);
      const rec = await r2(6);
      const rR = { sibling: rec(101) };
      const winOk = (await cdp.eval('1 + 1', 5000).catch(() => null)) === 2;
      const instrumentOk = live0.looper && live0.sibling && rB.looper > 0.5 && rB.sibling > 0.5 && rF.looper < rB.looper * 0.1; // both ticked; the looper READS frozen
      const frozenSib = rF.sibling < rB.sibling * 0.1;
      clause(arm, 'ctl/loop-instrument-sees-ticking-and-frozen', instrumentOk, `before: looper ${rB.looper.toFixed(1)}/s sibling ${rB.sibling.toFixed(1)}/s (offscreen frames tick ~1 Hz: Chromium throttles them; both frames live: ${JSON.stringify(live0)}); looping: looper ${rF.looper.toFixed(1)}/s (must read frozen)`);
      clause(arm, 'M1/a-looping-bloc-freezes-its-sibling-blocs-and-unmounting-it-does-not-free-them', instrumentOk && frozenSib && !live1.looper && live1.sibling && rR.sibling < rB.sibling * 0.1 && winOk,
        `MEASURED: sibling ${rB.sibling.toFixed(1)}/s before, ${rF.sibling.toFixed(1)}/s while the looper ran (frozen: ${frozenSib}); looper scrolled past ${KEEP} px → its frame is out of the page (${!live1.looper}), the sibling frame is live (${live1.sibling}) but ticks ${rR.sibling.toFixed(1)}/s (the loop keeps running in the shared frame process); app window answers: ${winOk}`);
    }

    const unchanged = treeHash([path.join(APP_DIR, 'dist'), path.join(APP_DIR, 'dist-electron')]) === origHash;
    clause(arm, 'ctl/built-app-dir-untouched', unchanged, `md5 over ${APP_DIR}/{dist,dist-electron} identical before/after the arm`);
  } catch (e) {
    clause(arm, 'rig/arm-completed', false, `ARM ABORTED: ${e.stack || e}`);
  } finally {
    const left = await h.stop();
    clause(arm, 'rig/teardown-no-survivors', left.length === 0, `processes still carrying ${h.world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}

const before = ctx.liveCanary();
for (const arm of ARMS) { if (arm !== 'real' && !MUTANTS[arm]) ctx.refuse(`unknown arm ${arm}`); await runArm(arm); }
const same = JSON.stringify(before) === JSON.stringify(ctx.liveCanary());
clause('rig', 'ctl/live-claude-dirs-untouched', same, `live ~/.claude* symlink-set + mcpServers hashes ${same ? 'identical before/after' : 'CHANGED'}`);

const isB = (c) => /^(B|W|M)\d+\//.test(c.clause);
const isCtl = (c) => /^(ctl|rig)\//.test(c.clause);
let rc = 0; const lines = [];
for (const arm of ARMS) {
  const mine = results.filter((c) => c.arm === arm);
  const ctlRed = mine.filter((c) => isCtl(c) && !c.ok).map((c) => c.clause);
  if (arm === 'real') { const red = mine.filter((c) => !c.ok).map((c) => c.clause); lines.push(`real: ${red.length ? 'RED ' + red.join(', ') : 'ALL GREEN'} (${mine.length} clauses)`); if (red.length) rc = 1; continue; }
  const want = MUTANTS[arm].clause;
  const named = mine.find((c) => c.clause.startsWith(want + '/'));
  const others = mine.filter((c) => isB(c) && !c.clause.startsWith(want + '/') && !MUTANTS[arm].allowed.some((a) => c.clause.startsWith(a + '/')) && !c.ok).map((c) => c.clause);
  const ok = !!named && !named.ok && ctlRed.length === 0 && others.length === 0;
  lines.push(`${arm}: ${ok ? 'MUST-FAIL CONFIRMED' : 'NOT CONFIRMED'} — ${want} ${named ? (named.ok ? 'stayed GREEN' : 'RED') : 'not evaluated'}; other clauses red: ${others.join(',') || 'none'}; controls red: ${ctlRed.join(',') || 'none'}`);
  if (!ok) rc = 1;
}
if (results.some((c) => c.arm === 'rig' && !c.ok)) rc = 1;
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ app: APP_DIR, arms: ARMS, results }, null, 2));
console.log('\n== verdict =='); for (const l of lines) console.log('  ' + l);
console.log(`\nVERDICT: ${rc === 0 ? 'OK' : 'RED'} (${results.filter((c) => c.ok).length}/${results.length} clauses green)`);
process.exit(rc);

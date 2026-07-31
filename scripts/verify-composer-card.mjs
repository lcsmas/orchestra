#!/usr/bin/env node
// Drive the built Orchestra renderer and verify the UNIFIED COMPOSER CARD:
//   - the deck bar is folded INSIDE the composer field (one frame, not two)
//   - the send button is a 28px circle with no text label
//   - the context strip renders under the card (worktree · cost · % · branch)
//   - bash mode rings the whole card and turns the send button purple
//
// Both halves per the `verify` skill: computed-style/geometry assertions AND
// screenshots (hashed, duplicates are a failure — a no-op drive still captures
// a frame).
//
// Usage: node scripts/verify-composer-card.mjs <cdpPort> <outDir>

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const PORT = process.argv[2] || '9347';
const OUT = process.argv[3] || '/tmp/av-verify';
const WS_ID = 'ws-verify';

let nextId = 1;
const pending = new Map();
let sock;

function send(method, params = {}) {
  const id = nextId++;
  sock.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`${method} timed out`))), 20000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result?.value;
}

const shots = new Map();
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  const hash = createHash('md5').update(buf).digest('hex');
  const path = `${OUT}/${name}.png`;
  writeFileSync(path, buf);
  // A byte-identical capture means the drive step silently no-opped.
  if (shots.has(hash)) throw new Error(`DUPLICATE screenshot: ${name} == ${shots.get(hash)}`);
  shots.set(hash, name);
  console.log(`  shot ${path} (${buf.length}b md5=${hash.slice(0, 8)})`);
  return path;
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  // ── connect ───────────────────────────────────────────────────────────────
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  console.log(`target: ${page.url}`);

  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    sock.onopen = res;
    sock.onerror = () => rej(new Error('ws failed'));
  });
  sock.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');

  // ── open the structured view ──────────────────────────────────────────────
  await evaluate(`window.__orchestraSetState({ activeId: '${WS_ID}', view: 'structured' })`);
  await new Promise((r) => setTimeout(r, 900));

  // Seed a finished turn so the strip has cost + context to show. Real
  // enqueue→fold path, not a state poke.
  await evaluate(`
    window.__injectAgentEvent('${WS_ID}', {
      type: 'turn-end', sessionId: 'verify-1', costUsd: 0.42, numTurns: 3,
      durationMs: 380000, contextUsedTokens: 68000, contextWindow: 200000,
      usage: { inputTokens: 12000, outputTokens: 4200,
               cacheCreationInputTokens: 900, cacheReadInputTokens: 51000 },
    });
  `);
  await new Promise((r) => setTimeout(r, 700));

  const viewOk = await evaluate(`!!document.querySelector('.av-view .av-composer')`);
  if (!viewOk) throw new Error('composer never rendered — aborting (instrument, not subject)');

  // ── STRUCTURE: one card, not two stacked frames ───────────────────────────
  console.log('\n[structure]');
  const struct = await evaluate(`(() => {
    const field = document.querySelector('.av-composer-field');
    const bar   = document.querySelector('.av-composer-bar');
    const deck  = document.querySelector('.av-deck-bar');
    const menus = document.querySelector('.av-controls-menus');
    const strip = document.querySelector('.av-strip');
    const cs = (e) => e ? getComputedStyle(e) : null;
    return {
      barInsideField: !!(field && bar && field.contains(bar)),
      menusInsideField: !!(field && menus && field.contains(menus)),
      deckDisplay: cs(deck)?.display ?? null,
      // The old layout had a SECOND bordered surface above the field.
      deckBorderTop: cs(deck)?.borderTopWidth ?? null,
      deckBg: cs(deck)?.backgroundColor ?? null,
      fieldDir: cs(field)?.flexDirection ?? null,
      fieldBorder: cs(field)?.borderTopWidth ?? null,
      stripExists: !!strip,
      stripAfterField: !!(strip && field && (field.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  })()`);
  check('control bar is INSIDE the composer field', struct.barInsideField);
  check('model/permission menus are inside the field', struct.menusInsideField);
  check('deck bar dissolved (display:contents)', struct.deckDisplay === 'contents', struct.deckDisplay);
  check('deck bar has no border of its own', struct.deckBorderTop === '0px', `border-top=${struct.deckBorderTop}`);
  check('deck bar has no background of its own',
    struct.deckBg === 'rgba(0, 0, 0, 0)', struct.deckBg);
  check('field is a column (text row over control row)', struct.fieldDir === 'column', struct.fieldDir);
  check('context strip renders after the card', struct.stripExists && struct.stripAfterField);

  // ── SEND BUTTON: circular, icon-only ──────────────────────────────────────
  console.log('\n[send button]');
  const sendInfo = await evaluate(`(() => {
    const b = document.querySelector('.av-composer-send');
    if (!b) return null;
    const cs = getComputedStyle(b), r = b.getBoundingClientRect();
    const field = document.querySelector('.av-composer-field').getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      radius: cs.borderRadius, text: b.textContent.trim(),
      aria: b.getAttribute('aria-label'), title: b.getAttribute('title'),
      disabled: b.disabled,
      opacity: cs.opacity, filter: cs.filter,
      hasSvg: !!b.querySelector('svg'),
      // right-docked inside the card
      gapToFieldRight: Math.round(field.right - r.right),
    };
  })()`);
  check('send is 28x28', sendInfo.w === 28 && sendInfo.h === 28, `${sendInfo.w}x${sendInfo.h}`);
  check('send is circular', sendInfo.radius === '50%', sendInfo.radius);
  check('send has NO text label', sendInfo.text === '', JSON.stringify(sendInfo.text));
  check('send keeps an accessible name', !!sendInfo.aria, sendInfo.aria);
  check('send renders its glyph', sendInfo.hasSvg);
  check('send is disabled while empty', sendInfo.disabled === true);
  // The empty state must read as "waiting", not "broken": keep the accent hue
  // (no saturate() wash) and stay legible. The old pill could grey out hard
  // because it carried a "Send" TEXT label; a bare icon circle cannot.
  check('disabled send keeps its accent hue (no desaturation)',
    sendInfo.filter === 'none', `filter=${sendInfo.filter}`);
  check('disabled send stays legible (opacity >= 0.4)',
    parseFloat(sendInfo.opacity) >= 0.4, `opacity=${sendInfo.opacity}`);
  check('send docks to the card right edge', sendInfo.gapToFieldRight <= 12, `${sendInfo.gapToFieldRight}px`);

  await shot('01-idle-empty');

  // ── FLAT CHIPS: no chip in the control row may look like a raised button ──
  // ENUMERATE every element in the row rather than checking the ones we expect
  // to be wrong — scoping this to known offenders is how the class survives
  // being fixed. Two real defects were found this way: the interrupt inherited
  // `.av-btn`'s border + surface fill, and EVERY `.av-menu-trigger` carried
  // `box-shadow: var(--shadow-sm)` leaking from styles.css's bare `button`
  // element rule (zeroing border/background does not reset shadow).
  console.log('\n[flat chips]');
  const chips = await evaluate(`(() => {
    const bar = document.querySelector('.av-composer-bar');
    const SEND = 'av-composer-send';
    const offenders = [];
    for (const e of bar.querySelectorAll('*')) {
      if (e.offsetParent === null) continue;
      const cls = typeof e.className === 'string' ? e.className : '';
      // The send button is INTENTIONALLY a filled circle; dots/indicators are
      // meant to be coloured marks, not chrome.
      if (cls.includes(SEND) || /-dot\\b/.test(cls)) continue;
      const cs = getComputedStyle(e);
      // A BOX border is chrome; the account chip's single border-left divider
      // is not (borderTopWidth stays 0px there), so key on the top edge only.
      const border = cs.borderTopWidth !== '0px';
      const shadow = cs.boxShadow !== 'none';
      const bg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      if (border || shadow || bg) {
        offenders.push({ cls: cls.slice(0, 44), tag: e.tagName,
          border: border ? cs.borderTopWidth + ' ' + cs.borderTopColor : null,
          shadow: shadow ? cs.boxShadow.slice(0, 48) : null,
          bg: bg ? cs.backgroundColor : null });
      }
    }
    return offenders;
  })()`);
  check('no raised-button chrome on any control-row chip',
    chips.length === 0,
    chips.length ? JSON.stringify(chips) : 'all flat');

  // ── STRIP CONTENT ─────────────────────────────────────────────────────────
  console.log('\n[context strip]');
  const strip = await evaluate(`(() => {
    const s = document.querySelector('.av-strip');
    if (!s) return null;
    const cs = getComputedStyle(s);
    const branch = s.querySelector('.av-strip-branch');
    const gauge = s.querySelector('.av-turn-context');
    return {
      text: s.innerText.replace(/\\s+/g, ' ').trim(),
      fontSize: cs.fontSize,
      color: cs.color,
      branchText: branch?.innerText.trim() ?? null,
      branchRight: branch ? Math.round(branch.getBoundingClientRect().right) : null,
      stripRight: Math.round(s.getBoundingClientRect().right),
      gaugePct: gauge?.querySelector('.av-turn-stat-value')?.textContent ?? null,
      gaugeLabelHidden: gauge ? getComputedStyle(gauge.querySelector('.av-turn-stat-label')).display === 'none' : null,
      barW: gauge ? Math.round(gauge.querySelector('.av-turn-context-bar').getBoundingClientRect().width) : null,
    };
  })()`);
  check('strip shows the branch', !!strip.branchText, strip.branchText);
  check('branch docks right', strip.branchRight !== null && strip.stripRight - strip.branchRight <= 14,
    `gap=${strip.stripRight - strip.branchRight}px`);
  check('strip is caption weight (11px)', strip.fontSize === '11px', strip.fontSize);
  check('context gauge shows 34%', strip.gaugePct === '34%', strip.gaugePct);
  check('gauge "used" label hidden at strip scale', strip.gaugeLabelHidden === true);
  check('gauge bar is 40px', strip.barW === 40, `${strip.barW}px`);
  check('strip carries the cost', strip.text.includes('$0.42'), strip.text);

  // ── TYPED STATE: send enables ─────────────────────────────────────────────
  console.log('\n[typed]');
  // The composer is a CodeMirror editor (CmComposer), not a textarea: set its
  // text through the `__cmComposerView` E2E seam. A native-setter poke on
  // `.av-composer-input` throws "Illegal invocation" now that the element is
  // gone, which is what this used to do.
  const setComposerText = async (text) => {
    const ok = await evaluate(
      '(() => {' +
      '  const v = window.__cmComposerView;' +
      '  if (!v) return false;' +
      '  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ' + JSON.stringify(text) + ' } });' +
      '  v.focus();' +
      '  return true;' +
      '})()',
    );
    if (!ok) throw new Error('__cmComposerView missing — cannot drive the composer');
  };
  await setComposerText('Review the plan and tell me what you would cut.');
  await new Promise((r) => setTimeout(r, 350));
  const typed = await evaluate(`(() => {
    const b = document.querySelector('.av-composer-send');
    const f = document.querySelector('.av-composer-field');
    return { disabled: b.disabled, ring: getComputedStyle(f).boxShadow.includes('rgb') ,
             border: getComputedStyle(f).borderTopColor };
  })()`);
  check('send enables once text is entered', typed.disabled === false);
  check('focus ring on the card', typed.ring, typed.border);
  await shot('02-typed-focused');

  // ── BASH MODE ─────────────────────────────────────────────────────────────
  console.log('\n[bash mode]');
  await setComposerText('!pnpm run test 2>&1 | tail -30');
  await new Promise((r) => setTimeout(r, 350));
  const bash = await evaluate(`(() => {
    const f = document.querySelector('.av-composer-field');
    const b = document.querySelector('.av-composer-send');
    const note = document.querySelector('.av-composer-bar-note');
    const chip = document.querySelector('.av-composer-bash-chip');
    const menus = document.querySelector('.av-controls-menus');
    return {
      cardHasBashClass: f.classList.contains('av-composer-field-bash'),
      cardBorder: getComputedStyle(f).borderTopColor,
      sendBg: getComputedStyle(b).backgroundColor,
      sendHasBashClass: b.classList.contains('av-composer-send-bash'),
      noteText: note?.textContent.trim() ?? null,
      chipText: chip?.textContent.trim() ?? null,
      menusVisible: !!menus && menus.offsetParent !== null,
    };
  })()`);
  check('bash rings the whole card', bash.cardHasBashClass, bash.cardBorder);
  check('bash chip leads the input', bash.chipText === 'bash', bash.chipText);
  check('send takes the bash purple', bash.sendHasBashClass, bash.sendBg);
  check('menus swap for the bash explanation', !bash.menusVisible && !!bash.noteText, bash.noteText);
  await shot('03-bash-mode');

  // ── reset ─────────────────────────────────────────────────────────────────
  await setComposerText('');

  // ── RUNNING STATE ─────────────────────────────────────────────────────────
  // A `user-message` event is what flips `running:true` in the real fold
  // (agent-events.ts:1183-1206) — drive it that way rather than poking state,
  // so the interrupt chip / queue glyph are exercised through the true path.
  console.log('\n[running]');
  const preRun = await evaluate(`(() => {
    const b = document.querySelector('.av-composer-send');
    const i = document.querySelector('.av-controls-interrupt');
    return { running: window.__readAgentSession('${WS_ID}')?.running ?? false,
             interruptShown: i ? getComputedStyle(i).display !== 'none' : false,
             sendPath: b.querySelector('svg path')?.getAttribute('d') ?? null };
  })()`);
  check('pre-state: not running', preRun.running === false);
  check('pre-state: interrupt hidden while idle', preRun.interruptShown === false);

  await evaluate(`
    window.__injectAgentEvent('${WS_ID}', {
      type: 'user-message', seq: 900, text: 'Check the sandbox path too.',
      at: Date.now() - 64000,
    });
  `);
  await new Promise((r) => setTimeout(r, 900));

  const run = await evaluate(`(() => {
    const s = window.__readAgentSession('${WS_ID}');
    const b = document.querySelector('.av-composer-send');
    const i = document.querySelector('.av-controls-interrupt');
    const field = document.querySelector('.av-composer-field').getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const work = document.querySelector('.av-working-line');
    return {
      running: s?.running ?? false,
      interruptShown: i ? getComputedStyle(i).display !== 'none' : false,
      interruptDisabled: i ? i.disabled : null,
      interruptFirst: i ? Math.round(i.getBoundingClientRect().left) : null,
      // Interrupt is docked beside SEND now (both are turn actions); the left
      // edge belongs to the vim mode indicator, which must not move when a turn
      // starts. Measure the gap between them rather than an absolute x.
      interruptToSendGap: i ? Math.round(br.left - i.getBoundingClientRect().right) : null,
      vimChipLeft: (() => { const v = document.querySelector('.av-composer-vim');
        return v ? Math.round(v.getBoundingClientRect().left) : null; })(),
      sendPath: b.querySelector('svg path')?.getAttribute('d') ?? null,
      sendTitle: b.getAttribute('title'),
      sendAria: b.getAttribute('aria-label'),
      sendStillCircle: getComputedStyle(b).borderRadius === '50%',
      sendGap: Math.round(field.right - br.right),
      // The live readout renders in the TRANSCRIPT (CC-desktop placement),
      // not in the composer bar — assert it is NOT inside the card.
      workingExists: !!work,
      workingInCard: !!(work && document.querySelector('.av-composer-field').contains(work)),
      workingText: work ? work.innerText.replace(/\\s+/g, ' ').trim() : null,
    };
  })()`);
  check('session is running', run.running === true);
  check('interrupt appears while running', run.interruptShown === true);
  check('interrupt is enabled', run.interruptDisabled === false);
  // Interrupt used to lead the row (order:1). It now sits at the TRAILING edge
  // beside send (order:8) so the vim mode indicator can own the left edge and
  // stay put across idle→running.
  check('interrupt docks beside send', run.interruptToSendGap !== null && run.interruptToSendGap < 40,
    `gap=${run.interruptToSendGap}px`);
  check('vim indicator keeps the left edge while running',
    run.vimChipLeft !== null && run.interruptFirst !== null && run.vimChipLeft < run.interruptFirst,
    `vim x=${run.vimChipLeft}, interrupt x=${run.interruptFirst}`);
  check('send swaps to the QUEUE glyph', run.sendPath === 'M12 4v5a3 3 0 0 1-3 3H4',
    run.sendPath);
  check('send announces queueing', run.sendAria === 'Queue message', run.sendAria);
  check('send tooltip explains the queue', /queue/i.test(run.sendTitle || ''), run.sendTitle);
  check('send stays circular while running', run.sendStillCircle);
  check('send stays docked right while running', run.sendGap <= 12, `${run.sendGap}px`);
  check('live readout renders in the transcript', run.workingExists === true);
  check('live readout is NOT inside the composer card', run.workingInCard === false);

  // Re-run the flat-chip enumeration WHILE RUNNING: the interrupt only exists
  // in this state, so the idle pass above is structurally blind to it — that is
  // exactly how its raised-button look shipped in the first place.
  const runChips = await evaluate(`(() => {
    const bar = document.querySelector('.av-composer-bar');
    const offenders = [];
    for (const e of bar.querySelectorAll('*')) {
      if (e.offsetParent === null) continue;
      const cls = typeof e.className === 'string' ? e.className : '';
      if (cls.includes('av-composer-send') || /-dot\\b/.test(cls)) continue;
      const cs = getComputedStyle(e);
      const border = cs.borderTopWidth !== '0px';
      const shadow = cs.boxShadow !== 'none';
      const bg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      if (border || shadow || bg) offenders.push({ cls: cls.slice(0, 44),
        border: border ? cs.borderTopWidth : null, shadow: shadow ? cs.boxShadow.slice(0, 40) : null,
        bg: bg ? cs.backgroundColor : null });
    }
    return offenders;
  })()`);
  check('interrupt chip is flat like its neighbours',
    runChips.length === 0, runChips.length ? JSON.stringify(runChips) : 'all flat');

  await shot('04-running');

  // Esc interrupts from the composer — the no-session path makes main emit a
  // synthetic turn-end, so running flips back to false. Real trusted keydown.
  await evaluate(`window.__cmComposerView && window.__cmComposerView.focus()`);
  await new Promise((r) => setTimeout(r, 120));
  // Esc is CONTEXT-DEPENDENT now: in vim INSERT it leaves insert mode and does
  // NOT interrupt (so a half-typed message never kills a running turn). Leave
  // INSERT first, so the Esc below exercises the interrupt path.
  await evaluate(`(() => {
    const chip = document.querySelector('.av-composer-vim');
    if (chip && chip.dataset.on === '1' && chip.dataset.mode === 'INSERT') {
      window.__cmComposerView.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await new Promise((r) => setTimeout(r, 1400));
  const afterEsc = await evaluate(`(() => {
    const s = window.__readAgentSession('${WS_ID}');
    const i = document.querySelector('.av-controls-interrupt');
    const b = document.querySelector('.av-composer-send');
    return { running: s?.running ?? false,
             stopReason: s?.lastTurn?.stopReason ?? null,
             interruptShown: i ? getComputedStyle(i).display !== 'none' : false,
             sendPath: b.querySelector('svg path')?.getAttribute('d') ?? null };
  })()`);
  check('Esc from the composer interrupts the turn', afterEsc.running === false,
    `stopReason=${afterEsc.stopReason}`);
  check('interrupt hides again once stopped', afterEsc.interruptShown === false);
  check('send reverts to the SEND glyph', afterEsc.sendPath === 'M8 13V3', afterEsc.sendPath);

  // ── NO REGRESSION: nothing overlaps, card is above the strip ──────────────
  console.log('\n[layout sanity]');
  const geo = await evaluate(`(() => {
    const f = document.querySelector('.av-composer-field').getBoundingClientRect();
    const s = document.querySelector('.av-strip').getBoundingClientRect();
    const bar = document.querySelector('.av-composer-bar').getBoundingClientRect();
    const list = document.querySelector('.av-message-list')?.getBoundingClientRect();
    return {
      stripBelowCard: s.top >= f.bottom - 1,
      barInsideCard: bar.top >= f.top - 1 && bar.bottom <= f.bottom + 1,
      cardBelowList: list ? f.top >= list.bottom - 1 : null,
      cardH: Math.round(f.height), barH: Math.round(bar.height),
      inViewport: f.bottom <= window.innerHeight + 1,
    };
  })()`);
  check('strip sits below the card', geo.stripBelowCard);
  check('control row is inside the card', geo.barInsideCard);
  check('card does not overlap the transcript', geo.cardBelowList !== false);
  check('composer fits the viewport', geo.inViewport, `cardH=${geo.cardH} barH=${geo.barH}`);

  // ── report ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(58)}`);
  console.log(`${results.length - failed.length}/${results.length} passed, ${shots.size} unique screenshots`);
  if (failed.length) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.label} (${f.detail})`);
  }
  console.log('='.repeat(58));
  sock.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('DRIVE ERROR:', e.message);
  process.exit(2);
});

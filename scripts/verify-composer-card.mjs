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
  check('send docks to the card right edge', sendInfo.gapToFieldRight <= 12, `${sendInfo.gapToFieldRight}px`);

  await shot('01-idle-empty');

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
  const ta = '.av-composer-input';
  await evaluate(`(() => {
    const t = document.querySelector('${ta}');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(t, 'Review the plan and tell me what you would cut.');
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.focus();
  })()`);
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
  await evaluate(`(() => {
    const t = document.querySelector('${ta}');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(t, '!pnpm run test 2>&1 | tail -30');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
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
  await evaluate(`(() => {
    const t = document.querySelector('${ta}');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

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

#!/usr/bin/env node
/**
 * Does hover actually CHANGE anything, and does it EASE?
 *
 * The user reported "hovers are not the same". Measured at source: Electron
 * carries 41 `transition` declarations, the GTK port carried 1, and 54 GTK
 * selectors have a `:hover` rule. So the hover DESTINATIONS were largely
 * ported; what was missing was the easing between states — every hover
 * snapped. That is invisible in a still screenshot, which is why several
 * static verification passes did not catch it.
 *
 * This drives the real binary and measures rendered pixels, because the two
 * failure modes it has to separate are indistinguishable in source:
 *
 *   1. The hover rule does not apply at all (nothing changes).
 *   2. The hover rule applies but snaps (endpoints change, no intermediates).
 *
 * A CSS read cannot tell those apart, and neither can a single screenshot.
 *
 * Hover is driven via the `hover` op (GTK's PRELIGHT flag) rather than a
 * pointer: the headless seat has none. PRELIGHT is the same flag a real
 * pointer sets, so a `:hover` CSS rule cannot distinguish them. What this
 * therefore does NOT prove is pointer REACHABILITY — see the caveat printed
 * with the results.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  startHeadlessSway,
  launchGtk,
  mkTmp,
  installExitCleanup,
  waitFor,
} from './harness.mjs';

installExitCleanup();

const OUT = mkTmp('hover-parity');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Widgets to test, spanning the hover CLASSES that received transitions.
 *
 * Taken from a live `list_widgets` enumeration (252 names), not guessed. An
 * earlier version of this list was invented from the CSS class names
 * (`repo-add`, `ws-icon-btn`, `header-icon-btn`, …) and NOT ONE of the five
 * existed as a widget name — every result would have been NOT-FOUND, which
 * reads exactly like a broken app rather than a wrong probe. */
const CANDIDATES = [
  // `header-add-repo` and `header-new-scratch` used to live here and were
  // REMOVED, not broken: T4 replaced the three separate header buttons with
  // Electron's single "+ New" menu (sidebar/mod.rs sets `header-new-menu`),
  // so both names now exist NOWHERE in the tree. They kept reporting
  // NOT-FOUND — indistinguishable from a genuinely missing widget, and two
  // permanently-red rows train a reader to skip NOT-FOUND entirely, which is
  // where the next real one would hide. The menu's three items are children
  // of `new-menu-popover` and only exist while it is open, so the hoverable
  // header control is the button itself.
  'header-new-menu', // .new-menu-btn
  'repo-add-orchestra', // .repo-add
  'repo-collapse-orchestra', // .repo-collapse
  'ws-row-ws-1', // #sidebar-list row
  // `.ws-icon-btn` is `opacity: 0`, revealed by `.ws-row:hover .ws-icon-btn`
  // — the reveal is gated on hovering the ROW, not the button. Hovering the
  // button alone leaves it fully transparent, which the harness reports as
  // "empty render node": a real measurement of a genuinely invisible widget,
  // and easy to misread as a rendering defect when it is correct behaviour.
  // `parent` hovers the row first so the button is actually revealed.
  { name: 'ws-archive-ws-1', parent: 'ws-row-ws-1' }, // .ws-icon-btn
  { name: 'ws-delete-scratch-1', parent: 'ws-row-scratch-1' }, // .ws-icon-btn.danger
  'open-help', // .footer-link
  'open-resources', // .footer-link
  // tab-terminal is the ACTIVE tab at boot, and `.tab:checked` sets the same
  // surface `.tab:hover` would — so hovering it legitimately changes nothing.
  // Testing only the active tab would report a working hover as absent.
  'tab-terminal', // .tab (active — expected NO-VISUAL-CHANGE)
  // tab-diff is the inactive tab and WOULD be the discriminating case, but it
  // has zero allocation in this fixture (the tab strip needs a workspace state
  // this mock does not reach), so `.tab:hover` is UNVERIFIED either way. Left
  // in the list deliberately: it reports NO-ALLOCATION rather than vanishing,
  // because an omitted surface reads as a verified one.
  'tab-diff', // .tab (inactive — UNVERIFIED, no allocation in this fixture)
  'restart-btn', // .restart-btn
  'welcome-help-btn', // button.welcome-help-btn
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

/** Screenshot a widget to a fresh file and return {bytes, hash, path}. */
async function shot(rc, name, tag) {
  const p = path.join(OUT, `${tag}.png`);
  const res = await rc.send({ op: 'screenshot', path: p, name });
  if (!res.ok) return { ok: false, error: res.error };
  const buf = fs.readFileSync(p);
  return { ok: true, bytes: buf.length, hash: sha(buf), path: p, buf };
}

/** Byte-inequality between two PNG buffers.
 *
 *  PNG is compressed, so this is NOT a pixel metric — it is only a
 *  CHANGED / NOT-CHANGED signal, which is all the endpoint test needs. Any
 *  claim about HOW MUCH something changed would need decoded pixels, so this
 *  script never makes one.
 *
 *  KNOWN LIMITATION, established by a mutation test (transitions block removed,
 *  rebuilt, re-run): on SMALL widgets this cleanly separates easing from
 *  snapping — six surfaces flipped to CHANGES-BUT-NO-MID-FRAME without the
 *  transitions and back to EASES with them. But two LARGE widgets
 *  (`ws-row-ws-1`, a full sidebar row, and `restart-btn`) reported EASES in
 *  BOTH builds. Their captures differ slightly between grabs regardless of
 *  state, so for them an EASES verdict is NOT evidence the transition ran.
 *
 *  Consequence for readers: an EASES verdict is trustworthy on small widgets
 *  and INCONCLUSIVE on large ones. Closing this properly needs decoded-pixel
 *  comparison rather than a tighter byte threshold — a threshold would just
 *  move the boundary, not make the metric measure the right thing. */
function differs(a, b) {
  if (a.length !== b.length) return true;
  return !a.equals(b);
}

/** Widgets whose captures are known to vary between grabs independent of
 *  state, so an EASES verdict on them proves nothing. Named explicitly rather
 *  than silently dropped: an omitted surface reads as a verified one. */
const NOISY = new Set(['ws-row-ws-1', 'restart-btn']);

async function main() {
  const sway = await startHeadlessSway();
  const app = await launchGtk({
    sway,
    env: { ORCHESTRA_GTK_MOCK: '1' },
    label: 'hover',
  });
  const { rc } = app;

  // INSTRUMENT CONTROL, before any measurement: prove the tree-walker can see
  // a widget that is always present. A walker keyed on the wrong field returns
  // an empty set, every lookup then "fails", and the run reports a broken app
  // instead of a broken probe.
  const tree = await rc.send({ op: 'list_widgets' });
  const names = JSON.stringify(tree).match(/"[a-z0-9-]+"/g) ?? [];
  if (!JSON.stringify(tree).includes('main-window')) {
    console.error('INSTRUMENT FAULT: list_widgets cannot see main-window.');
    console.error('No absence reported below would be trustworthy. Aborting.');
    console.error(JSON.stringify(tree).slice(0, 400));
    app.stop();
    process.exit(2);
  }
  console.log(`walker control OK: main-window visible, ${names.length} name tokens\n`);

  const results = [];

  for (const entry of CANDIDATES) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const parent = typeof entry === 'string' ? null : entry.parent;
    // Does the widget exist at all? An absent widget must be reported as
    // NOT-FOUND, never folded in with "no visual change" — they have opposite
    // meanings and only one of them is a defect in the app.
    const probe = await rc.send({ op: 'get', name, prop: 'state' });
    if (!probe.ok) {
      results.push({ name, verdict: 'NOT-FOUND', detail: probe.error });
      continue;
    }

    // Baseline: explicitly UN-hover first. Asserting a state that may already
    // hold tests nothing — if the widget were already hovered, the "change"
    // below would be measured against the wrong baseline.
    // The BASELINE must already have the parent revealed. Otherwise `before`
    // is a fully-transparent widget and `after` is a revealed one, so the
    // measured difference would be the REVEAL, not the widget's own hover —
    // a change with the right shape and the wrong cause.
    if (parent) {
      await rc.send({ op: 'hover', name: parent, on: true });
      await sleep(250);
    }
    await rc.send({ op: 'hover', name, on: false });
    await sleep(250);
    const before = await shot(rc, name, `${name}-off`);
    if (!before.ok) {
      results.push({ name, verdict: 'NO-ALLOCATION', detail: before.error });
      continue;
    }

    // Reveal the widget first if its visibility is gated on an ancestor's
    // hover, then hover the widget itself.
    if (parent) {
      const pres = await rc.send({ op: 'hover', name: parent, on: true });
      if (!pres.ok) {
        results.push({ name, verdict: 'PARENT-HOVER-FAILED', detail: pres.error });
        continue;
      }
      await sleep(250);
    }

    // Hover ON. The op itself asserts PRELIGHT was achieved and errors if not,
    // so a silent no-op cannot masquerade as "hover produced no change".
    const hres = await rc.send({ op: 'hover', name, on: true });
    if (!hres.ok) {
      results.push({ name, verdict: 'HOVER-REJECTED', detail: hres.error });
      continue;
    }

    // Confirm via an INDEPENDENT read, not just the op's own return value.
    const st = await rc.send({ op: 'get', name, prop: 'state' });
    const hovered = JSON.stringify(st.value ?? []).includes('hover');

    // Sample DURING the transition. 140ms is the ported duration, so ~60ms in
    // is mid-flight; if the state eases, this frame differs from BOTH ends.
    await sleep(60);
    const mid = await shot(rc, name, `${name}-mid`);

    // Settle well past the transition for the true end state.
    await sleep(400);
    const after = await shot(rc, name, `${name}-on`);

    const changed = after.ok && differs(before.buf, after.buf);
    const eased =
      mid.ok &&
      after.ok &&
      differs(before.buf, mid.buf) &&
      differs(mid.buf, after.buf);

    results.push({
      name,
      verdict: !hovered
        ? 'STATE-NOT-SET'
        : !changed
          ? 'NO-VISUAL-CHANGE'
          : eased
            ? NOISY.has(name)
              ? 'EASES(INCONCLUSIVE-noisy)'
              : 'EASES'
            : 'CHANGES-BUT-NO-MID-FRAME',
      bytes: `${before.bytes}/${mid.ok ? mid.bytes : '-'}/${after.bytes}`,
      hashes: `${before.hash} ${mid.ok ? mid.hash : '-'} ${after.hash}`,
    });

    await rc.send({ op: 'hover', name, on: false });
    if (parent) await rc.send({ op: 'hover', name: parent, on: false });
    await sleep(200);
  }

  console.log('=== HOVER RESULTS ===');
  for (const r of results) {
    console.log(
      `${r.name.padEnd(24)} ${String(r.verdict).padEnd(26)} ${r.bytes ?? ''} ${r.detail ?? ''}`,
    );
    if (r.hashes) console.log(`${''.padEnd(24)} sha: ${r.hashes}`);
  }

  // DUPLICATE GUARD. A drive that silently no-ops still writes a file, so
  // identical hashes across the off/mid/on triple mean the capture proved
  // nothing — regardless of what the verdict column says.
  const dupes = results.filter((r) => {
    if (!r.hashes) return false;
    const h = r.hashes.split(/\s+/).filter((x) => x !== '-');
    return new Set(h).size < h.length;
  });
  if (dupes.length) {
    console.log(`\nNOTE: ${dupes.length} widget(s) produced duplicate captures:`);
    for (const d of dupes) console.log(`  ${d.name}: ${d.hashes}`);
    console.log('  Identical frames cannot evidence a state change.');
  }

  console.log(`\ncaptures: ${OUT}`);
  console.log(
    '\nCAVEAT — what this does NOT prove: hover is driven by setting GTK\'s\n' +
      'PRELIGHT flag, not by moving a pointer. That is sound for verifying\n' +
      'STYLING (a :hover CSS rule selects on exactly that flag and cannot tell\n' +
      'the difference), but it bypasses hit-testing entirely. A widget that is\n' +
      'occluded, zero-sized, or covered by another surface would still pass\n' +
      'here while being unreachable by a real cursor. Pointer REACHABILITY is\n' +
      'not verified by this script.',
  );

  app.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

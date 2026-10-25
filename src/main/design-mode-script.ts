// The page-side half of design mode: the self-contained IIFE the browser panel
// injects (Runtime.evaluate) to draw the hover overlay and capture a pick.
// Extracted verbatim from browser-panel.ts (#403) so the page script can evolve
// without touching the panel's transport code. NOTE: it IS a template literal —
// no backticks inside the script.

/** The id the injected overlay uses for its own DOM, so re-arming replaces
 *  rather than stacking overlays, and disarm can find and remove it. */
export const DESIGN_OVERLAY_ID = '__orchestra_design_overlay__';

/** Where the in-page script stashes a completed pick for main to poll.
 *  A global (rather than a CDP event) because the picker deliberately holds NO
 *  debugger event subscription — see the block comment above. */
export const DESIGN_PICK_GLOBAL = '__orchestraDesignPick';

/** Arm the in-page picker: inject the highlight overlay and start listening for
 *  a click. Idempotent — re-running replaces any existing overlay.
 *
 *  The script is a single self-contained IIFE (no build step reaches the page)
 *  that: draws a fixed-position outline + label box following `mousemove`,
 *  and on `click` (captured, prevented) walks the picked element's ancestor
 *  chain into a selector-node list, snapshots its computed style + outerHTML +
 *  box, stashes the result on `window[DESIGN_PICK_GLOBAL]`, and tears itself
 *  down. Escape disarms without picking. */
export const DESIGN_MODE_SCRIPT = `(() => {
  const OVERLAY_ID = ${JSON.stringify(DESIGN_OVERLAY_ID)};
  const PICK_GLOBAL = ${JSON.stringify(DESIGN_PICK_GLOBAL)};
  // Re-arming: tear down any previous run first so listeners never stack.
  if (window.__orchestraDesignTeardown) { try { window.__orchestraDesignTeardown(); } catch (e) {} }
  window[PICK_GLOBAL] = null;

  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  // pointer-events:none on the whole overlay is what makes the picker unable to
  // pick ITSELF — elementFromPoint skips pointer-events:none nodes.
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;border:2px solid #6aa9ff;background:rgba(106,169,255,0.18);border-radius:2px;transition:all 40ms linear;pointer-events:none;';
  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#6aa9ff;color:#0b1020;padding:2px 6px;border-radius:3px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.35);';
  host.appendChild(box); host.appendChild(label);
  (document.body || document.documentElement).appendChild(host);

  let current = null;

  const describe = (el) => {
    const cls = (el.getAttribute && el.getAttribute('class')) || '';
    const classes = cls.split(/\\s+/).filter(Boolean);
    let nth = 1;
    let sib = el.previousElementSibling;
    while (sib) { if (sib.tagName === el.tagName) nth++; sib = sib.previousElementSibling; }
    return { tag: el.tagName, id: el.id || undefined, classes, nthOfType: nth };
  };

  const paint = (el) => {
    const r = el.getBoundingClientRect();
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    const cls = el.classList && el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : '';
    label.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : cls) +
      '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    // Prefer the label ABOVE the box; flip below when the element is near the
    // top edge, so the label never sits off-screen.
    const above = r.top > 22;
    label.style.left = Math.max(0, r.left) + 'px';
    label.style.top = (above ? r.top - 20 : r.bottom + 4) + 'px';
  };

  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === current) return;
    current = el; paint(el);
  };

  const onClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY) || current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const computed = {};
    // Snapshot the computed style as a plain map; main subsets it
    // (shared/design-mode.ts STYLE_PROPS) so the property list lives in ONE
    // place that the unit tests assert against.
    //
    // TWO passes, because ITERATING a CSSStyleDeclaration yields only LONGHAND
    // properties: margin, padding, border and border-radius are SHORTHANDS and
    // never appear in that enumeration, so a pure index walk silently drops
    // exactly the four box/border values design mode exists to report.
    // (Measured on a real page: 383 enumerated properties, 0 of them
    // shorthands, while getPropertyValue('margin') returns 6px fine.) So walk
    // the enumeration for everything, then explicitly ask for the shorthands.
    // NOTE: no backticks anywhere in this script — it IS a template literal.
    for (let i = 0; i < cs.length; i++) { const p = cs[i]; computed[p] = cs.getPropertyValue(p); }
    for (const p of ['margin', 'padding', 'border', 'border-radius', 'font']) {
      const v = cs.getPropertyValue(p);
      if (v) computed[p] = v;
    }
    const chain = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      chain.unshift(describe(node));
      node = node.parentElement;
    }
    window[PICK_GLOBAL] = {
      url: location.href,
      title: document.title,
      chain: chain,
      outerHTML: el.outerHTML || '',
      computed: computed,
      box: { x: r.left, y: r.top, width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
    teardown();
  };

  const onKey = (e) => { if (e.key === 'Escape') { window[PICK_GLOBAL] = { cancelled: true }; teardown(); } };

  const teardown = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    const h = document.getElementById(OVERLAY_ID);
    if (h && h.parentNode) h.parentNode.removeChild(h);
    window.__orchestraDesignTeardown = null;
  };
  window.__orchestraDesignTeardown = teardown;

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  return true;
})()`;

#!/usr/bin/env python3
"""Close D10: the failed setup-pill, measured from COMPOSITED full-window frames.

Both prior attempts failed for stated reasons: a colour-search heuristic caught
antialiased text, and a row-scoped snapshot rendered over a transparent row
(91% pure black). Only the full window paints an opaque backdrop here.

Locating without guessing: scan the sidebar span for rows containing the EXACT
token colour, take the densest contiguous band, then verify the band's backdrop
is the real sidebar base (18,21,26) — NOT black. That backdrop assertion is the
guard that would have caught the row-capture mistake automatically, so it runs
before any colour is reported.

Reports fill and glyph separately: the inherited claim is that fill geometry
matches and only TEXT colour is wrong, and those are different measurements.
"""
import os, sys
from collections import Counter
from importlib.machinery import SourceFileLoader

VREF = "/home/lmas/.orchestra/worktrees/orchestra-lunar-valley-aa2170d8/docs/visual-reference"
mp = SourceFileLoader("mp", os.path.join(VREF, "measure-pair.py")).load_module()

GTK_RED = (255, 107, 107)          # @red, opaque token
E_TEXT = (255, 180, 180)           # #ffb4b4, from the live DOM
SIDEBAR_BASE = {(18, 21, 26), (26, 31, 38), (18, 21, 27)}


def band_for(path, token, xmax, label):
    w, h, rows = mp.read_png(path)
    ys = [y for y in range(h)
          if sum(1 for x in range(min(xmax, w)) if rows[y][x] == token) > 0]
    if not ys:
        print(f"\n== {label}: token {token} not found in sidebar span — cannot locate")
        return None
    # densest contiguous band
    runs, start, prev = [], ys[0], ys[0]
    for y in ys[1:]:
        if y != prev + 1:
            runs.append((start, prev)); start = y
        prev = y
    runs.append((start, prev))
    y0, y1 = max(runs, key=lambda r: r[1] - r[0])
    xs = [x for y in range(y0, y1 + 1) for x in range(min(xmax, w)) if rows[y][x] == token]
    x0, x1 = min(xs), max(xs)
    # BACKDROP GUARD — the check that would have caught the transparent-row error.
    #
    # Sample WELL clear of the pill, not 5px above it: the band located here is
    # only ~7px tall and a 5px offset lands INSIDE the pill's own fill, so the
    # guard was reading the tint it exists to validate and refusing good data.
    # 14px above clears the pill and its antialiased edge in both frontends.
    above = Counter(rows[max(0, y0 - 14)][x] for x in range(x0, x1 + 1)).most_common(1)[0][0]
    ok = above in SIDEBAR_BASE
    print(f"\n== {label}   pill band x{x0}..{x1} y{y0}..{y1}")
    print(f"   backdrop above band: {above}   {'OK (composited)' if ok else 'SUSPECT — not a sidebar base colour'}")
    if not ok:
        print("   REFUSING to report colours: still compositing over nothing")
        return None
    px = [rows[y][x] for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    c = Counter(px); tot = len(px)
    print(f"   region {tot}px; top colours:")
    for col, n in c.most_common(5):
        note = ""
        if col == GTK_RED: note = "  <-- EXACT @red (opaque token)"
        if col == E_TEXT:  note = "  <-- EXACT #ffb4b4"
        print(f"      {str(col):18} {n/tot*100:5.1f}%{note}")
    return (x0, y0, x1, y1)


band_for(sys.argv[1], E_TEXT, 337, "ELECTRON .setup-pill.failed")
band_for(sys.argv[2], GTK_RED, 516, "GTK .pill.setup-pill.failed")

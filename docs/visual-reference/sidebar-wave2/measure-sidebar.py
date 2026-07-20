#!/usr/bin/env python3
"""Sidebar-region measurements by REGIONAL DOMINANCE, absolute coordinates.

measure-pair.py measures x RELATIVE TO THE PANE EDGE, which is designed for
main-pane surfaces. The sidebar lives LEFT of that edge, so this reuses its PNG
reader and dominance method with absolute sidebar coordinates instead.

Reports for each region: dominant colour + its SHARE + the region bounds + the
sample count, so a reader can judge representativeness rather than trusting a
triple. Also reports the top-3, because a surface whose dominant colour covers
only 30% is structured (rows/seams) and a single "dominant" value would
misdescribe it.

Usage: measure_sidebar.py <electron.png> <gtk.png>
"""
import sys, os
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
VREF = "/home/lmas/.orchestra/worktrees/orchestra-lunar-valley-aa2170d8/docs/visual-reference"
sys.path.insert(0, VREF)
from importlib.machinery import SourceFileLoader

mp = SourceFileLoader("mp", os.path.join(VREF, "measure-pair.py")).load_module()

ep, gp = sys.argv[1], sys.argv[2]
ew, eh, erows = mp.read_png(ep)
gw, gh, grows = mp.read_png(gp)
print(f"electron {ew}x{eh}   gtk {gw}x{gh}")
assert (ew, eh) == (gw, gh), "SIZE MISMATCH — pair compares nothing"


def dom(rows, x0, y0, x1, y1, top=3):
    c = Counter()
    for y in range(max(0, y0), min(len(rows), y1)):
        r = rows[y]
        for x in range(max(0, x0), min(len(r), x1)):
            c[r[x]] += 1
    tot = sum(c.values())
    return tot, c.most_common(top)


def show(label, rows, x0, y0, x1, y1):
    tot, top = dom(rows, x0, y0, x1, y1)
    if not tot:
        print(f"   {label:10} EMPTY REGION")
        return
    parts = [f"{col} {n/tot*100:5.1f}%" for col, n in top]
    print(f"   {label:10} n={tot:7}  " + "   ".join(parts))


def pair(name, x0, y0, x1, y1, note=""):
    print(f"\n== {name}   region x{x0}..{x1} y{y0}..{y1}   {note}")
    show("electron", erows, x0, y0, x1, y1)
    show("gtk", grows, x0, y0, x1, y1)


# Sidebar widths differ (Electron 337, GTK 516) — a sibling is fixing that, so
# regions are chosen to sit INSIDE both sidebars (x < 337) wherever the surface
# is left-anchored, and each side's own geometry is used where it is not.
E_SB, G_SB = 337, 516

pair("sidebar-base-left", 4, 200, 120, 900,
     "left gutter, inside both sidebars, below header")
pair("section-hdr-orchestrators", 8, 125, 200, 145, "ORCHESTRATORS title band")
pair("section-hdr-scratch", 8, 303, 200, 322, "SCRATCH title band")
pair("row-band-first", 0, 148, 330, 175, "first ws row full-width band")
pair("active-accent-bar", 0, 148, 3, 175, "x0..3 = accent bar column")
pair("insights-strip", 4, 900, 330, 930, "Insights strip band")

print("\n\n#### COLUMN-PERSISTENCE (vertical seams), y 200..900 ####")
print("A single scanline is a point sample in the other axis; a column only")
print("counts as a seam if it holds one colour across the whole span.")
for tag, rows, lo, hi in (("electron", erows, E_SB - 4, E_SB + 4),
                          ("gtk", grows, G_SB - 4, G_SB + 4)):
    print(f"\n  {tag}:")
    for x in range(lo, hi + 1):
        c = Counter(rows[y][x] for y in range(200, 900) if x < len(rows[y]))
        if not c:
            continue
        col, n = c.most_common(1)[0]
        tot = sum(c.values())
        print(f"    x={x:4}  {col}  {n/tot*100:5.1f}% of {tot}")

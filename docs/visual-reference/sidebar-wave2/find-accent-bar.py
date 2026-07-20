#!/usr/bin/env python3
"""Locate the ACTIVE row's accent bar on each side, then compare like with like.

A region pinned to "the first row" tests whichever row happens to sit there,
not the ACTIVE one — and the two sides select the same workspace but place it
at different y (GTK's list is vertically compressed). Comparing a fixed band
would produce a confident wrong verdict about a bar that is simply elsewhere.

So: SCAN the x0..2 column for the accent colour, report every y-run found on
each side, and only then compare. If a side has no run at all, that is the
finding; if both have runs, compare width/height/colour.
"""
import os, sys
from importlib.machinery import SourceFileLoader

VREF = "/home/lmas/.orchestra/worktrees/orchestra-lunar-valley-aa2170d8/docs/visual-reference"
mp = SourceFileLoader("mp", os.path.join(VREF, "measure-pair.py")).load_module()

ACCENT = (110, 168, 255)


def near(c, t, tol=28):
    return all(abs(a - b) <= tol for a, b in zip(c, t))


def runs_for(rows, w, h, label):
    print(f"\n== {label}: scanning x=0..8 for accent-like pixels, y=0..{h}")
    # Which column carries it, and over which y-runs?
    for x in range(0, 9):
        ys = [y for y in range(h) if x < len(rows[y]) and near(rows[y][x], ACCENT)]
        if not ys:
            continue
        runs, start, prev = [], ys[0], ys[0]
        for y in ys[1:]:
            if y != prev + 1:
                runs.append((start, prev))
                start = y
            prev = y
        runs.append((start, prev))
        runs = [(a, b) for a, b in runs if b - a >= 3]  # ignore text antialiasing
        if runs:
            print(f"   x={x}: {len(runs)} run(s) >=4px: " +
                  ", ".join(f"y{a}..{b}({b-a+1}px)" for a, b in runs[:8]))
            for a, b in runs[:3]:
                mid = (a + b) // 2
                print(f"        exact colour at y={mid}: {rows[mid][x]}")


for path, label in ((sys.argv[1], "ELECTRON"), (sys.argv[2], "GTK")):
    w, h, rows = mp.read_png(path)
    runs_for(rows, w, h, label)

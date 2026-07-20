#!/usr/bin/env python3
"""Measure a state-matched Electron/GTK capture pair.

METHOD RULE BAKED IN: colours are reported by REGIONAL DOMINANCE, never by a
single sample point. A point sample on a surface that has rows, hover or
selection painted over it yields a sharp WRONG number and more confidence in it
(this exact error produced, then retracted, a "GTK sidebar is one step too
light" finding in this workstream). Every colour here comes with the SHARE of
the region it covers, so a reader can judge representativeness instead of
taking the triple on trust.

The x-origin caveat is printed with every main-pane region: the GTK sidebar is
wider than Electron's, so pane-relative geometry must be measured from each
side's own pane edge, not from absolute window x.

Usage: measure-pair.py <electron.png> <gtk.png> [--region NAME x0 y0 x1 y1]...
"""
import sys
import zlib
import struct
from collections import Counter


def read_png(path):
    """Minimal dep-free PNG reader -> (w, h, rows of RGB tuples)."""
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path}: not a PNG"
    pos, idat, w, h, depth, ctype = 8, b"", None, None, None, None
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, ctype = (*struct.unpack(">II", chunk[:8]), chunk[8], chunk[9])
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    assert depth == 8, f"{path}: unsupported bit depth {depth}"
    nch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = w * nch
    out, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b = prev[i]
                c = prev[i - nch] if i >= nch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        prev = line
        row = [tuple(line[i:i + 3]) if nch >= 3 else (line[i],) * 3
               for i in range(0, stride, nch)]
        out.append(row)
    return w, h, out


def dominant(px, w, h, x0, y0, x1, y1):
    """Dominant colour of a region + its share. NEVER a single sample."""
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)
    c = Counter()
    for y in range(y0, y1):
        row = px[y]
        for x in range(x0, x1):
            c[row[x]] += 1
    if not c:
        return None, 0, 0
    (col, n), total = c.most_common(1)[0], sum(c.values())
    return col, n / total, total


def content_bounds(px, w, h, bg, x0, y0, x1, y1, tol=6):
    """Bounding box of non-background pixels — for measuring real geometry."""
    minx, miny, maxx, maxy = None, None, None, None
    for y in range(max(0, y0), min(h, y1)):
        row = px[y]
        for x in range(max(0, x0), min(w, x1)):
            r, g, b = row[x]
            if abs(r - bg[0]) > tol or abs(g - bg[1]) > tol or abs(b - bg[2]) > tol:
                if minx is None or x < minx:
                    minx = x
                if maxx is None or x > maxx:
                    maxx = x
                if miny is None or y < miny:
                    miny = y
                if maxy is None or y > maxy:
                    maxy = y
    if minx is None:
        return None
    return (minx, miny, maxx, maxy)


def pane_edge(px, w, h):
    """Sidebar/pane boundary: the x where a colour change persists down the
    WHOLE column, not just at one probe row.

    A single-row probe is exactly the point-sample error this module exists to
    avoid: on the welcome screen it locked onto the welcome CARD's left edge
    (689px) instead of the sidebar boundary (339px) — a clean, specific, WRONG
    reference that would have made every pane-relative measurement wrong by
    350px while looking perfectly precise.

    So: for each candidate x, count how many sampled rows show a change there.
    A real sidebar edge runs the full height; a card edge does not.
    """
    ys = [y for y in range(40, h - 40, 7)]
    votes = Counter()
    for y in ys:
        row = px[y]
        for x in range(60, min(w - 3, 700)):
            a, b = row[x], row[x + 2]
            d = abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])
            if d > 12:
                votes[x] += 1
    if not votes:
        return 0
    # Require the edge to appear in a large majority of rows.
    best_x, best_n = max(votes.items(), key=lambda kv: (kv[1], -kv[0]))
    if best_n < 0.5 * len(ys):
        return 0
    return best_x


if __name__ == "__main__":
    ep, gp = sys.argv[1], sys.argv[2]
    ew, eh, epx = read_png(ep)
    gw, gh, gpx = read_png(gp)
    print(f"electron {ew}x{eh}   gtk {gw}x{gh}")
    if (ew, eh) != (gw, gh):
        print("!! SIZE MISMATCH — a pair captured at different sizes compares nothing")

    ee, ge = pane_edge(epx, ew, eh), pane_edge(gpx, gw, gh)
    print(f"pane edge (sidebar width):  electron {ee}px   gtk {ge}px   delta {ge - ee:+d}px")
    print("   (all pane-relative geometry below is measured from each side's OWN edge)\n")

    regions = []
    args = sys.argv[3:]
    i = 0
    while i < len(args):
        if args[i] == "--region":
            regions.append((args[i + 1], *map(int, args[i + 2:i + 6])))
            i += 6
        else:
            i += 1
    if not regions:
        regions = [("main-pane-body", 0, 200, 0, 940)]  # x relative to pane edge

    for name, x0, y0, x1, y1 in regions:
        print(f"== {name}  (x {x0}..{x1} rel. to pane edge, y {y0}..{y1})")
        for label, px, w, h, edge in (("electron", epx, ew, eh, ee), ("gtk", gpx, gw, gh, ge)):
            ax0 = edge + x0
            ax1 = (edge + x1) if x1 else w
            col, share, total = dominant(px, w, h, ax0, y0, ax1, y1)
            print(f"   {label:9s} {str(col):18s} {share*100:5.1f}% of {total} px"
                  f"   [abs x {ax0}..{ax1}]")
        print()

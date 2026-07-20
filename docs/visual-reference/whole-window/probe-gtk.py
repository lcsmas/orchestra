#!/usr/bin/env python3
"""T0 — GTK HALF of the whole-window diff: measure painted colour per region.

The GTK side has NO oracle (no getComputedStyle), so it is measured in PIXELS.
Every trap that makes pixel measurement lie is handled explicitly here:

TRAP 1 — POINT SAMPLES LIE ON STRUCTURED SURFACES. A single sample on a region
that has rows, seams, hover or selection painted over it returns a sharp WRONG
number and more confidence in it. Everything below is REGIONAL DOMINANCE and
reports the SAMPLE SHARE alongside, so a reader can see whether the dominant
value actually characterises the region or is a 12% plurality.

TRAP 2 — WIDGET-SCOPED CAPTURES ARE BLIND TO TRANSLUCENCY AND OCCLUSION. A
widget snapshot renders OFFSCREEN over NOTHING, so a translucent fill composites
against transparent black and a correct 0.12 tint reads as a solid slab. M4
filed exactly this at "88.8% dominance". So we capture the COMPOSITED WINDOW
FRAME once and crop regions out of it by widget bounds — the window paints an
opaque background, so what we read is what a user sees.

TRAP 3 — THE BACKDROP ASSERTION. After any ancestor-scoped crop, the backdrop
must be the expected background or the crop landed somewhere else. That check
is in diff-report.py, where both halves are available to compare against.

TRAP 4 — ALLOCATION IS NOT RENDERING. A widget can report visible=true, appear
in list_widgets, and paint NOTHING (zero allocation). Bounds of 0x0 are reported
as ZERO-ALLOCATION rather than being silently skipped or read as a colour.

Regions are addressed by WIDGET NAME, enumerated from the live tree — never by
an identifier read out of the inventory doc, whose negatives are provably wrong
in one direction.

Usage: probe-gtk.py <rc-sock> <out.json> <frame.png>
"""
import hashlib
import json
import os
import socket
import struct
import sys
import time
import zlib
from collections import Counter

rc_path, out_path, frame_path = sys.argv[1], sys.argv[2], sys.argv[3]

rc = socket.socket(socket.AF_UNIX)
rc.connect(rc_path)
rcf = rc.makefile("rw")


def rpc(obj):
    rcf.write(json.dumps(obj) + "\n")
    rcf.flush()
    return json.loads(rcf.readline())


# ── Frame reading: SHARED with the fault-injection proof ────────────────────
# Deliberately imported rather than duplicated. If the proof had its own
# decoder, a decoder bug could let the proof pass while the probe misreads every
# frame — the control would be validating a different instrument than the one
# actually in service.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from framescan import read_png, dominant  # noqa: E402


def names_tree():
    r = rpc({"op": "list_widgets"})
    # KEYING ON THE WRONG FIELD MAKES THE WALKER RETURN AN EMPTY SET SILENTLY,
    # and every lookup then reports ABSENT — an instrument bug that reads
    # identically to a real finding. Assert the field exists.
    if "widgets" not in r:
        print(f"FAIL: list_widgets reply has no 'widgets' key: {sorted(r)}")
        sys.exit(1)
    out = {}

    def walk(nodes):
        for n in nodes:
            nm = n.get("name")
            if nm:
                out.setdefault(nm, n)
            walk(n.get("children", []))

    walk(r["widgets"])
    return out


# ── POSITIVE CONTROL FOR THE TREE WALKER ────────────────────────────────────
# Before ANY absence is reported as a finding, prove the walker can see a
# widget known to always exist. Without this, a walker bug and a genuinely
# missing widget are indistinguishable, and the bug fails in the PASSING
# direction (everything reads ABSENT, which is what a parity sweep half
# expects to find).
present = {}
for _ in range(60):
    present = names_tree()
    if any(n.startswith("ws-row-") for n in present):
        break
    time.sleep(0.25)

if "main-window" not in present:
    print("FAIL: tree walker cannot see 'main-window' — the INSTRUMENT is broken.")
    print("      Refusing to report any widget as absent on a walker that cannot")
    print("      see a widget that always exists.")
    sys.exit(1)
rows = sorted(n for n in present if n.startswith("ws-row-"))
if not rows:
    print("FAIL: no ws-row-* widgets — the mock fixture never rendered")
    sys.exit(1)
print(f"-- walker control OK (main-window visible); {len(rows)} workspace rows")
time.sleep(1.5)  # async badge/pill work settles


def geom(name):
    """Widget bounds in window coordinates, via the harness's own reply.

    Returns None when the widget is absent; a 0x0 result is returned AS a
    zero-allocation reading rather than being conflated with absence — a widget
    that exists and paints nothing is a different (and more interesting)
    finding than one that is not there at all.
    """
    r = rpc({"op": "bounds", "name": name})
    if not r.get("ok"):
        return None
    return r


# ── The composited window frame is the ONLY camera ──────────────────────────
shot = rpc({"op": "screenshot", "path": frame_path})
# ASSERT ON THE HARNESS'S OWN RETURN VALUE, not just on the file appearing.
if not shot.get("ok"):
    print(f"FAIL: window screenshot failed: {shot.get('error')}")
    sys.exit(1)
if not (os.path.exists(frame_path) and os.path.getsize(frame_path) > 0):
    print(f"FAIL: screenshot reported ok but produced no bytes at {frame_path}")
    sys.exit(1)

W, H, PX = read_png(frame_path)
digest = hashlib.md5(open(frame_path, "rb").read()).hexdigest()
print(f"-- window frame {W}x{H} md5={digest[:12]}")

REGIONS = [
    ("header-strip", "sidebar-header", "fill"),
    ("sidebar-body", "sidebar", "fill"),
    ("sidebar-bottom", "sidebar-footer", "fill"),
    ("toolbar", "toolbar", "fill"),
    ("main-pane", "main-area", "fill"),
    ("app-root", "main-window", "fill"),
    # Rows are named ws-row-<workspaceId> — a DYNAMIC identifier, so it is
    # resolved from the live tree rather than written as a literal. The M4
    # inventory's habit of naming guessed identifiers is what made its negatives
    # wrong in one direction.
    ("ws-row", rows[0] if rows else "ws-row-missing", "fill"),
]

out = {
    "frame": {"path": frame_path, "w": W, "h": H, "md5": digest},
    "achieved": {"w": W, "h": H},
    "rows": len(rows),
    "regions": {},
    "absent": [],
}

for rid, widget, klass in REGIONS:
    g = geom(widget)
    if g is None:
        # Reported as an explicit ABSENT entry, never dropped. A dropped region
        # is invisible in the ranked diff and therefore reads as a match.
        out["absent"].append({"id": rid, "widget": widget})
        print(f"   {rid:16s} ABSENT (no widget {widget!r})")
        continue
    x, y, w, h = g.get("x", 0), g.get("y", 0), g.get("width", 0), g.get("height", 0)
    if w <= 0 or h <= 0:
        out["regions"][rid] = {
            "widget": widget, "surfaceClass": klass,
            "bounds": {"x": x, "y": y, "w": w, "h": h},
            "zeroAllocation": True, "dominant": None, "share": 0.0,
        }
        print(f"   {rid:16s} ZERO-ALLOCATION ({w}x{h}) — exists but paints nothing")
        continue
    # Inset by 2px so a 1px border/seam on the boundary cannot dominate a thin
    # region; the inset is reported so the bounds stay auditable.
    inset = 2 if (w > 8 and h > 8) else 0
    col, share, total = dominant(PX, W, H, x + inset, y + inset,
                                 x + w - inset, y + h - inset)
    out["regions"][rid] = {
        "widget": widget, "surfaceClass": klass,
        "bounds": {"x": x, "y": y, "w": w, "h": h},
        "sampled": {"x0": x + inset, "y0": y + inset,
                    "x1": x + w - inset, "y1": y + h - inset},
        "inset": inset, "zeroAllocation": False,
        "dominant": list(col) if col else None,
        "share": share, "samples": total,
    }
    print(f"   {rid:16s} rgb{col} {share*100:5.1f}% of {total:7d}px"
          f"  [{klass}]  bounds {int(w)}x{int(h)}@{int(x)},{int(y)}")

json.dump(out, open(out_path, "w"), indent=2)
print(f"-- gtk probe written to {out_path}")
sys.exit(0)

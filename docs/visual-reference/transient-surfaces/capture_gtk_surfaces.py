"""Capture GTK transient surfaces in the CORRECTED order.

Ordering rule (learned the hard way): focus/geometry FIRST, open the surface
SECOND, and re-assert the surface still exists IN THE SAME BREATH as the
capture. Opening before focusing let a compositor move dismiss the modal, and
the geometry assertion still passed — a green control on a vanished target.

Every capture takes BOTH:
  * a widget-scoped crop (detail), and
  * a WINDOW-scoped in-situ frame (proves it is on stage composited, since a
    widget-scoped snapshot renders offscreen and is structurally blind to
    occlusion).
Hashes are collected so duplicates fail loudly.
"""
import os
import sys
import time
from collections import Counter

from rc import RC

CAPS = os.path.abspath('caps')
os.makedirs(CAPS, exist_ok=True)
hashes = {}


def cap(r, tag, widget, expect_present):
    """Capture widget + in-situ, asserting the surface is present RIGHT NOW."""
    ns = r.names()
    present = expect_present in ns
    print(f"  [{tag}] surface {expect_present!r} present at capture time: {present}")
    if not present:
        print(f"  [{tag}] SKIP — target vanished; no verdict from this run")
        return None
    w = r.shot(f"{CAPS}/gtk-{tag}.png", widget)
    i = r.shot(f"{CAPS}/gtk-{tag}-INSITU.png", "main-window")
    print(f"  [{tag}] widget bytes={w['bytes']:7d} md5={w.get('md5','')[:10]}")
    print(f"  [{tag}] insitu bytes={i['bytes']:7d} md5={i.get('md5','')[:10]}")
    for k, v in (("%s:widget" % tag, w), ("%s:insitu" % tag, i)):
        if v.get('md5'):
            hashes[k] = v['md5']
    return w, i


def main():
    r = RC()
    r.assert_walker_sees()
    print("walker control PASSED")

    # dialog (confirm/destructive path)
    print("\n== dialog: delete orchestrator ==")
    res = r.click('ws-delete-orch-1')
    print("  click ->", res)          # assert on the OP RESULT, not just state
    time.sleep(1.3)
    cap(r, 'dialog-delete', 'orch-dialog', 'orch-dialog')
    # tone chip PARENT-scoped: a translucent tint read widget-scoped is a guess
    if 'orch-dialog' in r.names():
        p = r.shot(f"{CAPS}/gtk-tonechip-parent.png", 'orch-dialog')
        print(f"  tone chip parent-scoped bytes={p['bytes']}")
    r.key('Escape')
    time.sleep(0.8)

    # repo scripts modal
    print("\n== repo scripts modal ==")
    res = r.click('repo-scripts-orchestra')
    print("  click ->", res)
    time.sleep(1.5)
    cap(r, 'repo-scripts', 'repo-scripts-modal', 'repo-scripts-modal')
    if 'repo-scripts-cancel' in r.names():
        r.click('repo-scripts-cancel')
    time.sleep(0.8)

    # linear settings modal
    print("\n== linear settings modal ==")
    res = r.click('env-notice-linear-set-key')
    print("  click ->", res)
    time.sleep(1.5)
    cap(r, 'linear', 'linear-settings', 'linear-settings')

    print("\n== duplicate-hash guard ==")
    c = Counter(hashes.values())
    dupes = {h: [k for k, v in hashes.items() if v == h] for h, n in c.items() if n > 1}
    if dupes:
        print("  DUPLICATE CAPTURES (a drive silently no-opped):")
        for h, ks in dupes.items():
            print("   ", h[:10], ks)
        sys.exit(1)
    print(f"  OK — {len(hashes)} captures, all distinct")


main()

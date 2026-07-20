#!/usr/bin/env python3
"""Drive the GTK app through the MAIN-PANE + OVERLAY surfaces (parity verify).

Captures the region right of the sidebar plus the three full-page overlays,
against whichever backend the caller wired up (this script is backend-agnostic;
capture-gtk-mainpane.sh points it at a REAL daemon).

Why each guard exists — these are the failures that produced false verdicts here
before, so they are asserted rather than assumed:

* Every overlay gets a POSITIVE CONTROL: the widget subtree must go from absent/
  small to a descendant count above a floor, asserted BEFORE the screenshot. A
  broken drive and a genuinely-empty page otherwise produce the same PNG, and
  the empty one reads as a real finding. If the control fails we still capture,
  but the surface is recorded as CANNOT-VERIFY rather than as an empty page.
* The welcome screen is reached via the `mainpane.clear-active` harness action
  and asserted through the self-resetting `showing-empty` CSS class on the pane
  root. GTK reports is_visible()==true for a Stack's OFF-SCREEN child too, so
  visibility cannot discriminate the two states (documented main_pane.rs:224).
* Every capture is md5'd and duplicates FAIL the run: a drive step that silently
  no-ops still writes a plausible-looking screenshot.

Usage: drive-gtk-mainpane.py <rc-sock> <outdir>
"""
import hashlib
import json
import os
import socket
import sys
import time

rc_path, out_dir = sys.argv[1], sys.argv[2]
WELCOME_RUN_EARLY = os.environ.get("ORCHESTRA_WELCOME_RUN") == "1"
os.makedirs(out_dir, exist_ok=True)

rc = socket.socket(socket.AF_UNIX)
rc.settimeout(60)
rc.connect(rc_path)
rcf = rc.makefile("rw")

results = {}   # surface -> verdict note
captured = []  # (surface, path)


def rpc(obj):
    rcf.write(json.dumps(obj) + "\n")
    rcf.flush()
    return json.loads(rcf.readline())


def tree():
    return rpc({"op": "list_widgets"}).get("widgets", [])


def names():
    out = set()

    def walk(nodes):
        for n in nodes:
            if n.get("name"):
                out.add(n["name"])
            walk(n.get("children", []))

    walk(tree())
    return out


def subtree_size(target):
    """Descendant count of the named widget — the overlay positive control."""
    found = [0]

    def count(n):
        return 1 + sum(count(c) for c in n.get("children", []))

    def walk(nodes):
        for n in nodes:
            if n.get("name") == target:
                found[0] = count(n)
                return True
            if walk(n.get("children", [])):
                return True
        return False

    walk(tree())
    return found[0]


def css(name):
    r = rpc({"op": "get", "name": name, "prop": "css"})
    return set(r.get("value", [])) if r.get("ok") else set()


def shot(surface, widget=None):
    path = os.path.join(out_dir, f"gtk-{surface}.png")
    op = {"op": "screenshot", "path": path}
    if widget:
        op["name"] = widget
    r = rpc(op)
    ok = r.get("ok") and os.path.exists(path) and os.path.getsize(path) > 0
    print(f"  {'captured' if ok else '! FAILED'} gtk-{surface}.png"
          + ("" if ok else f" ({r.get('error')})"))
    if ok:
        captured.append((surface, path))
    return ok


def click(widget):
    r = rpc({"op": "click", "name": widget})
    if not r.get("ok"):
        print(f"  ! click {widget} failed: {r.get('error')}")
    return bool(r.get("ok"))


def action(act, name=None, param=None):
    op = {"op": "action", "action": act}
    if name:
        op["name"] = name
    if param:
        op["param"] = param
    r = rpc(op)
    if not r.get("ok"):
        print(f"  ! action {act} failed: {r.get('error')}")
    return bool(r.get("ok"))


# ── The tree-walker needs its own positive control ────────────────────────
# Keying on the wrong reply field silently yields an EMPTY set, and every
# waitFor below would then burn its budget and report "absent" — an instrument
# bug wearing the costume of a real finding. Assert a known-always-present
# widget first.
present = set()
for _ in range(80):
    present = names()
    if "main-window" in present:
        break
    time.sleep(0.25)
if "main-window" not in present:
    print("FAIL: tree-walker cannot see 'main-window' — the walker is broken, "
          "so NO absence it reports is trustworthy")
    sys.exit(1)
print(f"-- walker control OK: main-window visible, {len(present)} named widgets")

# Wait for the fixture to actually arrive from the backend.
rows = []
for _ in range(120):
    present = names()
    rows = sorted(n for n in present if n.startswith("ws-row-"))
    if rows:
        break
    time.sleep(0.25)
print(f"-- {len(rows)} workspace rows rendered")
if not rows and not WELCOME_RUN_EARLY:
    print("   (no rows — capturing anyway; an empty backend is itself a finding)")
time.sleep(1.5)  # async badges/pills settle


# ══ 1. OVERLAYS — the never-seen-live surfaces, highest priority ══════════
# Capture even if broken/empty: any rendered frame is the first evidence that
# exists for these. But distinguish "page is empty" from "my drive failed" via
# the closed->open descendant-count control.
# Root widget names read from set_widget_name() in overlays/*.rs — NOT guessed.
# A guessed selector fails for reasons unrelated to the claim, which would send
# someone hunting a non-bug.
# Child widgets probed for allocation inside each overlay. The overlay ROOT
# acts as the sibling positive control: if it screenshots, the capture path
# works, so a zero on a child is a real zero.
OVERLAY_PROBES = {
    "resources": ["res-live", "res-close"],
    "insights": ["insights-run-btn", "insights-close"],
    "help": ["help-close", "help-guide-link"],
}

OVERLAYS = [
    ("resources", "open-resources", "resources-overlay"),
    ("insights", "open-insights", "insights-overlay"),
    ("help", "open-help", "help-overlay"),
]

WELCOME_RUN = os.environ.get("ORCHESTRA_WELCOME_RUN") == "1"

for surface, button, view_name in ([] if WELCOME_RUN else OVERLAYS):
    print(f"-- overlay: {surface}")
    if button not in names():
        print(f"  ! entry point {button!r} ABSENT from the widget tree")
        results[surface] = "CANNOT-VERIFY: entry point absent"
        continue
    # TWO controls, because the overlays open by DIFFERENT mechanisms and one
    # probe is structurally blind to the other's:
    #   * Resources/Insights POPULATE on open (descendant count jumps).
    #   * Help is built STATICALLY at mount (overlays/mod.rs:125 flips
    #     set_visible only), so its subtree is the same size open or closed and
    #     a count-based control can never fire. Reading that as "the page never
    #     opened" would have been a false defect from MY probe, not the app.
    # So accept EITHER a descendant jump OR a visible transition.
    before = subtree_size(view_name)
    before_vis = rpc({"op": "get", "name": view_name, "prop": "visible"}).get("value")
    if not click(button):
        results[surface] = "CANNOT-VERIFY: click rejected"
        continue
    after, after_vis, opened = before, before_vis, False
    for _ in range(40):
        time.sleep(0.25)
        after = subtree_size(view_name)
        after_vis = rpc({"op": "get", "name": view_name, "prop": "visible"}).get("value")
        if after > max(before, 3) or (after_vis and not before_vis):
            opened = True
            break
    if opened:
        how = "populated" if after > max(before, 3) else "became visible"
        print(f"  control OK: {view_name} {how} "
              f"({before}->{after} descendants, visible {before_vis}->{after_vis})")
        results[surface] = f"OPENED via {how} ({after} descendants)"
    else:
        print(f"  ! control FAILED: {view_name} {after} descendants, "
              f"visible {before_vis}->{after_vis}")
        results[surface] = (f"CANNOT-VERIFY: never opened ({before}->{after}, "
                            f"vis {before_vis}->{after_vis}); an empty capture "
                            "here may be MY drive, not the page")
    time.sleep(1.2)  # let async CPU/disk/token sampling populate
    shot(f"overlay-{surface}", "main-window")
    # ALLOCATION probe: visible=True is UPSTREAM of allocation. A widget can be
    # present, enumerable and flagged visible while painting nothing (two repo
    # icons did exactly that for two commits). Widget-scoped screenshot BYTES
    # are the render proof; the overlay root doubles as the positive control
    # that makes any zero meaningful.
    alloc = {}
    for probe_name in [view_name] + OVERLAY_PROBES.get(surface, []):
        pr = rpc({"op": "screenshot",
                  "path": os.path.join(out_dir, f".alloc-{probe_name}.png"),
                  "name": probe_name})
        ap = os.path.join(out_dir, f".alloc-{probe_name}.png")
        alloc[probe_name] = os.path.getsize(ap) if os.path.exists(ap) else 0
        if os.path.exists(ap):
            os.unlink(ap)
    root_bytes = alloc.get(view_name, 0)
    zeros = [k for k, v in alloc.items() if v == 0]
    print(f"  alloc bytes: {alloc}")
    if root_bytes == 0:
        print(f"  ! {view_name} allocated ZERO bytes — capture path or page is dead")
        results[surface] += " | ZERO-ALLOCATION ROOT"
    elif zeros:
        print(f"  ! zero-allocation children (root OK, so path works): {zeros}")
        results[surface] += f" | zero-alloc children: {','.join(zeros)}"
    # Close again so the next overlay opens from a known state, and ASSERT it
    # closed: leaving one open would layer the next capture on top of it, and
    # the resulting composite is a convincing, worthless image.
    rpc({"op": "key", "name": "Escape"})
    closed = False
    for _ in range(20):
        time.sleep(0.2)
        if not rpc({"op": "get", "name": view_name, "prop": "visible"}).get("value"):
            closed = True
            break
    if not closed:
        print(f"  ! {view_name} did not close — falling back to the toggle button")
        click(button)
        time.sleep(0.6)


# ══ 2. WELCOME SCREEN — brand new, no user affordance reaches it ══════════
print("-- welcome screen")
if action("mainpane.clear-active", name="main-empty"):
    shown = False
    for _ in range(40):
        time.sleep(0.2)
        if "showing-empty" in css("main-area"):
            shown = True
            break
    if shown:
        print("  control OK: main-area gained .showing-empty")
        results["welcome"] = "SHOWN"
        time.sleep(0.8)
        shot("welcome-full", "main-window")
        shot("welcome-pane", "main-empty")
        if "welcome-features" in names():
            shot("welcome-feature-grid", "welcome-features")
        else:
            print("  ! welcome-features absent from the tree")
    else:
        print("  ! .showing-empty never appeared — welcome screen not on stage")
        results["welcome"] = "CANNOT-VERIFY: showing-empty never set"
else:
    results["welcome"] = "CANNOT-VERIFY: harness action unavailable"


# ══ 3. MAIN PANE with a workspace selected: tabs / run pane / status ══════
# Pin a MID-LIST row: auto-selection only ever lands on tree-top rows, and a
# pair that quietly differs in selected row still looks rigorous.
target_row = None if WELCOME_RUN else os.environ.get("ORCHESTRA_CAPTURE_ROW")
if target_row and rows:
    if target_row not in rows:
        print(f"FAIL: ORCHESTRA_CAPTURE_ROW={target_row!r} not among rendered rows")
        print(f"      rendered: {', '.join(rows)}")
        sys.exit(1)
    if "active" in css(target_row):
        print(f"FAIL: {target_row!r} is ALREADY active — clicking is a no-op and "
              "the captures would be byte-identical to the unselected ones")
        sys.exit(1)
    if click(target_row):
        moved = False
        for _ in range(30):
            time.sleep(0.2)
            if "active" in css(target_row):
                moved = True
                break
        if not moved:
            print(f"FAIL: click on {target_row} did not make it active")
            sys.exit(1)
        print(f"-- selected row: {target_row}")
        time.sleep(2.0)
        shot("mainpane-terminal", "main-area")
        shot("tabstrip", "toolbar")
        shot("statusstrip", "status-strip")
        results["main-pane"] = f"row {target_row} active"

        # Tab strip: Diff then Run, asserting the stack page actually moved.
        for tab, surface in [("tab-diff", "tab-diff"), ("tab-run", "tab-run")]:
            n = names()
            if tab in n:
                if click(tab):
                    time.sleep(1.5)
                    klass = css(tab)
                    print(f"  {tab} classes: {sorted(klass)}")
                    shot(f"mainpane-{surface}", "main-area")
                    results[surface] = f"classes={sorted(klass)}"
            else:
                print(f"  ! {tab} absent from the tree")
                results[surface] = "CANNOT-VERIFY: tab widget absent"
else:
    print("-- no row pin / no rows: skipping selected-row surfaces")


# ══ Duplicate guard: a no-op drive still writes a plausible screenshot ════
digests = {}
for surface, path in captured:
    with open(path, "rb") as fh:
        digests.setdefault(hashlib.md5(fh.read()).hexdigest(), []).append(surface)

dupes = [v for v in digests.values() if len(v) > 1]
print("\n-- capture manifest (md5)")
for surface, path in captured:
    with open(path, "rb") as fh:
        print(f"   {hashlib.md5(fh.read()).hexdigest()}  gtk-{surface}.png")
print("\n-- verdicts")
for k, v in results.items():
    print(f"   {k}: {v}")

if dupes:
    for d in dupes:
        print(f"\n! IDENTICAL captures (a drive step no-opped): {', '.join(d)}")
    sys.exit(1)
print("\n-- drive complete, no duplicate captures")

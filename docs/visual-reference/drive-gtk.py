#!/usr/bin/env python3
"""Remote-control driver for the GTK half of the visual reference pair (M4-V0).

Speaks the newline-JSON harness protocol on --remote-control's socket and
captures the SAME surfaces drive-electron.mjs does, so each pair compares like
with like:

    full-window / sidebar / workspace-selected / main-pane / toolbar /
    sidebar-selected / dialog

NOTE on `sidebar-selected`: the drive expands the Archived section (and asserts
it opened) before this capture, but with 14 fixture rows the archived rows sit
BELOW the visible fold, so the crop shows the selected-row sidebar rather than
archived chrome. It is named for what it actually shows, not what the drive did.

Widget names below were read from `set_widget_name(...)` in
native/orchestra-gtk/src — they intentionally mirror the Electron class names
(sidebar, toolbar, archived-toggle, archived-bar-delete).

The harness's screenshot op awaits two frame-clock ticks itself (GTK defers
layout to the frame clock, so a capture taken right after a structural rebuild
would otherwise yield an empty render node), and with no `name` it prefers the
topmost dialog toplevel — which is how the dialog surface is captured.

Usage: drive-gtk.py <rc-sock> <outdir>
"""
import json
import os
import socket
import sys
import time

rc_path, out_dir = sys.argv[1], sys.argv[2]

rc = socket.socket(socket.AF_UNIX)
rc.connect(rc_path)
rcf = rc.makefile("rw")


def rpc(obj):
    rcf.write(json.dumps(obj) + "\n")
    rcf.flush()
    return json.loads(rcf.readline())


def names():
    """Flatten the widget tree to a set of widget names."""
    r = rpc({"op": "list_widgets"})
    out = set()

    def walk(nodes):
        for n in nodes:
            if n.get("name"):
                out.add(n["name"])
            walk(n.get("children", []))

    walk(r.get("widgets", []))
    return out


def shot(surface, widget=None):
    path = os.path.join(out_dir, f"gtk-{surface}.png")
    op = {"op": "screenshot", "path": path}
    if widget:
        op["name"] = widget
    r = rpc(op)
    if not r.get("ok"):
        print(f"  ! screenshot {surface} failed: {r.get('error')}")
        return False
    ok = os.path.exists(path) and os.path.getsize(path) > 0
    print(f"  {'captured' if ok else '! EMPTY'} gtk-{surface}.png")
    return ok


def click(widget):
    r = rpc({"op": "click", "name": widget})
    if not r.get("ok"):
        print(f"  ! click {widget} failed: {r.get('error')}")
    return bool(r.get("ok"))


failures = []

# The fixture must actually be on screen before any pixels are taken —
# otherwise an empty app screenshots "successfully" and proves nothing.
present = set()
for _ in range(40):
    present = names()
    if any(n.startswith("ws-row-") for n in present):
        break
    time.sleep(0.25)
rows = sorted(n for n in present if n.startswith("ws-row-"))
if not rows:
    print("FAIL: no ws-row-* widgets — the mock fixture never rendered")
    sys.exit(1)
print(f"-- {len(rows)} workspace rows rendered")
time.sleep(1.0)  # let async badge/pill work settle

# ── Surface 1: full window ────────────────────────────────────────────────
if not shot("full-window"):
    failures.append("full-window")

# ── Surface 2: sidebar region ─────────────────────────────────────────────
if "sidebar" in present:
    shot("sidebar", "sidebar")
else:
    print("  ! no 'sidebar' widget")

# ── Surface 3: main pane with a workspace selected ────────────────────────
# The app boots with the first row already selected, so clicking rows[0] is a
# no-op whose screenshot is byte-identical to the full-window one. Select a
# DIFFERENT row (same reasoning as the Electron driver) and assert it took.
def active_rows():
    r = rpc({"op": "get", "name": "sidebar-list", "prop": "css"})
    return r


# WHICH row gets selected is a BOOT RACE by default. The scan below takes the
# first row lacking `.active`, so the answer depends on whether the app's own
# auto-selection has landed before the driver's first poll. Three rigs saw the
# same commit yield different targets (ws-row-orch-1 / ws-row-orch-scratch-kid),
# which matters because a before/after pair that quietly differs in SELECTED ROW
# still looks like a rigorous comparison — it is a state mismatch, not a change.
# Set ORCHESTRA_CAPTURE_ROW to pin the target when capturing a comparable pair.
#
# An absent pinned row FAILS LOUDLY and never falls back to the racy scan: a
# silent fallback would restore the exact nondeterminism this flag removes while
# reading as though the run were pinned, which is worse than having no flag.
target_row = os.environ.get("ORCHESTRA_CAPTURE_ROW") or None
if target_row is not None and target_row not in rows:
    print(f"FAIL: ORCHESTRA_CAPTURE_ROW={target_row!r} is not among the rendered rows")
    print(f"      rendered: {', '.join(rows)}")
    sys.exit(1)
if target_row is None:
    for name in rows:
        r = rpc({"op": "get", "name": name, "prop": "css"})
        classes = set(r.get("value", [])) if r.get("ok") else set()
        if "active" not in classes:
            target_row = name
            break
if target_row is None:
    print("FAIL: every row already active — nothing to select")
    sys.exit(1)

# A pinned row that is ALREADY `.active` makes the click below a no-op, and the
# post-click assertion then passes VACUOUSLY — the class it checks for was there
# before the click. The captures come out byte-identical to the unselected ones
# and only the md5 duplicate guard notices. Refuse the target instead: this must
# be caught here, where the cause is obvious, not downstream as a hash collision.
if os.environ.get("ORCHESTRA_CAPTURE_ROW"):
    r = rpc({"op": "get", "name": target_row, "prop": "css"})
    if r.get("ok") and "active" in set(r.get("value", [])):
        print(f"FAIL: ORCHESTRA_CAPTURE_ROW={target_row!r} is ALREADY active at boot")
        print("      Clicking it is a no-op, so the 'selected' captures would be")
        print("      byte-identical to the unselected ones. Pin a different row.")
        sys.exit(1)

if click(target_row):
    # Assert the selection actually moved onto the clicked row.
    moved = False
    for _ in range(20):
        time.sleep(0.2)
        r = rpc({"op": "get", "name": target_row, "prop": "css"})
        if r.get("ok") and "active" in set(r.get("value", [])):
            moved = True
            break
    if not moved:
        print(f"FAIL: click on {target_row} did not make it active")
        sys.exit(1)
    print(f"-- selected row: {target_row}")
    time.sleep(1.5)
    if not shot("workspace-selected"):
        failures.append("workspace-selected")
    if "main-area" in names():
        shot("main-pane", "main-area")
    if "toolbar" in names():
        shot("toolbar", "toolbar")
    else:
        print("  ! no 'toolbar' widget")

# ── Surface 4: archived section expanded ──────────────────────────────────
# Assert the archived rows actually appeared rather than trusting the click —
# the bar widgets only exist once the section is open.
if "archived-toggle" in names() and click("archived-toggle"):
    opened = False
    for _ in range(20):
        time.sleep(0.2)
        if "archived-bar" in names():
            opened = True
            break
    if not opened:
        print("FAIL: archived section never expanded (no archived-bar)")
        sys.exit(1)
    print("-- archived expanded")
    shot("sidebar-selected", "sidebar")

# ── Surface 5: a dialog (same user path as the Electron side) ─────────────
n = names()
if "archived-select-all" in n and click("archived-select-all"):
    time.sleep(0.5)
    if "archived-bar-delete" in names() and click("archived-bar-delete"):
        time.sleep(0.8)
        # No `name` → the harness prefers the topmost dialog toplevel.
        shot("dialog")
    else:
        print("  ! archived-bar-delete not present — skipping dialog surface")
else:
    print("  ! archived-select-all not present — skipping dialog surface")

# Guard against no-op drives: a click that silently fails yields a screenshot
# byte-identical to the previous surface, which LOOKS like a successful capture
# but proves nothing. Fail loudly instead.
import hashlib

digests = {}
for f in sorted(os.listdir(out_dir)):
    if f.startswith("gtk-") and f.endswith(".png"):
        with open(os.path.join(out_dir, f), "rb") as fh:
            digests.setdefault(hashlib.md5(fh.read()).hexdigest(), []).append(f)
for dupes in digests.values():
    if len(dupes) > 1:
        print(f"  ! IDENTICAL captures (a drive step no-opped): {', '.join(dupes)}")
        failures.append("duplicate:" + ",".join(dupes))

print("-- gtk capture complete")
sys.exit(1 if failures else 0)

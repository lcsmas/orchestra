#!/usr/bin/env python3
"""Capture the GTK welcome / no-workspace screen over --remote-control.

The app boots with a row auto-selected, so the welcome screen is NOT what is
on screen at boot. This drive asserts the app reached the welcome state before
taking any pixels — an app still showing a workspace would screenshot
"successfully" and prove nothing about the welcome screen.

Usage: drive-welcome.py <rc-sock> <out.png> <label>
"""
import hashlib
import json
import os
import socket
import sys
import time

rc_path, out_png, label = sys.argv[1], sys.argv[2], sys.argv[3]

rc = socket.socket(socket.AF_UNIX)
rc.connect(rc_path)
rcf = rc.makefile("rw")


def rpc(obj):
    rcf.write(json.dumps(obj) + "\n")
    rcf.flush()
    return json.loads(rcf.readline())


def names():
    r = rpc({"op": "list_widgets"})
    out = set()

    def walk(nodes):
        for n in nodes:
            if n.get("name"):
                out.add(n["name"])
            walk(n.get("children", []))

    walk(r.get("widgets", []))
    return out


# Wait for the fixture to render at all.
present = set()
for _ in range(40):
    present = names()
    if any(n.startswith("ws-row-") for n in present):
        break
    time.sleep(0.25)
if not any(n.startswith("ws-row-") for n in present):
    print("FAIL: app never rendered the fixture")
    sys.exit(1)

# The pane reflects which stack branch is on stage as a css class on
# `main-area` (`showing-empty` / `showing-content`). GTK's `visible` is useless
# here: it reads true for a Stack's off-screen child too, so both branches
# report true at once and an assertion on it cannot fail.
def stage():
    r = rpc({"op": "get", "name": "main-area", "prop": "css"})
    return set(r.get("value", [])) if r.get("ok") else set()


# PRE-STATE: the app auto-selects a workspace at boot, but that is a RACE with
# this driver's first poll. Wait for the CONTENT branch to land first, so the
# transition asserted below is one this drive actually caused rather than a
# state that predated it.
pre = None
for _ in range(60):
    c = stage()
    if "showing-content" in c:
        pre = "content"
        break
    if c:
        pre = "empty"
    time.sleep(0.25)
if pre != "content":
    print(f"FAIL: a workspace never became active (stage={pre!r}) — the clear")
    print("      action would be a no-op and the assertion below vacuous.")
    sys.exit(1)
print("-- pre-state: showing-content (a workspace is active), as expected")

r = rpc({"op": "action", "action": "mainpane.clear-active", "name": "main-empty"})
if not r.get("ok"):
    print(f"FAIL: clear-active: {r.get('error')}")
    sys.exit(1)

# ASSERT THE TRANSITION content -> empty (pre-state proven above).
moved = False
for _ in range(30):
    if "showing-empty" in stage():
        moved = True
        break
    time.sleep(0.2)
if not moved:
    print("FAIL: never reached showing-empty — not the welcome screen")
    sys.exit(1)
print("-- welcome state confirmed: showing-content -> showing-empty observed")

time.sleep(1.0)  # settle
# Snapshot the PARENT (`main-area`), not `main-empty`: WidgetPaintable clips to
# the named widget's bounds, and a `main-empty`-scoped capture cut the heading's
# ascender off the top edge (observed). The parent is sized to the pane, so
# nothing on the welcome screen falls outside the frame.
r = rpc({"op": "screenshot", "path": out_png, "name": "main-area"})
if not r.get("ok"):
    print(f"FAIL: screenshot: {r.get('error')}")
    sys.exit(1)
if not (os.path.exists(out_png) and os.path.getsize(out_png) > 0):
    print("FAIL: screenshot empty")
    sys.exit(1)
digest = hashlib.md5(open(out_png, "rb").read()).hexdigest()
print(f"-- captured {label}: {out_png} md5={digest}")

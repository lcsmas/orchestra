#!/usr/bin/env python3
"""T2 — measure the RENDERED type of every text role in the GTK frontend.

Uses the remote-control `get {prop: "font"}` op, which reports the font
description Pango resolved for the widget AFTER the CSS cascade. That is the
distinction this script exists for: `theme.css` is a set of REQUESTS, and three
things routinely make the request differ from the result —

  * the rule is outranked by a more specific one,
  * the family is not installed and fontconfig silently substitutes,
  * no family is declared at all, so the widget inherits the gtk-font-name
    SETTING, which appears in no stylesheet anywhere.

The third is invisible to any amount of source reading and is the one that
matters most here.

ROLES ARE REACHED STRUCTURALLY, NOT BY GUESSED NAME. The port names widgets per
INSTANCE (`ws-row-ws-1`), and the row's own name/subtitle labels carry no
widget name at all — so a role table of hand-written identifiers reports
NOT-FOUND for exactly the roles that matter, which is indistinguishable from
those roles being absent. Instead this walks the live tree, finds a container
by a name pattern, and measures the GtkLabels INSIDE it, addressing each by the
`Type#N` form the harness's find_widget supports. The CSS classes of each label
are reported alongside, so a reader can tell WHICH role a measured label is
without trusting this script's ordering.

Usage: measure-type-gtk.py <rc-sock> <out.json>
"""
import json
import socket
import sys

rc_path, out_path = sys.argv[1], sys.argv[2]

rc = socket.socket(socket.AF_UNIX)
rc.connect(rc_path)
rcf = rc.makefile("rw")


def rpc(obj):
    rcf.write(json.dumps(obj) + "\n")
    rcf.flush()
    return json.loads(rcf.readline())


def tree():
    r = rpc({"op": "list_widgets"})
    if not r.get("ok"):
        sys.exit(f"list_widgets failed: {r}")
    # The reply key is 'widgets'. Keying on the wrong field returns an EMPTY
    # set silently, and every role then reports NOT-FOUND — a broken instrument
    # wearing the costume of a total-absence finding. The control below guards.
    tops = r.get("widgets")
    if tops is None:
        sys.exit(f"INSTRUMENT FAILURE: no 'widgets' key in reply: {list(r)}")
    return tops


def walk(node, path, out):
    out.append((node.get("name", ""), node.get("type", ""), tuple(path)))
    for c in node.get("children", []) or []:
        walk(c, path + [node.get("name", "")], out)


def all_nodes(tops):
    out = []
    for t in tops:
        walk(t, [], out)
    return out


def get(name, prop):
    r = rpc({"op": "get", "name": name, "prop": prop})
    return r.get("value") if r.get("ok") else {"error": r.get("error")}


tops = tree()
nodes = all_nodes(tops)
names = [n for n, _, _ in nodes]

# --- POSITIVE CONTROL for the tree walker ----------------------------------
# If the walker silently returns nothing, every measurement below is an
# artifact. A known-always-present widget must be visible first.
if "main-window" not in names:
    sys.exit(
        "INSTRUMENT FAILURE: walker cannot see 'main-window' "
        f"({len(names)} nodes). Refusing to emit results."
    )

# Labels are anonymous, so the harness addresses them as GtkLabel#N in
# DEPTH-FIRST order across ALL toplevels — the same order find_widget walks.
# Build that index here so each measured label can be named unambiguously.
#
# CRITICAL INDEXING DETAIL: find_widget counts matches on `widget_name`, and an
# unnamed widget's widget_name falls back to its GType name. So the Nth
# "GtkLabel#N" is the Nth label WHOSE NAME IS LITERALLY "GtkLabel" — named
# labels are NOT in that counter. Counting all labels here would silently
# off-by-K and measure the wrong widget while returning a perfectly plausible
# font, so the counter below mirrors find_widget's rule exactly, and each
# result is cross-checked against the text this walk expects.
label_index = []
anon_seen = 0
for nm, ty, path in nodes:
    if ty != "GtkLabel":
        continue
    if nm == "GtkLabel" or not nm:
        label_index.append((anon_seen, nm, path, None))
        anon_seen += 1
    else:
        label_index.append((None, nm, path, nm))

measurements = []
for idx, nm, path, named in label_index:
    addr = named if named else f"GtkLabel#{idx}"
    font = get(addr, "font")
    text = get(addr, "label")
    css = get(addr, "css")
    measurements.append(
        {
            "addr": addr,
            "widget_name": nm,
            "css_classes": css,
            "text": text if isinstance(text, str) else None,
            "font": font,
            "ancestors": [p for p in path if p][-4:],
        }
    )

payload = {
    "controls": {
        "walker_positive_control": "main-window present",
        "nodes_seen": len(names),
        "labels_seen": len(label_index),
    },
    "labels": measurements,
    "all_widget_names": sorted({n for n in names if n}),
}
with open(out_path, "w") as f:
    json.dump(payload, f, indent=2)

print(f"measured {len(measurements)} labels of {len(names)} nodes -> {out_path}")

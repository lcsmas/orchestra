#!/usr/bin/env python3
"""Per-widget ALLOCATION probe over the remote-control socket.

WHY THIS EXISTS: presence in list_widgets and visible=True are both UPSTREAM of
allocation. A widget can be present, enumerable and flagged visible while having
zero allocation and painting nothing — that is exactly how two repo-header icons
stayed permanently invisible for two commits while reporting healthy on every
other signal (they carried a hover-revealed `ws-icon-btn` class on a container
that has no hover rule, so nothing could ever reveal them).

The only signal that caught it was a WIDGET-SCOPED SCREENSHOT returning 0 bytes
while a SIBLING widget in the same container screenshotted fine. The sibling is
not optional: a zero from an unaudited capture path is indistinguishable from a
real zero, and it fails silently in the PASSING direction.

BOUNDARY, stated so nobody over-reads the output: bytes>0 proves ALLOCATION,
not CORRECTNESS. A widget can allocate and paint the wrong colour, the wrong
glyph, or be clipped. Treat this as a necessary gate that a surface must pass
before pixel comparison decides MATCHES/DIFFERS — never as proof it looks right.

Usage: probe-alloc.py <rc-sock> <widget> [widget...]
"""
import json
import os
import socket
import sys
import tempfile

rc_path = sys.argv[1]
widgets = sys.argv[2:]

rc = socket.socket(socket.AF_UNIX)
rc.settimeout(60)
rc.connect(rc_path)
rcf = rc.makefile("rw")


def rpc(obj):
    rcf.write(json.dumps(obj) + "\n")
    rcf.flush()
    return json.loads(rcf.readline())


def probe(name):
    """Return (bytes, visible, present) for one widget."""
    vis = rpc({"op": "get", "name": name, "prop": "visible"})
    visible = vis.get("value") if vis.get("ok") else None
    present = bool(vis.get("ok"))
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
        path = fh.name
    r = rpc({"op": "screenshot", "path": path, "name": name})
    size = os.path.getsize(path) if os.path.exists(path) else 0
    err = r.get("error")
    os.unlink(path) if os.path.exists(path) else None
    return size, visible, present, err


print(f"{'widget':38s} {'bytes':>8s}  {'visible':>7s}  {'present':>7s}  note")
print("-" * 92)
zero, nonzero = [], []
for name in widgets:
    size, visible, present, err = probe(name)
    note = ""
    if size == 0:
        note = f"ZERO ALLOCATION{' — ' + str(err) if err else ''}"
        zero.append(name)
    else:
        nonzero.append(name)
    print(f"{name:38s} {size:8d}  {str(visible):>7s}  {str(present):>7s}  {note}")

print()
if not nonzero:
    print("!! NO widget returned bytes — the CAPTURE PATH itself is suspect.")
    print("   Every zero here is uninterpretable: an instrument failure and a")
    print("   real zero are indistinguishable without a working positive control.")
    sys.exit(1)
print(f"positive control OK: {len(nonzero)} widget(s) DID screenshot "
      f"({nonzero[0]}), so the capture path works and a zero is meaningful.")
if zero:
    print(f"ZERO-ALLOCATION widgets ({len(zero)}): {', '.join(zero)}")
    print("   -> present and/or visible but painting NOTHING.")
else:
    print("No zero-allocation widgets among those probed.")

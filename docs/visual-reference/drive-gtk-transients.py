#!/usr/bin/env python3
"""Drive the GTK app through every TRANSIENT surface (dialogs, modals, popovers).

Companion to drive-gtk.py, which owns the persistent surfaces. This one opens
each dialog/modal/popover in turn and captures it as its own image.

Two things this driver refuses to do, both learned from prior false verdicts:

  * It never captures a surface it has not PROVEN is on screen. Every open step
    asserts a widget that exists ONLY when that surface is up (the modal's own
    root, not something that was already present). A screenshot of a modal that
    failed to open is a perfectly good PNG of the wrong thing.
  * It never trusts an absence reported by the widget walker without first
    proving the walker can see a known-present control (`main-window`). A
    walker keyed on the wrong reply field returns an empty set, every waitFor
    then burns its budget, and the run reports TIMED OUT — indistinguishable
    from an app hang.

Usage: drive-gtk-transients.py <rc-sock> <outdir>
"""
import hashlib
import json
import os
import socket
import sys
import time

rc_path, out_dir = sys.argv[1], sys.argv[2]
os.makedirs(out_dir, exist_ok=True)

rc = socket.socket(socket.AF_UNIX)
rc.connect(rc_path)
rc.settimeout(30)
rcf = rc.makefile("rw")

results = []   # (surface, verdict, note)
captures = []  # (filename, surface)


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


# ---- POSITIVE CONTROL for the walker itself --------------------------------
# If this fails, every "widget absent" below would be a lie, so stop here.
boot = set()
for _ in range(60):
    boot = names()
    if "main-window" in boot:
        break
    time.sleep(0.25)
if "main-window" not in boot:
    print("FAIL: walker cannot see 'main-window' — the INSTRUMENT is broken, "
          "not necessarily the app. Refusing to report any absence.")
    sys.exit(1)
print(f"-- walker control OK: main-window visible among {len(boot)} named widgets")

for _ in range(40):
    if any(n.startswith("ws-row-") for n in names()):
        break
    time.sleep(0.25)
rows = sorted(n for n in names() if n.startswith("ws-row-"))
print(f"-- {len(rows)} workspace rows rendered")
time.sleep(1.0)


def shot(surface, widget=None):
    path = os.path.join(out_dir, f"gtk-{surface}.png")
    op = {"op": "screenshot", "path": path}
    if widget:
        op["name"] = widget
    r = rpc(op)
    if not r.get("ok"):
        print(f"  ! screenshot {surface}: {r.get('error')}")
        return False
    # A capture at exactly the main-window size is the signature of a silent
    # fallback to the main window. Refuse it for surfaces that are supposed to
    # be their own smaller toplevel, rather than reporting a captured file.
    # Surfaces deliberately captured AT main-window scope (banners composite
    # against the window; the dialog-over-window shot exists to show the
    # surround) are exempt from the fallback guard.
    if widget != "main-window":
        w, h = r.get("width"), r.get("height")
        if (w, h) == (1596, 971):
            print(f"  ! screenshot {surface}: got MAIN-WINDOW size {w}x{h} — "
                  f"the capture fell back instead of targeting {widget!r}. "
                  f"NOT a capture of {surface}.")
            return False
    if not (os.path.exists(path) and os.path.getsize(path) > 0):
        print(f"  ! screenshot {surface}: EMPTY file")
        return False
    captures.append((f"gtk-{surface}.png", surface))
    print(f"  captured gtk-{surface}.png")
    return True


def click(widget):
    r = rpc({"op": "click", "name": widget})
    if not r.get("ok"):
        print(f"  ! click {widget}: {r.get('error')}")
    return bool(r.get("ok"))


def wait_for(widget, timeout=8.0):
    """Wait until `widget` exists. Returns True/False; never raises."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if widget in names():
            return True
        time.sleep(0.2)
    return False


def esc():
    rpc({"op": "key", "name": "Escape"})
    time.sleep(0.5)


def surface(label, trigger, proof, verdict_on_fail="ABSENT"):
    """Open one transient surface and capture it, asserting `proof` appeared.

    `proof` must be a widget that exists ONLY while this surface is open.
    """
    print(f"\n== {label}")
    pre = names()
    if trigger not in pre:
        print(f"  ! trigger {trigger!r} not present")
        results.append((label, verdict_on_fail, f"trigger {trigger} not in widget tree"))
        return False
    if not click(trigger):
        results.append((label, verdict_on_fail, f"click on {trigger} failed"))
        return False
    if not wait_for(proof):
        print(f"  ! {proof!r} never appeared — surface did NOT open")
        results.append((label, verdict_on_fail, f"{proof} never appeared after clicking {trigger}"))
        return False
    print(f"  opened (proof widget {proof!r} present)")
    time.sleep(0.9)  # let the entry animation settle
    # Target the surface BY NAME. An unnamed screenshot resolves via
    # dialogs::topmost(), which only tracks the `dialogs::OPEN` stack — modals
    # built as plain gtk::Windows are NOT on it, so an unnamed capture silently
    # falls back to the MAIN WINDOW and yields a perfectly valid PNG of the
    # wrong surface. That is indistinguishable from success without looking.
    ok = shot(label, proof)
    results.append((label, "CAPTURED" if ok else "CANNOT-VERIFY",
                    "" if ok else "screenshot failed"))
    return ok


# ── 1. Sound settings modal ────────────────────────────────────────────────
if surface("sound-settings", "open-sound", "sound-settings"):
    esc()
else:
    esc()

# ── 2. Linear settings modal (NEVER COMPARED BEFORE) ───────────────────────
if surface("linear-settings", "footer-linear", "linear-settings"):
    shot("linear-settings-title", "linear-title")
    esc()
else:
    esc()

# ── 3. Repo scripts modal (NEVER COMPARED BEFORE) ──────────────────────────
repo_trigger = sorted(n for n in names() if n.startswith("repo-scripts-"))
if repo_trigger:
    if surface("repo-scripts", repo_trigger[0], "repo-scripts-modal"):
        esc()
    else:
        esc()
else:
    print("\n== repo-scripts\n  ! no repo-scripts-* trigger button in the tree")
    results.append(("repo-scripts", "CANNOT-VERIFY", "no repo-scripts-* trigger widget"))

# ── 4. Branch picker popover ───────────────────────────────────────────────
n = names()
branch_trigger = next((x for x in ("branch-picker-btn", "branch-chip-base",
                                   "branch-chip-orchestrator", "branch-chip-scratch")
                       if x in n), None)
if branch_trigger:
    surface("branch-popover", branch_trigger, "branch-panel")
    esc()
else:
    print("\n== branch-popover\n  ! no branch trigger found")
    results.append(("branch-popover", "CANNOT-VERIFY",
                    "no branch-chip/toolbar-branch/branch-picker widget"))

# ── 4b. Accounts settings modal ────────────────────────────────────────────
if surface("accounts-settings", "accounts-open", "accounts-settings"):
    # The login modal is reached FROM accounts settings (its Login button).
    if "accounts-login" in names() and click("accounts-login"):
        if wait_for("account-login-modal"):
            time.sleep(1.2)
            ok = shot("account-login-modal", "account-login-modal")
            results.append(("account-login-modal",
                            "CAPTURED" if ok else "CANNOT-VERIFY", ""))
            esc()
        else:
            results.append(("account-login-modal", "ABSENT",
                            "account-login-modal never appeared"))
    else:
        results.append(("account-login-modal", "CANNOT-VERIFY",
                        "accounts-login button absent"))
    esc()
else:
    esc()

# ── 4c. New-workspace base-branch popover ──────────────────────────────────
n = names()
if "base-picker" in n:
    surface("base-branch-popover", "base-picker", "branch-panel")
    esc()
else:
    print("\n== base-branch-popover\n  ! base-picker not in tree (needs the new-workspace form open)")
    results.append(("base-branch-popover", "CANNOT-VERIFY",
                    "base-picker only exists while the new-workspace form is open"))

# ── 4d. Banners (in-window, not toplevels) ─────────────────────────────────
# Both banners are DATA-DRIVEN, so they only reveal on the workspace that
# carries the data (mock.rs): ws-2 has queuedPrompts, ws-4 setupStatus=failed,
# ws-5 setupStatus=running. Selecting an arbitrary row and reporting "not
# revealed" would be a property of the DRIVE, not of the app.
for label, widget, row in (("setup-banner-failed", "setup-banner", "ws-row-ws-4"),
                           ("setup-banner-running", "setup-banner", "ws-row-ws-5"),
                           ("queue-banner", "queue-banner", "ws-row-ws-2")):
    print(f"\n== {label} (via {row})")
    if row not in names():
        results.append((label, "CANNOT-VERIFY", f"{row} not among rendered rows"))
        continue
    click(row)
    time.sleep(1.4)
    if widget not in names():
        results.append((label, "CANNOT-VERIFY", f"{widget} not in widget tree"))
        continue
    r = rpc({"op": "get", "name": widget, "prop": "visible"})
    vis = r.get("value")
    print(f"  {widget} visible={vis}")
    if vis:
        # Capture the PARENT, not the banner. A widget-scoped snapshot of a
        # translucent surface renders it with NOTHING composited behind it, so
        # a correct rgba(...,0.12) tint reads as fully saturated colour. That
        # is an artifact of the probe, not a defect — verified by measuring the
        # ALPHA channel (31/255 = 0.12, i.e. exactly right) and by an isolated
        # 4-way A/B of every rgba/alpha() spelling, which all rendered a=31.
        # Snapshotting the parent puts the real backdrop behind the tint.
        ok = shot(label, "main-window")
        results.append((label, "CAPTURED" if ok else "CANNOT-VERIFY",
                        "captured via main-window so the tint composites"))
    else:
        results.append((label, "ABSENT",
                        f"{widget} still not revealed on {row}, which DOES carry "
                        f"the data in mock.rs"))

# ── 5. Confirm dialog + destructive dialog, via the real user path ─────────
print("\n== dialogs (via archived → select-all → delete)")
if "archived-toggle" in names() and click("archived-toggle"):
    if wait_for("archived-bar"):
        print("  archived expanded")
        if "archived-select-all" in names() and click("archived-select-all"):
            time.sleep(0.5)
            if "archived-bar-delete" in names() and click("archived-bar-delete"):
                if wait_for("orch-dialog"):
                    time.sleep(0.9)
                    ok = shot("dialog-destructive")
                    results.append(("dialog-destructive",
                                    "CAPTURED" if ok else "CANNOT-VERIFY", ""))
                    # Full-window shot WITH the dialog up: this is the only way
                    # to see what the surround looks like, i.e. the backdrop.
                    ok2 = shot("dialog-over-window", "main-window")
                    results.append(("backdrop-surround",
                                    "CAPTURED" if ok2 else "CANNOT-VERIFY", ""))
                    esc()
                else:
                    results.append(("dialog-destructive", "CANNOT-VERIFY",
                                    "orch-dialog never appeared"))
            else:
                results.append(("dialog-destructive", "CANNOT-VERIFY",
                                "archived-bar-delete absent"))
        else:
            results.append(("dialog-destructive", "CANNOT-VERIFY",
                            "archived-select-all absent"))
    else:
        results.append(("dialog-destructive", "CANNOT-VERIFY",
                        "archived section never expanded"))
else:
    results.append(("dialog-destructive", "CANNOT-VERIFY", "archived-toggle absent"))

# ── Duplicate guard: a no-op drive still writes a valid PNG ────────────────
print("\n-- hashing captures")
digests = {}
for fn, _ in captures:
    p = os.path.join(out_dir, fn)
    with open(p, "rb") as fh:
        d = hashlib.md5(fh.read()).hexdigest()
    digests.setdefault(d, []).append(fn)
    print(f"  {d}  {fn}")

dupes = [v for v in digests.values() if len(v) > 1]
for group in dupes:
    print(f"  ! IDENTICAL captures (a drive step no-opped): {', '.join(group)}")

with open(os.path.join(out_dir, "transients-manifest.json"), "w") as fh:
    json.dump({"results": results,
               "hashes": {fn: d for d, fns in digests.items() for fn in fns},
               "duplicates": dupes}, fh, indent=2)

print("\n-- per-surface results")
for label, verdict, note in results:
    print(f"  {verdict:14} {label} {note}")

sys.exit(1 if dupes else 0)

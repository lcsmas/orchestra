#!/usr/bin/env python3
"""GTK counterpart sweep: which CSS classes exist, and what do the rules say.

GTK has no computed-style oracle over the harness, so the comparison is:
  - RUNTIME: does a widget carrying the class exist and render (bytes)?
  - SOURCE:  what does the operative theme.css rule set?

CRITICAL — CITED RULE != OPERATIVE RULE. A class can be matched by several rules
and the last/most-specific wins, so this prints EVERY rule block matching each
selector rather than the first. A verdict drawn from an outranked rule is a
regression disguised as a fix.

Also reports, for each class, whether ANY widget in the live tree carries it —
a rule that renders fine but is never APPLIED is invisible to a pixel probe and
must be reported with BOTH readings (stale rule vs missing widget).
"""
import json, re, socket, sys, time

THEME = "/home/lmas/.orchestra/worktrees/orchestra-lunar-valley-aa2170d8/native/orchestra-gtk/src/theme.css"
css = open(THEME).read()

CLASSES = [
    "sidebar", "sidebar-header", "sidebar-title", "ws-list",
    "repo-section", "repo-header", "repo-name", "repo-count", "repo-add",
    "orchestrator-section", "scratch-section",
    "repo-sync", "host-group-header", "host-dot",
    "ws-row", "ws-item", "ws-dot", "ws-tree-connector", "ws-collapse",
    "ws-name", "ws-hidden-count", "ws-icon-btn", "ws-context", "ws-size",
    "ws-login-badge", "account-badge",
    "ws-pills", "repo-tag-pill", "orchestrator-pill", "merged-pill",
    "released-pill", "unpushed-pill", "diff-indicator", "setup-pill",
    "pr-badge", "archived-toggle", "archived-bar", "archived-row",
    "env-notice", "env-notice-body", "env-notice-link",
    "sidebar-footer", "sidebar-footer-link", "footer-link", "sidebar-footer-version",
    "usage-bars", "usage-bar-label", "usage-bar-track", "usage-bar-fill",
    "insights-row", "insights-step", "ws-empty-hint",
]

# Live tree: which classes are actually carried by a widget?
rc = socket.socket(socket.AF_UNIX); rc.connect(sys.argv[1])
f = rc.makefile("rw")


def rpc(o):
    f.write(json.dumps(o) + "\n"); f.flush()
    return json.loads(f.readline())


def walk(nodes, out):
    for n in nodes:
        if n.get("name"):
            out.append(n["name"])
        walk(n.get("children", []), out)
    return out


names = []
for _ in range(40):
    names = walk(rpc({"op": "list_widgets"}).get("widgets", []), [])
    if any(x.startswith("ws-row-") for x in names):
        break
    time.sleep(0.25)
assert "main-window" in names, "WALKER BROKEN"

# Sample the css classes actually applied, via the `css` prop on named widgets.
applied = set()
for n in set(names):
    r = rpc({"op": "get", "name": n, "prop": "css"})
    if r.get("ok"):
        applied.update(r.get("value", []))
# CONTROL: a class we know is applied, and one we know is not.
assert "ws-row" in applied, "CLASS PROBE BROKEN — ws-row not seen"
assert "zzznonsense" not in applied
print(f"class-probe controls OK ({len(applied)} distinct classes on named widgets)\n")

print(f"{'class':26} {'rules':5} {'applied?':9} operative declarations")
for cls in CLASSES:
    blocks = re.findall(r"([^\n{}]*\." + re.escape(cls) + r"[^\n{}]*)\{([^}]*)\}", css)
    tag = "YES" if cls in applied else "no"
    if not blocks:
        print(f"{cls:26} {0:5} {tag:9} — NO RULE IN theme.css")
        continue
    # operative = last matching block (later wins at equal specificity)
    sel, body = blocks[-1]
    decls = " ".join(x.strip() for x in body.strip().split("\n") if x.strip())
    print(f"{cls:26} {len(blocks):5} {tag:9} [{sel.strip()}] {decls[:90]}")
    if len(blocks) > 1:
        for s, b in blocks[:-1]:
            d = " ".join(x.strip() for x in b.strip().split("\n") if x.strip())
            print(f"{'':26} {'':5} {'':9}   OUTRANKED: [{s.strip()}] {d[:70]}")

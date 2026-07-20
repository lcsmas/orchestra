"""Driver lib for the orchestra-gtk remote-control harness.

Every absence this reports is only meaningful if the walker can SEE things, so
`names()` callers must first assert the known-always-present control
(main-window). See lesson: give the tree-walker its own positive control.
"""
import json, os, socket, sys, hashlib

SOCK = open('/tmp/claude-1000/-home-lmas--orchestra-worktrees-orchestra-noble-horizon-fe944aa2/f6402dd4-6588-472d-ab3e-dc39bec834ab/scratchpad/shortdir').read().strip() + '/rc.sock'


class RC:
    def __init__(self, path=SOCK):
        self.s = socket.socket(socket.AF_UNIX)
        self.s.connect(path)
        self.f = self.s.makefile('rw')

    def rpc(self, obj):
        self.f.write(json.dumps(obj) + "\n")
        self.f.flush()
        return json.loads(self.f.readline())

    def tree(self):
        return self.rpc({"op": "list_widgets"}).get("widgets", [])

    def names(self):
        out = set()
        def walk(ns):
            for n in ns:
                if n.get("name"):
                    out.add(n["name"])
                walk(n.get("children", []))
        walk(self.tree())
        return out

    def assert_walker_sees(self, control="main-window"):
        """POSITIVE CONTROL: an instrument bug must fail AS an instrument bug."""
        ns = self.names()
        if control not in ns:
            raise SystemExit(
                f"WALKER BROKEN: control {control!r} not visible ({len(ns)} names). "
                "Every absence from this run is UNINTERPRETABLE."
            )
        return ns

    def click(self, name):
        return self.rpc({"op": "click", "name": name})

    def key(self, name):
        return self.rpc({"op": "key", "name": name})

    def type(self, text, name=None):
        o = {"op": "type", "text": text}
        if name: o["name"] = name
        return self.rpc(o)

    def action(self, action, param=None, name=None):
        o = {"op": "action", "action": action}
        if param is not None: o["param"] = param
        if name: o["name"] = name
        return self.rpc(o)

    def get(self, name, prop):
        return self.rpc({"op": "get", "name": name, "prop": prop})

    def shot(self, path, name=None):
        o = {"op": "screenshot", "path": path}
        if name: o["name"] = name
        r = self.rpc(o)
        r["bytes"] = os.path.getsize(path) if os.path.exists(path) else 0
        if r["bytes"]:
            r["md5"] = hashlib.md5(open(path, 'rb').read()).hexdigest()
        return r

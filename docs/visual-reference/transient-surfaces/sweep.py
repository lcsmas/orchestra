"""Sweep the remaining GTK transient surfaces.

For each: assert the op RESULT, assert the surface is present AT capture time,
capture widget-scoped + an output grab (the correct in-situ instrument for
separate toplevels), and hash everything so a silent no-op fails loudly.
"""
import hashlib
import os
import subprocess
import time
from collections import Counter

from rc import RC

CAPS = os.path.abspath('caps')
SP = os.path.dirname(os.path.abspath(__file__))
ENV = dict(os.environ, SWAYSOCK=f"{SP}/rig/sway.sock",
           WAYLAND_DISPLAY=open(f"{SP}/rig/wd").read().strip())
hashes = {}


def grim(tag):
    p = f"{CAPS}/out-{tag}.png"
    r = subprocess.run(['grim', p], env=ENV, capture_output=True)
    if r.returncode != 0 or not os.path.exists(p):
        print(f"    grim FAILED rc={r.returncode} {r.stderr[:120]}")
        return None
    h = hashlib.md5(open(p, 'rb').read()).hexdigest()
    hashes[f"out:{tag}"] = h
    print(f"    output grab bytes={os.path.getsize(p):7d} md5={h[:10]}")
    return h


def surface(r, tag, trigger, expect, closer=None, settle=1.4):
    print(f"\n== {tag} ==")
    if trigger:
        res = r.click(trigger)
        print(f"  click({trigger}) -> {res}")
        if not res.get('ok'):
            print("  ABORT — trigger failed; no verdict")
            return False
    time.sleep(settle)
    ns = r.names()
    ok = expect in ns
    print(f"  {expect!r} present at capture time: {ok}")
    if not ok:
        return False
    s = r.shot(f"{CAPS}/gtk-{tag}.png", expect)
    print(f"    widget bytes={s['bytes']:7d} md5={s.get('md5','')[:10]}")
    if s.get('md5'):
        hashes[f"w:{tag}"] = s['md5']
    grim(tag)
    if closer:
        c = r.click(closer) if closer in r.names() else r.key('Escape')
        print(f"  close -> {c}")
        time.sleep(0.8)
    return True


def main():
    r = RC()
    r.assert_walker_sees()
    print("walker control PASSED")

    results = {}
    # --- branch picker popover (toolbar) ---
    results['branch-popover'] = surface(
        r, 'branch-popover', 'branch-picker-btn', 'branch-panel', closer=None)
    r.key('Escape'); time.sleep(0.6)

    # --- sound settings ---
    results['sound'] = surface(r, 'sound', 'open-sound', 'sound-modal', closer=None)
    if not results['sound']:
        ns = r.names()
        cand = sorted(n for n in ns if 'sound' in n.lower())
        print("  sound-ish widgets now:", cand[:15])
        for c in cand:
            if c != 'open-sound':
                s = r.shot(f"{CAPS}/gtk-sound.png", c)
                print(f"    fallback root {c}: bytes={s['bytes']}")
                if s['bytes']:
                    hashes['w:sound'] = s['md5']; grim('sound'); results['sound'] = True
                break
    r.key('Escape'); time.sleep(0.8)

    # --- accounts settings ---
    results['accounts'] = surface(r, 'accounts', 'accounts-open', 'accounts-modal', closer=None)
    if not results['accounts']:
        ns = r.names()
        cand = sorted(n for n in ns if 'account' in n.lower() and 'ws-' not in n)
        print("  account-ish widgets now:", cand[:15])
    r.key('Escape'); time.sleep(0.8)

    print("\n== duplicate guard ==")
    c = Counter(hashes.values())
    d = {h: [k for k, v in hashes.items() if v == h] for h, n in c.items() if n > 1}
    print("  DUPES:", d if d else f"none ({len(hashes)} captures)")
    print("\nRESULTS:", results)


main()

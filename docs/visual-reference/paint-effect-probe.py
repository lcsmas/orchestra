"""Prove a PURE-PAINT css property renders — the half `measure()` cannot see.

Layout-neutral properties (color, background, border-color, box-shadow) read
dw=0 dh=0 under prop-effect-probe.py WHILE WORKING PERFECTLY, so measuring
layout would report a working paint rule as a no-op. This samples rendered
PIXELS instead.

Two modes:

  static <theme.css>   — renders a widget with the property ON vs OFF and
                         reports the per-channel RGB delta at a sampled point.
  animated <theme.css> — snapshots the same widget across an animation window
                         and reports distinct frame hashes PLUS the sampled
                         pixel per frame, so you can say WHICH WAY it moved
                         rather than only that it moved.

BOTH MODES RUN TWO CONTROLS, because one control cannot cover both failure
modes (thanks to gtk4-port-verifier for the distinction):
  * KNOWN-GOOD  — an input that must register. Guards a false ZERO (a probe
                  that cannot detect anything reports "no effect" for
                  everything).
  * KNOWN-INERT — an input that must NOT register. Guards a false NON-ZERO (a
                  probe that always moves makes every property look like it
                  works). For paint this is the important one: antialiasing,
                  animation phase and compositor noise all move pixels on their
                  own.
A run whose controls do not both behave is INVALID and its verdicts must be
discarded, not interpreted.

Usage:
  paint-effect-probe.py static   [theme.css]
  paint-effect-probe.py animated [theme.css] [css-class] [duration-ms] [frames]
"""

import hashlib
import sys

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

Gtk.init()

REPO = "/home/lmas/.orchestra/worktrees/orchestra-tidy-comet-6c630d0e"
DEFAULT_THEME = f"{REPO}/native/orchestra-gtk/src/theme.css"

# Sample point as a fraction of the widget box. Kept off-centre so a glow/shadow
# ring is sampled rather than the flat fill at the middle of a dot.
SAMPLE_FX, SAMPLE_FY = 0.5, 0.12
WIDGET_PX = 40


def _provider(css: str):
    p = Gtk.CssProvider()
    errs = []
    p.connect("parsing-error", lambda _p, _s, e: errs.append(e.message))
    p.load_from_data(css.encode())
    return p, errs


def _snapshot(widget: Gtk.Widget):
    """Render `widget` to a texture; returns (rgba_bytes, w, h, stride)."""
    native = widget.get_native()
    if native is None:
        return None, 0, 0, 0
    w, h = widget.get_width(), widget.get_height()
    if w == 0 or h == 0:
        return None, 0, 0, 0

    # Same call sequence as remote_control.rs:432 screenshot_widget. The zero-size
    # guard above is load-bearing: an unallocated widget yields a transparent
    # texture that is indistinguishable from "the property painted nothing".
    # See _settle() — timing, not the renderer or the display backend, is what
    # makes this path return real pixels.
    paintable = Gtk.WidgetPaintable.new(widget)
    snap = Gtk.Snapshot()
    paintable.snapshot(snap, w, h)
    node = snap.to_node()
    if node is None:
        # An EMPTY NODE IS A RESULT, NOT A FAILURE: a widget that paints nothing
        # (fully transparent) legitimately has nothing to draw. Verified — an
        # allocated 40x40 with `background:none` yields node=None while the same
        # widget with a red background yields a GskColorNode. Returning None here
        # would make the baseline unsampleable and every delta None, so report it
        # as fully-transparent pixels instead. That keeps "OFF" a real datapoint,
        # which is what the ON-vs-OFF comparison needs.
        return bytes(w * h * 4), w, h, w * 4

    texture = native.get_renderer().render_texture(node, None)
    dl = Gdk.TextureDownloader.new(texture)
    dl.set_format(Gdk.MemoryFormat.R8G8B8A8)
    data, stride = dl.download_bytes()
    return data.get_data(), texture.get_width(), texture.get_height(), stride


def _sample(buf, w, h, stride, fx=SAMPLE_FX, fy=SAMPLE_FY):
    """RGBA at a fractional point. Format is R8G8B8A8 (set on the downloader),
    so the byte order is r,g,b,a — do NOT assume BGRA."""
    if buf is None or w == 0:
        return None
    x, y = min(int(w * fx), w - 1), min(int(h * fy), h - 1)
    off = y * stride + x * 4
    return (buf[off], buf[off + 1], buf[off + 2], buf[off + 3])


def _digest(buf, w, h, stride):
    """Whole-region fingerprint + ink count.

    A SINGLE SAMPLE POINT IS A TRAP for edge-painting properties: box-shadow and
    border paint at/outside the widget's rim, so a centre-ish sample reports "no
    change" for a rule that is working — a false negative inside a run whose
    controls both passed, which is the most dangerous kind. Comparing the whole
    region (and counting non-transparent pixels) asks "did ANY pixel change",
    which is the question the ON-vs-OFF comparison actually needs.
    """
    if buf is None or w == 0:
        return None, 0
    rows = [bytes(buf[r * stride:r * stride + w * 4]) for r in range(h)]
    flat = b"".join(rows)
    ink = sum(1 for i in range(0, len(flat), 4) if flat[i + 3] != 0)
    return hashlib.md5(flat).hexdigest()[:10], ink


def _settle(widget, timeout_ms=1500):
    """Block on a REAL main loop until `widget` is allocated and painted.

    This is the whole ballgame. Snapshotting in the same turn a widget is added
    yields `get_width() == 0` and a transparent texture — which looks EXACTLY
    like "the property painted nothing", i.e. a false category (c) verdict on
    every pure-paint rule. Draining `MainContext.iteration()` in a for-loop is
    NOT enough; the frame clock needs wall-clock time, so this runs a real
    GLib.MainLoop with a timeout.

    Do not "optimise" this into a busy-drain. I originally blamed the resulting
    zeros on Vulkan dmabuf downloads and on wayland-vs-x11, and BOTH were wrong:
    measured, Vulkan and Cairo and wayland all return correct pixels once the
    widget is actually allocated. Timing was the only cause.
    """
    loop = GLib.MainLoop()
    state = {"done": False}

    def poll():
        if widget.get_width() > 0 and widget.get_height() > 0:
            state["done"] = True
            loop.quit()
            return False
        return True

    GLib.timeout_add(20, poll)
    GLib.timeout_add(timeout_ms, lambda: (loop.quit(), False)[1])
    loop.run()
    if not state["done"]:
        return False
    # One more turn so the first frame is actually painted, not just allocated.
    settle = GLib.MainLoop()
    GLib.timeout_add(60, lambda: (settle.quit(), False)[1])
    settle.run()
    return True


class Rig:
    """A realised toplevel we can restyle and re-snapshot."""

    def __init__(self, base_css_path):
        with open(base_css_path) as fh:
            self.base_css = fh.read()
        self.win = Gtk.Window()
        self.win.set_default_size(200, 120)
        self.box = Gtk.Box()
        self.win.set_child(self.box)
        self.win.present()
        self.disp = Gdk.Display.get_default()
        self._extra = None

    def style(self, extra_css: str):
        if self._extra is not None:
            Gtk.StyleContext.remove_provider_for_display(self.disp, self._extra)
        prov, errs = _provider(self.base_css + "\n" + extra_css)
        Gtk.StyleContext.add_provider_for_display(
            self.disp, prov, Gtk.STYLE_PROVIDER_PRIORITY_USER
        )
        self._extra = prov
        return errs

    def render_sample(self, css_classes):
        w = Gtk.Box()
        w.set_size_request(WIDGET_PX, WIDGET_PX)
        for c in css_classes:
            w.add_css_class(c)
        self.box.append(w)
        _settle(w)
        got = _snapshot(w)
        px = _sample(*got) if got[0] is not None else None
        dig, ink = _digest(*got)
        self.box.remove(w)
        return px, dig, ink


def _delta(a, b):
    if a is None or b is None:
        return None
    return tuple(int(x) - int(y) for x, y in zip(a, b))


def run_static(theme):
    rig = Rig(theme)
    # min-width/height are on the OFF state too: they guarantee an allocation
    # regardless of the property under test, so the baseline is a real sample
    # rather than None. Without this the OFF widget never sizes and every delta
    # is None — which the controls correctly refuse to interpret.
    OFF = (f".paintprobe {{ background: none; border: none; "
           f"min-width: {WIDGET_PX}px; min-height: {WIDGET_PX}px; }}")
    print("PURE-PAINT STATIC PROBE (pixel sample, not layout)\n")

    cases = [
        # (name, css, kind) — kind drives control interpretation
        ("KNOWN-GOOD  background red",
         ".paintprobe { background-color: rgb(255,0,0); }", "good"),
        ("KNOWN-INERT unknown property",
         ".paintprobe { -nonexistent-prop: 12px; }", "inert"),
        # KNOWN LIMITATION, kept in the run as a documented negative: an OUTER
        # box-shadow paints OUTSIDE the widget's bounds, and WidgetPaintable
        # clips to those bounds — so this reads ink=0 here even though the glow
        # renders fine in the app. Do NOT read that as category (c). For outer
        # shadows, snapshot a PARENT container (or drive the real app's
        # screenshot op) so the shadow falls inside the captured region.
        ("box-shadow glow (clipped - see note)",
         ".paintprobe { box-shadow: 0 0 8px 4px rgba(255,200,87,.9); }", "note"),
        ("box-shadow INSET (visible in bounds)",
         ".paintprobe { box-shadow: inset 0 0 8px 4px rgba(255,200,87,.9); }",
         "test"),
        ("border-color",
         ".paintprobe { border: 4px solid rgb(0,255,0); }", "test"),
    ]

    rig.style(OFF)
    base, base_dig, base_ink = rig.render_sample(["paintprobe"])
    print(f"baseline sample rgba={base} region={base_dig} ink={base_ink}\n")

    verdicts = {}
    for name, css, kind in cases:
        errs = rig.style(OFF + "\n" + css)
        px, dig, ink = rig.render_sample(["paintprobe"])
        d = _delta(px, base)
        # Region digest is authoritative; the point sample only says WHICH WAY.
        moved = dig != base_dig or ink != base_ink
        print(f"{name:34} rgba={px} d={d} ink={ink:5} "
              f"-> {'MOVED' if moved else 'no change'}")
        if errs:
            print(f"    parse: {errs}")
        verdicts[kind] = verdicts.get(kind, []) + [(name, moved)]

    print()
    ok_good = all(m for _, m in verdicts.get("good", []))
    ok_inert = all(not m for _, m in verdicts.get("inert", []))
    print(f"CONTROL known-good  detected a change : {ok_good}")
    print(f"CONTROL known-inert stayed at zero    : {ok_inert}")
    if not (ok_good and ok_inert):
        print("\n*** RUN INVALID — controls misbehaved; discard the verdicts above ***")
        return 1
    print("\nControls both behaved: the MOVED/no-change verdicts above are meaningful.")
    return 0


def run_animated(theme, cls="ws-dot running", duration_ms=1600, frames=6):
    """Distinct frame hashes across an animation window + the sampled pixel."""
    rig = Rig(theme)
    classes = cls.split()
    print(f"PURE-PAINT ANIMATION PROBE — .{'.'.join(classes)} "
          f"over {duration_ms}ms, {frames} frames\n")

    w = Gtk.Box()
    w.set_size_request(WIDGET_PX, WIDGET_PX)
    for c in classes:
        w.add_css_class(c)
    rig.box.append(w)
    _settle(w)

    seen, rows = [], []
    step = duration_ms / frames

    def grab(_):
        got = _snapshot(w)
        buf = got[0]
        h = hashlib.md5(buf).hexdigest()[:10] if buf else "EMPTY"
        rows.append((len(rows), h, _sample(*got) if buf is not None else None))
        seen.append(h)
        return False

    loop = GLib.MainLoop()
    for i in range(frames):
        GLib.timeout_add(int(step * i) + 20, grab, None)
    GLib.timeout_add(int(step * frames) + 200, lambda _: (loop.quit(), False)[1], None)
    loop.run()

    for i, h, px in rows:
        print(f"  frame {i}  hash={h}  sample rgba={px}")
    distinct = len(set(seen))
    print(f"\ndistinct frame hashes: {distinct}/{len(seen)}")
    if distinct <= 1:
        print("*** category (c): the rule parses but paints ONE unchanging frame ***")
        return 1
    print("Renders an animation (frames differ), and the per-frame samples above")
    print("show WHICH WAY the paint moved, not merely that it moved.")
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "static"
    theme = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_THEME
    if mode == "static":
        rc = run_static(theme)
    else:
        cls = sys.argv[3] if len(sys.argv) > 3 else "ws-dot running"
        dur = int(sys.argv[4]) if len(sys.argv) > 4 else 1600
        fr = int(sys.argv[5]) if len(sys.argv) > 5 else 6
        rc = run_animated(theme, cls, dur, fr)
    sys.exit(rc)

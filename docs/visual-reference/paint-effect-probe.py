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

!! READ THIS BEFORE USING THIS PROBE TO DECLARE A RULE DEAD !!

An OUTER `box-shadow` paints OUTSIDE the widget's bounds and WidgetPaintable
CLIPS to those bounds, so a widget-scoped run reports it as no-change EVEN WHEN
IT WORKS. Point this at theme.css unguarded and it will call every outer glow
dead — including the working `.ws-dot.running/.waiting/.error` ones.

THIS CAVEAT USED TO LIVE ONLY HERE, AND THAT WAS THE BUG. The static path
honoured it; the animated path never did, and reported the working
`.ws-dot.running` pulse as "1/6 distinct frames — category (c)" with every
sample rgba=(0,0,0,0). The file LOOKED audited, which is worse than an
unwarned file: a reader sees the caveat and assumes it applies throughout.

So the correction now lives IN CODE, in the one shared capture path:
  * `pad_for()`   — wraps the probed widget in a SIZED parent (a margin is not
                    enough; a Gtk.Box shrink-wraps, so a margined parent around
                    an 8px dot is still 8px wide and clips the ring anyway).
  * `_capture()`  — the ONLY caller of `_snapshot`. Both modes route through it,
                    so a third mode added later cannot silently skip the fix.
  * `assert_captured()` — HARD-FAILS the run if every frame is fully
                    transparent. Not a warning: an all-transparent capture has
                    no verdict to report, and a number printed beside a warning
                    still gets acted on.

Run `paint-effect-probe.py selftest` to watch the guard fire and pass.

And for a DEAD-RULE SWEEP specifically: give every rule you believe dead its own
POSITIVE CONTROL in the same run. A probe that cannot detect anything reports
EVERY rule as dead — and for this task the expected finding and the instrument
failure produce identical output, which is the one case where a control is not
optional. Re-derive rather than inherit: a rule someone else proved dead should
fail your control-backed run too, and if it doesn't, say so.

Usage:
  paint-effect-probe.py static   [theme.css]
  paint-effect-probe.py animated [theme.css] [css-class] [duration-ms] [frames]
  paint-effect-probe.py selftest [theme.css]   # prove the empty-capture guard
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

# Slack around the probed widget so an OUTER glow/shadow/pulse ring falls inside
# the captured region instead of being clipped away. The pulse in
# `@keyframes ws-dot-pulse` reaches 6px of spread plus a 10px blur, so 10px would
# already clip the tail; 26 leaves headroom for the widest rule in theme.css.
PAD_PX = 26


def _provider(css: str):
    p = Gtk.CssProvider()
    errs = []
    p.connect("parsing-error", lambda _p, _s, e: errs.append(e.message))
    p.load_from_data(css.encode())
    return p, errs


class EmptyCapture(Exception):
    """Every sampled frame was fully transparent — the probe captured NOTHING.

    Raised, not warned. A run that captured nothing has NO VERDICT to report:
    the frame count is an artifact of the rig, not a measurement of the rule.
    A warning printed beside "1/6 distinct frames" still leaves the number on
    the page, and a number on the page gets acted on line by line while nobody
    re-checks which lines came from a degraded run. So this aborts the run and
    prints no verdict at all.
    """


def _capture(widget: Gtk.Widget):
    """THE ONE SNAPSHOT PATH. Every mode must call this — see `pad_for`.

    Deliberately the only function in this file that calls `_snapshot`. The
    original bug was that the parent-scoping correction lived in a DOCSTRING
    that only the static path honoured, so the animated path snapshotted the
    bare widget and clipped the entire pulse ring away — reporting a live
    animation as "1/6 distinct frames, category (c)" with every sample
    rgba=(0,0,0,0). A correction attachable to one code path is a correction
    the next code path will not inherit. Putting the scoping in the shared
    helper is what makes that structurally impossible.
    """
    return _snapshot(widget)


def pad_for(widget: Gtk.Widget, pad_px: int = PAD_PX) -> Gtk.Widget:
    """Wrap `widget` in a SIZED container and return the thing to snapshot.

    WidgetPaintable clips to the snapshotted widget's bounds, so an outer
    box-shadow / glow / pulse ring paints entirely outside a widget-scoped
    capture and reads as "no change" WHILE WORKING PERFECTLY.

    A margin alone does NOT fix this, which is the part that cost real time:
    a Gtk.Box shrink-wraps its child, so a margined parent around an 8px dot is
    still 8px wide and the ring still has nowhere to land (measured: ink stays
    0 and every frame hashes identically). The parent must be explicitly SIZED
    LARGER than the child, with the child centred inside it. Measured on
    .ws-dot.running: bare widget -> 1/6 identical all-transparent frames;
    sized parent -> 8/8 distinct, ink 308..468.
    """
    pad = Gtk.Box()
    pad.set_size_request(widget_natural(widget) + pad_px * 2,
                         widget_natural(widget) + pad_px * 2)
    pad.set_hexpand(False)
    pad.set_vexpand(False)
    widget.set_halign(Gtk.Align.CENTER)
    widget.set_valign(Gtk.Align.CENTER)
    pad.append(widget)
    return pad


def widget_natural(widget: Gtk.Widget) -> int:
    """Natural size of `widget`, used to size the pad around it."""
    _min_w, nat_w, _b1, _b2 = widget.measure(Gtk.Orientation.HORIZONTAL, -1)
    _min_h, nat_h, _b3, _b4 = widget.measure(Gtk.Orientation.VERTICAL, -1)
    return max(nat_w, nat_h, WIDGET_PX)


def assert_captured(frames, label):
    """HARD-FAIL if every frame is fully transparent. Raises EmptyCapture.

    `frames` is a list of (buf, w, h, stride). The check is on the WHOLE
    REGION ink count, never the point sample: the pulse ring is sparse enough
    that a single sample point is legitimately (0,0,0,0) on most frames of a
    perfectly healthy capture (measured — see pad_for). Keying the guard on
    the point sample would hard-fail working runs.
    """
    total_ink = 0
    for buf, w, h, stride in frames:
        if buf is None or w == 0:
            continue
        for r in range(h):
            row = buf[r * stride:r * stride + w * 4]
            total_ink += sum(1 for i in range(0, len(row), 4) if row[i + 3] != 0)
    if total_ink == 0:
        raise EmptyCapture(
            f"{label}: all {len(frames)} sampled frames were fully transparent "
            f"(total ink=0 across the whole captured region). The probe captured "
            f"NOTHING, so the frame count is not a verdict — not a low-confidence "
            f"verdict, NOT A VERDICT. Most likely the capture is clipping an "
            f"outer-painting effect: snapshot a SIZED parent via pad_for()."
        )
    return total_ink


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

    def render_sample(self, css_classes, size_request=True):
        w = Gtk.Box()
        if size_request:
            w.set_size_request(WIDGET_PX, WIDGET_PX)
        for c in css_classes:
            w.add_css_class(c)
        # Both modes capture through pad_for + _capture. Snapshotting `w` here
        # instead would silently clip outer-painting rules — the exact bug this
        # file shipped in its animated path.
        pad = pad_for(w)
        self.box.append(pad)
        _settle(pad)
        got = _capture(pad)
        px = _sample(*got) if got[0] is not None else None
        dig, ink = _digest(*got)
        self.box.remove(pad)
        return px, dig, ink, got


def _delta(a, b):
    if a is None or b is None:
        return None
    return tuple(int(x) - int(y) for x, y in zip(a, b))


def run_static(theme):
    rig = Rig(theme)
    # THE OFF BASELINE MUST ITSELF PAINT (gtk4-port-verifier's invariant, and it
    # closes a hole I shipped one iteration earlier). With a TRANSPARENT baseline
    # the snapshot is node=None, and node=None is produced BOTH by "this property
    # legitimately paints nothing" AND by "this property silently did nothing" —
    # so None-vs-None reads as "no change" for a working-but-invisible rule just
    # as it does for a dead one. A grey baseline makes the OFF state a KNOWN
    # PAINTING state, so any real change shows up as a region-digest difference
    # against something rather than against nothing.
    #
    # This is the known-inert control's logic applied to the baseline: the
    # reference point has to be calibrated too, not just the deltas measured
    # from it. min-width/height additionally guarantee allocation (see _settle).
    OFF = (f".paintprobe {{ background-color: rgb(128,128,128); border: none; "
           f"min-width: {WIDGET_PX}px; min-height: {WIDGET_PX}px; }}")
    print("PURE-PAINT STATIC PROBE (pixel sample, not layout)\n")

    cases = [
        # (name, css, kind) — kind drives control interpretation
        ("KNOWN-GOOD  background red",
         ".paintprobe { background-color: rgb(255,0,0); }", "good"),
        ("KNOWN-INERT unknown property",
         ".paintprobe { -nonexistent-prop: 12px; }", "inert"),
        # WAS a documented negative ("clipped, reads ink=0, do not read as
        # category (c)"). It is no longer clipped: routing this path through
        # pad_for() gives the glow somewhere to land, and it now registers
        # MOVED with ink well above the baseline. Kept as a POSITIVE control
        # for outer-painting rules specifically — if this one ever reads
        # "no change" again, the capture region has regressed and every
        # outer-glow verdict in the run is untrustworthy.
        ("box-shadow glow (outer, now captured)",
         ".paintprobe { box-shadow: 0 0 8px 4px rgba(255,200,87,.9); }", "good"),
        ("box-shadow INSET (visible in bounds)",
         ".paintprobe { box-shadow: inset 0 0 8px 4px rgba(255,200,87,.9); }",
         "test"),
        ("border-color",
         ".paintprobe { border: 4px solid rgb(0,255,0); }", "test"),
        # DEMONSTRATES THE NON-PAINTING-BASELINE HOLE (verifier's point): with a
        # transparent OFF state this reads exactly like the clipped outer shadow
        # above — both "no change" — yet one is a real no-op and the other works
        # but paints out of frame. A non-painting baseline cannot tell them apart.
        ("(hole demo) transparent colour",
         ".paintprobe { color: rgba(0,0,0,0); }", "note"),
    ]

    rig.style(OFF)
    base, base_dig, base_ink, base_got = rig.render_sample(["paintprobe"])
    # Hard-fail before any verdict is printed: if the BASELINE captured nothing
    # the whole run is uninterpretable, so emit no verdicts at all.
    assert_captured([base_got], "static baseline")
    print(f"baseline sample rgba={base} region={base_dig} ink={base_ink}\n")

    verdicts = {}
    for name, css, kind in cases:
        errs = rig.style(OFF + "\n" + css)
        px, dig, ink, _got = rig.render_sample(["paintprobe"])
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


def _sample_frames(rig, classes, extra_css, duration_ms, frames, size_request=False):
    """Capture `frames` snapshots over `duration_ms`. Returns (rows, raws).

    Captures through pad_for + _capture like every other path. `size_request` is
    off by default here so a rule's own min-width/min-height governs the widget's
    size — forcing 40x40 on an 8px dot would test a widget the CSS never sizes.
    """
    if extra_css is not None:
        rig.style(extra_css)
    w = Gtk.Box()
    if size_request:
        w.set_size_request(WIDGET_PX, WIDGET_PX)
    for c in classes:
        w.add_css_class(c)
    pad = pad_for(w)
    rig.box.append(pad)
    _settle(pad)

    rows, raws = [], []
    step = duration_ms / frames

    def grab(_):
        got = _capture(pad)
        buf = got[0]
        raws.append(got)
        h = hashlib.md5(buf).hexdigest()[:10] if buf else "EMPTY"
        _dig, ink = _digest(*got)
        rows.append((len(rows), h, _sample(*got) if buf is not None else None, ink))
        return False

    loop = GLib.MainLoop()
    for i in range(frames):
        GLib.timeout_add(int(step * i) + 20, grab, None)
    GLib.timeout_add(int(step * frames) + 200, lambda _: (loop.quit(), False)[1], None)
    loop.run()
    rig.box.remove(pad)
    return rows, raws


def _report_frames(label, rows, raws):
    """Print frames + distinct count. Hard-fails (raises) on an empty capture.

    The guard runs BEFORE the distinct count is printed, so a degraded run
    cannot leave a number on the page for someone to act on.
    """
    ink_total = assert_captured(raws, label)
    for i, h, px, ink in rows:
        print(f"  frame {i}  hash={h}  sample rgba={px}  region-ink={ink}")
    distinct = len(set(h for _, h, _, _ in rows))
    # Baseline printed alongside the verdict so "1/8 distinct" can be judged
    # against how much was actually captured, without the reader having to know
    # to ask. A rule that removes the need to spot nonsense beats one that asks.
    print(f"  -> distinct frame hashes: {distinct}/{len(rows)}  "
          f"(captured ink across all frames: {ink_total})")
    return distinct


def run_animated(theme, cls="ws-dot running", duration_ms=1600, frames=6):
    """Distinct frame hashes across an animation window + the sampled pixel.

    Runs BOTH controls in the SAME run as the subject, because they guard
    opposite failures and neither substitutes for the other:
      * KNOWN-GOOD  — an animation that must register. Without it, a probe that
                      can detect nothing calls every animation dead.
      * KNOWN-INERT — a static rule that must NOT register. Without it, timing
                      jitter/antialiasing makes every rule look animated.
    """
    rig = Rig(theme)
    classes = cls.split()
    print(f"PURE-PAINT ANIMATION PROBE — .{'.'.join(classes)} "
          f"over {duration_ms}ms, {frames} frames")
    print(f"(capturing a {PAD_PX}px-padded parent so outer glows are not clipped)\n")

    GOOD = ("@keyframes _probe_good { from { background-color: rgb(255,0,0); } "
            "to { background-color: rgb(0,0,255); } } "
            ".probegood { min-width: 20px; min-height: 20px; "
            "animation: _probe_good 0.4s linear infinite; }")
    INERT = (".probeinert { min-width: 20px; min-height: 20px; "
             "background-color: rgb(0,128,0); }")

    print("CONTROL known-good (animated background):")
    good_rows, good_raws = _sample_frames(
        rig, ["probegood"], rig.base_css + "\n" + GOOD, duration_ms, frames)
    good_distinct = _report_frames("known-good control", good_rows, good_raws)

    print("\nCONTROL known-inert (static background):")
    inert_rows, inert_raws = _sample_frames(
        rig, ["probeinert"], rig.base_css + "\n" + INERT, duration_ms, frames)
    inert_distinct = _report_frames("known-inert control", inert_rows, inert_raws)

    print(f"\nSUBJECT .{'.'.join(classes)}:")
    rows, raws = _sample_frames(rig, classes, rig.base_css, duration_ms, frames)
    distinct = _report_frames(f".{'.'.join(classes)}", rows, raws)

    ok_good = good_distinct > 1
    ok_inert = inert_distinct == 1
    print(f"\nCONTROL known-good  animated  : {ok_good} "
          f"({good_distinct}/{frames} distinct)")
    print(f"CONTROL known-inert stayed still: {ok_inert} "
          f"({inert_distinct}/{frames} distinct)")
    if not (ok_good and ok_inert):
        print("\n*** RUN INVALID — controls misbehaved; discard the verdict above ***")
        return 1

    print()
    if distinct <= 1:
        print("*** category (c): the rule parses but paints ONE unchanging frame ***")
        return 1
    print("Renders an animation (frames differ), and the per-frame samples above")
    print("show WHICH WAY the paint moved, not merely that it moved.")
    return 0


def run_selftest(theme):
    """Prove the empty-capture guard fires AND that it can pass — same run.

    A guard nobody has seen fail is not a guard, and that is precisely the
    defect this file shipped. So the probe demonstrates its own guard in both
    directions rather than asking the reader to trust it.
    """
    print("EMPTY-CAPTURE GUARD SELF-TEST (both directions)\n")
    rig = Rig(theme)

    print("direction 1 — point the probe at something that paints NOTHING;")
    print("             the guard must fire and NO verdict may be printed.")
    fired = False
    try:
        rows, raws = _sample_frames(
            rig, ["probenothing"],
            rig.base_css + "\n.probenothing { min-width: 20px; min-height: 20px; "
                           "background: none; border: none; }",
            400, 4)
        _report_frames("nothing-painted", rows, raws)
    except EmptyCapture as exc:
        fired = True
        print(f"  GUARD FIRED (no verdict emitted): {exc}")
    if not fired:
        print("  *** SELF-TEST FAILED: guard did NOT fire on an empty capture ***")
        return 1

    print("\ndirection 2 — point it at something that DOES paint;")
    print("             the guard must stay silent and a verdict must appear.")
    try:
        rows, raws = _sample_frames(
            rig, ["probepaints"],
            rig.base_css + "\n.probepaints { min-width: 20px; min-height: 20px; "
                           "background-color: rgb(255,0,0); }",
            400, 4)
        _report_frames("something-painted", rows, raws)
    except EmptyCapture as exc:
        print(f"  *** SELF-TEST FAILED: guard fired on a healthy capture: {exc} ***")
        return 1
    print("  GUARD SILENT, verdict emitted normally.")

    print("\nSELF-TEST PASSED — the guard fires on empty and passes on painted.")
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "static"
    theme = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_THEME
    try:
        if mode == "static":
            rc = run_static(theme)
        elif mode == "selftest":
            rc = run_selftest(theme)
        else:
            cls = sys.argv[3] if len(sys.argv) > 3 else "ws-dot running"
            dur = int(sys.argv[4]) if len(sys.argv) > 4 else 1600
            fr = int(sys.argv[5]) if len(sys.argv) > 5 else 6
            rc = run_animated(theme, cls, dur, fr)
    except EmptyCapture as exc:
        # HARD FAIL, NO VERDICT. Deliberately not a warning: see EmptyCapture.
        print(f"\n*** PROBE FAILED — EMPTY CAPTURE ***\n{exc}\n"
              f"*** NO VERDICT EMITTED. Fix the capture region and re-run. ***",
              file=sys.stderr)
        sys.exit(2)
    sys.exit(rc)

"""LAYOUT-class evidence for the welcome screen's ported properties.

Each property below CHANGES SIZE when it works, so the right evidence is a
measured delta (a pixel sample would be the wrong instrument). Measured on the
real widget shape, against the same baseline, with BOTH controls:

  KNOWN-GOOD  (font-size 13 -> 19.5) — must register. Guards a false ZERO: a
              probe that cannot detect anything reports every property dead.
  KNOWN-INERT (a property GTK does not implement for labels) — must NOT
              register. Guards a false NON-ZERO: a probe that always moves
              makes every property look alive.

A run where either control misbehaves is INVALID and its verdicts discarded.
"""
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, Gdk, GLib

Gtk.init()

# The real strings, so the measurement is on the shipped content.
TITLE = "Welcome to Orchestra"
DESC = "Each agent gets its own branch and directory — no clobbering"

BASE = ".p { font-size: 13px; }"
CASES = [
    # (label, css, text, class)
    ("CONTROL known-good: font-size 19.5px", ".p { font-size: 19.5px; }", TITLE, "must move"),
    ("CONTROL known-inert: text-shadow",     ".p { font-size: 13px; text-shadow: 0 0 4px red; }", TITLE, "must NOT move"),
    ("welcome-title font-size 19.5",  ".p { font-size: 19.5px; }", TITLE, "layout"),
    ("welcome-title font-weight 600", ".p { font-size: 19.5px; font-weight: 600; }", TITLE, "layout"),
    ("welcome-title letter-spacing -0.2px", ".p { font-size: 19.5px; font-weight: 600; letter-spacing: -0.2px; }", TITLE, "layout"),
    ("feature-name font-size 12",     ".p { font-size: 12px; }", "Isolated worktrees", "layout"),
    ("feature-name font-weight 600",  ".p { font-size: 12px; font-weight: 600; }", "Isolated worktrees", "layout"),
    ("feature-desc font-size 11",     ".p { font-size: 11px; }", DESC, "layout"),
    ("card padding 10px 12px",        ".p { font-size: 11px; padding: 10px 12px; }", DESC, "layout"),
    ("card min-width 160px (on the DESC label: below natural size)", ".p { font-size: 11px; min-width: 160px; }", DESC, "expect N/A"),
    ("card min-width 160px (on a SHORT label: binding)", ".p { font-size: 11px; min-width: 160px; }", "ok", "layout"),
    ("help-btn font-size 12",         ".p { font-size: 12px; }", "Everything Orchestra can do", "layout"),
]

win = Gtk.Window(); box = Gtk.Box(); win.set_child(box); win.present()

def measure(css, text):
    prov = Gtk.CssProvider(); errs = []
    prov.connect("parsing-error", lambda p, s, e: errs.append(e.message))
    prov.load_from_data(css.encode())
    disp = Gdk.Display.get_default()
    Gtk.StyleContext.add_provider_for_display(disp, prov, Gtk.STYLE_PROVIDER_PRIORITY_USER)
    lbl = Gtk.Label(label=text); lbl.add_css_class("p"); box.append(lbl)
    while GLib.MainContext.default().pending():
        GLib.MainContext.default().iteration(False)
    w = lbl.measure(Gtk.Orientation.HORIZONTAL, -1); h = lbl.measure(Gtk.Orientation.VERTICAL, -1)
    box.remove(lbl); Gtk.StyleContext.remove_provider_for_display(disp, prov)
    return (w.minimum, h.minimum), errs

def run():
    print(f"{'property':62} {'w':>5} {'h':>4} {'dw':>5} {'dh':>5}  verdict")
    print("-"*104)
    for name, css, text, kind in CASES:
        base, _ = measure(BASE, text)          # same TEXT baseline: comparability first
        got, errs = measure(css, text)
        dw, dh = got[0]-base[0], got[1]-base[1]
        moved = bool(dw or dh)
        verdict = "DELTA" if moved else "no change"
        print(f"{name:62} {got[0]:5} {got[1]:4} {dw:+5} {dh:+5}  {verdict}  [{kind}] (base w={base[0]} h={base[1]})")
        if errs: print(f"    parse errors: {errs}")
    Gtk.Window.destroy(win); loop.quit()

loop = GLib.MainLoop(); GLib.timeout_add(300, run); loop.run()

"""Does each property I shipped produce a MEASURED rendering delta?

A clean parse only rules out "errors in the parser". This measures the actual
Pango-rendered width/height of the same text with the property ON vs OFF, on
the real widget shape. A zero delta means the property parsed and did nothing
(V4's category (c)) and my claim for it is UNVERIFIED.
"""
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, Gdk, GLib

Gtk.init()

BASE = ".probe { font-size: 9px; }"
CASES = [
    ("letter-spacing: 0.2px", ".probe { font-size: 9px; letter-spacing: 0.2px; }"),
    ("font-weight: 600", ".probe { font-size: 9px; font-weight: 600; }"),
    ("text-transform: uppercase", ".probe { font-size: 9px; text-transform: uppercase; }"),
    ("font-size 9 vs 10 (sanity)", ".probe { font-size: 10px; }"),
    ("padding: 0 5px", ".probe { font-size: 9px; padding: 0 5px; }"),
]

win = Gtk.Window()
box = Gtk.Box()
win.set_child(box)
win.present()

results = []


def measure(css):
    prov = Gtk.CssProvider()
    errs = []
    prov.connect("parsing-error", lambda p, s, e: errs.append(e.message))
    prov.load_from_data(css.encode())
    disp = Gdk.Display.get_default()
    Gtk.StyleContext.add_provider_for_display(disp, prov, Gtk.STYLE_PROVIDER_PRIORITY_USER)
    lbl = Gtk.Label(label="merged")
    lbl.add_css_class("probe")
    box.append(lbl)
    # force a layout pass
    while GLib.MainContext.default().pending():
        GLib.MainContext.default().iteration(False)
    w = lbl.measure(Gtk.Orientation.HORIZONTAL, -1)
    h = lbl.measure(Gtk.Orientation.VERTICAL, -1)
    box.remove(lbl)
    Gtk.StyleContext.remove_provider_for_display(disp, prov)
    return (w.minimum, h.minimum), errs


def run():
    base, _ = measure(BASE)
    print(f"BASELINE (9px, no extras): w={base[0]} h={base[1]}\n")
    for name, css in CASES:
        got, errs = measure(css)
        dw, dh = got[0] - base[0], got[1] - base[1]
        verdict = "RENDERS A DELTA" if (dw or dh) else "*** NO EFFECT ***"
        print(f"{name:32} w={got[0]:4} h={got[1]:3}  dw={dw:+3} dh={dh:+3}  {verdict}")
        if errs:
            print(f"    parse errors: {errs}")
    Gtk.Window.destroy(win)
    loop.quit()


loop = GLib.MainLoop()
GLib.timeout_add(300, run)
loop.run()

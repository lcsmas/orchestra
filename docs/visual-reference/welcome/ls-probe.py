"""Isolate letter-spacing: same font-size on BOTH sides, only the tracking varies.

The earlier run compared "19.5+600+tracking" against a 13px baseline, so the
font-size change dominated and the tracking's own contribution was invisible.
Comparability BEFORE precision: hold everything else constant.
"""
import gi
gi.require_version("Gtk","4.0")
from gi.repository import Gtk, Gdk, GLib
Gtk.init()
TITLE="Welcome to Orchestra"
win=Gtk.Window(); box=Gtk.Box(); win.set_child(box); win.present()
def measure(css,text=TITLE):
    prov=Gtk.CssProvider(); errs=[]
    prov.connect("parsing-error",lambda p,s,e: errs.append(e.message))
    prov.load_from_data(css.encode())
    d=Gdk.Display.get_default()
    Gtk.StyleContext.add_provider_for_display(d,prov,Gtk.STYLE_PROVIDER_PRIORITY_USER)
    l=Gtk.Label(label=text); l.add_css_class("p"); box.append(l)
    while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)
    w=l.measure(Gtk.Orientation.HORIZONTAL,-1).minimum
    box.remove(l); Gtk.StyleContext.remove_provider_for_display(d,prov)
    return w,errs
def run():
    ref="font-size: 19.5px; font-weight: 600;"
    base,_=measure(".p { %s }"%ref)
    print(f"baseline (19.5/600, no tracking): w={base}")
    for v in ["-0.2px","-1px","-2px","+2px","0.5px"]:
        got,errs=measure(".p { %s letter-spacing: %s; }"%(ref,v))
        print(f"  letter-spacing {v:7} -> w={got:4} dw={got-base:+4} {'DELTA' if got!=base else 'NO EFFECT'}{' errs='+str(errs) if errs else ''}")
    Gtk.Window.destroy(win); loop.quit()
loop=GLib.MainLoop(); GLib.timeout_add(300,run); loop.run()

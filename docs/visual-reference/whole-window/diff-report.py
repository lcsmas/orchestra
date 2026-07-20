#!/usr/bin/env python3
"""T0 — the PER-REGION DIFFERENCE MAP. Pairs the Electron oracle against the
GTK pixel probe and ranks regions by delta.

THE RANKING IS THE DELIVERABLE. Not a pass/fail: a boolean tells five agents
nothing about where to start, and "some regions differ" is what four M4
verification waves already established. The ordered table below IS the work
order, and it is produced by measurement rather than by agents choosing their
own scope.

HOW THE TWO HALVES ARE MADE COMPARABLE:

  ELECTRON is read from getComputedStyle — exact, alpha explicit. Where an
  element does not paint (alpha 0), the oracle already walked up to the nearest
  painting ancestor, because that is what a user sees there.

  GTK is read as regional dominance from the composited window frame. It has no
  oracle, so pixels are the only instrument — but they are read from the real
  frame, not a widget-scoped snapshot.

  A translucent Electron reference is COMPOSITED against its painting ancestor
  before comparison, because the GTK pixel is already a composited result.
  Comparing a raw rgba() against a composited pixel would report a delta that is
  purely the alpha, i.e. a false finding on every translucent surface.

WHAT A DELTA MEANS. Max per-channel absolute difference in 8-bit sRGB. It is
deliberately max-channel rather than a mean: a mean lets a large match on two
channels hide a gross miss on the third.

EVERY ROW CARRIES ITS PROVENANCE — sample share, region bounds, surface class —
so a reader can audit whether the sample was representative instead of taking
the triple on trust. A dominance figure over a FILL carries alpha risk; the same
figure over INK does not. M4 produced two findings reading "88.8%" and "88.9%"
of which one was an artifact, and only the surface class distinguished them.

Usage: diff-report.py <electron-oracle.json> <gtk-probe.json> [--threshold N]
Exit: 0 if every paired region is within threshold, 1 otherwise.
"""
import json
import re
import sys

THRESHOLD = 3  # 8-bit channel delta below which two surfaces are the same colour


def parse_css_color(s):
    """'rgba(26, 31, 38, 0.5)' / 'rgb(26,31,38)' -> (r,g,b,a). Returns None if
    unparseable rather than guessing — a silently-wrong reference is worse than
    a missing one."""
    if not s:
        return None
    m = re.match(r"rgba?\(([^)]+)\)", s.strip())
    if not m:
        return None
    parts = [p.strip() for p in m.group(1).replace("/", ",").split(",")]
    try:
        vals = [float(p) for p in parts]
    except ValueError:
        return None
    if len(vals) == 3:
        return (vals[0], vals[1], vals[2], 1.0)
    if len(vals) == 4:
        return (vals[0], vals[1], vals[2], vals[3])
    return None


def composite(fg, bg):
    """Source-over of fg onto an opaque bg. The GTK side is already composited,
    so the reference must be too or the delta is just the alpha."""
    a = fg[3]
    return tuple(round(fg[i] * a + bg[i] * (1 - a)) for i in range(3))


def main():
    args = sys.argv[1:]
    threshold = THRESHOLD
    if "--threshold" in args:
        i = args.index("--threshold")
        threshold = int(args[i + 1])
        args = args[:i] + args[i + 2:]
    epath, gpath = args[0], args[1]

    E = json.load(open(epath))
    G = json.load(open(gpath))

    print("=" * 78)
    print("WHOLE-WINDOW REGION DIFF — Electron (DOM oracle) vs GTK (frame pixels)")
    print("=" * 78)

    # ── GEOMETRY GATE ───────────────────────────────────────────────────────
    # Setting geometry is not holding it: it reverted three times in one M5
    # session. A pair captured at different sizes compares NOTHING, and the
    # resulting numbers look perfectly precise, so this is a hard refusal
    # rather than a warning.
    ew, eh = E["viewport"]["w"], E["viewport"]["h"]
    gw, gh = G["achieved"]["w"], G["achieved"]["h"]
    print(f"\nachieved geometry   electron {ew}x{eh}   gtk {gw}x{gh}")
    if (ew, eh) != (gw, gh):
        print("\n!! REFUSING TO DIFF: the two halves were captured at DIFFERENT SIZES.")
        print("   Every region delta below would be an artifact of layout, not colour.")
        return 2
    print("   sizes match — the pair is comparable\n")

    rows = []
    unpaired = []
    uncomparable = []

    for rid, e in E["regions"].items():
        # UNCOMPARABLE REGIONS NEVER ENTER THE RANKING.
        # If the Electron value is inherited from an ancestor, or exists only
        # under a state rule, then a delta computed from it is meaningless in
        # BOTH directions: it can invent a defect, and it can invent a PASS.
        # The delta-0 case is the worse one — a confident pass is never
        # revisited, so the error becomes permanent. Reported in its own
        # section with the reason, never as a number.
        if e.get("comparable") is False:
            uncomparable.append((rid, e.get("uncomparableReasons", []),
                                 e.get("selector"), e.get("gtkWidget")))
            continue
        g = G["regions"].get(rid)
        if g is None:
            absent = next((a for a in G.get("absent", []) if a["id"] == rid), None)
            unpaired.append((rid, "GTK widget absent" if absent else "not probed",
                             e.get("gtkWidget")))
            continue
        if g.get("zeroAllocation"):
            unpaired.append((rid, "GTK ZERO-ALLOCATION (exists, paints nothing)",
                             g["widget"]))
            continue

        eb = e["effectiveBg"]
        eref = parse_css_color(eb["painted"])
        gdom = g["dominant"]
        if eref is None or gdom is None:
            unpaired.append((rid, "unparseable colour", e.get("gtkWidget")))
            continue

        # COMPOSITING BASE. A translucent Electron surface is painted OVER
        # whatever its ancestors paint, and the GTK pixel is already the
        # composited result. Comparing a raw rgba() against a composited pixel
        # reports a delta that is purely the alpha — a false finding on every
        # translucent surface, and these gradients run 0.75–0.92 alpha.
        # The app root is opaque, so it is the correct base.
        base = parse_css_color(
            E["regions"].get("app-root", {}).get("effectiveBg", {}).get("painted") or "")
        base_rgb = tuple(round(v) for v in base[:3]) if base else (0, 0, 0)

        eres = composite(eref, base_rgb) if eref[3] < 1.0 else tuple(
            round(v) for v in eref[:3])

        delta = max(abs(eres[i] - gdom[i]) for i in range(3))
        rows.append({
            "id": rid, "delta": delta, "electron": eres, "gtk": tuple(gdom),
            "share": g["share"], "samples": g["samples"],
            "class": g["surfaceClass"], "bounds": g["bounds"],
            "widget": g["widget"], "selector": e["selector"],
            "alpha": eref[3],
            "paintKind": eb.get("paintKind"),
            "gradientStops": eb.get("gradientStops"),
            "compositedOver": base_rgb,
        })

    rows.sort(key=lambda r: -r["delta"])

    # ── THE RANKED MAP ──────────────────────────────────────────────────────
    print("RANKED REGION DIFFERENCE MAP  (delta = max per-channel, 8-bit sRGB)")
    print("-" * 78)
    hdr = (f"{'region':16s} {'electron':16s} {'gtk':16s} {'Δ':>4s}  "
           f"{'share':>6s} {'class':5s} bounds")
    print(hdr)
    print("-" * 78)
    for r in rows:
        flag = "  " if r["delta"] <= threshold else "**"
        b = r["bounds"]
        print(f"{flag}{r['id']:14s} rgb{str(r['electron']):14s} "
              f"rgb{str(r['gtk']):14s} {r['delta']:4d}  "
              f"{r['share']*100:5.1f}% {r['class']:5s} "
              f"{int(b['w'])}x{int(b['h'])}@{int(b['x'])},{int(b['y'])}")

    failing = [r for r in rows if r["delta"] > threshold]

    # ── PROVENANCE, stated rather than implied ──────────────────────────────
    print("\nPROVENANCE / HOW TO AUDIT EACH ROW")
    print("-" * 78)
    for r in rows:
        note = []
        if r["class"] == "fill":
            note.append("FILL — alpha risk applies; electron value is post-composite")
        else:
            note.append("INK — opaque both sides, dominance trustworthy")
        if r["share"] < 0.5:
            note.append(f"LOW SHARE ({r['share']*100:.1f}%) — dominant colour is a "
                        f"plurality, NOT characteristic; treat as UNRELIABLE")
        if r["alpha"] < 1.0:
            note.append(f"electron alpha={r['alpha']} — composited over "
                        f"rgb{r['compositedOver']} before compare")
        if r.get("paintKind") == "gradient":
            stops = r.get("gradientStops") or []
            # A STRUCTURAL difference the colour delta alone cannot express:
            # Electron paints a gradient, and if GTK paints a flat fill the two
            # can still agree at the sampled dominant colour while looking
            # different to a user across the region's height. Reported so it is
            # not silently absorbed into a small delta.
            note.append(f"electron paints a GRADIENT ({len(stops)} stops: "
                        f"{', '.join(stops)}) — a flat GTK fill can match the "
                        f"dominant colour and still differ across the region")
        print(f"  {r['id']:16s} sel={r['selector']:22s} widget={r['widget']:16s} "
              f"{r['samples']:7d}px")
        for n in note:
            print(f"       - {n}")

    # ── COVERAGE, named rather than silent ──────────────────────────────────
    # An omitted surface is indistinguishable from a verified one. Every region
    # that could NOT be compared is named, with the reason.
    if uncomparable:
        print("\nUNCOMPARABLE — MEASURED BUT NOT DIFFED")
        print("-" * 78)
        print("  These are NOT passes and NOT failures. A delta computed from")
        print("  them would be meaningless in both directions — it can invent a")
        print("  defect, and it can invent a PASS (the worse case: a confident")
        print("  delta-0 is never revisited, so the error becomes permanent).")
        for rid, reasons, sel, gtk in uncomparable:
            print(f"\n  {rid}  (electron {sel} vs gtk {gtk})")
            for why in reasons:
                print(f"     - {why}")

    print("\nCOVERAGE")
    print("-" * 78)
    total = len(E["regions"])
    print(f"  compared {len(rows)} of {total} oracle regions")
    if uncomparable:
        print(f"  UNCOMPARABLE ({len(uncomparable)}): "
              f"{', '.join(r[0] for r in uncomparable)}")
    if unpaired:
        print(f"  NOT COMPARED ({len(unpaired)}) — these are UNVERIFIED, not passing:")
        for rid, why, w in unpaired:
            print(f"     - {rid:16s} {why} (gtk target: {w})")
    elif not uncomparable:
        print("  every oracle region was paired and compared")

    print("\nVERDICT")
    print("-" * 78)
    if failing:
        print(f"  {len(failing)} region(s) exceed the delta threshold of {threshold}:")
        for r in failing:
            print(f"     {r['id']:16s} Δ{r['delta']:<4d} "
                  f"electron rgb{r['electron']} vs gtk rgb{r['gtk']}")
        print("\n  ^ THIS ORDER IS THE WORK ORDER. Largest delta first.")
    else:
        print(f"  all {len(rows)} compared regions within threshold {threshold}")
    if unpaired:
        print(f"  plus {len(unpaired)} region(s) UNVERIFIED (named above)")
    if uncomparable:
        print(f"  plus {len(uncomparable)} region(s) UNCOMPARABLE — these need a "
              f"different instrument, not a rerun")

    # Machine-readable result beside the oracle, for the prove-detector gate
    # and for the sibling agents consuming the work order.
    import os
    result_path = os.path.join(os.path.dirname(os.path.abspath(epath)),
                               "diff-result.json")
    json.dump({"rows": rows, "unpaired": unpaired,
               "uncomparable": [{"id": r[0], "reasons": r[1],
                                 "selector": r[2], "gtkWidget": r[3]}
                                for r in uncomparable],
               "threshold": threshold, "failing": len(failing),
               "geometry": {"w": ew, "h": eh}},
              open(result_path, "w"), indent=2)
    print(f"\n  machine-readable result: {result_path}")
    return 1 if failing else 0


if __name__ == "__main__":
    sys.exit(main())

"""Regional-dominance measurement helpers.

RULE (learned expensively): never report a point sample. Every colour verdict
reports the DOMINANT value, its SAMPLE SHARE, and the REGION BOUNDS, so a
reader can tell an 18000-sample result from a 1-sample one.
"""
from PIL import Image
from collections import Counter


def region_dominant(path, box=None, quant=8):
    """Dominant colour over a region. Returns (rgb, share, n, box)."""
    im = Image.open(path).convert('RGB')
    if box is None:
        box = (0, 0, im.width, im.height)
    crop = im.crop(box)
    px = list(crop.getdata())
    q = [(r // quant * quant, g // quant * quant, b // quant * quant) for r, g, b in px]
    c = Counter(q)
    rgb, n = c.most_common(1)[0]
    return rgb, n / len(px), len(px), box


def report(label, path, box=None, quant=8):
    rgb, share, n, box = region_dominant(path, box, quant)
    print(f"{label:34s} dom=rgb{rgb} share={share:6.1%} n={n:7d} box={box}")
    return rgb, share, n


def stats(path, box=None):
    """Mean luminance + spread over a region — for backdrop dim measurement."""
    im = Image.open(path).convert('RGB')
    if box is None:
        box = (0, 0, im.width, im.height)
    px = list(im.crop(box).getdata())
    lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px]
    mean = sum(lum) / len(lum)
    var = sum((x - mean) ** 2 for x in lum) / len(lum)
    return mean, var ** 0.5, len(px)


def size(path):
    im = Image.open(path)
    return im.width, im.height

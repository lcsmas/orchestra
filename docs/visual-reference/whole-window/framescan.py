"""Dep-free PNG reading shared by probe-gtk.py and prove-detector.sh.

Kept separate so the fault-injection proof reads frames with the SAME decoder
the probe uses. If the proof had its own reader, a decoder bug could make the
proof pass while the probe misreads every frame — the control would then be
validating a different instrument than the one in service.
"""
import struct
import zlib
from collections import Counter


def read_png(path):
    """Minimal PNG reader -> (w, h, rows of RGB tuples). 8-bit only."""
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path}: not a PNG"
    pos, idat, w, h, depth, ctype = 8, b"", None, None, None, None
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, ctype = (*struct.unpack(">II", chunk[:8]), chunk[8], chunk[9])
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    assert depth == 8, f"{path}: unsupported bit depth {depth}"
    nch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = w * nch
    out, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b = prev[i]
                c = prev[i - nch] if i >= nch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        prev = line
        out.append([tuple(line[i:i + 3]) if nch >= 3 else (line[i],) * 3
                    for i in range(0, stride, nch)])
    return w, h, out


def count_magenta(px):
    """Count the fault-injection sentinel across a whole frame.

    Deliberately whole-frame and tolerant (not an exact-triple match): the
    question it answers is "did the mutation reach the screen AT ALL", which
    must not depend on the mutation landing in the region we expected. A
    region-scoped exact match would return 0 for a sentinel that painted
    somewhere else, and 0 would then be read as "the detector missed it".
    """
    return sum(1 for row in px for c in row
               if c[0] > 200 and c[1] < 60 and c[2] > 200)


def dominant(px, w, h, x0, y0, x1, y1):
    """Dominant colour of a region + share + sample count. NEVER a point sample.

    A point sample on a surface with rows, seams, hover or selection painted
    over it returns a sharp WRONG number and more confidence in it.
    """
    x0, y0 = max(0, int(x0)), max(0, int(y0))
    x1, y1 = min(w, int(x1)), min(h, int(y1))
    c = Counter()
    for y in range(y0, y1):
        row = px[y]
        for x in range(x0, x1):
            c[row[x]] += 1
    if not c:
        return None, 0.0, 0
    (col, n), total = c.most_common(1)[0], sum(c.values())
    return col, n / total, total

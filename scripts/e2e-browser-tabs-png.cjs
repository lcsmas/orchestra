// Shared PNG helpers for the #391 browser-tabs rigs (8-bit RGB/RGBA, non-interlaced grim output).
const zlib = require('node:zlib');

function decodePng(buf) {
  let pos = 8; const idat = []; let w, h, ct;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; } else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3, stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++], line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0; let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = (line[x] + add) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ch, data: out };
}
/** share of pixels in [x,y,w,h] within tol of the named colour */
function share(I, rect, rgb, tol = 10) {
  let n = 0, t = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const o = (y * I.w + x) * I.ch; t++;
    if (Math.abs(I.data[o] - rgb[0]) <= tol && Math.abs(I.data[o + 1] - rgb[1]) <= tol && Math.abs(I.data[o + 2] - rgb[2]) <= tol) n++;
  }
  return n / t;
}

module.exports = { decodePng, share };

// The pairing QR (#336): the generator's own matrix is NOT the proof — we rasterise OUR path (what the renderer draws) and read it
// back with an independent decoder (jsQR). The built-app clause in scripts/e2e-acces-mobile.mjs does the same on real screen pixels.

import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { pairingUrl } from './acces-mobile.ts';
import { QR_MARGIN, qrRows, qrSvg } from './qr.ts';

const TOKEN = 'Qm9nIl_-' + 'x7Yz'.repeat(8) + 'AbCde'.slice(0, 3); // 43 chars of base64url
const URL_A = pairingUrl('lmas.tail6e788b.ts.net', 8445, TOKEN)!;

/** Rasterise the SVG path the way the browser would: white plate, black modules, `scale` px per module. */
function raster(text: string, scale = 6): { data: Uint8ClampedArray; width: number; height: number } {
  const { size, d } = qrSvg(text);
  const width = size * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, run] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let py = y * scale; py < (y + 1) * scale; py++)
      for (let px = x * scale; px < (x + run) * scale; px++) {
        const i = (py * width + px) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
  }
  return { data, width, height: width };
}
const decode = (img: { data: Uint8ClampedArray; width: number; height: number }) => jsQR(img.data, img.width, img.height)?.data ?? null;

test('the rendered QR decodes (independent decoder) to EXACTLY the pairing URL, fragment and token included', () => {
  assert.equal(decode(raster(URL_A)), URL_A);
  const other = pairingUrl('other-box.tail1234.ts.net', 9001, 'Z'.repeat(43))!;
  assert.equal(decode(raster(other)), other, 'another host/port/token');
});

test('must-FAIL: the decoder is not a yes-machine — blank and noise decode to nothing; the QR of A never decodes to B', () => {
  const blank = { data: new Uint8ClampedArray(240 * 240 * 4).fill(255), width: 240, height: 240 };
  assert.equal(decode(blank), null, 'blank page');
  const noise = { data: new Uint8ClampedArray(240 * 240 * 4), width: 240, height: 240 };
  let s = 12345;
  for (let i = 0; i < noise.data.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const v = s & 0x100 ? 255 : 0; noise.data[i] = noise.data[i + 1] = noise.data[i + 2] = v; noise.data[i + 3] = 255; }
  assert.equal(decode(noise), null, 'noise');
  const b = pairingUrl('lmas.tail6e788b.ts.net', 8445, 'B'.repeat(43))!;
  assert.equal(decode(raster(URL_A)), URL_A, 'control');
  assert.notEqual(decode(raster(URL_A)), b);
  assert.notEqual(decode(raster(b)), URL_A);
});

test('quiet zone: 4 modules on every side, nothing dark inside it; sized for a phone camera', () => {
  const rows = qrRows(URL_A);
  const { size, d } = qrSvg(URL_A);
  assert.equal(QR_MARGIN, 4);
  assert.equal(size, rows.length + 2 * QR_MARGIN);
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, run] = [Number(m[1]), Number(m[2]), Number(m[3])];
    assert.ok(x >= QR_MARGIN && y >= QR_MARGIN && x + run <= size - QR_MARGIN && y < size - QR_MARGIN, `run ${m[0]} stays out of the quiet zone`);
  }
  assert.ok(d.length > 100, 'control: the path really draws modules');
  assert.ok(size <= 65, `${size} modules: a ~80-char URL stays a small code (≥ 3 px per module at 208 px)`);
});

test('the path is a pure function of the text (no state leaks between codes)', () => {
  assert.equal(qrSvg(URL_A).d, qrSvg(URL_A).d);
  assert.notEqual(qrSvg(URL_A).d, qrSvg(URL_A.replace('8445', '8446')).d);
});

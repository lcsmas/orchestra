// QR code for the Accès mobile pairing URL (#336). Library: `qrcode` (soldair, ~5M weekly downloads, pure JS, browser build via its
// `browser` field) — only its encoder is used (`create`); drawing is ours (one SVG path, no canvas, no HTML injection). The
// renderer imports this; the Accès mobile SERVER process never does (it must stay dependency-free).

import QRCode from 'qrcode';

/** Quiet zone in modules — the QR spec asks for 4; scanners fail on less. */
export const QR_MARGIN = 4;

/** The dark modules as rows of booleans (error correction M: 15 % of the code can be lost). */
export function qrRows(text: string): boolean[][] {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const rows: boolean[][] = [];
  for (let r = 0; r < modules.size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < modules.size; c++) row.push(modules.get(r, c) === 1);
    rows.push(row);
  }
  return rows;
}

/** The QR as an SVG path in module units, quiet zone included: one `M x y h<run> v1 h-<run> z` per horizontal run of dark modules.
 *  `size` is the viewBox side. */
export function qrSvg(text: string): { size: number; d: string } {
  const rows = qrRows(text);
  const parts: string[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      parts.push(`M${x + QR_MARGIN} ${y + QR_MARGIN}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
  return { size: rows.length + 2 * QR_MARGIN, d: parts.join('') };
}

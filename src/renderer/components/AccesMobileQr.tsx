import { useMemo } from 'react';
import { qrSvg } from '../../shared/qr';

/** The pairing QR (#336): black modules on a white plate (scanners need the contrast, whatever the app theme). Drawn from one SVG
 *  path — no canvas, no injected HTML. The text it encodes is shown next to it by the caller. */
export function AccesMobileQr({ text, px = 208 }: { text: string; px?: number }) {
  const { size, d } = useMemo(() => qrSvg(text), [text]);
  return (
    <svg className="am-qr" data-am-qr role="img" aria-label="QR code de pairing" viewBox={`0 0 ${size} ${size}`} width={px} height={px} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

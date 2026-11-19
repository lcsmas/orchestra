// Duration and size parsers. Sizes follow systemd: K/M/G/T and KiB/MiB/GiB/TiB are powers of 1024, KB/MB/GB/TB powers of 1000.

const DURATION_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `15m`, `2s`, `500ms`, `1h30m`, or a bare number of seconds → milliseconds. Throws on anything else. */
export function parseDuration(text: string): number {
  const s = text.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/y;
  let total = 0;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) throw new Error(`invalid duration: ${JSON.stringify(text)}`);
    total += Number(m[1]) * DURATION_MS[m[2]];
    pos = re.lastIndex;
  }
  if (pos === 0) throw new Error(`invalid duration: ${JSON.stringify(text)}`);
  return Math.round(total);
}

const SIZE_MUL: Record<string, number> = {
  '': 1, b: 1,
  k: 1024, kib: 1024, m: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tib: 1024 ** 4,
  kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
};

/** `6G`, `10GiB`, `512M`, `100MB`, `1.5G`, or bare bytes → bytes. Throws on anything else. */
export function parseSize(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(text.trim());
  const mul = m ? SIZE_MUL[m[2].toLowerCase()] : undefined;
  if (!m || mul === undefined) throw new Error(`invalid size: ${JSON.stringify(text)}`);
  return Math.round(Number(m[1]) * mul);
}

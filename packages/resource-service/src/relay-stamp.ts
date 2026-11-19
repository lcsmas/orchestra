// Pure half of the Docker relay (prior art: the keeper relay, ADR 0004 — read, not imported): which API call creates a container, and how its JSON body gets the run label.
// The body is edited IN TEXT, never parsed and re-serialised: a JSON round trip rewrites every integer above 2^53 (a compose `ulimits`/`memory` max) and Docker then refuses the create.

/** The request target as the daemon's router sees it: absolute-form stripped, query dropped, percent-decoded, `//` and `.`/`..` collapsed. null = undecodable (the daemon answers 400). */
function routedPath(url: string | undefined): string | null {
  let u = url ?? '';
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(u);
  if (abs) u = u.slice(abs[0].length);
  u = u.split(/[?#]/, 1)[0];
  try {
    u = decodeURIComponent(u);
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const seg of u.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

/**
 * `POST /containers/create`, with or without the `/v<version>` prefix (docker CLI, compose and client libraries all create through this one call) — judged on the path the daemon will
 * ROUTE (`%63reate`, `//containers/create`, an absolute-form target all reach it), so a spelling that slips past a raw match cannot create an unlabelled container.
 */
export function isContainerCreate(method: string | undefined, url: string | undefined): boolean {
  if (method !== 'POST') return false;
  const p = routedPath(url);
  return p === null || /^(?:\/v[0-9.]+)?\/containers\/create$/.test(p); // the daemon's own version segment: `v[0-9.]+` (`v1.54.`, `v01.54` route too) // undecodable: stamping a request the daemon will refuse anyway is harmless
}

const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
function skipWs(s: string, i: number): number {
  while (i < s.length && isWs(s[i])) i++;
  return i;
}

/** `s[i]` is `"`; the index just past the closing quote, or -1 when unterminated. */
function skipString(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
  }
  return -1;
}

/** Index just past the JSON value starting at `i`, or -1 when malformed. */
function skipValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return skipString(s, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const d = s[j];
      if (d === '"') {
        const e = skipString(s, j);
        if (e < 0) return -1;
        j = e - 1;
      } else if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }
  let j = i;
  while (j < s.length && !',}] \t\n\r'.includes(s[j])) j++;
  return j > i ? j : -1;
}

/** Go's decoder matches member names by simple case folding: `labels`, `LABELS` and `Labelſ` (long s) all land in `Labels`. */
const isLabelsKey = (k: string): boolean => k.toLowerCase().replace(/\u017f/g, 's') === 'labels';

/**
 * Add `labels` to a container-create body, byte-identical everywhere else. Our keys go LAST inside the LAST `Labels` member, so a client-supplied `resctl.run` loses.
 * A later member wins in the daemon's decoder, so the LAST `Labels` member (under Go's case folding) is the one stamped.
 * Null when the body is not a JSON object we can edit with certainty — the caller must then REFUSE the call (forwarding it would leave an unlabelled container).
 */
export function stampContainerCreateBody(text: string, labels: Record<string, string>): string | null {
  let i = skipWs(text, 0);
  if (text[i] !== '{') return null;
  const open = i;
  i++;
  let labelsAt: { start: number; end: number } | null = null;
  let nonEmpty = false;
  for (;;) {
    i = skipWs(text, i);
    if (text[i] === '}') break;
    if (nonEmpty) {
      if (text[i] !== ',') return null;
      i = skipWs(text, i + 1);
    }
    if (text[i] !== '"') return null;
    const kEnd = skipString(text, i);
    if (kEnd < 0) return null;
    let key: string;
    try {
      key = JSON.parse(Buffer.from(text.slice(i, kEnd), 'latin1').toString('utf8')) as string; // the text is latin1 (byte-for-byte): decode the key's own bytes
    } catch {
      return null;
    }
    i = skipWs(text, kEnd);
    if (text[i] !== ':') return null;
    i = skipWs(text, i + 1);
    const vEnd = skipValue(text, i);
    if (vEnd < 0) return null;
    if (isLabelsKey(key)) labelsAt = { start: i, end: vEnd };
    nonEmpty = true;
    i = vEnd;
  }
  if (skipWs(text, i + 1) !== text.length) return null; // trailing garbage after the object
  const entries = Object.entries(labels)
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',');
  if (!labelsAt) return `${text.slice(0, open + 1)}"Labels":{${entries}}${nonEmpty ? ',' : ''}${text.slice(open + 1)}`;
  const value = text.slice(labelsAt.start, labelsAt.end);
  let stamped: string;
  if (value === 'null') {
    stamped = `{${entries}}`;
  } else if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1);
    stamped = `{${inner}${inner.trim() === '' ? '' : ','}${entries}}`;
  } else {
    return null;
  }
  return text.slice(0, labelsAt.start) + stamped + text.slice(labelsAt.end);
}

/** Largest create body the relay buffers (a real one is a few KB); past it the call is refused with a 413. */
export const MAX_CREATE_BODY_BYTES = 64 * 1024 * 1024;

/** The stamped create body as bytes, or null = cannot be stamped. latin1 maps every byte to one char and back, so non-UTF-8 bytes survive untouched (the structural characters are ASCII). */
export function stampCreateBodyBytes(body: Buffer, labels: Record<string, string>): Buffer | null {
  const stamped = stampContainerCreateBody(body.toString('latin1'), labels);
  return stamped === null ? null : Buffer.from(stamped, 'latin1');
}

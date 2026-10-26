#!/usr/bin/env node
// #398 gate: the CDP proxy host is the ONLY code in src/main that touches a tab's debugger.
// Lists every code (non-comment, non-test) use of `debugger` / `.attach(` / `sendCommand(` under src/main and
// requires that all of them sit in the proxy's seat (src/main/browser-cdp-seat.ts), which the proxy host imports.
//   node scripts/check-single-debugger-attacher.mjs [--root <repo>] [--list]   → CLEAN (RC 0) | DIRTY (RC 1)
//   node scripts/check-single-debugger-attacher.mjs --self-test                 → positive + negative control
// The positive control: the SAME scan must find the seat's own `attach(` (else the pattern is blind).
// The negative control (--self-test): a throwaway copy of src/main with a second attach injected must read DIRTY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEAT = 'src/main/browser-cdp-seat.ts';
const HOST = 'src/main/browser-cdp-host.ts';
const PATTERNS = [
  ['debugger', /\bdebugger\b/],
  ['attach(', /\.attach\(/],
  ['sendCommand(', /\bsendCommand\(/],
];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Code lines only: a full-line `//` or block-comment line is skipped, a trailing `// …` is cut. */
function codeOf(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  return line.replace(/(^|\s)\/\/.*$/, '$1');
}

export function scan(root) {
  const hits = [];
  for (const file of walk(path.join(root, 'src/main'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = codeOf(line);
      if (!code) return;
      for (const [kind, re] of PATTERNS) if (re.test(code)) hits.push({ file: rel, line: i + 1, kind, text: line.trim() });
    });
  }
  return hits;
}

export function verdict(root) {
  const hits = scan(root);
  const outside = hits.filter((h) => h.file !== SEAT);
  const seatAttach = hits.filter((h) => h.file === SEAT && h.kind === 'attach(');
  const host = fs.existsSync(path.join(root, HOST)) ? fs.readFileSync(path.join(root, HOST), 'utf8') : '';
  const hostUsesSeat = /from '\.\/browser-cdp-seat\.ts'/.test(host) && /seatAcquire\(/.test(host);
  const problems = [];
  if (outside.length) problems.push(`${outside.length} debugger use(s) outside the proxy seat`);
  if (seatAttach.length !== 1) problems.push(`positive control: expected exactly 1 attach( in ${SEAT}, found ${seatAttach.length}`);
  if (!hostUsesSeat) problems.push(`positive control: ${HOST} does not acquire the seat`);
  return { hits, outside, seatAttach, hostUsesSeat, problems, clean: problems.length === 0 };
}

export function selfTest(root) {
  const real = verdict(root);
  if (!real.clean) return { ok: false, why: `real tree is not CLEAN: ${real.problems.join('; ')}` };
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'single-attacher-'));
  try {
    fs.cpSync(path.join(root, 'src/main'), path.join(tmp, 'src/main'), { recursive: true });
    const victim = path.join(tmp, 'src/main/browser-panel.ts');
    fs.appendFileSync(victim, "\nfunction secondAttacher(wc: any) { wc.debugger.attach('1.3'); }\n");
    const bad = verdict(tmp);
    if (bad.clean || !bad.outside.some((h) => h.file === 'src/main/browser-panel.ts')) {
      return { ok: false, why: 'negative control: an injected second attach was NOT flagged' };
    }
    return { ok: true, why: `real tree CLEAN (${real.hits.length} hits, all in the seat); injected second attach → DIRTY` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--root');
  const root = path.resolve(ri >= 0 ? args[ri + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (args.includes('--self-test')) {
    const r = selfTest(root);
    console.log(r.ok ? `SELF-TEST OK — ${r.why}` : `SELF-TEST FAILED — ${r.why}`);
    process.exit(r.ok ? 0 : 1);
  }
  const v = verdict(root);
  if (args.includes('--list') || !v.clean) for (const h of v.hits) console.log(`${h.file}:${h.line}: [${h.kind}] ${h.text}`);
  console.log(
    v.clean
      ? `CLEAN — every debugger use in src/main (${v.hits.length}) is in ${SEAT}; its one attach( is there; ${HOST} acquires it`
      : `DIRTY — ${v.problems.join('; ')}`,
  );
  process.exit(v.clean ? 0 : 1);
}

// Render smoke-test for the Plafond mémoire notice row (#322, D-Q7 = B): `node --test` strips types but does NOT transform JSX, so the unit suite proves the row as DATA (src/shared/mem-notice.test.ts) but not that the event
// the keeper path emits becomes the dedicated ONE-LINE row — red for a killed command, amber for the warning level, the command in a chip — through the real fold and the real renderer, nor that the Warning row it
// replaces is gone. scripts/memory-cap-row-screenshot.mjs proves it reaches PIXELS on the real stylesheet. SELECTOR CONTRACT: assertions key on data-notice / data-memcap-* hooks and rendered TEXT — never tag or position.
import { createRequire } from 'node:module';
import { renderToString } from 'react-dom/server';
import React from 'react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try { return require_('esbuild'); } catch {
    const store = fs.globSync?.(process.cwd() + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
}
const { build } = loadEsbuild();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const outfile = path.join(cache, 'memory-cap-row-smoke.mjs');
const entryFile = path.join(cache, 'memory-cap-row-entry.tsx');
const C = (rel) => JSON.stringify(path.join(repoRoot, rel));
fs.writeFileSync(entryFile, `export { MessageBubble } from ${C('src/renderer/components/agent/MessageBubble.tsx')};
export { NoticeRow } from ${C('src/renderer/components/agent/NoticeRow.tsx')};
export { makeMemNotice, memNoticeEntryOf, interleaveMemNotices } from ${C('src/shared/mem-notice.ts')};
export { foldEvents, emptySession } from ${C('src/shared/agent-events.ts')};
`);
await build({ entryPoints: [entryFile], outfile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], loader: { '.css': 'empty' }, logLevel: 'silent' });
globalThis.self = globalThis;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), orchestra: new Proxy({}, { get: (_t, k) => (String(k).startsWith('on') ? () => () => {} : async () => []) }) };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
const { MessageBubble, NoticeRow, makeMemNotice, memNoticeEntryOf, interleaveMemNotices, foldEvents, emptySession } = await import(`${outfile}?t=${Date.now()}`);

let failures = 0;
const check = (label, cond, detail = '') => { if (cond) console.log(`  ok   ${label}`); else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } };
const html = (el) => renderToString(el).replace(/<!-- -->/g, '');
const h = React.createElement;
const GB = 1024 ** 3;
const kill = { kind: 'kill', source: 'kernel', seq: 4, at: Date.parse('2026-10-09T14:02:00'), level: 'hard', command: 'python3 swarm.py 8 50 10', pid: 9, rssBytes: 1, candidates: [], unit: 'u.scope', hardBytes: 6 * GB };
const soft = { kind: 'soft', seq: 5, at: Date.parse('2026-10-09T13:58:00'), unit: 'u.scope', bytes: 3.1 * GB, softBytes: 3 * GB, hardBytes: 6 * GB };
// the REAL path: record → entry → the notice event the live emit / the backfill builds → the real fold → the real renderer
const rowFor = (rec) => {
  const ev = makeMemNotice({ seq: 1 }, memNoticeEntryOf(rec));
  const sess = foldEvents(emptySession('ws'), [ev]);
  const msg = sess.messages[sess.messages.length - 1];
  return { msg, out: html(h(MessageBubble, { message: msg })) };
};

console.log('\nThe dedicated row (D-Q7 B), through fold + MessageBubble:');
const hard = rowFor(kill);
check('a kill becomes the memory-cap notice row — NOT the generic Warning row it replaces', hard.msg.noticeKind === 'memory-cap' && hard.out.includes('data-notice="memory-cap"') && !hard.out.includes('data-notice="warning"') && !hard.out.includes('av-notice-warning'), hard.out);
check('one line: label « Plafond mémoire », a status note, red (is-hard), the time at the right', hard.out.includes('Plafond mémoire</span>') && hard.out.includes('role="note"') && hard.out.includes('is-hard') && hard.out.includes('data-memcap-tone="hard"') && /av-notice-tag">\d\d:\d\d/.test(hard.out), hard.out);
check('the command is in a CHIP; the sentence around it: « Command [cmd] killed — 6 GB reached »', /Command <code class="av-notice-chip" data-memcap-chip="">python3 swarm\.py 8 50 10<\/code> killed — 6 GB reached/.test(hard.out), hard.out);
check('the full plain sentence rides as the tooltip (a11y + the hard cap detail)', hard.out.includes('title="Command python3 swarm.py 8 50 10 killed: Plafond mémoire 6 GB reached"'), hard.out);
const inferred = rowFor({ ...kill, source: 'inferred', command: 'python3 swarm.py' });
check('an INFERRED victim reads « probably » with its chip', /A command was killed — 6 GB reached · probably <code class="av-notice-chip" data-memcap-chip="">python3 swarm\.py<\/code>/.test(inferred.out), inferred.out);
const unnamed = rowFor({ ...kill, command: null });
check('a command too brief to be named: red, no chip', unnamed.out.includes('is-hard') && !unnamed.out.includes('data-memcap-chip') && unnamed.out.includes('it lived too briefly to be named'), unnamed.out);
const ended = rowFor({ ...kill, role: 'cli' });
check('the member\'s own agent process killed: the row says the SESSION ended', ended.out.includes('the session ended'), ended.out);
const ext = rowFor({ ...kill, level: 'external' });
check('an OOM from outside the scope limit is not blamed on the Plafond', ext.out.includes('by the system under memory pressure (not by the Plafond mémoire)') && ext.out.includes('is-hard'), ext.out);
const warn = rowFor(soft);
check('the warning level is AMBER (is-soft), nothing killed, no chip', warn.out.includes('is-soft') && warn.out.includes('data-memcap-tone="soft"') && !warn.out.includes('is-hard') && !warn.out.includes('data-memcap-chip') && warn.out.includes('Working set 3.1 GB — warning level 3 GB crossed (hard cap 6 GB)'), warn.out);
const long = rowFor({ ...kill, command: 'y'.repeat(200) });
check('a long command is cut inside the chip (≤ 80 chars) — the tooltip keeps the sentence', (/data-memcap-chip="">(y+…?)<\/code>/.exec(long.out)?.[1].length ?? 999) <= 80, long.out.slice(0, 400));

console.log('\nBackfill (a reopened pane) and the old Warning row:');
const entry = memNoticeEntryOf(kill);
const backfilled = interleaveMemNotices([], [entry], { seq: 1_000_000 });
const bSess = foldEvents(emptySession('ws'), backfilled);
const bOut = html(h(MessageBubble, { message: bSess.messages[0] }));
check('the reopened pane renders the SAME row as the live one', bOut === hard.out, bOut);
const legacyEntry = { unit: 'u.scope', seq: 9, at: kill.at, level: 'hard', text: 'Command cargo build killed: Plafond mémoire 6 GB reached' };
const legacy = html(h(MessageBubble, { message: foldEvents(emptySession('ws'), [makeMemNotice({ seq: 2 }, legacyEntry)]).messages[0] }));
check('an entry persisted BEFORE the dedicated row (text only) still renders as the Plafond row, red, one text segment', legacy.includes('data-notice="memory-cap"') && legacy.includes('is-hard') && legacy.includes('Command cargo build killed: Plafond mémoire 6 GB reached') && !legacy.includes('data-memcap-chip'), legacy);
const plainWarning = html(h(NoticeRow, { message: { id: 'n', role: 'system', noticeKind: 'warning', text: 'API retry', at: 1, done: true } }));
check('CONTROL — an ordinary Warning notice is untouched (still the generic Warning row)', plainWarning.includes('data-notice="warning"') && plainWarning.includes('av-notice-warning') && !plainWarning.includes('memory-cap'), plainWarning);
const bare = html(h(NoticeRow, { message: { id: 'n2', role: 'system', noticeKind: 'memory-cap', text: 'x', done: true } }));
check('a memory-cap message with no structured row and no time never throws: one red text row, no time tag', bare.includes('data-notice="memory-cap"') && !bare.includes('av-notice-tag'), bare);

console.log(`\nmemory-cap-row-render-smoke: ${failures === 0 ? 'all checks passed' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);

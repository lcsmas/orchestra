#!/usr/bin/env node
// Resolve a theme.css conflict where BOTH sides appended an independent block.
//
// This shape recurs constantly in the port swarm: N agents each append a new
// section at EOF, so every branch after the first conflicts on the same hunk.
// Keeping both sides in order is correct — but only when the two sides declare
// DISJOINT selectors and the result still parses. Doing it by hand ate a
// closing brace once (446 open / 445 close) because a conflict block can begin
// or end MID-RULE, with the shared brace living outside the markers.
//
// So this script refuses rather than guesses:
//   - bails if the two sides share any selector (a real conflict needing a human)
//   - repairs the mid-rule split explicitly instead of concatenating blindly
//   - verifies brace balance after, and restores the file if it broke
//
// Usage: node scripts/resolve-css-append.mjs <file>

import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: resolve-css-append.mjs <file>');
  process.exit(2);
}

const original = readFileSync(file, 'utf8');
const re = /<<<<<<< [^\n]*\n(.*?)\n=======\n(.*?)\n>>>>>>> [^\n]*\n/s;
const m = original.match(re);
if (!m) {
  console.error('no conflict block found');
  process.exit(2);
}

const [, ours, theirs] = m;

const selectors = (t) => new Set([...t.matchAll(/^\s*([.#][A-Za-z0-9_.#>: -]+)\s*\{/gm)].map((x) => x[1].trim()));
const a = selectors(ours);
const b = selectors(theirs);
const overlap = [...a].filter((s) => b.has(s));

if (overlap.length) {
  console.error(`REFUSING: ${overlap.length} selector(s) declared on BOTH sides — not a pure append:`);
  overlap.forEach((s) => console.error(`  ${s}`));
  console.error('A human must decide which rule wins.');
  process.exit(1);
}

// A conflict block can start or end mid-rule; the balancing brace then sits
// OUTSIDE the markers and is shared by both sides. Close ours before appending
// theirs so theirs' final rule inherits that shared brace.
const openDelta = (t) => (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
const ourDelta = openDelta(ours);
const bridge = ourDelta > 0 ? '\n}\n'.repeat(ourDelta) : '\n';

const merged = `${ours}${bridge}${theirs}\n`;
const next = original.slice(0, m.index) + merged + original.slice(m.index + m[0].length);

const open = (next.match(/\{/g) ?? []).length;
const close = (next.match(/\}/g) ?? []).length;
if (open !== close) {
  console.error(`REFUSING: braces unbalanced after merge (${open} open, ${close} close). File left untouched.`);
  process.exit(1);
}
if (/<<<<<<<|>>>>>>>/.test(next)) {
  console.error('REFUSING: conflict markers remain (more than one block?). File left untouched.');
  process.exit(1);
}

writeFileSync(file, next);
console.log(`resolved: kept both blocks (${a.size} + ${b.size} selectors, disjoint), braces ${open}/${close}`);

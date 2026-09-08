#!/usr/bin/env node
/**
 * T118.3 — the generated startup notice NAMES THE SWITCH STATES.
 *
 * The gate's disproof clause is the whole point: "the grep passes on a notice
 * that never mentions switches" is a marker as unspecific as its claim
 * (carry-forward 2). So this rig demands:
 *   POSITIVE control: switch ON  -> the ON string appears
 *   NEGATIVE control: switch OFF -> the OPPOSITE string appears (NOT merely the
 *                     absence of the ON string -- absence is not presence)
 *   SPECIFICITY arm : a notice that MENTIONS the switch name without stating a
 *                     state must be REJECTED.
 *
 * Usage: node --experimental-strip-types t118-3-notice.mjs <repoRoot>
 * RC 0 PASS · 1 FAIL · 20 rig could not run (no switch notice found at all).
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';

const repo = path.resolve(process.argv[2] || process.cwd());
const wsSrc = readFileSync(path.join(repo, 'src/main/workspaces.ts'), 'utf8');

let failures = 0;
const log = (ok, m) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${m}`); if (!ok) failures++; };

// Locate the notice script(s) #118 must have taught to name switch state.
// Enumerate the generated scripts rather than guessing one name.
const SCRIPT_CONSTS = [
  'SELF_MODIFY_INSTRUCTION_SCRIPT', 'RENAME_INSTRUCTION_SCRIPT', 'LINK_INSTRUCTION_SCRIPT',
  'ORCHESTRATOR_INSTRUCTION_SCRIPT', 'INBOX_INSTRUCTION_SCRIPT', 'FIELDGUIDE_INSTRUCTION_SCRIPT',
  'COMMS_RESURFACE_SCRIPT', 'ORCHESTRA_HOOK_SCRIPT',
];
const bodies = new Map();
for (const c of SCRIPT_CONSTS) {
  const i = wsSrc.indexOf(`const ${c} = \``);
  if (i < 0) continue;
  const start = wsSrc.indexOf('`', wsSrc.indexOf('=', i)) + 1;
  // find the closing backtick that is not escaped
  let j = start;
  while (j < wsSrc.length) { if (wsSrc[j] === '`' && wsSrc[j - 1] !== '\\') break; j++; }
  bodies.set(c, wsSrc.slice(start, j));
}
console.log(`generated script constants found: ${[...bodies.keys()].join(', ')}`);

// A switch-state notice must name a MECHANISM and a STATE. Look for both.
const SWITCH_HINT = /switch|mechanism|bus[- ]wake|shadow[- ]mirror|COUNTED|counted, not fired/i;
const STATE_ON = /(?<![A-Za-z])(ON|ENABLED|FIRED)(?![A-Za-z])/;   // case-SENSITIVE: /\bON\b/i matched the English word "on"
const STATE_OFF = /(?<![A-Za-z])(OFF|DISABLED|COUNTED)(?![A-Za-z])|counted, not fired/;   // case-SENSITIVE

const carriers = [...bodies.entries()].filter(([, b]) => SWITCH_HINT.test(b));
if (carriers.length === 0) {
  console.log('NO generated script mentions switch state.');
  console.log('T118.3 RESULT: NOT-IMPLEMENTED (rig could not run — #118 has not landed the notice)');
  process.exit(20);   // never readable as a pass
}
for (const [name, body] of carriers) {
  // SELF-CHECK: the body we captured must actually contain the hint that
  // selected it. A mismatch means the template-literal scan drifted -- that is
  // a RIG FAULT, and it must never be reported as a candidate verdict.
  const hit = body.match(SWITCH_HINT);
  if (!hit) {
    console.error(`RIG_CANNOT_RUN: ${name} was selected as a carrier but its captured body does not contain the hint — the backtick scan drifted (captured ${body.length} chars)`);
    process.exit(20);
  }
  console.log(`--- ${name} mentions switch state (hint: "${hit[0]}") ---`);
  log(STATE_ON.test(body) || STATE_OFF.test(body),
    `${name}: names an actual STATE, not merely the word "switch"`);
}

// ── SPECIFICITY ARM (the disproof clause) ────────────────────────────────────
// Feed the SAME predicate a notice that MENTIONS the subject without stating a
// state. It must be REJECTED. If it passes, the marker is unspecific and every
// green above is decoration.
const decoy = 'echo "[orchestra] This workspace has switches and mechanisms. See the docs."';
const decoyNamesState = STATE_ON.test(decoy) || STATE_OFF.test(decoy);
log(!decoyNamesState,
  `SPECIFICITY: a notice that MENTIONS "switches"/"mechanisms" without a state is REJECTED (decoy matched=${decoyNamesState})`);

// And the mirror: a notice that DOES state a value must be ACCEPTED, proving the
// predicate can say yes (a predicate that rejects everything is also useless).
const onSample  = 'echo "[orchestra] bus-wake: ON — wakes are FIRED"';
const offSample = 'echo "[orchestra] bus-wake: OFF — COUNTED, not fired"';
log(STATE_ON.test(onSample),   `POSITIVE control: an ON notice is recognised`);
log(STATE_OFF.test(offSample), `NEGATIVE control: an OFF notice is recognised by its OWN string ("COUNTED, not fired"), not by absence`);
log(!STATE_ON.test('echo "[orchestra] nothing to report"'),
    `ZERO control: an unrelated notice matches neither state`);

// The decisive arm: the notice line ITSELF must state a value. Locate every
// line in the whole source that mentions the switch subject and require at
// least one of them to name a state -- on the REAL tree, not on a decoy.
const subjectLines = wsSrc.split('\n').filter(l => SWITCH_HINT.test(l) && l.includes('echo'));
console.log(`notice lines mentioning the switch subject: ${subjectLines.length}`);
for (const l of subjectLines) console.log(`   > ${l.trim().slice(0, 110)}`);
log(subjectLines.length > 0, 'at least one generated NOTICE line mentions the switch subject');
log(subjectLines.some(l => STATE_ON.test(l) || STATE_OFF.test(l)),
  'REAL-TREE ARM: a notice line that mentions switches also NAMES A STATE (ON/OFF/COUNTED), not merely the subject');

console.log(failures === 0 ? 'T118.3 RESULT: PASS' : `T118.3 RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

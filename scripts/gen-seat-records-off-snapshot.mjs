#!/usr/bin/env node
// #590: freeze the render of the coordinator skill + every v2 reference for the whole switch matrix (seatRecords absent/off) as sha256 — the byte-identity oracle of
// `fanout-role-texts.test.ts`. Run ONCE on master's text (before #590's edits); never regenerate to make a red test green.
//   node --experimental-strip-types --no-warnings scripts/gen-seat-records-off-snapshot.mjs > src/shared/fixtures/seat-records-off-snapshot.json
import { createHash } from 'node:crypto';
import { renderVerifiedFanoutSkill, verifiedFanoutReferenceWanted } from '../src/shared/verified-fanout-skill.ts';
import { renderSwitchBlocks } from '../src/shared/fanout-switch-render.ts';
import { VERIFIED_FANOUT_FILES, VERIFIED_FANOUT_V2_REFERENCES } from '../src/shared/verified-fanout-files.ts';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const AXES = { earlyGate: ['on', 'off'], acceptance: ['on', 'off'], minorPolicy: ['legacy', 'refuse', 'spec', 'demonstrated'], verifier: ['on', 'off'], preNominationChecks: ['on', 'off'] };
const combos = [{}];
for (const [k, vs] of Object.entries(AXES)) { const next = []; for (const c of combos) for (const v of vs) next.push({ ...c, [k]: v }); combos.length = 0; combos.push(...next); }
const out = {};
for (const sw of combos) {
  const key = Object.entries(sw).map(([k, v]) => `${k}=${v}`).join(' ');
  const refs = [...VERIFIED_FANOUT_FILES, ...VERIFIED_FANOUT_V2_REFERENCES].filter((f) => verifiedFanoutReferenceWanted(f.path, sw)).map((f) => `${f.path}\n${f.path.endsWith('.md') ? renderSwitchBlocks(f.content, sw) : f.content}`);
  out[key] = { skill: sha(renderVerifiedFanoutSkill(sw)), refs: sha(refs.join('\n\0\n')), refFiles: refs.length };
}
// the default render (no switch given) and the two profiles' defaults are among the matrix; the bare default call is pinned too
out['(default)'] = { skill: sha(renderVerifiedFanoutSkill()), refs: null, refFiles: null };
process.stdout.write(JSON.stringify(out, null, 1) + '\n');

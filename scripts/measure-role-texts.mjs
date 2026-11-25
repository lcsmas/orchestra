#!/usr/bin/env node
// #590: words (wc -w) + bytes of every role text, for a few switch sets — the "sizes before / after" of the ticket.
//   node --experimental-strip-types --no-warnings scripts/measure-role-texts.mjs
import { renderVerifiedFanoutSkill } from '../src/shared/verified-fanout-skill.ts';
import { renderSwitchBlocks } from '../src/shared/fanout-switch-render.ts';
import { VERIFIED_FANOUT_V2_REFERENCES } from '../src/shared/verified-fanout-files.ts';
const wc = (t) => t.split(/\s+/).filter(Boolean).length;
const SETS = {
  'default (v0.5.375)': {},
  'this vague (verifier=off preNominationChecks=on)': { verifier: 'off', preNominationChecks: 'on' },
  'max (demonstrated, acceptance=on, verifier=off, preNom=on)': { minorPolicy: 'demonstrated', acceptance: 'on', verifier: 'off', preNominationChecks: 'on' },
};
let roles = {};
try {
  const r = await import('../src/shared/fanout-reviewer-skill.ts'); const i = await import('../src/shared/fanout-implementer-skill.ts');
  roles = { reviewer: r.renderFanoutReviewerSkill, implementer: i.renderFanoutImplementerSkill };
} catch { /* before #590: the role files do not exist */ }
for (const [label, sw0] of Object.entries(SETS)) {
  for (const seat of process.env.SEAT ? [process.env.SEAT] : ['off', 'on']) {
    const sw = { ...sw0, seatRecords: seat };
    let skill; try { skill = renderVerifiedFanoutSkill(sw); } catch { continue; }
    const row = { SKILL: [wc(skill), Buffer.byteLength(skill)] };
    for (const f of VERIFIED_FANOUT_V2_REFERENCES) { if (f.path.endsWith('acceptance-tests.md') && sw.acceptance !== 'on') continue; const t = renderSwitchBlocks(f.content, sw); row[f.path.replace('references/', '')] = [wc(t), Buffer.byteLength(t)]; }
    for (const [n, fn] of Object.entries(roles)) { if (seat !== 'on') continue; const t = fn(sw); row[`role:${n}`] = [wc(t), Buffer.byteLength(t)]; }
    console.log(`## ${label} · seatRecords=${seat}`); for (const [k, [w, b]] of Object.entries(row)) console.log(`  ${k.padEnd(28)} ${String(w).padStart(5)} words ${String(b).padStart(7)} B`);
  }
}

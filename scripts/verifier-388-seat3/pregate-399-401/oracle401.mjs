// Seat 3 — #401 independent oracle for decideSpawnProfile: a from-scratch reimplementation of the stated rule, ~300k seeded adversarial inputs, plus leak properties.
// Usage: node --experimental-strip-types oracle401.mjs <path-to-spawn-profile.ts> [label]
import path from 'node:path';
const target = path.resolve(process.argv[2]);
const label = process.argv[3] ?? 'subject';
const { decideSpawnProfile } = await import(target);
let seed = 0x9e3779b9; const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const SENT = () => 'zqx' + Math.floor(rnd() * 1e9).toString(36);
const NAMES = ['Staging admin', 'Prod', 'prod', 'PROD', 'İstanbul', 'istanbul', 'Straße', 'STRASSE', 'Kelvin', 'kelvin', 'Work', ' Work ', '', 'a'.repeat(300), 'Zoë', 'zoë', 'ß', 'SS', 'null', 'undefined', '__proto__', 'constructor', 'bp-0123456789ab', 'x‮y', 'tab\tname', 'new\nline'];
const mkId = () => 'bp-' + [...Array(12)].map(() => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
const trimmed = (s) => s.trim();
const lower = (s) => s.toLowerCase();
function oracle(i) {
  if (i.requested === undefined) return { kind: 'none' };
  const req = trimmed(i.requested);
  if (i.detached) return { kind: 'refused', reason: 'detached' };
  if (!i.caller) return { kind: 'refused', reason: 'no-caller' };
  if (!i.callerVouched) return { kind: 'refused', reason: 'unvouched' };
  const rid = i.caller.browserProfileId;
  const held = rid === undefined ? undefined : i.profiles.find((p) => p.id === rid);
  if (!held) return { kind: 'refused', reason: 'holds-none' };
  const match = req === held.id || (req !== '' && lower(req) === lower(held.name));
  if (!match) return { kind: 'refused', reason: 'not-held' };
  if (i.deleting.includes(held.id)) return { kind: 'refused', reason: 'deleting' };
  return { kind: 'honoured', profileId: held.id };
}
let n = 0, bad = 0, badDecision = 0, badLeak = 0; const firstBad = [];
const classes = {};
for (let it = 0; it < 300000; it++) {
  const np = Math.floor(rnd() * 5);
  const profiles = [...Array(np)].map(() => ({ id: rnd() < 0.1 ? 'BP-' + mkId().slice(3) : mkId(), name: rnd() < 0.4 ? SENT() : pick(NAMES), createdAt: 1 }));
  const dupId = np > 1 && rnd() < 0.05; if (dupId) profiles[1] = { ...profiles[1], id: profiles[0].id };
  const heldIx = np ? Math.floor(rnd() * np) : -1;
  const recorded = rnd() < 0.12 ? mkId() /* dangling */ : rnd() < 0.15 ? undefined : heldIx >= 0 ? profiles[heldIx].id : undefined;
  const any = profiles.length ? pick(profiles) : { id: mkId(), name: pick(NAMES) };
  const held0 = profiles.find((p) => p.id === recorded);
  const reqPool = [undefined, '', '   ', any.id, any.id.toUpperCase(), ' ' + any.id + ' ', any.name, any.name.toUpperCase(), lower(any.name), ' ' + any.name + '\n', held0?.id, held0?.name, held0 ? held0.name + 'x' : 'x', pick(NAMES), mkId(), any.id.slice(0, 8), 'bp-', '*', '%', '.*', '\u0000', 'x'.repeat(100)];
  const input = {
    requested: pick(reqPool),
    detached: rnd() < 0.12,
    caller: rnd() < 0.1 ? undefined : { browserProfileId: recorded },
    callerVouched: rnd() < 0.85,
    profiles,
    deleting: rnd() < 0.2 ? [held0?.id ?? mkId(), ...(rnd() < 0.3 ? [any.id] : [])] : [],
  };
  const want = oracle(input);
  const got = decideSpawnProfile(JSON.parse(JSON.stringify(input, (k, v) => (v === undefined ? '__U__' : v)), (k, v) => (v === '__U__' ? undefined : v)));
  n++; const key = want.kind + (want.reason ? ':' + want.reason : ''); classes[key] = (classes[key] ?? 0) + 1;
  let problem = null;
  if (got.kind !== want.kind || (want.reason && got.reason !== want.reason) || (want.kind === 'honoured' && got.profileId !== want.profileId)) problem = `decision differs: want ${JSON.stringify(want)} got ${JSON.stringify({ kind: got.kind, reason: got.reason, profileId: got.profileId })}`;
  // property: honoured never carries an id other than the caller's recorded one
  if (!problem && got.kind === 'honoured' && got.profileId !== recorded) problem = 'honoured a profile the caller does not record';
  // leak property: with the caller's own typed echo removed, a refusal names no profile id/name other than the HELD one (and none at all unless vouched + holding)
  if (!problem && got.kind === 'refused') {
    const echo = JSON.stringify(String(input.requested ?? '').trim().slice(0, 40));
    const msg = got.message.split(echo).join('');
    const mayName = want.reason === 'not-held' || want.reason === 'deleting' ? held0 : undefined;
    for (const p of profiles) {
      if (p === mayName || p.id === mayName?.id) continue;
      if (!p.name.startsWith('zqx')) continue;               // only sentinel names are unambiguous in the template text
      if (p.name !== mayName?.name && msg.includes(p.name)) { problem = `message names profile ${JSON.stringify(p.name)} (not the held one): ${got.message}`; break; }
      if (msg.includes(p.id) && p.id !== mayName?.id) { problem = `message contains profile id ${p.id}: ${got.message}`; break; }
    }
  }
  if (problem) { bad++; if (problem.startsWith('decision') || problem.startsWith('honoured')) badDecision++; else badLeak++; if (firstBad.length < 3) firstBad.push({ problem, input: JSON.stringify(input).slice(0, 400) }); }
}
console.log(`ORACLE ${label}: ${n} cases, ${bad} disagreements (${badDecision} decision, ${badLeak} leak); classes ${JSON.stringify(classes)}`);
for (const b of firstBad) console.log('  FIRST-BAD', b.problem.slice(0, 300), '\n    input', b.input);
process.exit(bad ? 1 : 0);

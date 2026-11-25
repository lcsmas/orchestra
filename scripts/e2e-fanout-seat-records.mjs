#!/usr/bin/env node
// #587 rig (vague #585, ledger #591: I1 + I2) — the `seatRecords` switch and the plan/interfaces rules: every clause MUTATED in a scratch copy of src/ and
// src/cli/fanout-seat-records.test.ts (production paths: `runFanout` state verbs, parseState, applyTicketPatch, the show render) must go RED.
// Light: no Electron, no network, no tokens; the scratch copy lives under $TMPDIR; the repo is never written.
//   node scripts/e2e-fanout-seat-records.mjs            control: the unpatched copy must be GREEN (0 fail, 0 skipped)
//   node scripts/e2e-fanout-seat-records.mjs --mutants  each mutant (exact string, must occur ONCE in its file — else REFUSED as stale) must be KILLED (≥1 test FAILs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-seat-rig-'));
if (!path.resolve(scratch).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
fs.cpSync(path.join(ROOT, 'src'), path.join(scratch, 'src'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ type: 'module' })); // quiet the module-type reparse warning
const TESTS = ['src/cli/fanout-seat-records.test.ts'].map((f) => path.join(scratch, f));

function run() {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...TESTS], { cwd: scratch, encoding: 'utf8', timeout: 240_000, env: { ...process.env, TMPDIR: tmpBase } });
  const out = `${r.stdout}\n${r.stderr}`;
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return { pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests'), out };
}

// [name, file, from, to] — `from` must occur exactly once in `file`.
const S = 'src/shared/fanout-state.ts';
const C = 'src/cli/fanout-state.ts';
const B = 'src/shared/fanout-brief-common.ts';
const mutants = [
  // I1 — the switch
  ['default seatRecords flipped to on (v0.5.375 profile)', S, "preNominationChecks: 'off', seatRecords: 'off' }; // #559: the v0.5.375 profile", "preNominationChecks: 'off', seatRecords: 'on' }; // #559: the v0.5.375 profile"],
  ['default seatRecords flipped to on (v0.5.378 profile)', S, "minorPolicy: 'spec', verifier: 'on', preNominationChecks: 'off', seatRecords: 'off' };", "minorPolicy: 'spec', verifier: 'on', preNominationChecks: 'off', seatRecords: 'on' };"],
  ['SWITCH_VALUES drops seatRecords (the switch is unknown)', S, ", preNominationChecks: ['on', 'off'], seatRecords: ['on', 'off'] } as const;", ", preNominationChecks: ['on', 'off'] } as const;"],
  ['seatRecordsOn reads off always', S, "switchesOf(s).seatRecords === 'on';", "switchesOf(s).seatRecords === 'never';"],
  ['seatRecordsOn reads on always', S, "switchesOf(s).seatRecords === 'on';", "switchesOf(s).seatRecords !== 'never';"],
  ['the switches line prints a default-off seatRecords (byte-identity broken)', S, "const shown = SWITCH_NAMES.filter((n) => n !== 'seatRecords' || sw[n] !== 'off' || switchSourceOf(state, n) !== 'default');", "const shown = SWITCH_NAMES;"],
  ['the switches line hides an explicit seatRecords', S, "n !== 'seatRecords' || sw[n] !== 'off' || switchSourceOf(state, n) !== 'default');", "n !== 'seatRecords');"],
  // I1 — the new verbs under off
  ['off: a seatRecords patch key is accepted', S, "for (const k of SEAT_PATCH_KEYS) if (k in patch && !seat) throw seatOff(", "for (const k of SEAT_PATCH_KEYS) if (k in patch && false) throw seatOff("],
  ['off: --plan is accepted', S, "if (!seatRecordsOn(st)) throw seatOff(mode === 'add' ? '--plan-add' : '--plan');", ""],
  ['off: a stored depsDeclared is written (state file differs from master)', S, "    if (seat) { // #587: giving the dependencies (even none) declares them;", "    if (true) { // #587: giving the dependencies (even none) declares them;"],
  ['refusals exit 1 instead of 2', C, "return { code: 2, stdout: '', stderr: `${e.message}\\n` }; // #587", "return { code: 1, stdout: '', stderr: `${e.message}\\n` }; // #587"],
  ['a refusal does not start with its bracketed name', S, "super(`[${refusal}] ${detail}`);", "super(detail);"],
  ['`--depends-on none` is a ticket id under on', C, "      if (p.vals['--depends-on'].trim().toLowerCase() === 'none') patch.dependsOn = [];", "      if (false) patch.dependsOn = [];"],
  ['`--depends-on none` is declared empty under off too', C, "if (before && seatRecordsOn(before) && p.vals['--depends-on']", "if (before && p.vals['--depends-on']"],
  // I2 — the plan
  ['plan: --status started is not checked', S, "const starts = 'status' in patch && (next.status === 'started' || next.status === 'nominated' || next.status === 'gated');", "const starts = 'status' in patch && (next.status === 'nominated' || next.status === 'gated');"],
  ['plan: --status nominated is not checked', S, "const starts = 'status' in patch && (next.status === 'started' || next.status === 'nominated' || next.status === 'gated');", "const starts = 'status' in patch && (next.status === 'started' || next.status === 'gated');"],
  ['plan: --status gated is not checked', S, "const starts = 'status' in patch && (next.status === 'started' || next.status === 'nominated' || next.status === 'gated');", "const starts = 'status' in patch && (next.status === 'started' || next.status === 'nominated');"],
  ['plan: the whole check is skipped', S, "    if (starts || spawns) {\n      const missing = planMissing(out);", "    if (false) {\n      const missing = planMissing(out);"],
  ['plan: a missing plan is not listed', S, "if (!state.plan) out.push('no plan declared", "if (false) out.push('no plan declared"],
  ['plan: a plan ticket absent from the state is not listed', S, "else for (const id of state.plan.tickets) if (!state.tickets[id]) out.push(", "else for (const id of state.plan.tickets) if (false) out.push("],
  ['plan: undeclared dependencies are not listed', S, "if (t.depsDeclared !== true) out.push(", "if (false) out.push("],
  ['plan: a depended-on ticket with no interface is not listed', S, "if (!state.tickets[d]?.iface) needed.set(d,", "if (false) needed.set(d,"],
  ['plan: a dropped ticket is demanded its dependencies', S, "const live = Object.entries(state.tickets).filter(([, t]) => t.status !== 'dropped');", "const live = Object.entries(state.tickets);"],
  ['plan: an interface is demanded of a ticket nobody depends on', S, "const needed = new Map<string, string[]>();", "const needed = new Map<string, string[]>(Object.keys(state.tickets).map((k) => [k, ['*']] as [string, string[]]));"],
  ['plan: depending declares nothing (depsDeclared never set)', S, "      next.depsDeclared = true;\n", ""],
  ['plan: the listed items do not name the ticket', S, "out.push(`${id}: dependencies not declared — state set ${id}", "out.push(`dependencies not declared — state set ${id}"],
  ['plan: --plan re-declared after the first spawn is accepted', S, "const locked = st.plan ? switchesLockedWhy(st) : null;", "const locked = null as string | null;"],
  ['plan: --plan-add is refused after the first spawn too', S, "  return { ...st, plan: { tickets: [...new Set([...(st.plan?.tickets ?? []), ...list])],", "  if (switchesLockedWhy(st)) throw new SeatRefusal('plan-frozen', 'no');\n  return { ...st, plan: { tickets: [...new Set([...(st.plan?.tickets ?? []), ...list])],"],
  ['plan: --plan-add replaces instead of appending', S, "tickets: [...new Set([...(st.plan?.tickets ?? []), ...list])]", "tickets: list"],
  ['plan: an empty --plan is accepted', S, "  if (list.length === 0) throw new FanoutStateError(`${mode === 'add'", "  if (false) throw new FanoutStateError(`${mode === 'add'"],
  ['plan: a held interface no longer lets a dependent start', S, "&& !(seat && open.every((u) => out.tickets[u]?.iface))) {", "&& true) {"],
  // I2 — the interface
  ['interface: a blank text is accepted', S, "    if (!text.trim()) throw new SeatRefusal('interface-blank',", "    if (false) throw new SeatRefusal('interface-blank',"],
  ['interface: a change with no reason is accepted', S, "if (typeof reason !== 'string' || !reason.trim()) throw new SeatRefusal('interface-reason-missing',", "if (false) throw new SeatRefusal('interface-reason-missing',"],
  ['interface: a blank reason is accepted', S, "if (typeof reason !== 'string' || !reason.trim()) throw new SeatRefusal('interface-reason-missing',", "if (typeof reason !== 'string') throw new SeatRefusal('interface-reason-missing',"],
  ['interface: v1 needs a reason', S, "    if (!cur) next.iface = { version: 1, text, history: [] };", "    if (!cur && !(typeof patch.interfaceReason === 'string' && patch.interfaceReason.trim())) throw new SeatRefusal('interface-reason-missing', 'v1');\n    if (!cur) next.iface = { version: 1, text, history: [] };"],
  ['interface: the version does not increase', S, "next.iface = { version: cur.version + 1, text,", "next.iface = { version: cur.version, text,"],
  ['interface: the superseded version is not kept', S, "history: [...cur.history, { version: cur.version, text: cur.text, reason:", "history: [...cur.history.slice(0, 0), { version: cur.version, text: cur.text, reason:"],
  ['interface: the reason of the change is not kept', S, "reason: lineOf(reason, `${id}: --interface-reason`, 1000).trim(), at: now }] };", "reason: null, at: now }] };"],
  ['interface: the same text is a new version', S, "    else if (cur.text !== text) {", "    else {"],
  ['interface: --interface-reason alone is accepted', S, "if ('interfaceReason' in patch && !('interface' in patch)) throw", "if (false) throw"],
  ['interface: the interface text of CRLF is not normalised', S, "patch.interface.replace(/\\r\\n/g, '\\n') : '';", "patch.interface : '';"],
  ['interface: --interface - does not read stdin', C, "if (v === '-') return deps.readStdin();", ""],
  ['interface: --interface <file> does not read the file', C, "if (st.isFile() && st.size <= 100_000) return fs.readFileSync(abs, 'utf8');", ""],
  // I2 — follows
  ['follows: a nomination naming no version is accepted', S, "if (v === undefined) throw new SeatRefusal('interface-unfollowed',", "if (v === undefined) continue; if (false) throw new SeatRefusal('interface-unfollowed',"],
  ['follows: an older version is accepted', S, "if (v !== f.version) throw new SeatRefusal('interface-stale',", "if (false) throw new SeatRefusal('interface-stale',"],
  ['follows: the stale refusal does not carry the reason', S, "(${ifaceChanges(f, v)}) — rebuild", "— rebuild"],
  ['follows: the stale reason lists every change, not those after the followed version', S, "f.history.filter((h) => h.version >= v).map(", "f.history.map("],
  ['follows: only `nominated` is checked (gated escapes)', S, "if (((next.status === 'nominated' || next.status === 'gated') && ('status' in patch || 'head' in patch || 'verdict' in patch || 'follows' in patch)) || merging) {", "if ((next.status === 'nominated' && ('status' in patch || 'head' in patch || 'verdict' in patch || 'follows' in patch)) || merging) {"],
  ['follows: checked only when the status itself is patched (a head update escapes)', S, "('status' in patch || 'head' in patch || 'verdict' in patch || 'follows' in patch)) || merging) {\n      for", "('status' in patch)) || merging) {\n      for"],
  ['follows: a follow on a version that does not exist is accepted', S, "if (v > f.version) throw new SeatRefusal('follows-invalid',", "if (false) throw new SeatRefusal('follows-invalid',"],
  ['follows: a follow on an upstream not in dependsOn is accepted', S, "if (!next.dependsOn.includes(up)) throw new SeatRefusal('follows-invalid',", "if (false) throw new SeatRefusal('follows-invalid',"],
  ['follows: a follow on an upstream with no interface is accepted', S, "if (!f) throw new SeatRefusal('follows-invalid',", "if (false) throw new SeatRefusal('follows-invalid',"],
  ['follows: a dropped dependency keeps its follow', S, "if (kept.length) next.follows = Object.fromEntries(kept); else delete next.follows;", ""],
  ['follows: --follows replaces the record instead of merging', S, "next.follows = { ...(prev.follows ?? {}), ...followsOf(patch.follows, id) };", "next.follows = followsOf(patch.follows, id);"],
  ['follows: the value parser accepts a bare id', C, "const m = /^([^=]+)=(\\d+)$/.exec(part);", "const m = /^([^=]+)=?(\\d*)$/.exec(part);"],
  // the stored shape
  ['parse: a blank iface text loads', S, "if (typeof v.text !== 'string' || !v.text.trim()) throw new FanoutStateError(`${where}: iface.text must", "if (false) throw new FanoutStateError(`${where}: iface.text must"],
  ['parse: a history that does not match the version loads', S, "v.history.length !== (v.version as number) - 1) throw", "false) throw"],
  ['parse: an unknown iface field loads', S, "refuseUnknown(v, new Set(['version', 'text', 'history']), `${where} iface`);", ""],
  ['parse: a follows of 0 loads', S, "if (!Number.isInteger(n) || (n as number) < 1) throw new FanoutStateError(`${where}: follows[", "if (false) throw new FanoutStateError(`${where}: follows["],
  ['parse: a non-boolean depsDeclared loads', S, "t.depsDeclared === undefined || t.depsDeclared === false ? {} : (() => { throw new FanoutStateError(`ticket ${id}: depsDeclared must be a boolean`); })()", "{}"],
  ['parse: depsDeclared:false is refused (I2 types it boolean)', S, "t.depsDeclared === undefined || t.depsDeclared === false ? {} :", "t.depsDeclared === undefined ? {} :"],
  ['plan: a recorded implementer is not a spawn after the first one', S, "const spawns = (!!next.implementer && next.implementer !== prev.implementer) ||", "const spawns = false ||"],
  ['plan: a recorded verifier is not a spawn after the first one', S, " || (!!next.verifier && next.verifier !== prev.verifier)", ""],
  ['plan: the acceptance writer spawn (claimAcceptor) is not a plan-checked spawn', 'src/shared/fanout-acceptance.ts', "if (seatRecordsOn(state)) { // #587: the writer spawn is a spawn", "if (false) { // #587: the writer spawn is a spawn"],
  ['plan: `none` in a dependency list is a ticket id', S, "if (seat && next.dependsOn.includes('none')) throw", "if (false) throw"],
  ['follows: a stale follow merges', S, "const merging = next.status === 'merged' && prev.status !== 'merged' && 'status' in patch;", "const merging = false;"],
  ['follows: a merge with no recorded follow is refused as unfollowed', S, "        if (v === undefined && merging) continue;\n", ""],  ['parse: an empty plan loads', S, "if (tickets.length === 0) throw new FanoutStateError('plan.tickets is empty');", ""],
  ['parse: the stored plan is dropped on read', S, "    ...(raw.plan !== undefined ? { plan: planOf(raw.plan) } : {}),\n", ""],
  ['parse: a stored iface is dropped on read', S, "      ...(t.iface !== undefined ? { iface: ifaceOfStored(t.iface, `ticket ${id}`) } : {}),\n", ""],
  // the render
  // PR A — the run's decisions + the shared brief helpers
  ['decision: a blank text is accepted', S, "  if (!t) throw new SeatRefusal('decision-blank',", "  if (false) throw new SeatRefusal('decision-blank',"],
  ['decision: accepted under off', S, "  if (!seatRecordsOn(st)) throw seatOff('--run-decision');", ""],
  ['decision: numbered from the wrong base', S, "decisions: [...list, { n: list.length + 1, text: t, by, at: now }]", "decisions: [...list, { n: list.length, text: t, by, at: now }]"],
  ['decision: the recorder is not kept', S, "{ n: list.length + 1, text: t, by, at: now }", "{ n: list.length + 1, text: t, by: 'coordinator', at: now }"],
  ['decision: a decision replaces the earlier ones', S, "decisions: [...list, {", "decisions: [{"],
  ['decision: any caller records it', C, "if (seatRecordsOn(cur) && caller !== dr.run) throw new SeatRefusal('decision-caller'", "if (false) throw new SeatRefusal('decision-caller'"],
  ['decision: no identity is accepted', C, "caller !== dr.run) throw new SeatRefusal('decision-caller'", "caller && caller !== dr.run) throw new SeatRefusal('decision-caller'"],
  ['decision: --run-decision takes a ticket', C, "if (ticket || Object.keys(p.vals).some((k) => k !== '--run-decision' && k !== '--run')) throw", "if (false) throw"],
  ['decision: --run-decision does not read stdin / a file', C, "const text = readTextArg(p.vals['--run-decision'], deps);", "const text = p.vals['--run-decision'];"],
  ['decision: state show lists none', C, "const decisions = s.decisions?.length ?", "const decisions = false ?"],
  ['decision: a stored gap in the numbering loads', S, "if (d.n !== i + 1) throw new FanoutStateError(`decisions[${i}].n must be ${i + 1}`);", ""],
  ['decision: a stored blank decision loads', S, "if (typeof d.text !== 'string' || !d.text.trim()) throw new FanoutStateError(`decisions[${i}].text must be non-blank`);", ""],
  ['decision: a stored empty list loads', S, "if (!Array.isArray(v) || v.length === 0) throw new FanoutStateError('decisions must be", "if (!Array.isArray(v)) throw new FanoutStateError('decisions must be"],
  ['decision: the stored decisions are dropped on read', S, "    ...(raw.decisions !== undefined ? { decisions: decisionsOf(raw.decisions) } : {}),\n", ""],
  ['brief-common: briefHash is not sha256', B, "createHash('sha256')", "createHash('sha1')"],
  ['brief-common: the decisions are not numbered', B, "${x.n}. ${x.text}", "${x.text}"],
  ['brief-common: no decision is said as nothing', B, "return \"Decisions of the run: none recorded.\";", "return '';"],
  ['brief-common: the switches line reads the defaults', B, "const sw = switchesOf(state);", "const sw = switchesOf(undefined);"],
  ['brief-common: the interface changes are not shown', B, "const changes = f.history.map(", "const changes = [].map("],
  ['brief-common: a missing interface is not said', B, "if (!f) return `### ${id}: no interface declared`;", "if (!f) return '';"],
  ['brief-common: only the first interface is rendered', B, "const parts = ids.map((id) => {", "const parts = ids.slice(0, 1).map((id) => {"],
  ['decision: the env-asserted id is accepted as the coordinator', C, "const caller = (deps.vouchedCaller ?? '').trim();", "const caller = (deps.vouchedCaller ?? deps.env.ORCHESTRA_WS_ID ?? '').trim();"],
  ['decision: an unvouched caller (null) is the run', C, "const caller = (deps.vouchedCaller ?? '').trim();", "const caller = (deps.vouchedCaller ?? dr.run).trim();"],
  ['decision: the count is not bounded', S, "  if (list.length >= DECISIONS_MAX) throw new SeatRefusal('decisions-full',", "  if (false) throw new SeatRefusal('decisions-full',"],
  ['decision: the total size is not bounded', S, "  if (total + t.length > DECISIONS_TOTAL_MAX) throw new SeatRefusal('decisions-full',", "  if (false) throw new SeatRefusal('decisions-full',"],
  ['depends-on: an empty value declares an empty list', C, "      else if (!p.vals['--depends-on'].split(',').some((x) => x.trim())) throw new FanoutStateError(", "      else if (false) throw new FanoutStateError("],
  ['index: --run-decision is not vouched by the host', 'src/cli/index.ts', "fanoutDeps.vouchedCaller = hostIdentity?.source === 'host' ?", "fanoutDeps.vouchedCaller = true ?"],
  ['index: --run-decision never asks the host', 'src/cli/index.ts', "        await settleHostIdentity();\n        fanoutDeps.vouchedCaller", "        fanoutDeps.vouchedCaller"],
  ['show: the ready line is gone', C, "ready (todo, not started): ${ready.length", "ready: ${ready.length"],
  ['show: a started ticket is ready', S, "filter(([, t]) => t.status === 'todo')", "filter(([, t]) => true)"],
  ['show: ready is listed while the plan is incomplete', S, "  if (planMissing(state).length) return [];\n", ""],
  ['show: the seat lines are printed under off', C, "${seatRecordsOn(s) ? seatShow(s) : ''}", "${seatShow(s)}"],
  ['show: the seat lines are never printed', C, "${seatRecordsOn(s) ? seatShow(s) : ''}", "${''}"],
  ['help: seat-help prints nothing', C, "if (sub === 'seat-help') return { code: 0, stdout: `${SEAT_USAGE}\\n`, stderr: '' };", "if (sub === 'seat-help') return { code: 0, stdout: '', stderr: '' };"],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const base = run();
const baseOk = base.fail === 0 && base.skipped === 0 && base.pass >= 18 && base.pass === base.tests;
console.log(`control (unpatched copy): ${base.pass} pass / ${base.fail} fail / ${base.skipped} skipped → ${baseOk ? 'GREEN' : 'RED'}`);
if (!baseOk) { console.log(base.out.split('\n').filter((l) => /^not ok|error:/.test(l)).slice(0, 12).join('\n')); process.exit(1); }
if (!process.argv.includes('--mutants')) { fs.rmSync(scratch, { recursive: true, force: true }); process.exit(0); }

let survived = 0, refused = 0;
for (const [i, [name, file, from, to]] of mutants.entries()) {
  if (only && !name.includes(only)) continue;
  const f = path.join(scratch, file);
  const orig = fs.readFileSync(f, 'utf8');
  const n = orig.split(from).length - 1;
  if (n !== 1) { console.log(`M${String(i + 1).padStart(2, '0')} REFUSED (stale: the string occurs ${n}×, need exactly 1) — ${name}`); refused++; continue; }
  fs.writeFileSync(f, orig.replace(from, () => to));
  const r = run();
  fs.writeFileSync(f, orig);
  const killed = r.fail > 0 || Number.isNaN(r.pass); // a mutant that breaks loading (no TAP summary) is dead too
  if (!killed) survived++;
  console.log(`M${String(i + 1).padStart(2, '0')} ${killed ? 'KILLED' : 'SURVIVED'} (${r.pass} pass / ${r.fail} fail) — ${name}`);
}
const after = run(); // the restore is real: the copy is green again
const same = after.fail === 0 && after.pass === base.pass;
console.log(`\n${mutants.length - survived - refused}/${mutants.length} mutants killed, ${survived} survived, ${refused} refused; scratch restored → ${same ? 'GREEN' : 'RED'}`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(survived || refused || !same ? 1 : 0);

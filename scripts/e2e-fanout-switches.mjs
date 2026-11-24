#!/usr/bin/env node
// #554 rig — one switch per feature (earlyGate, acceptance, minorPolicy, verifier #563), frozen for the run: every clause of the switch table MUTATED in a scratch copy of src/ and the
// test files src/cli/fanout-switches.test.ts + fanout-verifier-switch.test.ts (production paths: state verbs, host spawn, acceptance verbs, gate, deliver, follow-up reader, skill render + installer) must go RED.
// Light: no Electron, no network, no tokens; the scratch copy lives under $TMPDIR; the repo is never written.
//   node scripts/e2e-fanout-switches.mjs            control: the unpatched copy must be GREEN (21+ tests, 0 fail, 0 skipped)
//   node scripts/e2e-fanout-switches.mjs --mutants  each mutant (exact string, must occur ONCE in its file — else REFUSED as stale) must be KILLED (≥1 test FAILs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-sw-rig-'));
if (!path.resolve(scratch).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
fs.cpSync(path.join(ROOT, 'src'), path.join(scratch, 'src'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ type: 'module' })); // quiet the module-type reparse warning
const TESTS = ['src/cli/fanout-switches.test.ts', 'src/cli/fanout-verifier-switch.test.ts'].map((f) => path.join(scratch, f)); // #563: the verifier arms live in their own file

function run() {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...TESTS], { cwd: scratch, encoding: 'utf8', timeout: 240_000, env: { ...process.env, TMPDIR: tmpBase } });
  const out = `${r.stdout}\n${r.stderr}`;
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return { pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests'), out };
}

// [name, file, from, to] — `from` must occur exactly once in `file`.
const S = 'src/shared/fanout-state.ts';
const A = 'src/shared/fanout-acceptance.ts';
const W = 'src/main/workspaces.ts';
const mutants = [
  ['default earlyGate flipped to off', S, "export const DEFAULT_SWITCHES: Readonly<Switches> = { earlyGate: 'on', acceptance: 'off', minorPolicy: 'legacy', verifier: 'on' }; // #559: the v0.5.375 profile", "export const DEFAULT_SWITCHES: Readonly<Switches> = { earlyGate: 'off', acceptance: 'off', minorPolicy: 'legacy', verifier: 'on' }; // #559: the v0.5.375 profile"],
  ['default acceptance flipped to on (the v0.5.378 default)', S, "{ earlyGate: 'on', acceptance: 'off', minorPolicy: 'legacy', verifier: 'on' }; // #559: the v0.5.375 profile", "{ earlyGate: 'on', acceptance: 'on', minorPolicy: 'legacy', verifier: 'on' }; // #559: the v0.5.375 profile"],
  ['default minorPolicy flipped to spec (the v0.5.378 default)', S, "{ earlyGate: 'on', acceptance: 'off', minorPolicy: 'legacy', verifier: 'on' }; // #559: the v0.5.375 profile", "{ earlyGate: 'on', acceptance: 'off', minorPolicy: 'spec', verifier: 'on' }; // #559: the v0.5.375 profile"],
  ['default minorPolicy flipped to refuse', S, "{ earlyGate: 'on', acceptance: 'off', minorPolicy: 'legacy', verifier: 'on' }; // #559: the v0.5.375 profile", "{ earlyGate: 'on', acceptance: 'off', minorPolicy: 'refuse', verifier: 'on' }; // #559: the v0.5.375 profile"],
  ['switchesOf ignores the stored switches', S, "return { ...DEFAULTS_PROFILES[defaultsProfileOf(state)], ...(state?.switches ?? {}) };", "return { ...DEFAULTS_PROFILES[defaultsProfileOf(state)] };"],
  ['unknown switch name accepted', S, "if (!(SWITCH_NAMES as string[]).includes(name)) throw new FanoutStateError(`unknown switch", "if (false as boolean) throw new FanoutStateError(`unknown switch"],
  ['unknown switch value accepted', S, "if (typeof v !== 'string' || !allowed.includes(v)) throw new FanoutStateError(`switch ${name} must be", "if (typeof v !== 'string' || false as boolean) throw new FanoutStateError(`switch ${name} must be"],
  ['a stored unknown switch / value is accepted on read', S, "for (const [k, val] of Object.entries(v)) out[k] = switchValueOf(k, val);", "for (const [k, val] of Object.entries(v)) out[k] = val;"],
  ['a switch can change after the freeze (set never locks)', S, "if (locked) throw new FanoutStateError(`the switches of run", "if (false as boolean) throw new FanoutStateError(`the switches of run"],
  ['the lock ignores the first-spawn detector (record only)', S, "  const signal = firstSpawnSignal(state);\n  return signal ? `the run already spawned (${signal})` : null;", "  return null;"],
  ['freezeAtFirstSpawn never freezes', S, "  const signal = firstSpawnSignal(state);\n  if (!signal) return state;", "  const signal = null as string | null;\n  if (!signal) return state;"],
  ['applyTicketPatch does not freeze at the first spawn', S, "return freezeAtFirstSpawn(out, now); // #554: the first spawn of the run fixes the switches", "return out;"],
  ['an implementer record is not a spawn', S, "    if (t.implementer) return `ticket ${id} has an implementer (${t.implementer})`;\n", ""],
  ['a verifier record is not a spawn', S, "    if (t.verifier) return `ticket ${id} has a verifier (${t.verifier})`;\n", ""],
  ['an acceptance writer is not a spawn', S, "    if (t.accept?.acceptor) return `ticket ${id} has an acceptance writer (${t.accept.acceptor.name})`;\n", ""],
  ['a started ticket is not a spawn', S, "if (t.status === 'started' || t.status === 'nominated' || t.status === 'gated' || t.status === 'merged') return `ticket ${id} is ${t.status}`;", "if (t.status === 'nominated' || t.status === 'gated' || t.status === 'merged') return `ticket ${id} is ${t.status}`;"],
  ['state show does not print the switches', S, "return `switches (#554, #559, #563): ${SWITCH_NAMES.map(", "return `${SWITCH_NAMES.map("],
  ['earlyGate off: upstreamBlocker still admits a verified candidate', S, "if (switchesOf(state).earlyGate === 'off') return { kind: 'ineligible', why:", "if (switchesOf(state).earlyGate === 'never') return { kind: 'ineligible', why:"],
  ['earlyGate off: state set still nominates a dependent on an open upstream', S, "if (switchesOf(state).earlyGate === 'off' && (next.status === 'nominated' || next.status === 'gated')) {", "if (false as boolean && (next.status === 'nominated' || next.status === 'gated')) {"],
  ['earlyGate off: the reason does not say the dependent waits for the MERGE', S, "earlyGate is off for this run: a dependent may START against a frozen interface but is not nominated or gated before its upstream is MERGED", "a dependent is not nominated here"],
  ['minorPolicy legacy: followUpRefusal still refuses', S, "if (switchesOf(state).minorPolicy === 'legacy') return null; // #554: legacy = before #514, follow-ups unrestricted", ""],
  ['minorPolicy legacy: a further candidate on a merged ticket is still a follow-up (state)', S, "const legacyMinor = switchesOf(state).minorPolicy === 'legacy';", "const legacyMinor = false;"],
  ['minorPolicy refuse treated as legacy', S, "if (switchesOf(state).minorPolicy === 'legacy') return null;", "if (switchesOf(state).minorPolicy !== 'spec') return null;"],
  ['acceptance off: the writer claim still spawns', A, "  assertAcceptanceOn(state, `claim a writer for ${id}`); // #554: the spawn is ABSENT with the switch off — the host's only door is this claim\n", ""],
  ['acceptance off: a writer claim does not freeze the switches', A, "return freezeAtFirstSpawn({ ...state, tickets: { ...state.tickets, [id]: { ...t, accept: withAccept(t, { acceptor: { id: null, name, at: now } }), updatedAt: now } }, updatedAt: now }, now);", "return { ...state, tickets: { ...state.tickets, [id]: { ...t, accept: withAccept(t, { acceptor: { id: null, name, at: now } }), updatedAt: now } }, updatedAt: now };"],
  ['acceptance off: freezeInto accepts', A, "  assertAcceptanceOn(state, `freeze tests for ${id}`);\n", ""],
  ['acceptance off: waiveInto accepts', A, "  assertAcceptanceOn(state, `waive acceptance for ${id}`);\n", ""],
  ['acceptance off: amendInto accepts', A, "): FanoutState {\n  assertAcceptanceOn(state, `amend the tests of ${id}`);\n  const cur = ticketOf(state, id);\n  if (!cur) throw", "): FanoutState {\n  const cur = ticketOf(state, id);\n  if (!cur) throw"],
  ['acceptance off: amendHarnessInto accepts', A, "): FanoutState {\n  assertAcceptanceOn(state, `amend the tests of ${id}`);\n  const cur = ticketOf(state, id);\n  const acc", "): FanoutState {\n  const cur = ticketOf(state, id);\n  const acc"],
  ['acceptance off: the refusal is not an exit-2 refusal', 'src/cli/fanout-acceptance.ts', "if (e instanceof Refusal || e instanceof AcceptanceOffError) return", "if (e instanceof Refusal) return"],
  ['acceptance off: `acceptance spawn` still hands the host a request', 'src/cli/fanout-acceptance.ts', "    assertAcceptanceOn(st, `spawn a writer for ${ticket}`); // #554\n", ""],
  ['acceptance off: the gate / deliver reader still reports the frozen phase', 'src/cli/fanout-acceptance.ts', "if (!acceptanceOn(state)) return { consulted: true, known: true, acceptance: null, phase: 'none', ticket: t, run: r };", ""],
  ['acceptance off: state set still asks the host for a writer', 'src/cli/fanout-state.ts', "const hostCalls: HostCall[] = accOn && needsAcceptor(t, deps.now())", "const hostCalls: HostCall[] = needsAcceptor(t, deps.now())"],
  ['acceptance off: state set still warns about the gate', 'src/cli/fanout-state.ts', "const notice = accOn && acceptancePhase(t) === 'unspecified'", "const notice = acceptancePhase(t) === 'unspecified'"],
  ['acceptance off: state show still lists the acceptance lines', 'src/cli/fanout-state.ts', "const acc = acceptanceOn(s) ? Object.entries(s.tickets)", "const acc = true ? Object.entries(s.tickets)"],
  ['init --switch is ignored', 'src/cli/fanout-state.ts', "...(p.vals['--switch'] !== undefined ? { switches: parseSwitchAssignments(p.vals['--switch']) } : {}), harness:", "harness:"],
  ['state set --switch does not go through setSwitches', 'src/cli/fanout-state.ts', "return setSwitches(cur, assign, deps.now());", "return { ...cur, switches: { ...switchesOf(cur), ...assign }, updatedAt: deps.now() };"],
  ['state set --switch asks the host for no skill re-render', 'src/cli/fanout-state.ts', "stderr: sr.note + spawnNote, hostCalls: [skillsCall(sr.run, deps)] };", "stderr: sr.note + spawnNote };"],
  ['earlyGate off: deliver still reads the built-on content check', 'src/cli/fanout-deliver.ts', "const early = switchesOf(state).earlyGate === 'on';", "const early = true;"],
  ['host skills op refreshes nobody', 'src/shared/fanout-acceptance-host.ts', "refreshed: deps.refreshSkills ? await deps.refreshSkills(ids) : [] };", "refreshed: [] };"],
  ['renderer keeps every block', 'src/shared/fanout-switch-render.ts', "if (!values.includes(sw[name])) keep = false;", ""],
  ['renderer drops every block', 'src/shared/fanout-switch-render.ts', "if (!values.includes(sw[name])) keep = false;", "keep = false;"],
  ['renderer accepts an unterminated block', 'src/shared/fanout-switch-render.ts', "if (keep !== null) throw new Error('unterminated switch block');", ""],
  ['skill: the acceptance section leaks with acceptance off', 'src/shared/verified-fanout-skill.ts', "<!--sw acceptance=on-->\n## 1b.", "<!--sw acceptance=on|off-->\n## 1b."],
  ['skill: the early-gate paragraph leaks with earlyGate off', 'src/shared/verified-fanout-skill.ts', "<!--sw earlyGate=on-->", "<!--sw earlyGate=on|off-->"],
  ['skill: the #514 merge-rule paragraph leaks under legacy', 'src/shared/verified-fanout-skill.ts', "<!--sw minorPolicy=refuse-->\n*A review round with 0 BLOCKING and 0 MAJOR merges on its current gate; every", "<!--sw minorPolicy=legacy|refuse-->\n*A review round with 0 BLOCKING and 0 MAJOR merges on its current gate; every"],
  ['skill: the #514 follow-up bullet leaks under legacy', 'src/shared/verified-fanout-skill.ts', "<!--sw minorPolicy=refuse-->\n- **At most ONE follow-up", "<!--sw minorPolicy=legacy|refuse-->\n- **At most ONE follow-up"],
  ['skill: the #552 merge-rule paragraph leaks under refuse', 'src/shared/verified-fanout-skill.ts', "<!--sw minorPolicy=spec-->\n*A review round with 0 BLOCKING, 0 MAJOR", "<!--sw minorPolicy=spec|refuse-->\n*A review round with 0 BLOCKING, 0 MAJOR"],
  ['skill: the #552 refusal sentence leaks under legacy', 'src/shared/verified-fanout-skill.ts', "<!--sw minorPolicy=spec-->\nrefusal: inspect and retry.", "<!--sw minorPolicy=spec|legacy-->\nrefusal: inspect and retry."],
  ['reference: the #552 section leaks under refuse', 'src/shared/verified-fanout-files.ts', "<!--sw minorPolicy=spec-->\\n\\n**A MINOR that breaks a sentence", "<!--sw minorPolicy=spec|refuse-->\\n\\n**A MINOR that breaks a sentence"],
  ['skill: the early-gate-off variant is missing (the dependent is not told it waits)', 'src/shared/verified-fanout-skill.ts', "<!--sw earlyGate=off-->", "<!--sw earlyGate=on-->"],
  ['installer ignores the switches', 'src/main/verified-fanout-install.ts', "await writeAtomic(skillFile, renderVerifiedFanoutSkill(switches));", "await writeAtomic(skillFile, renderVerifiedFanoutSkill());"],
  ['installer ships the acceptance reference with acceptance off', 'src/main/verified-fanout-install.ts', "if (!verifiedFanoutReferenceWanted(f.path, switches)) { await rm(dest, { force: true }); continue; }", ""],
  ['installer leaves an earlier acceptance reference behind', 'src/main/verified-fanout-install.ts', "{ await rm(dest, { force: true }); continue; }", "{ continue; }"],
  ['the stamp ignores the switches', S, "return diff.length ? `${version}+sw:${diff.join(',')}` : version;", "return version;"],
  ['the reference filter keeps the acceptance reference', 'src/shared/verified-fanout-skill.ts', "path !== ACCEPTANCE_REFERENCE_PATH || switchesOf({ switches }).acceptance === 'on'", "true"],
  ['earlyGate off: resume still advises the #506 candidate route (todo)', S, "${early ? `nominate only once", "${true ? `nominate only once"],
  ['earlyGate off: resume still advises --built-on (started)', S, "(early ? `finish and self-gate; nomination needs", "(true ? `finish and self-gate; nomination needs"],
  ['earlyGate off: stackView still compares builtOn at a merged upstream', S, "return builtOn && head && switchesOf(state).earlyGate === 'on' &&", "return builtOn && head &&"],
  ['earlyGate off: reconcile still flags upstream-changed', S, "t.dependsOn.filter((d) => switchesOf(state).earlyGate === 'on' && effMerged(d) && t.builtOn[d])", "t.dependsOn.filter((d) => effMerged(d) && t.builtOn[d])"],
  ['acceptance off: show --brief still prints the acceptance line', 'src/cli/fanout-acceptance.ts', "(acceptanceOn(s) ? acceptanceLine(ticket, t) : null) ??", "acceptanceLine(ticket, t) ??"],
  ['install call drops the switches', W, "e), fanoutSwitches),", "e)),"],
  ['install skip gate compares the plain version', W, "=== stampValue) return;", "=== HOOKS_VERSION) return;"],
  ['install writes the plain stamp', W, ".hooks-version'), stampValue)", ".hooks-version'), HOOKS_VERSION)"],
  ['install reads no run switches', W, "switchesForRun(orchestraHome(), resolveWaveRunId(roleWs))", "{ ...DEFAULT_SWITCHES }"],
  ['skills op does not reinstall', 'src/main/fanout-acceptance-wiring.ts', "await installOrchestraHooks(ws.worktreePath); done.push(id);", "done.push(id);"],
  ['host-side freeze: the owner\'s children are ignored', 'src/cli/fanout-state.ts', "if (deps.spawned && deps.spawned.length) throw", "if (false as boolean) throw"],
  ['host-side freeze: a silent host is said nothing about', 'src/cli/fanout-state.ts', "return deps.spawned === null ? 'note: the host could not say", "return false as boolean ? 'note: the host could not say"],
  ['host-side freeze: init --switch is not checked', 'src/cli/fanout-state.ts', "const initNote = p.vals['--switch'] !== undefined ? checkSpawned(deps, run) : '';", "const initNote = '';"],
  ['host-side freeze: set --switch is not checked', 'src/cli/fanout-state.ts', "const spawnNote = checkSpawned(deps, sr.run);", "const spawnNote = '';"],
  ['host-side freeze: the verb detector never matches', 'src/cli/fanout-state.ts', "|| !args.includes('--switch')) return null;", "|| !args.includes('--switch') || true) return null;"],
  ['host-side freeze: the host answers no children', 'src/shared/fanout-acceptance-host.ts', "children: owner && deps.childrenOf ? deps.childrenOf(owner) : [] }", "children: [] }"],
  ['host-side freeze: production lists every workspace', 'src/main/fanout-acceptance-wiring.ts', "store.workspaces.filter((w) => w.parentId === run)", "store.workspaces.filter((w) => w.parentId !== run)"],
  ['host-side freeze: the CLI never asks the host', 'src/cli/index.ts', "if (switchRun) {", "if (false as boolean) {"],
  ['references are not rendered by the switches', 'src/main/verified-fanout-install.ts', "f.path.endsWith('.md') ? renderSwitchBlocks(f.content, switches) : f.content", "f.content"],
  ['reference: the early-gate sentence leaks with earlyGate off', 'src/shared/verified-fanout-files.ts', "<!--sw earlyGate=on-->\\n- **A stack's order", "<!--sw earlyGate=on|off-->\\n- **A stack's order"],
  ['lost-sentence guard fires under refuse / legacy too', S, "if (switchesOf(state).minorPolicy === 'spec' && (next.specText !== prev.specText", "if ((next.specText !== prev.specText"],
  ['lost-sentence guard never fires', S, "if (switchesOf(state).minorPolicy === 'spec' && (next.specText !== prev.specText", "if (false as boolean && (next.specText !== prev.specText"],
  ['m1: a custom --run id has no owner (the caller\'s children are ignored)', 'src/shared/fanout-acceptance-host.ts', "(str(input.from) && deps.isWorkspace(str(input.from)!) ? str(input.from)! : null)", "null"],
  // #559 — the defaults profile + the in-flight rule
  ['559: a new state is not stamped with the defaults profile', S, "switchDefaults: 'v0.5.375', tickets: {}, updatedAt: opts.now", "tickets: {}, updatedAt: opts.now"],
  ['559: applyTicketPatch does not stamp before the patch', S, "  const state = stampDefaults(state0); // #559: BEFORE the patch", "  const state = state0; // #559: BEFORE the patch"],
  ['559: updateState does not stamp before the writer', S, "const next = mutate(cur && stampDefaults(cur));", "const next = mutate(cur);"],
  ['559: stampDefaults stamps after the patch only (claimAcceptor)', A, "  const state = stampDefaults(state0); // #559: before the claim", "  const state = state0; // #559: before the claim"],
  ['559: a spawned unmarked state is read with the NEW defaults (the in-flight rule is gone)', S, "return state && (state.switchesFrozen || (state.tickets && firstSpawnSignal({ tickets: state.tickets } as FanoutState))) ? 'v0.5.378' : 'v0.5.375';", "return 'v0.5.375';"],
  ['559: an unspawned unmarked state is read with the OLD defaults', S, "return state && (state.switchesFrozen || (state.tickets && firstSpawnSignal({ tickets: state.tickets } as FanoutState))) ? 'v0.5.378' : 'v0.5.375';", "return 'v0.5.378';"],
  ['559: a frozen record alone does not mean spawned', S, "(state.switchesFrozen || (state.tickets && firstSpawnSignal(", "(false as boolean || (state.tickets && firstSpawnSignal("],
  ['559: the stamp of an unmarked state is always the new profile', S, "return state.switchDefaults ? state : { ...state, switchDefaults: defaultsProfileOf(state) };", "return state.switchDefaults ? state : { ...state, switchDefaults: 'v0.5.375' };"],
  ['559: a stamped profile is ignored on read', S, "  if (state?.switchDefaults) return state.switchDefaults;\n", ""],
  ['559: show labels an explicit value as a default', S, "return stored !== undefined ? 'explicit' : 'default';", "return 'default';"],
  ['559: show never says a legacy default was kept', S, "return V378_DEFAULT_SWITCHES[name] === DEFAULT_SWITCHES[name] ? 'default' : 'default-kept-v0.5.378';", "return 'default';"],
  ['559: show labels a v0.5.378 stored value that differs from its default as kept, not explicit', S, "if (stored !== undefined && stored !== V378_DEFAULT_SWITCHES[name]) return 'explicit';\n", ""],
  ['559: the stamp of a legacy-kept run is the plain version', S, "const diff = SWITCH_NAMES.filter((n) => sw[n] !== undefined && sw[n] !== DEFAULT_SWITCHES[n])", "const diff = SWITCH_NAMES.filter((n) => sw[n] !== undefined && sw[n] !== V378_DEFAULT_SWITCHES[n])"],
  ['559: the host reader falls back to the old defaults', S, "catch { return { ...DEFAULT_SWITCHES }; }", "catch { return { ...V378_DEFAULT_SWITCHES }; }"],
  ['559: an unknown defaults profile is accepted on read', S, "if (v !== 'v0.5.375' && v !== 'v0.5.378') throw new FanoutStateError(", "if (false as boolean) throw new FanoutStateError("],
  ['559: --help still says acceptance is on by default', 'src/cli/fanout-state.ts', "acceptance=on|off     off (default): no writer spawned, no frozen test asked; on:", "acceptance=on|off     on (default): no writer spawned, no frozen test asked; on:"],
  ['559: --help still says minorPolicy spec is the default', 'src/cli/fanout-state.ts', "minorPolicy=legacy|refuse|spec   legacy (default): follow-ups unrestricted (before #514); refuse: #514 (a follow-up needs a BLOCKING|MAJOR finding); spec: #552", "minorPolicy=legacy|refuse|spec   legacy: follow-ups unrestricted (before #514); refuse: #514 (a follow-up needs a BLOCKING|MAJOR finding); spec (default): #552"],
  ['559: --help forgets the in-flight rule', 'src/cli/fanout-state.ts', "A run that had ALREADY spawned when they changed keeps the old ones", "A run"],
  ['559: skill: the routing rule is not part of the acceptance feature', 'src/shared/verified-fanout-skill.ts', "<!--sw acceptance=on-->\n**Routing rule", "<!--sw acceptance=on|off-->\n**Routing rule"],
  ['559: skill: the legacy merge rule is not the v0.5.375 sentence', 'src/shared/verified-fanout-skill.ts', "merges on its current gate; a\nMINOR that touches correctness or a ticket promise goes to the candidate's ONE\nfollow-up branch, every other finding is ¤noted¤.*\n<!--/sw-->\n\nThe count", "merges on its current gate.*\n<!--/sw-->\n\nThe count"],
  ['559: skill: legacy loses the v0.5.375 one-follow-up line', 'src/shared/verified-fanout-skill.ts', "<!--sw minorPolicy=legacy-->\n- **At most ONE follow-up branch per candidate**; only a BLOCKING/MAJOR in its own diff reopens it.\n<!--/sw-->\n", ""],
  ['559: installer: the default install ships the acceptance reference', 'src/shared/verified-fanout-skill.ts', "path !== ACCEPTANCE_REFERENCE_PATH || switchesOf({ switches }).acceptance === 'on'", "true"],
  ['559: the first-spawn lock forgets a v0.5.378-shaped state', S, "  if (state.switchesFrozen) return `frozen ${state.switchesFrozen.at} (${state.switchesFrozen.by})`;\n", ""],
  ['m2: a run that set nothing persists the freeze record', S, "  if (!state.switches || Object.keys(state.switches).length === 0) return state;\n", ""],
  ['m2: an explicit value equal to the default is dropped (not reportable as explicit)', S, "return { ...rest, switches: { ...(prev ?? {}), ...assign }, updatedAt: now };", "return { ...rest, ...(Object.entries({ ...(prev ?? {}), ...assign }).every(([k, v]) => v === (DEFAULTS_PROFILES[defaultsProfileOf(rest)] as Record<string, string>)[k]) ? {} : { switches: { ...(prev ?? {}), ...assign } }), updatedAt: now };"],
  ['m2: the lock forgets the state signal once nothing is recorded', S, "  const signal = firstSpawnSignal(state);\n  return signal ? `the run already spawned", "  const signal = null as string | null;\n  return signal ? `the run already spawned"],
  // #563 — the verifier switch
  ["563: default verifier flipped to off", S, "minorPolicy: 'legacy', verifier: 'on' }; // #559: the v0.5.375 profile", "minorPolicy: 'legacy', verifier: 'off' }; // #559: the v0.5.375 profile"],
  ["563: SWITCH_VALUES drops the verifier switch", S, ", verifier: ['on', 'off'] } as const;", " } as const;"],
  ["563: state set --verifier records a seat under verifier=off", S, "if (next.verifier && switchesOf(state).verifier === 'off') throw", "if (next.verifier && switchesOf(state).verifier === 'never') throw"],
  ["563: the stamp ignores a non-default verifier", S, "sw[n] !== undefined && sw[n] !== DEFAULT_SWITCHES[n]", "n !== 'verifier' && sw[n] !== undefined && sw[n] !== DEFAULT_SWITCHES[n]"],
  ["563: deliver never reads the verifier switch", "src/cli/fanout-deliver.ts", "if (opts.noReviewGate && deps.verifierSwitch) {", "if (false as boolean && deps.verifierSwitch) {"],
  ["563: deliver reads off as on", "src/cli/fanout-deliver.ts", "if (sw === 'off') return done({ verdict: 'refused', reason: 'no-verdict'", "if (sw === 'never' as string) return done({ verdict: 'refused', reason: 'no-verdict'"],
  ["563: deliver's off refusal is not the no-verdict answer", "src/cli/fanout-deliver.ts", "if (sw === 'off') return done({ verdict: 'refused', reason: 'no-verdict'", "if (sw === 'off') return done({ verdict: 'refused', reason: 'bad-args' as never"],
  ["563: production deliver wires no switch reader", "src/cli/fanout-deliver.ts", "  verifierSwitch: (o) => verifierSwitchFromState(o),\n", ""],
  ["563: the switch reader fails open on an explicit --run with no state", "src/cli/fanout-deliver.ts", "    if (opts.run) throw new FanoutStateError(`no fanout state for --run ${opts.run}: a wrong run id would skip the verifier switch`);\n", ""],
  ["563: the switch reader fails open on an unknown ticket", "src/cli/fanout-deliver.ts", "  throw new FanoutStateError(`ticket ${opts.ticket} is not in the fanout state of run ${run}: a mistyped --ticket would skip the verifier switch`);", "  return null;"],
  ["563: the switch reader returns on whatever the state says", "src/cli/fanout-deliver.ts", "if (state.tickets[opts.ticket]) return switchesOf(state).verifier;", "if (state.tickets[opts.ticket]) return 'on';"],
  ["563: a reader that throws is read as on", "src/cli/fanout-deliver.ts", "return done({ verdict: 'unchecked', reason: 'bad-state', detail: `cannot read the fanout state for ${opts.ticket}'s verifier switch", "sw = 'on'; if (false as boolean) return done({ verdict: 'unchecked', reason: 'bad-state', detail: `cannot read the fanout state for ${opts.ticket}'s verifier switch"],
  ["563: --help forgets the verifier switch", "src/cli/fanout-state.ts", "verifier=on|off       on (default): a verifier seat", "verifier=on|off       off (default): a verifier seat"],
  ["563: deliver --help forgets the verifier switch", "src/cli/fanout-deliver.ts", "verifier=off (#563, \\`state set --switch verifier=off\\`)", "the verifier switch"],
  ["563: renderer: a multi-term directive keeps on ONE term", "src/shared/fanout-switch-render.ts", "if (!values.includes(sw[name])) keep = false;", "if (values.includes(sw[name])) keep = true;"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 description", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\ndescription: Mechanics of running a verified", "<!--sw verifier=on|off-->\ndescription: Mechanics of running a verified"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 roles paragraph", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\nThree roles.", "<!--sw verifier=on|off-->\nThree roles."],
  ["563 skill: the verifier variant leaks with verifier off \u2014 role prefixes", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n¤impl-¤ implementer, ¤verif-¤", "<!--sw verifier=on|off-->\n¤impl-¤ implementer, ¤verif-¤"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 tool limits", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n  reviewer, explorer and scribe (the verifier edits scratch only", "<!--sw verifier=on|off-->\n  reviewer, explorer and scribe (the verifier edits scratch only"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 handoff", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n  Hand off a heavy member (verifier, coordinator)", "<!--sw verifier=on|off-->\n  Hand off a heavy member (verifier, coordinator)"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 full suite on the verifier's seat", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n- **The full suite and the build run on the verifier's seat", "<!--sw verifier=on|off-->\n- **The full suite and the build run on the verifier's seat"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 gate merge candidates", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n- **Gate merge candidates, not pushes.**", "<!--sw verifier=on|off-->\n- **Gate merge candidates, not pushes.**"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 section 3 spawn the verifier", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n## 3. Spawn the verifier", "<!--sw verifier=on|off-->\n## 3. Spawn the verifier"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 section 3 delta-gate sentence", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\nonly): the implementer's pre-review + the verifier's delta gate suffice", "<!--sw verifier=on|off-->\nonly): the implementer's pre-review + the verifier's delta gate suffice"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 section 4 send the verifier the ref", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n- Implementer reports done → send the verifier", "<!--sw verifier=on|off-->\n- Implementer reports done → send the verifier"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 section 4 CI runs while the verifier gates", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n- **At nomination, parallel with the gate:", "<!--sw verifier=on|off-->\n- **At nomination, parallel with the gate:"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 section 4 PASS \u2192 merge rule", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n- PASS → apply the **merge rule**", "<!--sw verifier=on|off-->\n- PASS → apply the **merge rule**"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 deliver paragraph --no-review-gate", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\nALWAYS pass ¤--review-verdict¤", "<!--sw verifier=on|off-->\nALWAYS pass ¤--review-verdict¤"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 deliver paragraph back to the verifier", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\nconflict goes to the implementer, a moved head", "<!--sw verifier=on|off-->\nconflict goes to the implementer, a moved head"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 fix round", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n- **BLOCKING/MAJOR → ONE fix round**", "<!--sw verifier=on|off-->\n- **BLOCKING/MAJOR → ONE fix round**"],
  ["563 skill: the verifier variant leaks with verifier off \u2014 references list", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=on-->\n- **references/verifier-and-review.md** — read when briefing the verifier", "<!--sw verifier=on|off-->\n- **references/verifier-and-review.md** — read when briefing the verifier"],
  ["563 skill: the verifier=off variant of \u00a73 is missing", "src/shared/verified-fanout-skill.ts", "<!--sw verifier=off-->\n## 3. No gating seat", "<!--sw verifier=on-->\n## 3. No gating seat"],
  ["563 skill: \u00a71b keeps the verifier variant with verifier off", "src/shared/verified-fanout-skill.ts", "<!--sw acceptance=on verifier=on-->\n- **Register the spec**", "<!--sw acceptance=on-->\n- **Register the spec**"],
  ["563 skill: \u00a71b names a verifier with verifier off (off variant = on text)", "src/shared/verified-fanout-skill.ts", "<!--sw acceptance=on verifier=off-->\n- **Register the spec**: ¤orchestra fanout state set <ticket> --spec <file|url|ledger section> --implementer <ws id>¤.", "<!--sw acceptance=on verifier=off-->\n- **Register the spec**: ¤orchestra fanout state set <ticket> --spec <file|url|ledger section> --implementer <ws id> --verifier <ws id>¤."],
  ["563 reference: the verifier variant leaks with verifier off \u2014 budget-and-gates full suite", "src/shared/verified-fanout-files.ts", "<!--sw verifier=on-->\\n- **The full suite and the build run on the verifier's seat", "<!--sw verifier=on|off-->\\n- **The full suite and the build run on the verifier's seat"],
  ["563 reference: the verifier variant leaks with verifier off \u2014 lead-ops tiers", "src/shared/verified-fanout-files.ts", "<!--sw verifier=on-->\\n  spawned agents of its own: the set of workers and the verifier", "<!--sw verifier=on|off-->\\n  spawned agents of its own: the set of workers and the verifier"],
  ["563 reference: the verifier variant leaks with verifier off \u2014 acceptance-tests register", "src/shared/verified-fanout-files.ts", "<!--sw verifier=on-->\\n1. **Register**", "<!--sw verifier=on|off-->\\n1. **Register**"],
  ["563 reference: the verifier variant leaks with verifier off \u2014 verifier-and-review head", "src/shared/verified-fanout-files.ts", "<!--sw verifier=on-->\\n# The verifier brief", "<!--sw verifier=on|off-->\\n# The verifier brief"],
];

const base = run();
const baseOk = base.fail === 0 && base.skipped === 0 && base.pass >= 48 && base.pass === base.tests;
console.log(`control (unpatched copy): ${base.pass} pass / ${base.fail} fail / ${base.skipped} skipped → ${baseOk ? 'GREEN' : 'RED'}`);
if (!baseOk) { console.log(base.out.slice(-3000)); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(1); }
if (!process.argv.includes('--mutants')) { fs.rmSync(scratch, { recursive: true, force: true }); process.exit(0); }

let survived = 0, refused = 0;
for (const [i, [name, file, from, to]] of mutants.entries()) {
  const f = path.join(scratch, file);
  const orig = fs.readFileSync(f, 'utf8');
  const n = orig.split(from).length - 1;
  if (n !== 1) { console.log(`M${String(i + 1).padStart(2, '0')} REFUSED (stale: the string occurs ${n}×, need exactly 1) — ${name}`); refused++; continue; }
  fs.writeFileSync(f, orig.replace(from, () => to));
  const r = run();
  fs.writeFileSync(f, orig);
  const killed = r.fail > 0 || Number.isNaN(r.pass); // a mutant that breaks the module graph (no tests ran) is also dead
  if (!killed) survived++;
  console.log(`M${String(i + 1).padStart(2, '0')} ${killed ? 'KILLED' : 'SURVIVED'} (${r.pass} pass / ${r.fail} fail) — ${name}`);
}
const after = run(); // the restore is real: the copy is green again
const same = after.fail === 0 && after.pass === base.pass;
console.log(`\n${mutants.length - survived - refused}/${mutants.length} mutants killed, ${survived} survived, ${refused} refused; scratch restored → ${same ? 'GREEN' : 'RED'}`);

fs.rmSync(scratch, { recursive: true, force: true });
process.exit(survived || refused || !same ? 1 : 0);

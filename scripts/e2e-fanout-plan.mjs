#!/usr/bin/env node
// #604 rig (spec #601, ledger #613) — the plan step of the Boucle: every clause of the plan check, the single-use agent's host op, the submit (one retry, twice = the run does not start) and
// the no-decision-after-plan rule MUTATED in a scratch copy of src/; the three test files (and, for a mutant that lives in the CLI, the BUILT cli.js rebuilt in the scratch) must go RED.
// Light: no Electron, no network, no tokens; the scratch copy lives under $TMPDIR; the repo is never written.
//   node scripts/e2e-fanout-plan.mjs            control: the unpatched copy must be GREEN (0 fail, 0 skipped)
//   node scripts/e2e-fanout-plan.mjs --mutants  each mutant (exact string, must occur ONCE in its file — else REFUSED as stale) must be KILLED (≥1 test FAILs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-plan-rig-'));
if (!path.resolve(scratch).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
fs.cpSync(path.join(ROOT, 'src'), path.join(scratch, 'src'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'vite.cli.config.ts'), path.join(scratch, 'vite.cli.config.ts'));
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(scratch, 'package.json'));
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
const UNIT = ['src/shared/fanout-plan.test.ts', 'src/cli/fanout-plan.test.ts'].map((f) => path.join(scratch, f));
const CLI_TEST = [path.join(scratch, 'src/cli/fanout-plan-cli.test.ts')];
const CLI_JS = path.join(scratch, 'dist-electron', 'cli.js');

function build() { // the scratch's own cli.js: a rig on a stale or absent bundle proves nothing
  fs.rmSync(path.join(scratch, 'dist-electron'), { recursive: true, force: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.cli.config.ts'], { cwd: scratch, encoding: 'utf8', timeout: 240_000 });
  if (r.status !== 0 || !fs.existsSync(CLI_JS)) { console.error(`${r.stdout}\n${r.stderr}`); throw new Error('the scratch cli.js did not build'); }
}
function run(files) {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: scratch, encoding: 'utf8', timeout: 300_000, env: { ...process.env, TMPDIR: tmpBase, ORCHESTRA_TEST_CLI: CLI_JS } });
  const out = `${r.stdout}\n${r.stderr}`;
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return { pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests'), out };
}

// [name, file, from, to, cli?] — `from` must occur exactly once in `file`; `cli` = the mutant lives in what the BUILT CLI bundles: rebuild and run the CLI test.
const P = 'src/shared/fanout-plan.ts';
const PH = 'src/shared/fanout-plan-host.ts';
const PB = 'src/shared/fanout-plan-brief.ts';
const C = 'src/cli/fanout-plan.ts';
const H = 'src/shared/fanout-acceptance-host.ts';
const S = 'src/shared/fanout-state.ts';
const X = 'src/cli/index.ts';
const mutants = [
  // the check
  ['check: a ticket missing from the plan is not reported', P, "for (const id of want) if (!seen.has(id)) reasons.push", "for (const id of want) if (false as boolean) reasons.push"],
  ['check: a ticket unknown to the run is not reported', P, "for (const id of seen.keys()) if (!want.includes(id)) reasons.push", "for (const id of seen.keys()) if (false as boolean) reasons.push"],
  ['check: a duplicate ticket is not reported', P, "if (n > 1) reasons.push", "if (n > 99) reasons.push"],
  ['check: a cycle is not reported', P, "if (cycle) reasons.push", "if (false as boolean && cycle) reasons.push"],
  ['check: the cycle search never closes a loop', P, "if (mark.get(id) === 1) return [...chain.slice(chain.indexOf(id)), id];", "if (mark.get(id) === 1) return null;"],
  ['check: a dependency outside the plan is accepted', P, "else if (!known.has(d)) reasons.push", "else if (false as boolean) reasons.push"],
  ['check: a self-dependency is accepted', P, "if (d === t.id) reasons.push", "if (false as boolean) reasons.push"],
  ['check: an interface keyed on an unknown ticket is accepted', P, "for (const k of Object.keys(plan.interfaces)) if (!known.has(k)) reasons.push", "for (const k of Object.keys(plan.interfaces)) if (false as boolean) reasons.push"],
  ['check: a depended-on ticket with no interface is accepted', P, "if (text === undefined || !text.trim()) reasons.push", "if (text === undefined && false as boolean) reasons.push"],
  ['check: an interface with no name in backticks is accepted', P, "else if (!interfaceNames(text).length) reasons.push", "else if (false as boolean) reasons.push"],
  ['check: a free-text key at the top of the plan is accepted', P, "if (!['version', 'tickets', 'interfaces'].includes(k)) free(", "if (false as boolean) free("],
  ['check: a free-text key on a ticket is accepted', P, "if (!['id', 'title', 'spec', 'dependsOn'].includes(k)) free(", "if (false as boolean) free("],
  ['check: a title of any length is accepted', P, "else if (t.title.length > PLAN_TITLE_MAX || CTRL_LINE.test(t.title)) free(", "else if (false as boolean) free("],
  ['check: a multi-line spec is accepted', P, "else if (t.spec.length > PLAN_SPEC_MAX || CTRL_LINE.test(t.spec)) free(", "else if (false as boolean) free("],
  ['check: the version is not checked', P, "if (v.version !== PLAN_VERSION) bad(", "if (false as boolean) bad("],
  ['check: text that is not JSON is reported as free text', P, "catch (e) { return { plan: null, reasons: [{ code: 'plan-bad-json', detail: `not JSON:", "catch (e) { return { plan: null, reasons: [{ code: 'plan-free-text', detail: `not JSON:"],
  ['check: parsePlan returns a plan with reasons', P, "if (reasons.length || !plan) throw new PlanError(", "if (!plan) throw new PlanError("],
  ['check: validatePlan stops at the first reason class (the graph is skipped on a shape reason)', P, "const graph = plan ? checkPlan(plan, ticketIds).reasons : [];", "const graph = plan && !reasons.length ? checkPlan(plan, ticketIds).reasons : [];"],
  // recording
  ['apply: the marker is not set', P, "return { ...st, loopPlan: { at: now, hash, attempts }, updatedAt: now };", "return { ...st, updatedAt: now };"],
  ['apply: the attempts are not kept', P, "loopPlan: { at: now, hash, attempts }", "loopPlan: { at: now, hash, attempts: 1 }"],
  ['apply: the dependencies are not recorded', P, "for (const t of plan.tickets) st = applyTicketPatchCore(st, t.id, { dependsOn: t.dependsOn }, now);", "for (const t of plan.tickets) st = st;"],
  ['apply: the interfaces are not recorded', P, "for (const [id, text] of Object.entries(plan.interfaces)) st = applyTicketPatchCore(st, id, { interface: text }, now);", "for (const [id, text] of Object.entries(plan.interfaces)) void text;"],
  ['apply: the specs are not recorded', P, "{ dependsOn: [], spec: t.spec }", "{ dependsOn: [] }"],
  ['apply: the plan is not declared (setPlan skipped)', P, "let st = setPlan(state, ids, 'declare', now);", "let st = state;"],
  ['apply: a plan that fails the check is recorded', P, "if (!checked.ok) throw new SeatRefusal('plan-invalid'", "if (false as boolean) throw new SeatRefusal('plan-invalid'"],
  ['apply: another plan overwrites the first', P, "    throw new SeatRefusal('plan-already-applied',", "    return state; throw new SeatRefusal('plan-already-applied',"],
  ['apply: the same plan twice is refused (not idempotent)', P, "if (state.loopPlan.hash === hash) return state;", "if (false as boolean) return state;"],
  ['hash: the interfaces are not in the hash', P, "interfaces: Object.fromEntries(Object.keys(plan.interfaces).sort().map((k) => [k, plan.interfaces[k]])) };", "interfaces: {} };"],
  ['state: a run decision is accepted after the plan', S, "if (st.loopPlan) throw new SeatRefusal('decision-after-plan'", "if (false as boolean) throw new SeatRefusal('decision-after-plan'"],
  ['state: a loopPlan with a bad hash loads', S, "if (typeof v.hash !== 'string' || !SHA256.test(v.hash)) throw new FanoutStateError('loopPlan.hash", "if (false as boolean) throw new FanoutStateError('loopPlan.hash"],
  ['state: a loopPlan with an unknown field loads', S, "refuseUnknown(v, new Set(['at', 'hash', 'attempts']), 'loopPlan');", ""],
  ['state: the loopPlan is dropped when the state is read', S, "...(raw.loopPlan !== undefined ? { loopPlan: loopPlanOf(raw.loopPlan) } : {}),", ""],
  ['apply: a plan is applied to a run that already spawned', P, "if (locked) throw new SeatRefusal('plan-after-spawn'", "if (false as boolean) throw new SeatRefusal('plan-after-spawn'"],
  ['check: an inherited member name reads as an interface (TypeError)', P, "const text = Object.hasOwn(plan.interfaces, d) ? plan.interfaces[d] : undefined;", "const text = plan.interfaces[d];"],
  ['host: applyPlanText ignores a bad shape', PH, "try { ids = parsePlan(i.text).tickets.map((t) => t.id); } catch (e) { if (e instanceof PlanError) return { ok: false, reasons: e.reasons }; throw e; }", "ids = [];"],
  ['check: punctuation / digits in backticks is a name', P, "|| !/[A-Za-z]/.test(n) || CTRL_LINE.test(n)) return false;", "|| CTRL_LINE.test(n)) return false;"],
  ['check: a one-character span is a name', P, "if (n.length < 2 || n.length > NAME_MAX", "if (n.length < 1 || n.length > NAME_MAX"],
  ['check: a name may be of any length', P, "n.length > NAME_MAX ||", ""],
  ['check: a placeholder (TODO, it, thing) is a name', P, "if (NOT_A_NAME.has(n.toLowerCase())) return false;", ""],
  ['check: a sentence in backticks is a name', P, "return parts.length === 2 && HTTP_METHOD.test(parts[0]) && parts[1].startsWith('/');", "return true;"],
  ['check: any two words are a name (not METHOD /path)', P, "return parts.length === 2 && HTTP_METHOD.test(parts[0]) && parts[1].startsWith('/');", "return parts.length === 2;"],
  ['check: the METHOD is not checked', P, "return parts.length === 2 && HTTP_METHOD.test(parts[0]) && parts[1].startsWith('/');", "return parts.length === 2 && parts[1].startsWith('/');"],
  ['check: an empty plan is ok', P, "if (!plan.tickets.length) reasons.push({ code: 'plan-ticket-missing'", "if (false as boolean) reasons.push({ code: 'plan-ticket-missing'"],
  ['apply: a decision written before the plan survives it', P, "if (state.decisions?.length) throw new SeatRefusal('plan-after-decision'", "if (false as boolean) throw new SeatRefusal('plan-after-decision'"],
  ['apply: a remembered refusal does not stop a plan', P, "if (state.planRefusal) throw new SeatRefusal(state.planRefusal.code", "if (false as boolean) throw new SeatRefusal('plan-invalid'"],
  ['start: `fanout start` ignores a plan step that ended without a plan', 'src/shared/fanout-start.ts', "if (state.planRefusal) return new SeatRefusal(", "if (false as boolean) return new SeatRefusal("],
  ['state: the final refusal is not remembered', PH, "return final ? { ...cur, planRefusal:", "return false ? { ...cur, planRefusal:"],
  ['state: an unrecordable plan is not remembered', PH, "return { ...cur, planRefusal: { at: i.now, code: 'plan-apply-failed', detail: msg }, updatedAt: i.now };", "return cur;"],
  ['submit: the remembered refusal is not read (deleting the record reopens the step)', PH, "if (cur.planRefusal) throw new SeatRefusal(cur.planRefusal.code, `the plan step of run ${run} ended", "if (false as boolean) throw new SeatRefusal(cur.planRefusal.code, `the plan step of run ${run} ended"],
  ['host: the remembered refusal is not read (a new agent is spawned)', PH, "if (cur.planRefusal) { early = refusal(", "if (false as boolean) { early = refusal("],
  ['submit: an apply failure is swallowed (the agent is told nothing)', PH, "if (failure) throw failure;", "void failure;"],
  ['cli: the remembered refusal is not seen by the verb', C, "if (st?.planRefusal) return { code: 2,", "if (false as boolean) return { code: 2,"],
  ['M1: the host renders text from a ticket "id"', PH, "const badId = tickets.find((t) => !TICKET_ID.test(t));", "const badId = undefined as string | undefined;"],
  ['M1: the verb renders text from a ticket "id"', C, "const badId = tickets.find((t) => !TICKET_ID.test(t));", "const badId = undefined as string | undefined;"],
  ['brief: it does not say a name is ONE token', PB, "each in backticks, ONE token (or `METHOD /path`, ≤ 80 chars), at least one. A backticked sentence is no name; no names, no plan.", "each in backticks, at least one. No names, no plan."],
  // the submit
  ['submit: a second refusal does not end the run', PH, "const final = n >= PLAN_MAX_SUBMISSIONS;", "const final = n >= 99;"],
  ['submit: the first refusal ends the run (no second try)', PH, "export const PLAN_MAX_SUBMISSIONS = 2;", "export const PLAN_MAX_SUBMISSIONS = 1;"],
  ['submit: any caller submits', PH, "if (!i.caller || !sc.agent?.id || i.caller !== sc.agent.id) throw", "if (false as boolean) throw"],
  ['submit: an unrecorded agent id lets anyone in', PH, "if (!i.caller || !sc.agent?.id || i.caller !== sc.agent.id) throw", "if (!i.caller || (sc.agent?.id && i.caller !== sc.agent.id)) throw"],
  ['submit: a second plan after an accepted one is not refused', PH, "if (cur.loopPlan) throw new SeatRefusal('plan-closed'", "if (false as boolean) throw new SeatRefusal('plan-closed'"],
  ['submit: a submission with no request is read', PH, "if (!sc) throw new SeatRefusal('plan-not-requested'", "if (false as boolean) throw new SeatRefusal('plan-not-requested'"],
  ['submit: a refused plan is not counted', PH, "writePlanSidecar(i.home, run, { ...sc, attempts: [...sc.attempts, { at: i.now, ok: false, reasons: v.reasons }], outcome: final ? 'refused-twice' : 'open' });", "void final;"],
  ['submit: the agent is not told it is done', PH, "You are done: end your session now, write nothing else.", "Carry on."],
  ['submit: the first refusal does not say it may retry', PH, "fix the file and submit ONCE more; a second refusal ends the run", "fix the file"],
  ['submit: the reasons are not listed', PH, "Reasons:\\n${reasonsText(r.reasons)}\\nYou are done: end your session.", "Reasons:\\nYou are done: end your session."],
  // the host op
  ['host: any caller asks for a plan', PH, "if (!caller || caller !== run || !deps.vouches || !deps.vouches(caller, str(input.key))) return refusal(", "if (false as boolean) return refusal("],
  ['host: the key is not checked', PH, "|| !deps.vouches || !deps.vouches(caller, str(input.key))) return refusal(", "|| !deps.vouches) return refusal("],
  ['host: seatRecords=off is accepted', PH, "if (!seatRecordsOn(cur)) { early = refusal('seat-records-off'", "if (false as boolean) { early = refusal('seat-records-off'"],
  ['host: a call with no tickets spawns an agent', PH, "if (!tickets.length) return refusal('plan-no-tickets'", "if (false as boolean) return refusal('plan-no-tickets'"],
  ['host: the claim is not recorded before the spawn (two concurrent calls spawn two agents)', PH, "agent: { id: null, name, at: now }, spawns:", "agent: null, spawns:"],
  ['host: a live agent is not adopted (a second one is spawned)', PH, "if (live(a.id)) return { action: 'adopt', id: a.id };", "if (live(a.id)) return { action: 'respawn' };"],
  ['host: a dead agent is replaced without limit', PH, "export const PLAN_MAX_SPAWNS = 2;", "export const PLAN_MAX_SPAWNS = 99;"],
  ['host: a dead agent is never replaced', PH, "return sc.spawns >= PLAN_MAX_SPAWNS ? { action: 'refuse', refusal: 'plan-agent-dead', detail: `the plan agent ${a.name} (${a.id}) died", "return true ? { action: 'refuse', refusal: 'plan-agent-dead', detail: `the plan agent ${a.name} (${a.id}) died"],
  ['host: the ticket list may change after the request', PH, "if (!same) return { action: 'refuse', refusal: 'plan-tickets-changed'", "if (false as boolean) return { action: 'refuse', refusal: 'plan-tickets-changed'"],
  ['host: the brief is not the rendered one', PH, "task = renderPlanBrief(tickets, { run });", "task = String(input.task ?? '');"],
  ['host: the agent is not a child of the coordinator', PH, "const parent = deps.isWorkspace(run) ? run : caller;", "const parent = undefined as unknown as string;"],
  ['host: a run that already spawned is asked for a plan', PH, "if (locked) { early = refusal('plan-after-spawn'", "if (false as boolean) { early = refusal('plan-after-spawn'"],
  ['host: a taken-over claim is overwritten by the late spawn', PH, "if (!sc || sc.agent?.id !== null || sc.agent.at !== now) { mine = false; return cur as FanoutState; }", "if (!sc) { mine = false; return cur as FanoutState; }"],
  ['submit: an apply failure is not recorded (the coordinator waits out its timeout)', PH, "writePlanSidecar(i.home, run, { ...sc, outcome: 'failed', failure: msg });", "void msg;"],
  ['host: a failed spawn stays claimed', PH, "{ ...sc, agent: null, spawns: Math.max(0, sc.spawns - 1) }", "{ ...sc }"],
  ['host: a failed spawn is reported as ok', PH, "if (!res.ok || !res.id) { const error", "if (false as boolean) { const error"],
  ['host: an accepted plan spawns another agent', PH, "if (cur.loopPlan) { adopted = { action: 'accepted', id: null }; return cur; }", ""],
  ['host: the route does not dispatch op plan', H, "if (input.op === 'plan') return await dispatchPlan(input, deps);", "if (input.op === 'plan-off') return await dispatchPlan(input, deps);"],
  ['brief: the agent is not named explo-plan-<run8>', PB, "export const PLAN_AGENT_PREFIX = 'explo-plan-';", "export const PLAN_AGENT_PREFIX = 'plan-';"],
  ['brief: the run id is not cut to 8', PB, ".slice(0, 8);\n  return `${PLAN_AGENT_PREFIX}", ".slice(0, 20);\n  return `${PLAN_AGENT_PREFIX}"],
  ['brief: a ticket is not listed', PB, "...tickets.map((id) => `- ${id}`),", "...tickets.slice(1).map((id) => `- ${id}`),"],
  ['brief: it does not say to copy the tickets\' own dependencies', PB, "dependsOn is what the tickets themselves declare", "dependsOn is what you think best"],
  ['brief: it does not name the submit command with the run', PB, "return `orchestra fanout plan submit <file> --run ${run}`;", "return `orchestra fanout plan submit <file>`;"],
  ['brief: it does not tell an explorer how to write the file', PB, "'Write the file under $TMPDIR (scratch only: your role edits no repository file", "'Write the file"],
  ['brief: it does not tell the agent to submit once more', PB, "Refused → it lists the reasons: fix the file, submit ONCE more. A second refusal ends the run.", "Refused → it lists the reasons."],
  // the verb
  ['cli: the caller is the bare env id', C, "const caller = (deps.vouchedCaller ?? '').trim(); // the HOST-vouched id (index.ts), never the bare env", "const caller = (deps.vouchedCaller ?? deps.env.ORCHESTRA_WS_ID ?? '').trim();", true],
  ['cli: the submitter is the bare env id', C, "const caller = (deps.vouchedCaller ?? '').trim() || null; // the HOST-vouched id, null = nobody", "const caller = (deps.vouchedCaller ?? deps.env.ORCHESTRA_WS_ID ?? '').trim() || null;", true],
  ['cli: the session key is not sent to the host', C, "key: deps.env.ORCHESTRA_SESSION_KEY?.trim() || undefined, tickets", "key: undefined, tickets"],
  ['cli: a dead agent is never re-asked', C, "if (nowMs() - lastAsk >= recheckMs) {", "if (false as boolean) {"],
  ['cli: a timeout exits 0', C, "return { code: 1, stdout: '', stderr: `${note}no accepted plan after", "return { code: 0, stdout: '', stderr: `${note}no accepted plan after"],
  ['cli: --print asks the host', C, "if (p.bools.has('--print')) return", "if (false as boolean) return"],
  ['cli: seatRecords=off is not refused', C, "if (!seatRecordsOn(state)) throw new SeatRefusal('seat-records-off'", "if (false as boolean) throw new SeatRefusal('seat-records-off'"],
  ['cli: --run is optional for the agent (its own id would be the run)', C, "if (!run) throw new FanoutStateError('--run <id> is required", "if (false as boolean) throw new FanoutStateError('--run <id> is required"],
  ['cli: plan is not routed', X, "if (args[0] === 'plan') { // #604", "if (args[0] === 'plan-off') { // #604", true],
  ['cli: plan is not settled with the host', X, "if (!noHost) await settleHostIdentity();", "if (false as boolean) await settleHostIdentity();", true],
  ['cli: an unvouched host is trusted', X, "fanoutDeps.vouchedCaller = !noHost && hostIdentity?.source === 'host' ?", "fanoutDeps.vouchedCaller = !noHost ?", true],
  ['cli: --help asks the host', X, "const noHost = args.includes('--help') || args.includes('-h') || args.includes('--print');", "const noHost = false;", true],
  ['cli: the host call has no key', X, "const pr = await runPlan(args.slice(1), fanoutDeps, (body) => request('/fanoutAcceptance', body, { timeoutMs: 180_000 }));", "const pr = await runPlan(args.slice(1), fanoutDeps, (body) => request('/fanoutAcceptance', { ...body, key: undefined }, { timeoutMs: 180_000 }));", true],
];

only_and_main();
function only_and_main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  build();
  const base = run([...UNIT, ...CLI_TEST]);
  const baseOk = base.fail === 0 && base.skipped === 0 && base.pass >= 52 && base.pass === base.tests;
  console.log(`control (unpatched copy): ${base.pass} pass / ${base.fail} fail / ${base.skipped} skipped → ${baseOk ? 'GREEN' : 'RED'}`);
  if (!baseOk) { console.log(base.out.split('\n').filter((l) => /^not ok|error:/.test(l)).slice(0, 12).join('\n')); process.exit(1); }
  if (!process.argv.includes('--mutants')) { fs.rmSync(scratch, { recursive: true, force: true }); process.exit(0); }

  let survived = 0, refused = 0;
  for (const [i, [name, file, from, to, cli]] of mutants.entries()) {
    if (only && !name.includes(only)) continue;
    const f = path.join(scratch, file);
    const orig = fs.readFileSync(f, 'utf8');
    const n = orig.split(from).length - 1;
    if (n !== 1) { console.log(`M${String(i + 1).padStart(2, '0')} REFUSED (stale: the string occurs ${n}×, need exactly 1) — ${name}`); refused++; continue; }
    fs.writeFileSync(f, orig.replace(from, () => to));
    let r;
    try { if (cli) build(); r = run(cli ? CLI_TEST : UNIT); } finally { fs.writeFileSync(f, orig); }
    const killed = r.fail > 0 || Number.isNaN(r.pass); // a mutant that breaks loading (no TAP summary) is dead too
    if (!killed) survived++;
    console.log(`M${String(i + 1).padStart(2, '0')} ${killed ? 'KILLED' : 'SURVIVED'} (${r.pass} pass / ${r.fail} fail) — ${name}`);
  }
  build();
  const after = run([...UNIT, ...CLI_TEST]); // the restore is real: the copy is green again
  const same = after.fail === 0 && after.pass === base.pass && after.skipped === 0;
  console.log(`\n${mutants.length - survived - refused}/${mutants.length} mutants killed, ${survived} survived, ${refused} refused; scratch restored → ${same ? 'GREEN' : 'RED'}`);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(survived || refused || !same ? 1 : 0);
}

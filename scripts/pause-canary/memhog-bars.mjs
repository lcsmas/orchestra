// Pause canary 1b — the MEMORY-HOG exercise (#324, wave H ledger #329): the PASS BARS and the pure measurement logic. NEVER lower a bar: a failing drill is a bug report, not a retuned number.
// Pure + unit-tested (src/main/pause-canary-memhog.test.ts, mutants: `node scripts/pause-canary/mutate-bars.mjs --memhog`): absent data reads RED, never green.
// The contract (OPS lot 6198): the process that overflows the cap is killed · the session survives · the member AND its coordinator are told (#322) · must-FAIL with the cap OFF · every instrument seen RED.

import { mustFailVerdict } from './bars.mjs';

export const MEMHOG_BARS = Object.freeze({
  /** Q9 chain (residual (d) of #320, ledger comment c/6070521692): single tool commands OOM-killed one after the other. */
  chainPlanned: 30,
  chainGapMs: 300,
  /** a cap is "applied" when memory.max is the asked one ±1 page */
  capSlackBytes: 65536,
});

/** KNOWN-RED instruments: expected RED until their ticket is fixed. NOT bars — a RED here never fails a drill. EMPTY since #332 closed Q9 (ledger #329): the chain `q9:session_survives_chain` is a BAR now (promoted by emptying this table, as designed); the machinery stays for the next one. */
export const KNOWN_RED = Object.freeze({});

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v) => (num(v) ? `${v.toFixed(1)} s` : 'NOT MEASURED');
/** The cap as the PRODUCT words it (src/shared/memory-scope.ts `fmtGb`): `1 GB`, `1.5 GB`, `0.25 GB` — integers bare, else at most two decimals. A `toFixed(2)` here would have read the 1 GiB cap's `1 GB` as a missing notice. */
export const fmtCap = (capGb) => { const g = Math.round(capGb * 1024 ** 3) / 1024 ** 3; return `${Number.isInteger(g) ? g : +g.toFixed(2)} GB`; };
const clip = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

/** The marker a worker's hog carries in its command line (the kill record must NAME it): unique per worker and cycle. */
export const hogMarker = (k, cycle) => `memhog-${k}-c${cycle}`;
/** Is `marker` a WHOLE argument of the command line (not a prefix: `memhog-w1-c1` must not be satisfied by `memhog-w1-c11`)? */
export const hasMarker = (command, marker) => typeof marker === 'string' && marker !== '' && String(command ?? '').split(/\s+/).includes(marker);
/** `swarm.py` (scripts/memory-cap) prints one line when its children are reaped; null when the tool printed none. */
export function parseSwarm(text) {
  const m = /swarm: children=(\d+) survived=(\d+) killed=(\d+)/.exec(String(text ?? ''));
  return m ? { children: Number(m[1]), survived: Number(m[2]), killed: Number(m[3]) } : null;
}
/** How many of `seqs` (message sequences addressed to the coordinator) it has READ: lies in a lot (`deliveries`: from_seq < seq <= to_seq) it took AND acked. A lot taken but never acked is not "read". */
export function readByCoordinator(seqs, deliveries) {
  return seqs.filter((q) => deliveries.some((d) => d.acked_at !== null && d.acked_at !== undefined && q > d.from_seq && q <= d.to_seq)).length;
}

// ── per-worker predicates: null = ok, a string = the measured reason it is not. Absent data is never ok. ──
export function scopeWhy(w, m) {
  const s = w.scope;
  if (!s) return 'NOT MEASURED (no scope facts)';
  const want = Math.round(m.capGb * 1024 ** 3);
  const bad = [];
  if (s.inRig !== true) bad.push(`keeper is in NO rig scope (cgroup ${clip(s.cgroup ?? s.unit ?? 'none', 50)})`);
  if (!num(s.memoryMax) || Math.abs(s.memoryMax - want) > MEMHOG_BARS.capSlackBytes) bad.push(`memory.max=${s.memoryMax ?? 'absent'} want ${want}`);
  if (s.swapMax !== '0') bad.push(`memory.swap.max=${s.swapMax ?? 'absent'} (the swap escape must be closed)`);
  if (s.high !== 'max') bad.push(`memory.high=${s.high ?? 'absent'} (no soft throttle, ever)`);
  if (s.policy !== 'continue') bad.push(`OOMPolicy=${s.policy ?? 'absent'} (never group-kill)`);
  return bad.length ? bad.join('; ') : null;
}

export function hogKilledWhy(w) {
  const sw = w.swarm;
  if (!sw || !num(sw.killed) || !num(sw.survived)) return 'NOT MEASURED (the hog tool printed no result)';
  if (!num(w.oomKillDelta)) return 'NOT MEASURED (no memory.events reading)';
  if (sw.killed < 1 || sw.survived !== 0) return `hog NOT killed: killed=${sw.killed} survived=${sw.survived}, oom_kill +${w.oomKillDelta}`;
  if (w.oomKillDelta < 1) return `the tool says killed=${sw.killed} but the kernel counted oom_kill +${w.oomKillDelta}`;
  const named = (w.records ?? []).some((r) => r.level === 'hard' && typeof w.marker === 'string' && w.marker !== '' && hasMarker(r.command, w.marker));
  return named ? null : `killed (oom_kill +${w.oomKillDelta}) but no record names this worker's hog "${w.marker}": ${clip((w.records ?? []).map((r) => r.command ?? 'null').join(' | '))}`;
}

export function sessionWhy(w) {
  const s = w.session;
  if (!s) return 'NOT MEASURED (no session facts)';
  const bad = [];
  if (s.keeperSame !== true) bad.push(s.keeperAlive === false ? 'keeper GONE' : 'keeper REPLACED');
  if (s.cliSame !== true) bad.push(s.cliAlive === false ? 'CLI GONE' : 'CLI REPLACED');
  if (s.answered !== true) bad.push('the CLI no longer answers a tool command');
  return bad.length ? bad.join(', ') : null;
}

export function capHoldsWhy(w) {
  const s = w.session;
  if (!s) return 'NOT MEASURED (no session facts)';
  const bad = [];
  if (s.scopeActive !== true) bad.push('the scope is no longer active (group-kill?)');
  if (s.capState !== 'active') bad.push(`keeper cap.state=${s.capState ?? 'absent'}`);
  if (Array.isArray(s.capDegradations) && s.capDegradations.length) bad.push(`keeper.log reports ${s.capDegradations.length} degradation line(s): "${clip(s.capDegradations[0], 120)}"`);   // #332-fu D-Q14: a flip after boot is in the keeper log only
  return bad.length ? bad.join(', ') : null;
}

/** #343 (LEAD rule, ledger #329): a session killed by the scope's BACKSTOP — not by the work leaf's hard level. Counted explicitly, one episode blocks the default activation. Three signals: a `k`-leaf `oom_kill`, a scope `oom_kill` beyond the work leaf's
 *  (the scope's counter is hierarchical, so it includes `k`'s), the keeper or the CLI dead. Absent counters are NOT MEASURED, never zero. */
export function backstopWhy(w) {
  const b = w.backstop;
  if (!b || !num(b.kLeafKills) || !num(b.beyondWorkKills)) return 'NOT MEASURED (no k-leaf / scope oom_kill counters)';
  const s = w.session ?? {};
  const bad = [];
  if (b.kLeafKills > 0) bad.push(`keeper-leaf (k) oom_kill +${b.kLeafKills}`);
  if (b.beyondWorkKills > 0) bad.push(`scope oom_kill +${b.beyondWorkKills} beyond the work leaf's`);
  if (s.keeperAlive !== true) bad.push('keeper dead');
  if (s.cliAlive !== true) bad.push('CLI dead');
  return bad.length ? `BACKSTOP episode: ${bad.join(', ')}` : null;
}
/** Counters {k, scope, work} (oom_kill of the keeper leaf, the scope — hierarchical — and the work leaf; null = unreadable) read at two instants → the window's backstop kills; null when either reading is incomplete or a counter went DOWN. */
export function backstopDelta(before, after) {
  const ok = (c) => !!c && num(c.k) && num(c.scope) && num(c.work);
  if (!ok(before) || !ok(after)) return null;
  const d = { kLeafKills: after.k - before.k, beyondWorkKills: (after.scope - after.work) - (before.scope - before.work) };
  return d.kLeafKills < 0 || d.beyondWorkKills < 0 ? null : d;
}

export function memberToldWhy(w, m) {
  const rows = w.memberKillRows;
  if (!Array.isArray(rows) || !num(w.oomKillDelta)) return 'NOT MEASURED (no stream / no kernel count)';
  if (w.oomKillDelta < 1) return `no kill to tell (oom_kill +${w.oomKillDelta})`;
  if (rows.length !== w.oomKillDelta) return `${rows.length} notice row(s) for ${w.oomKillDelta} kill(s)`;
  const re = new RegExp(`^(Command .+|A command \\(probably .+\\)) killed: Plafond mémoire ${fmtCap(m.capGb).replace('.', '\\.')} reached$`);
  const odd = rows.find((t) => !re.test(t));
  return odd === undefined ? null : `row not worded as the #322 notice: "${clip(odd, 90)}"`;
}

export function coordinatorToldWhy(w, m) {
  if (!num(w.oomKillDelta) || !Array.isArray(w.coordMsgs)) return 'NOT MEASURED (no bus reading)';
  if (w.oomKillDelta < 1) return `no kill to tell (oom_kill +${w.oomKillDelta})`;
  const all = w.coordMsgs.filter((x) => x.kind === 'escalation');
  const msgs = all.filter((x) => x.recipient === m.opsId);   // a copy that went ELSEWHERE is bar:only_coordinator_told's business, not this one's
  if (msgs.length !== w.oomKillDelta) return `${msgs.length} escalation(s) to the coordinator for ${w.oomKillDelta} kill(s)${all.length !== msgs.length ? ` (${all.length - msgs.length} went to someone else)` : ''}`;
  const wrong = msgs.find((x) => !String(x.body).includes(w.id) || !String(x.body).includes(`hard level (${fmtCap(m.capGb)})`));
  if (wrong) return `escalation not naming the workspace and the level: "${clip(wrong.body, 90)}"`;
  if (w.coordRead !== msgs.length) return `the coordinator's own relève returned ${w.coordRead ?? 'NOT MEASURED'} of ${msgs.length} escalation(s)`;
  return null;
}

/** The checks of ONE cycle from its measured metrics (`m.workers[]`, see memhog.mjs). Every check is RED when its metric is absent. */
export function evaluateMemhogCycle(m) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: ok === true, detail });
  const ws = Array.isArray(m.workers) ? m.workers : [];
  const each = (id, why, what) => {
    const bad = ws.map((w) => [w, why(w, m)]).filter(([, r]) => r !== null);
    const short = ws.length !== m.expectWorkers;
    const detail = `${ws.length - bad.length}/${m.expectWorkers} workers ${what}${short ? ` (only ${ws.length} measured)` : ''}${bad.length ? ` — ${bad.slice(0, 3).map(([w, r]) => `${w.k}: ${r}`).join(' | ')}` : ''}`;
    add(id, ws.length > 0 && !short && bad.length === 0, detail);
  };
  each('workers_up', (w) => (w.up === true ? null : 'session never came up'), 'up (keeper + CLI answered the init)');
  each('bar:cap_scope_applied', scopeWhy, 'in their own capped scope');
  each('bar:hog_killed', hogKilledWhy, 'had the overflowing process killed (tool + kernel + named record)');
  each('bar:session_survives', sessionWhy, 'kept keeper + CLI (same pid+start) and still answer');
  each('bar:cap_holds_after_kill', capHoldsWhy, 'still have an active scope after the kill');
  each('bar:no_backstop_kill', backstopWhy, 'had NO scope-backstop kill (k-leaf and beyond-work oom_kill 0, keeper + CLI alive) — #343');
  each('bar:member_told', memberToldWhy, 'got exactly one #322 notice row per kill');
  each('bar:coordinator_told', coordinatorToldWhy, 'had their coordinator told (one escalation per kill, read by its own relève)');
  // only the coordinator is told: every member-sent message goes to the OPS, names its own sender, and the LEAD (the coordinator's coordinator) saw none
  const msgs = ws.flatMap((w) => (w.coordMsgs ?? []).map((x) => ({ ...x, from: w.id })));
  const strays = msgs.filter((x) => x.recipient !== m.opsId || !String(x.body).includes(x.from));
  const lead = m.leadSeen;
  add('bar:only_coordinator_told', msgs.length > 0 && strays.length === 0 && num(lead) && lead === 0,
    msgs.length === 0 ? 'NOT MEASURED (no member message on the bus to attribute)' : `${msgs.length} member message(s), ${strays.length} stray (wrong recipient / names another sender)${strays[0] ? `: to=${String(strays[0].recipient).slice(-4)} "${clip(strays[0].body, 70)}"` : ''}; the LEAD saw ${num(lead) ? lead : 'NOT MEASURED'}`);
  add('published:time_to_member_told_s', num(m.tMemberToldS), `last member notice row ${fmt(m.tMemberToldS)} after the hogs started (published; no bar)`);
  add('published:time_to_coordinator_told_s', num(m.tCoordToldS), `last coordinator escalation ${fmt(m.tCoordToldS)} after the hogs started (published; no bar)`);
  return checks;
}

/** Counts for the table, from the SAME predicates the checks use. */
export function summarizeMemhogCycle(m) {
  const ws = Array.isArray(m.workers) ? m.workers : [];
  const n = (why) => ws.filter((w) => why(w, m) === null).length;
  return { workers: ws.length, killed: n(hogKilledWhy), sessions: n(sessionWhy), memberTold: n(memberToldWhy), coordTold: n(coordinatorToldWhy), kills: ws.reduce((a, w) => a + (num(w.oomKillDelta) ? w.oomKillDelta : 0), 0), backstopKills: ws.reduce((a, w) => a + (num(w.backstop?.beyondWorkKills) ? w.backstop.beyondWorkKills : 0), 0), backstopOk: n(backstopWhy) };
}

/** The runner-side checks (measured by the PARENT, from outside the child): survivors and the live config. */
export function evaluateSurvivors(s) {
  const ok = !!s && num(s.procs) && num(s.units) && s.procs === 0 && s.units === 0;
  return { id: 'bar:no_survivors', ok, detail: s ? `${s.procs ?? 'NOT MEASURED'} process(es) carrying the rig dir, ${s.units ?? 'NOT MEASURED'} scope(s) with the rig prefix${ok ? '' : ' — LEAK'}` : 'NOT MEASURED' };
}
export function evaluateLiveUntouched(before, after) {
  const ok = !!before && !!after && JSON.stringify(before) === JSON.stringify(after);
  return { id: 'bar:live_config_untouched', ok, detail: before && after ? (ok ? '~/.claude* entry counts, links and inherit manifests unchanged' : `CHANGED: ${JSON.stringify(before)} → ${JSON.stringify(after)}`) : 'NOT MEASURED' };
}

/** One Q9 chain run (`r`: planned, done, killsTotal, inScope (the keeper really ran in a capped scope), cliSeen (the CLI answered its init), lostAfter (kernel kills counted when keeper or CLI vanished, else null), keeperAlive, cliAlive, answered).
 *  A session lost at the VERY FIRST kill reads killsTotal 0 (the counter dies with the scope): a loss in a capped scope IS the cap having killed something. */
export function evaluateChainRun(r) {
  const checks = [];
  const add = (id, ok, detail, extra = {}) => checks.push({ id, ok: ok === true, detail, ...extra });
  const lost = r.lostAfter !== null && r.lostAfter !== undefined;
  const planned = r.planned ?? MEMHOG_BARS.chainPlanned;
  // premise: the cap really killed the chain's tools (a chain that killed nothing — cap OFF, scope missing — proves nothing either way)
  // a lost session counts as « the cap killed the chain » only if the CLI was seen up AND the loss followed a kernel kill or took the keeper (the scope's counter dies with it); a CLI that never initialised proves nothing (review 2, finding 6)
  const cliSeen = r.cliSeen === true;
  const lostByCap = lost && ((num(r.lostAfter) && r.lostAfter >= 1) || r.keeperAlive === false);
  add('premise_chain_killed_tools', r.inScope === true && cliSeen && ((num(r.killsTotal) && r.killsTotal >= planned) || lostByCap), `${r.inScope === true ? 'capped scope' : 'NO capped scope'}; ${r.killsTotal ?? 'NOT MEASURED'} kernel kill(s) over ${r.done ?? '?'} of ${planned} tools${lost ? ' (session lost)' : ''}${cliSeen ? '' : '; the CLI never initialised'}${lost && !lostByCap ? '; lost with no kernel kill and the keeper alive' : ''}`, { cliSeen, inScope: r.inScope === true });
  const alive = r.keeperAlive === true && r.cliAlive === true;
  add('q9:session_survives_chain', !lost && alive && r.answered === true && r.done === r.planned,
    lost ? `session LOST after ${r.lostAfter} kernel kill(s): keeper ${r.keeperAlive ? 'alive' : 'GONE'}, CLI ${r.cliAlive ? 'alive' : 'GONE'}`
      : `${r.done}/${r.planned} tools killed, keeper ${r.keeperAlive ? 'alive' : 'GONE'}, CLI ${r.cliAlive ? 'alive' : 'GONE'}, ${r.answered === true ? 'answers' : alive ? 'ALIVE BUT DID NOT ANSWER a tool (3 tries)' : 'no answer'}`,
    { lostAfter: lost ? r.lostAfter : null, alive });
  // #343: the chain must not trip the scope's backstop either (counted from the k leaf and the scope beyond the work leaf)
  const bs = backstopWhy({ backstop: r.backstop, session: { keeperAlive: r.keeperAlive, cliAlive: r.cliAlive } });
  add('bar:no_backstop_kill', bs === null, bs ?? 'no k-leaf / beyond-work oom_kill, keeper + CLI alive', { backstop: r.backstop ?? null, episodes: !!r.backstop && (r.backstop.kLeafKills > 0 || r.backstop.beyondWorkKills > 0) });
  return checks;
}

/** The verdict over the chain exercise (its runs' checks): PASS = no run lost the session or tripped the backstop (a BAR since #332 closed Q9); FAIL = at least one did (a regression of #332 / #343); VOID = a run killed no tool chain (premise RED). */
export function chainVerdict(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return { verdict: 'VOID', detail: 'no chain run' };
  const q9 = (r) => r.find((c) => c.id === 'q9:session_survives_chain');
  const bsOf = (r) => r.find((c) => c.id === 'bar:no_backstop_kill');
  const premiseOf = (r) => r.find((c) => c.id === 'premise_chain_killed_tools');
  // a run missing a check it must carry measured nothing (review 4, m3: an empty run is not a PASS)
  const incomplete = runs.filter((r) => !q9(r) || !bsOf(r) || !premiseOf(r));
  if (incomplete.length) return { verdict: 'VOID', detail: `${incomplete.length}/${runs.length} run(s) carry no complete check set — nothing measured` };
  // COUNTED backstop kills (a k-leaf / beyond-work oom_kill) are evidence whatever the premise says: a CLI killed by the backstop with the keeper alive and no work-leaf kill must not hide as a VOID (review 4, m3)
  const counted = runs.filter((r) => bsOf(r).episodes === true);
  const premiseRed = runs.filter((r) => !premiseOf(r).ok);
  if (premiseRed.length && counted.length === 0) return { verdict: 'VOID', detail: `${premiseRed.length}/${runs.length} run(s) killed no tool chain (premise RED) — nothing measured` };
  const lost = runs.filter((r) => q9(r).ok === false || bsOf(r).ok === false);
  const how = (r) => (bsOf(r).episodes === true ? `backstop kill: ${clip(bsOf(r).detail, 90)}` : q9(r).ok === false ? (num(q9(r).lostAfter) ? `session lost after ${q9(r).lostAfter} kill(s)` : q9(r).alive === true ? 'alive but unresponsive' : 'cut short') : `backstop kill: ${clip(bsOf(r).detail, 90)}`);
  const detail = `${lost.length}/${runs.length} run(s) lost the session or tripped the scope backstop${lost.length ? ` (${lost.map(how).join('; ')})` : ''}`;
  return { verdict: lost.length > 0 ? 'FAIL' : 'PASS', detail };
}

/** Split a check list: bars (decide PASS) vs KNOWN-RED instruments (published, never decisive when RED). */
export function splitChecks(checks, table = KNOWN_RED) {
  const bars = checks.filter((c) => !Object.hasOwn(table, c.id));
  const known = checks.filter((c) => Object.hasOwn(table, c.id));
  return { bars, known, barsRed: bars.filter((c) => !c.ok && !c.id.startsWith('published:')), knownGreen: known.filter((c) => c.ok), knownRed: known.filter((c) => !c.ok) };
}

/** The checks a drill that really ran always has — a list missing any of them (a drive that died before measuring, an empty list) is NOT a PASS. */
export const REQUIRED_CYCLE_CHECKS = Object.freeze(['workers_up', 'bar:cap_scope_applied', 'bar:hog_killed', 'bar:session_survives', 'bar:cap_holds_after_kill', 'bar:no_backstop_kill', 'bar:member_told', 'bar:coordinator_told', 'bar:only_coordinator_told']);
/** What the RUNNER adds (measured from outside the drive). */
export const REQUIRED_RUNNER_CHECKS = Object.freeze(['bar:no_survivors']);

/** A drill's verdict from its checks. PASS iff every required check is present, no bar is RED and the published metrics exist. */
export function drillVerdict(checks, required = REQUIRED_CYCLE_CHECKS) {
  const s = splitChecks(checks);
  const publishedMissing = s.bars.filter((c) => !c.ok && c.id.startsWith('published:'));
  const absent = required.filter((id) => !checks.some((c) => c.id === id));
  return absent.length === 0 && s.barsRed.length === 0 && publishedMissing.length === 0 ? 'PASS' : 'FAIL';
}
/** The required ids a list is missing (for the report). */
export const missingChecks = (checks, required = REQUIRED_CYCLE_CHECKS) => required.filter((id) => !checks.some((c) => c.id === id));

/** The runner's verdict for a must-FAIL / sabotage proof arm: `mustFailVerdict` (rig reached the fleet, premise intact, the named instrument RED with a measured reason) + PRECISION: the instruments
 *  that must stay GREEN did (a sabotage that reddens everything proves nothing about which instrument saw it). */
export function memhogArmVerdict({ reached, premiseRed, hit, overRed = [] }) {
  const v = mustFailVerdict({ reached, premiseRed, hit });
  return v === 'AS-EXPECTED (RED)' && overRed.length > 0 ? 'OVER-RED' : v;
}

/** Markdown table of the cycles — what the OPS posts on the ledger / #319. */
export function renderMemhogTable(cycles) {
  const s = (v) => (num(v) ? v.toFixed(1) : 'n/a');
  const rows = cycles.map((c) => {
    const k = c.summary;
    if (!k) return `| ${c.exercise} | ${c.cycle} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ABORTED (no summary: the cycle did not finish measuring) |`;   // review 2, finding 8: an aborted cycle has no summary and must not lose the report
    const verdict = drillVerdict(c.checks) === 'PASS' ? 'PASS' : `FAIL (${splitChecks(c.checks).barsRed.map((x) => x.id.replace(/^bar:/, '')).join(', ')})`;
    return `| ${c.exercise} | ${c.cycle} | ${k.workers}/${c.expectWorkers} | ${k.killed}/${k.workers} | ${k.sessions}/${k.workers} | ${k.memberTold}/${k.workers} | ${k.coordTold}/${k.workers} | ${k.kills} | ${k.backstopKills ?? 'n/a'} | ${s(c.tMemberToldS)} | ${s(c.tCoordToldS)} | ${verdict} |`;
  });
  return ['| exercice | cycle | workers | hog tué | session intacte | membre prévenu | coordinateur prévenu | kills noyau | kills filet (#343) | notice membre (s) | notice coord. (s) | verdict |', '|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

/** A drill the host cut short (rc 3 / VOID) is no verdict — unless a bar was ALREADY measured RED before the cut: that RED is evidence, the verdict is FAIL (never a VOID that hides it). */
export function voidOrFail(checks) {
  return splitChecks(Array.isArray(checks) ? checks : []).barsRed.length > 0 ? 'FAIL' : 'VOID';
}

/** The runner's verdict word over what ran: memhog's (PARTIAL when green but not the contract shape), else — chain alone — the chain's own state. A chain ASKED FOR and never measured is no PASS; a leak or a changed live config fails whatever ran. */
export function canaryWord({ hasMh, hasCh, mhVerdict, full, chV, chainSurvBad, liveOk }) {
  let word = hasMh ? (mhVerdict === 'PASS' && !full ? 'PARTIAL' : mhVerdict) : hasCh ? (chV === 'PASS' ? 'PASS' : chV === 'VOID' ? 'VOID' : 'FAIL') : 'NOT-RUN';
  if (hasMh && hasCh && chV !== 'PASS' && (word === 'PASS' || word === 'PARTIAL')) word = chV === 'VOID' ? 'VOID' : 'FAIL';
  if (!hasMh && (chainSurvBad || !liveOk)) word = 'FAIL';
  if (hasCh && chV === 'FAIL') word = 'FAIL';   // a chain RED that was MEASURED is evidence: a VOID memhog drill never hides it (review 4, m2)
  return word;
}
/** Exit code of a verdict word: 0 PASS · 4 PARTIAL · 3 VOID / NOT-RUN (nothing measured) · 1 anything else (a bar is RED — never a retuned number). */
export const canaryExit = (word) => (word === 'PASS' ? 0 : word === 'PARTIAL' ? 4 : word === 'VOID' || word === 'NOT-RUN' ? 3 : 1);

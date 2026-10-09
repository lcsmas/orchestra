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

/** KNOWN-RED instruments: expected RED until their ticket is fixed. NOT bars — a RED here never fails a drill, and a GREEN here fails the PROOF (the instrument went stale, or Q9 is fixed: promote it to a bar by emptying this table). */
export const KNOWN_RED = Object.freeze({
  'q9:session_survives_chain': { what: 'a chain of tool commands killed one after the other must not cost the session (keeper + CLI)', ticket: 'Q9 / residual (d) of #320', ref: 'ledger #329 comment 6070521692' },
});

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v) => (num(v) ? `${v.toFixed(1)} s` : 'NOT MEASURED');
const gb = (v) => Number(v).toFixed(2);
const clip = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

/** The marker a worker's hog carries in its command line (the kill record must NAME it): unique per worker and cycle. */
export const hogMarker = (k, cycle) => `memhog-${k}-c${cycle}`;
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
  const named = (w.records ?? []).some((r) => r.level === 'hard' && typeof w.marker === 'string' && w.marker !== '' && String(r.command ?? '').includes(w.marker));
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
  return bad.length ? bad.join(', ') : null;
}

export function memberToldWhy(w, m) {
  const rows = w.memberKillRows;
  if (!Array.isArray(rows) || !num(w.oomKillDelta)) return 'NOT MEASURED (no stream / no kernel count)';
  if (w.oomKillDelta < 1) return `no kill to tell (oom_kill +${w.oomKillDelta})`;
  if (rows.length !== w.oomKillDelta) return `${rows.length} notice row(s) for ${w.oomKillDelta} kill(s)`;
  const re = new RegExp(`^(Command .+|A command \\(probably .+\\)) killed: Plafond mémoire ${gb(m.capGb).replace('.', '\\.')} GB reached$`);
  const odd = rows.find((t) => !re.test(t));
  return odd === undefined ? null : `row not worded as the #322 notice: "${clip(odd, 90)}"`;
}

export function coordinatorToldWhy(w, m) {
  if (!num(w.oomKillDelta) || !Array.isArray(w.coordMsgs)) return 'NOT MEASURED (no bus reading)';
  if (w.oomKillDelta < 1) return `no kill to tell (oom_kill +${w.oomKillDelta})`;
  const all = w.coordMsgs.filter((x) => x.kind === 'escalation');
  const msgs = all.filter((x) => x.recipient === m.opsId);   // a copy that went ELSEWHERE is bar:only_coordinator_told's business, not this one's
  if (msgs.length !== w.oomKillDelta) return `${msgs.length} escalation(s) to the coordinator for ${w.oomKillDelta} kill(s)${all.length !== msgs.length ? ` (${all.length - msgs.length} went to someone else)` : ''}`;
  const wrong = msgs.find((x) => !String(x.body).includes(w.id) || !String(x.body).includes(`hard level (${gb(m.capGb)} GB)`));
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
  return { workers: ws.length, killed: n(hogKilledWhy), sessions: n(sessionWhy), memberTold: n(memberToldWhy), coordTold: n(coordinatorToldWhy), kills: ws.reduce((a, w) => a + (num(w.oomKillDelta) ? w.oomKillDelta : 0), 0) };
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

/** One Q9 chain run (`r`: planned, done, killsTotal, lostAfter (kill index at which keeper or CLI vanished, else null), keeperAlive, cliAlive, answered). */
export function evaluateChainRun(r) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: ok === true, detail });
  const lost = r.lostAfter !== null && r.lostAfter !== undefined;
  // premise: the cap really killed the chain's tools (a chain that killed nothing — cap OFF, scope missing — proves nothing either way)
  add('premise_chain_killed_tools', num(r.killsTotal) && r.killsTotal >= 1 && (lost || r.killsTotal >= (r.planned ?? MEMHOG_BARS.chainPlanned)), `${r.killsTotal ?? 'NOT MEASURED'} kernel kill(s) over ${r.done ?? '?'} of ${r.planned ?? '?'} tools`);
  add('q9:session_survives_chain', !lost && r.keeperAlive === true && r.cliAlive === true && r.answered === true && r.done === r.planned,
    lost ? `session LOST after ${r.lostAfter} kernel kill(s): keeper ${r.keeperAlive ? 'alive' : 'GONE'}, CLI ${r.cliAlive ? 'alive' : 'GONE'}` : `${r.done}/${r.planned} tools killed, keeper ${r.keeperAlive ? 'alive' : 'GONE'}, CLI ${r.cliAlive ? 'alive' : 'GONE'}, answers ${r.answered === true}`);
  return checks;
}

/** The verdict over a Q9 chain exercise (its runs' checks). KNOWN-RED = the expected state; KNOWN-RED-GONE = the chain never lost the session in any run (Q9 fixed, or the instrument stopped reproducing: look, then promote). */
export function chainVerdict(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return { verdict: 'VOID', detail: 'no chain run' };
  const premiseRed = runs.filter((r) => r.some((c) => c.id === 'premise_chain_killed_tools' && !c.ok));
  if (premiseRed.length) return { verdict: 'VOID', detail: `${premiseRed.length}/${runs.length} run(s) killed no tool chain (premise RED) — nothing measured` };
  const lost = runs.filter((r) => r.some((c) => c.id === 'q9:session_survives_chain' && !c.ok));
  const detail = `${lost.length}/${runs.length} run(s) lost the session${lost.length ? ` (${lost.map((r) => r.find((c) => c.id === 'q9:session_survives_chain').detail.replace(/^session LOST after (\d+) .*/, '$1')).join(', ')} kill(s) in)` : ''}`;
  return { verdict: lost.length > 0 ? 'KNOWN-RED' : 'KNOWN-RED-GONE', detail };
}

/** Split a check list: bars (decide PASS) vs KNOWN-RED instruments (published, never decisive when RED). */
export function splitChecks(checks) {
  const bars = checks.filter((c) => !Object.hasOwn(KNOWN_RED, c.id));
  const known = checks.filter((c) => Object.hasOwn(KNOWN_RED, c.id));
  return { bars, known, barsRed: bars.filter((c) => !c.ok && !c.id.startsWith('published:')), knownGreen: known.filter((c) => c.ok), knownRed: known.filter((c) => !c.ok) };
}

/** A drill's verdict from its cycles' checks (+ the runner's). PASS iff no bar is RED and published metrics exist. */
export function drillVerdict(checks) {
  const s = splitChecks(checks);
  const publishedMissing = s.bars.filter((c) => !c.ok && c.id.startsWith('published:'));
  return s.barsRed.length === 0 && publishedMissing.length === 0 ? 'PASS' : 'FAIL';
}

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
    const verdict = drillVerdict(c.checks) === 'PASS' ? 'PASS' : `FAIL (${splitChecks(c.checks).barsRed.map((x) => x.id.replace(/^bar:/, '')).join(', ')})`;
    return `| ${c.exercise} | ${c.cycle} | ${k.workers}/${c.expectWorkers} | ${k.killed}/${k.workers} | ${k.sessions}/${k.workers} | ${k.memberTold}/${k.workers} | ${k.coordTold}/${k.workers} | ${k.kills} | ${s(c.tMemberToldS)} | ${s(c.tCoordToldS)} | ${verdict} |`;
  });
  return ['| exercice | cycle | workers | hog tué | session intacte | membre prévenu | coordinateur prévenu | kills noyau | notice membre (s) | notice coord. (s) | verdict |', '|---|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

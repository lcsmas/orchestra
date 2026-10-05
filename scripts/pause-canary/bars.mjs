// Pause canary (#258) — the PASS BARS and the pure measurement logic. NEVER lower a bar (ledger #281 D3): a failing drill is a bug report, not a retuned number.
// Pure + unit-tested (src/main/pause-canary-bars.test.ts) so each instrument has a must-FAIL fixture: absent data reads RED, never green.

export const BARS = Object.freeze({
  hardAllPausedS: 60,          // Pause dure: every member paused in < 60 s
  softDeadlineS: 180,          // Pause douce: the host escalates AT the 3-min deadline …
  softEscalationSlackS: 5,     // … (timer + sweep slack)
  softTrapAfterEscalationS: 60,// … and the escalated trap is a hard pause: it must meet the hard bar from the escalation on
  lostWork: 0,
  selfRestarts: 0,
});

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v) => (num(v) ? `${v.toFixed(1)} s` : 'NOT MEASURED');

/** Lost-work verdict from FACTS the drive read out of git. `members[i].markers[j]` = { name, needle, found: { branch, pushed, ref } } where each `found.*` is the file content at that location or null.
 *  A marker is lost iff its needle is in NONE of the three; a branch is intact iff the pre-pause head is an ancestor of (or equal to) the branch tip now. */
export function lostWorkOf(members) {
  const lost = [];
  let markers = 0;
  let branches = 0;
  let intact = 0;
  for (const m of members) {
    branches++;
    if (m.branchIntact === true) intact++;
    else lost.push(`${m.id}: branch NOT intact (${m.branchDetail ?? 'pre-pause head is not an ancestor of the tip'})`);
    for (const mk of m.markers) {
      markers++;
      const hit = ['branch', 'pushed', 'ref'].find((loc) => typeof mk.found?.[loc] === 'string' && mk.found[loc].includes(mk.needle));
      if (!hit) lost.push(`${m.id}: ${mk.name} (${JSON.stringify(mk.needle)}) in NO location (branch/pushed/pause ref)`);
    }
  }
  return { members: members.length, markers, lostCount: lost.length, lost, branches, branchesIntact: intact };
}

/** API requests (those that CARRY tools = a real turn) a member had no right to make. `forbidden`: [{ role|'*', from, until }] (ms epoch, `until` null = open). Returns the offending requests. */
export function forbiddenRequests(requests, forbidden) {
  const out = [];
  for (const r of requests) {
    if (!(r.tools > 0)) continue;
    for (const w of forbidden) {
      if ((w.role === '*' || w.role === r.role) && r.t >= w.from && (w.until === null || w.until === undefined || r.t < w.until)) { out.push({ role: r.role, t: r.t, tool: r.tool ?? null, limitPrompt: r.limitPrompt === true, window: w.label ?? '' }); break; }
    }
  }
  return out;
}

/** The forbidden-request windows of the HOLD (verifier n°2 H-1, ledger #281 c/6002392986). A window that opens only at the RUN's trap stamp is blind to a member that finished EARLIER: the trap runs members in waves
 *  (concurrency 3), so a member done at +1.0 s whose CLI sends a request at +1.5 s is invisible when the last member (the stamp) completes at +2.3 s. A member the HOST took (`trap`) or found idle (`host-idle`) is paused from ITS OWN
 *  completion — `pause_members.pause_confirmed_at`, stamped by `confirmByTrap` right after `trapMember` returned (interrupt + kill DONE; `pause_records.created_at` is written BEFORE the interrupt, so it would flag in-flight requests).
 *  A member that confirmed ITSELF (Pause douce `member`) still makes its final request after its accusé: its window stays the run stamp. `rows` = the pause epoch's roster; `members` = [{ role, wsId }]. The `*` window (run stamp) always stays. */
export function holdWindows({ rows, tTrapDone, tR, members, legacy = false }) {
  const out = [];
  if (!legacy) {
    for (const m of members) {
      const row = rows.find((x) => x.ws_id === m.wsId);
      const done = row?.pause_confirmed_at;
      const own = (row?.pause_confirm_via === 'trap' || row?.pause_confirm_via === 'host-idle') && num(done);
      if (own && done < tTrapDone) out.push({ role: m.role, from: done, until: tR, label: 'hold-own' });
    }
  }
  out.push({ role: '*', from: tTrapDone, until: tR, label: 'hold' });
  return out;
}

/** Is `p` a MEMBER's tool process? `p` = a /proc census entry { pid, ppid, cwd, cmd }; `byPid` = Map pid → entry (the whole rig census); `kindOf(entry)` = 'keeper' | 'claude' | 'app' | …;
 *  `memberOf(entry)` = the member (`w3`) whose worktree it runs in, or null. A tool is anything in a member's worktree that is not its keeper / CLI / the app / an `orchestra cli` client AND whose ancestry does
 *  NOT reach the APP before a CLI or keeper: the app itself runs git in the worktrees (status / diff refresh: `git ls-files --others …`, ppid = app, seen 31 s after a trap — F3, ledger #281 c/6001999281) and that is
 *  host work, not a member restarting. An ORPHAN (ancestry ends without reaching the app) still counts: a killed command that escaped its tree is exactly what the instrument must see. */
export function isMemberTool(p, byPid, kindOf, memberOf) {
  if (!memberOf(p)) return false;
  if (['keeper', 'claude', 'app'].includes(kindOf(p))) return false;
  if (/orchestra cli /.test(p.cmd) || / cli /.test(p.cmd)) return false;
  let q = p;
  for (let hops = 0; hops < 64; hops++) {
    const parent = byPid.get(q.ppid);
    if (!parent) return true;                                   // orphan / parent outside the rig: counts
    const k = kindOf(parent);
    if (k === 'claude' || k === 'keeper') return true;          // a member's own tree
    if (k === 'app') return false;                              // the app's own child (git refresh…)
    q = parent;
  }
  return true;
}

/** The checks of ONE cycle from its measured metrics. Every check is RED when its metric is absent. `m.mode` = 'soft' | 'hard'. */
export function evaluateCycle(m) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: ok === true, detail });
  if (m.mode === 'soft') {
    // the ticket's 3 min is a CONSTANT of this harness, never read back from the app under test: an app whose deadline regressed to 10 min must read RED
    const esc = m.escalatedAtS;
    add('bar:soft_deadline_is_3_min', num(m.deadlineS) && Math.abs(m.deadlineS - BARS.softDeadlineS) <= 1, `the app's own pause deadline = ${fmt(m.deadlineS)} (the ticket's bar: ${BARS.softDeadlineS} s)`);
    add('bar:soft_escalated_by_deadline', num(esc) && esc <= BARS.softDeadlineS + BARS.softEscalationSlackS, `escalated at ${fmt(esc)} after the pause was written (deadline ${BARS.softDeadlineS} s + ${BARS.softEscalationSlackS} s slack)`);
    add('bar:soft_all_paused_lt_deadline_plus_hard_bar', num(m.tAllPausedS) && num(esc) && m.tAllPausedS < esc + BARS.softTrapAfterEscalationS, `all paused at ${fmt(m.tAllPausedS)} (escalation ${fmt(esc)} + trap < ${BARS.softTrapAfterEscalationS} s, so < 3 min + escalation)`);
  } else {
    add('bar:hard_all_paused_lt_60s', num(m.tAllPausedS) && m.tAllPausedS < BARS.hardAllPausedS, `all paused at ${fmt(m.tAllPausedS)} (bar < ${BARS.hardAllPausedS} s)`);
  }
  const lw = m.lostWork;
  add('bar:lost_work_is_zero', !!lw && num(lw.markers) && lw.markers > 0 && lw.lostCount === BARS.lostWork && lw.branchesIntact === lw.branches && lw.branches > 0, lw ? `${lw.lostCount} lost of ${lw.markers} markers; branches intact ${lw.branchesIntact}/${lw.branches}${lw.lost?.length ? ` — ${lw.lost.slice(0, 3).join(' | ')}` : ''}` : 'NOT MEASURED');
  const sr = m.selfRestarts;
  add('bar:no_self_restart', !!sr && Array.isArray(sr.members) && sr.members.length === BARS.selfRestarts && sr.probes > 0, sr ? `${sr.members.length} member(s) restarted on their own${sr.members.length ? `: ${sr.members.join(', ')}` : ''}; hold probes sent ${sr.probes ?? 0}; ${sr.detail ?? ''}` : 'NOT MEASURED');
  const ra = m.repriseAccused;
  add('bar:every_member_reprise_accused', !!ra && num(ra.m) && ra.m > 0 && ra.n === ra.m && ra.m >= (m.rosterMin ?? 1), ra ? `${ra.n}/${ra.m} members accused the Reprise${ra.missing?.length ? ` — missing: ${ra.missing.join(', ')}` : ''}` : 'NOT MEASURED');
  add('published:time_to_all_resumed', num(m.tAllResumedS), `all resumed at ${fmt(m.tAllResumedS)} (published; no bar)`);
  if (m.mode === 'soft') {
    const pa = m.pauseAccused;
    add('bar:every_member_pause_accused', !!pa && num(pa.m) && pa.m > 0 && pa.n === pa.m && pa.m >= (m.rosterMin ?? 1), pa ? `${pa.n}/${pa.m} roster rows paused (${Object.entries(pa.via ?? {}).map(([k, v]) => `${k}:${v}`).join(' ')})` : 'NOT MEASURED');
  }
  return checks;
}

/** Markdown table of the cycles (exercise × cycle × metrics) — what the OPS posts on the ledger / #258. */
export function renderTable(cycles) {
  const s = (v) => (num(v) ? v.toFixed(1) : 'n/a');
  const rows = cycles.map((c) => {
    const lw = c.lostWork;
    const verdict = c.checks.every((k) => k.ok) ? 'PASS' : `FAIL (${c.checks.filter((k) => !k.ok).map((k) => k.id.replace(/^(bar|published):/, '')).join(', ')})`;
    return `| ${c.exercise} | ${c.cycle} | ${c.workers}/${c.rosterSize ?? '?'} | ${s(c.tAllPausedS)} | ${c.mode === 'soft' ? s(c.escalatedAtS) : '—'} | ${s(c.tAllResumedS)} | ${lw ? `${lw.lostCount}/${lw.markers}` : 'n/a'} | ${lw ? `${lw.branchesIntact}/${lw.branches}` : 'n/a'} | ${c.selfRestarts ? c.selfRestarts.members.length : 'n/a'} | ${c.repriseAccused ? `${c.repriseAccused.n}/${c.repriseAccused.m}` : 'n/a'} | ${verdict} |`;
  });
  return ['| exercice | cycle | workers/roster | all-paused (s) | escalade (s) | all-resumed (s) | travail perdu | branches intactes | auto-relances | reprise-accusés | verdict |', '|---|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

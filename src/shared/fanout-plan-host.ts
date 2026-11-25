// #604 (ledger #613 FROZEN v1) — the plan step's flow, pure of Electron: the HOST op that spawns the single-use plan agent (`dispatchPlan`, op `plan` of the `/fanoutAcceptance` route) and the
// SUBMIT the agent's CLI runs (`submitPlan`): check the plan, answer with the reasons, one retry, a second refusal ends the run. State: the plan itself lands in state.json (`applyPlan`); what the
// step has to remember (which agent, how many submissions) lives in `fanout/<run>/plan-agent.json`, written under the state lock.
import fs from 'node:fs';
import path from 'node:path';
import { TICKET_ID, applyPlan, parsePlan, planHash, validatePlan, PlanError, type PlanReason } from './fanout-plan.ts';
import { planAgentName, renderPlanBrief } from './fanout-plan-brief.ts';
import { FanoutStateError, SeatRefusal, assertRunId, seatRecordsOn, stampDefaults, stateFile, switchesLockedWhy, updateState, type FanoutState } from './fanout-state.ts';

export const PLAN_MAX_SUBMISSIONS = 2;
/** The agent may be (re)spawned at most this many times for one run (a dead one is replaced once). */
export const PLAN_MAX_SPAWNS = 2;
/** A claim whose spawn never settled (the host died between the two writes) is taken over after this long. */
export const PLAN_CLAIM_STALE_MS = 240_000; // longer than the CLI's 180 s host call: a slow spawn is not taken over
export const PLAN_FILE_MAX = 1_000_000;

export interface PlanSidecar {
  version: 1;
  /** The run's tickets, as the coordinator named them (`--tickets`): what the plan is checked against. */
  tickets: string[];
  /** The plan agent: `id` null = the spawn is in flight (or failed). */
  agent: { id: string | null; name: string; at: string } | null;
  spawns: number;
  attempts: Array<{ at: string; ok: boolean; reasons: PlanReason[] }>;
  /** `failed` = a plan that passed the check could not be recorded (`failure` = why): the step ends, the coordinator is told. */
  outcome: 'open' | 'accepted' | 'refused-twice' | 'failed';
  failure?: string;
}

export const planSidecarFile = (home: string, run: string): string => path.join(path.dirname(stateFile(home, run)), 'plan-agent.json');

export function readPlanSidecar(home: string, run: string): PlanSidecar | null {
  let raw: string;
  try { raw = fs.readFileSync(planSidecarFile(home, run), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  let v: PlanSidecar;
  try { v = JSON.parse(raw) as PlanSidecar; } catch (e) { throw new FanoutStateError(`${planSidecarFile(home, run)} is not JSON (${e instanceof Error ? e.message : String(e)}) — remove it to ask for the plan again`); }
  if (v?.version !== 1 || !Array.isArray(v.tickets) || !Array.isArray(v.attempts)) throw new FanoutStateError(`${planSidecarFile(home, run)} is not a plan record (version 1)`);
  return v;
}

function writePlanSidecar(home: string, run: string, sc: PlanSidecar): void {
  const file = planSidecarFile(home, run);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(sc, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const reasonsText = (rs: PlanReason[]): string => rs.map((r) => `[${r.code}] ${r.detail}`).join('\n');

export type SubmitResult =
  | { kind: 'accepted'; attempts: number; hash: string; tickets: number }
  | { kind: 'refused'; attempt: number; final: boolean; reasons: PlanReason[] };

/** `orchestra fanout plan submit`, store-side: ONE critical section under the state lock. `caller` = the workspace the HOST vouched (null = nobody). Refusals that are not about the plan throw a SeatRefusal:
 *  `[plan-not-requested]` · `[plan-closed]` (a plan was accepted) · `[plan-refused-twice]` · `[plan-caller]` (not the recorded plan agent, or not vouched). A plan refused is a RESULT (the reasons), counted. */
export function submitPlan(i: { home: string; run: string; text: string; caller: string | null; now: string }): SubmitResult {
  const run = assertRunId(i.run);
  if (i.text.length > PLAN_FILE_MAX) throw new FanoutStateError(`the plan file is over ${PLAN_FILE_MAX} bytes`);
  let result: SubmitResult | null = null;
  let failure: unknown = null;
  const accepted: { sc: PlanSidecar | null } = { sc: null };
  updateState(stateFile(i.home, run), (cur) => {
    if (!cur) throw new FanoutStateError(`no fanout state for run ${run} — run \`orchestra fanout state init\` first`);
    const sc = readPlanSidecar(i.home, run);
    if (cur.loopPlan) throw new SeatRefusal('plan-closed', `the plan of run ${run} was accepted (${cur.loopPlan.at}): you are done — end your session`);
    if (cur.planRefusal) throw new SeatRefusal(cur.planRefusal.code, `the plan step of run ${run} ended (${cur.planRefusal.at}): ${cur.planRefusal.detail}`); // the state remembers it: deleting the plan record reopens nothing
    if (!sc) throw new SeatRefusal('plan-not-requested', `run ${run} has no plan request (the coordinator asks for one with \`orchestra fanout plan --tickets <id,…>\`)`);
    if (!i.caller || !sc.agent?.id || i.caller !== sc.agent.id) throw new SeatRefusal('plan-caller', `only the plan agent of run ${run}${sc.agent?.id ? ` (${sc.agent.name})` : ' (not recorded yet — retry in a few seconds)'} submits its plan${i.caller ? `, not ${i.caller}` : ' — the host could not vouch this session'}`);
    const v = validatePlan(i.text, sc.tickets);
    const n = sc.attempts.length + 1;
    if (v.ok && v.plan) {
      let next: FanoutState;
      try { next = applyPlan(cur, v.plan, i.now, n); } catch (e) { // a plan that passed the check but cannot be recorded (seat-records-off, plan-after-spawn, a pre-declared interface…): not a refusal of the plan, the step ENDS and the coordinator is told
        const msg = e instanceof Error ? e.message : String(e);
        writePlanSidecar(i.home, run, { ...sc, outcome: 'failed', failure: msg });
        failure = e;
        return { ...cur, planRefusal: { at: i.now, code: 'plan-apply-failed', detail: msg }, updatedAt: i.now };
      }
      accepted.sc = sc; // the sidecar says `accepted` only AFTER the state write below succeeded (the state is the truth)
      result = { kind: 'accepted', attempts: n, hash: planHash(v.plan), tickets: v.plan.tickets.length };
      return next;
    }
    const final = n >= PLAN_MAX_SUBMISSIONS;
    writePlanSidecar(i.home, run, { ...sc, attempts: [...sc.attempts, { at: i.now, ok: false, reasons: v.reasons }], outcome: final ? 'refused-twice' : 'open' });
    result = { kind: 'refused', attempt: n, final, reasons: v.reasons };
    return final ? { ...cur, planRefusal: { at: i.now, code: 'plan-refused-twice', detail: `refused twice — ${v.reasons.map((r) => `[${r.code}] ${r.detail}`).join('; ').slice(0, 1500)}` }, updatedAt: i.now } : cur;
  });
  if (failure) throw failure; // after the state remembered it
  if (accepted.sc) writePlanSidecar(i.home, run, { ...accepted.sc, attempts: [...accepted.sc.attempts, { at: i.now, ok: true, reasons: [] }], outcome: 'accepted' });
  return result!;
}

/** What the agent is told. Accepted ends it; the first refusal lists the reasons and allows one more; the second is final. */
export function submitText(r: SubmitResult): { code: number; stdout: string; stderr: string } {
  if (r.kind === 'accepted') return { code: 0, stdout: `plan accepted (${r.tickets} tickets, submission ${r.attempts}, ${r.hash.slice(0, 12)}). You are done: end your session now, write nothing else.\n`, stderr: '' };
  if (r.final) return { code: 2, stdout: '', stderr: `[plan-refused-twice] the plan was refused a second time — the run does not start. Reasons:\n${reasonsText(r.reasons)}\nYou are done: end your session.\n` };
  return { code: 2, stdout: '', stderr: `plan refused (${r.reasons.length} reason${r.reasons.length === 1 ? '' : 's'}) — fix the file and submit ONCE more; a second refusal ends the run:\n${reasonsText(r.reasons)}\n` };
}

// ── the host op: spawn the single-use agent ────────────────────────────────────────────────────────────────────
export interface PlanHostDeps {
  home: string;
  now: () => string;
  isWorkspace: (id: string) => boolean;
  /** Is this workspace alive (exists, not archived)? Absent = `isWorkspace`. */
  isLive?: (id: string) => boolean;
  repoPath: (i: { run: string; ticket: string; from?: string; repo: string | null; implementer: string | null }) => string | undefined;
  /** The agent spawn route: the role table pins the explorer role from the `explo-` prefix. */
  spawn: (i: { from?: string; name: string; task: string; repoPath?: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
  /** Did the host vouch `id` with this session key (the live session of that workspace)? Absent = nobody is vouched and the op is refused. */
  vouches?: (id: string, key: string | undefined) => boolean;
}
export type PlanHostResult =
  | { ok: true; op: 'plan'; action: 'spawn' | 'respawn' | 'adopt' | 'in-flight' | 'accepted'; id: string | null; name: string }
  | { ok: false; error: string };

export type PlanAgentDecision = { action: 'spawn' | 'respawn' | 'adopt' | 'in-flight'; id?: string } | { action: 'refuse'; refusal: string; detail: string };
/** Pure: what a `plan` call does given the sidecar, the clock and liveness. */
export function decidePlanAgent(sc: PlanSidecar | null, tickets: string[], now: string, live: (id: string) => boolean): PlanAgentDecision {
  if (!sc) return { action: 'spawn' };
  const same = sc.tickets.length === tickets.length && sc.tickets.every((t) => tickets.includes(t));
  if (!same) return { action: 'refuse', refusal: 'plan-tickets-changed', detail: `the plan of this run was requested for ${sc.tickets.join(', ')} — not for ${tickets.join(', ')}` };
  const a = sc.agent;
  if (!a) return sc.spawns >= PLAN_MAX_SPAWNS ? { action: 'refuse', refusal: 'plan-agent-dead', detail: 'the plan agent could not be started' } : { action: 'spawn' };
  if (a.id) {
    if (live(a.id)) return { action: 'adopt', id: a.id };
    return sc.spawns >= PLAN_MAX_SPAWNS ? { action: 'refuse', refusal: 'plan-agent-dead', detail: `the plan agent ${a.name} (${a.id}) died with no plan, and was already replaced once` } : { action: 'respawn' };
  }
  const age = Date.parse(now) - Date.parse(a.at);
  if (Number.isFinite(age) && age < PLAN_CLAIM_STALE_MS) return { action: 'in-flight' };
  return sc.spawns >= PLAN_MAX_SPAWNS ? { action: 'refuse', refusal: 'plan-agent-dead', detail: 'the plan agent could not be started' } : { action: 'respawn' };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const refusal = (name: string, detail: string): PlanHostResult => ({ ok: false, error: `[${name}] ${detail}` });

/** Op `plan` of the `/fanoutAcceptance` route: spawn the plan agent (or adopt the live one — never two). The caller must be the run's coordinator ON THE HOST'S WORD. */
export async function dispatchPlan(input: Record<string, unknown>, deps: PlanHostDeps): Promise<PlanHostResult> {
  try {
    const run = assertRunId(str(input.run) ?? '');
    const caller = str(input.from);
    if (!caller || caller !== run || !deps.vouches || !deps.vouches(caller, str(input.key))) return refusal('plan-caller', `only the run's coordinator (${run}) asks for its plan${caller && caller !== run ? `, not ${caller}` : ' — the host could not vouch this session'}`);
    const tickets = Array.isArray(input.tickets) ? [...new Set((input.tickets as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean))] : [];
    const badId = tickets.find((t) => !TICKET_ID.test(t));
    if (badId !== undefined) return refusal('plan-bad-ticket-id', `${JSON.stringify(badId.slice(0, 40))} is not a ticket id (letters, digits, . _ # : -, at most 64): the brief is rendered from ids, never from text`);
    if (!tickets.length) return refusal('plan-no-tickets', 'name the run\'s tickets: orchestra fanout plan --tickets <id,id,…>');
    const file = stateFile(deps.home, run);
    const live = deps.isLive ?? deps.isWorkspace;
    const now = deps.now();
    const name = planAgentName(run);
    let action: 'spawn' | 'respawn' = 'spawn';
    let early: PlanHostResult | null = null;
    let adopted: { action: 'adopt' | 'in-flight' | 'accepted'; id: string | null } | null = null;
    let task = '';
    let repo: string | null = null;
    updateState(file, (cur) => { // EVERYTHING is decided under the state lock, and the slot is claimed BEFORE the spawn: two concurrent calls spawn ONE agent, a plan that lands meanwhile spawns none
      if (!cur) throw new FanoutStateError(`no fanout state for run ${run}`);
      if (!seatRecordsOn(cur)) { early = refusal('seat-records-off', `run ${run} has seatRecords=off: the plan step is a seatRecords rule (state init --switch seatRecords=on)`); return cur; }
      if (cur.loopPlan) { adopted = { action: 'accepted', id: null }; return cur; }
      if (cur.planRefusal) { early = refusal(cur.planRefusal.code, `the plan step of run ${run} ended (${cur.planRefusal.at}): ${cur.planRefusal.detail}`); return cur; }
      const locked = switchesLockedWhy(stampDefaults(cur));
      if (locked) { early = refusal('plan-after-spawn', `run ${run} already spawned (${locked}) — the plan of the loop is written before the first spawn`); return cur; }
      if (cur.decisions?.length) { early = refusal('plan-after-decision', `run ${run} already holds ${cur.decisions.length} run decision(s): they ride in every brief verbatim — no plan agent is spawned (start from a state with none)`); return cur; }
      repo = cur.repo;
      const sc = readPlanSidecar(deps.home, run);
      const d = decidePlanAgent(sc, tickets, now, live);
      if (d.action === 'refuse') { early = refusal(d.refusal, d.detail); return cur; }
      if (d.action === 'adopt' || d.action === 'in-flight') { adopted = { action: d.action, id: d.action === 'adopt' ? d.id! : null }; return cur; }
      action = d.action;
      task = renderPlanBrief(tickets, { run });
      writePlanSidecar(deps.home, run, { version: 1, tickets, agent: { id: null, name, at: now }, spawns: (sc?.spawns ?? 0) + 1, attempts: sc?.attempts ?? [], outcome: 'open' });
      return cur;
    });
    if (early) return early;
    if (adopted) return { ok: true, op: 'plan', action: (adopted as { action: 'adopt' | 'in-flight' | 'accepted' }).action, id: (adopted as { id: string | null }).id, name };
    const settle = (id: string | null): boolean => { // false = the claim was taken over meanwhile (this agent is NOT the recorded one)
      for (let k = 0; ; k++) {
        try {
          let mine = true;
          updateState(file, (cur) => {
            const sc = readPlanSidecar(deps.home, run);
            if (!sc || sc.agent?.id !== null || sc.agent.at !== now) { mine = false; return cur as FanoutState; }
            writePlanSidecar(deps.home, run, id ? { ...sc, agent: { id, name, at: deps.now() } } : { ...sc, agent: null, spawns: Math.max(0, sc.spawns - 1) });
            return cur as FanoutState;
          });
          return mine;
        } catch (e) { if (k >= 3) throw e; }
      }
    };
    let res: Awaited<ReturnType<PlanHostDeps['spawn']>>;
    try {
      const parent = deps.isWorkspace(run) ? run : caller;
      res = await deps.spawn({ from: parent, name, task, repoPath: deps.repoPath({ run, ticket: '', from: caller, repo, implementer: null }) });
    } catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    if (!res.ok || !res.id) { const error = res.error ?? 'spawn failed'; settle(null); return { ok: false, error: `could not spawn the plan agent: ${error}` }; }
    if (!settle(res.id)) return refusal('plan-claim-lost', `${res.id} was spawned but another call took over the claim: it is not the recorded plan agent of run ${run}`);
    return { ok: true, op: 'plan', action, id: res.id, name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** `fanout run --plan <plan.json>` (#605): a plan a HUMAN hands over — no agent, no attempts. Checked against its OWN tickets (or `ticketIds`), recorded with `loopPlan` set. A plan that fails the check is a RESULT (the reasons);
 *  one that passes but cannot be recorded (`[seat-records-off]`, `[plan-after-spawn]`, `[plan-already-applied]`…) throws a SeatRefusal. The same plan again is a no-op (the loop starts again at any step). */
export function applyPlanText(i: { home: string; run: string; text: string; ticketIds?: string[]; now: string }): { ok: true; hash: string; tickets: number } | { ok: false; reasons: PlanReason[] } {
  const run = assertRunId(i.run);
  if (i.text.length > PLAN_FILE_MAX) throw new FanoutStateError(`the plan file is over ${PLAN_FILE_MAX} bytes`);
  let ids = i.ticketIds;
  if (!ids) {
    try { ids = parsePlan(i.text).tickets.map((t) => t.id); } catch (e) { if (e instanceof PlanError) return { ok: false, reasons: e.reasons }; throw e; }
  }
  const v = validatePlan(i.text, ids);
  if (!v.ok || !v.plan) return { ok: false, reasons: v.reasons };
  const plan = v.plan;
  updateState(stateFile(i.home, run), (cur) => {
    if (!cur) throw new FanoutStateError(`no fanout state for run ${run} — run \`orchestra fanout state init\` first`);
    return applyPlan(cur, plan, i.now, 1);
  });
  return { ok: true, hash: planHash(plan), tickets: plan.tickets.length };
}

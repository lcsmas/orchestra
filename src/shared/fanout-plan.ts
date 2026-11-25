// #604 (spec #601 decision 2; ledger #613 FROZEN NAMES v1) — the plan of a run of the Boucle: a JSON file written by a single-use agent, CHECKED BY CODE, then recorded as the run's plan (#587).
// Pure (no fs, no Electron). The form is the whole contract: every ticket present, no cycle, each depended-on ticket carries an interface with at least one exact name in backticks,
// and NO free text (any key beyond the schema is refused `plan-free-text`): a run decision ("wait for X") cannot ride in a plan. The submit flow (attempts, the agent) is fanout-plan-host.ts.
import { createHash } from 'node:crypto';
import { SeatRefusal, applyTicketPatchCore, planMissing, setPlan, stampDefaults, switchesLockedWhy, type FanoutState } from './fanout-state.ts';

export const PLAN_VERSION = 1;
export const PLAN_TITLE_MAX = 120;
export const PLAN_SPEC_MAX = 500;
export const PLAN_IFACE_MAX = 20_000;
/** Same shape as the state's ticket id (fanout-state.ts SAFE_TICKET): what a plan may name a ticket. */
export const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._#:-]{0,63}$/;
const CTRL_LINE = /[\x00-\x1f\x7f]/;
const CTRL_TEXT = /[\x00-\x08\x0b-\x1f\x7f]/;

export const PLAN_REASON_CODES = ['plan-bad-json', 'plan-free-text', 'plan-ticket-missing', 'plan-ticket-unknown', 'plan-duplicate-ticket', 'plan-cycle', 'plan-interface-missing', 'plan-interface-no-name', 'plan-bad-dependency'] as const;
export type PlanReasonCode = (typeof PLAN_REASON_CODES)[number];
export interface PlanReason { code: PlanReasonCode; detail: string }

export interface PlanTicket { id: string; title: string; spec: string; dependsOn: string[] }
export interface Plan { version: 1; tickets: PlanTicket[]; interfaces: Record<string, string> }

/** parsePlan's refusal: every structural reason found, not only the first (the agent fixes them in ONE retry). */
export class PlanError extends Error {
  readonly reasons: PlanReason[];
  constructor(reasons: PlanReason[]) { super(reasons.map((r) => `[${r.code}] ${r.detail}`).join('; ')); this.reasons = reasons; }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const short = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/** The shape pass: collects every structural reason and builds the plan from what is usable (an unknown key is reported and dropped). `plan` null = nothing usable (not an object, no tickets list). */
function readPlan(raw: unknown): { plan: Plan | null; reasons: PlanReason[] } {
  const reasons: PlanReason[] = [];
  const bad = (detail: string): void => { reasons.push({ code: 'plan-bad-json', detail }); };
  const free = (detail: string): void => { reasons.push({ code: 'plan-free-text', detail }); };
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return { plan: null, reasons: [{ code: 'plan-bad-json', detail: `not JSON: ${e instanceof Error ? e.message : String(e)}` }] }; } }
  if (!isObj(v)) return { plan: null, reasons: [{ code: 'plan-bad-json', detail: 'the plan must be a JSON object {version, tickets, interfaces}' }] };
  for (const k of Object.keys(v)) if (!['version', 'tickets', 'interfaces'].includes(k)) free(`unknown key "${k}" at the top of the plan — the plan holds only version, tickets, interfaces (no decisions, notes or order)`);
  if (v.version !== PLAN_VERSION) bad(`version must be ${PLAN_VERSION}`);
  if (!Array.isArray(v.tickets)) { bad('tickets must be a list of {id, title, spec, dependsOn}'); return { plan: null, reasons }; }
  const tickets: PlanTicket[] = [];
  v.tickets.forEach((t, i) => {
    const at = `tickets[${i}]`;
    if (!isObj(t)) { bad(`${at} must be an object {id, title, spec, dependsOn}`); return; }
    for (const k of Object.keys(t)) if (!['id', 'title', 'spec', 'dependsOn'].includes(k)) free(`${at}: unknown key "${k}" — a ticket holds only id, title, spec, dependsOn`);
    const id = typeof t.id === 'string' ? t.id : '';
    if (!TICKET_ID.test(id)) { bad(`${at}.id must be a ticket id (letters, digits, . _ # : -), got ${JSON.stringify(t.id)}`); return; }
    const where = `ticket ${id}`;
    let title = '';
    if (typeof t.title !== 'string' || !t.title.trim()) bad(`${where}: title must be a non-blank string`);
    else if (t.title.length > PLAN_TITLE_MAX || CTRL_LINE.test(t.title)) free(`${where}: title must be one printable line of at most ${PLAN_TITLE_MAX} characters (${t.title.length} given) — a title is a label, not a place for text`);
    else title = t.title.trim();
    let spec = '';
    if (typeof t.spec !== 'string' || !t.spec.trim()) bad(`${where}: spec must name where the ticket's text is (a file, a URL, a ledger section)`);
    else if (t.spec.length > PLAN_SPEC_MAX || CTRL_LINE.test(t.spec)) free(`${where}: spec must be one printable line of at most ${PLAN_SPEC_MAX} characters (a file, a URL, a ledger section)`);
    else spec = t.spec.trim();
    let dependsOn: string[] = [];
    if (!Array.isArray(t.dependsOn) || t.dependsOn.some((d) => typeof d !== 'string')) bad(`${where}: dependsOn must be a list of ticket ids ([] = none)`);
    else dependsOn = [...new Set((t.dependsOn as string[]).map((d) => d.trim()))];
    tickets.push({ id, title, spec, dependsOn });
  });
  const ifaceEntries: Array<[string, string]> = [];
  if (v.interfaces === undefined) bad('interfaces must be an object {<ticket id>: <text>} ({} when no ticket is depended on)');
  else if (!isObj(v.interfaces)) bad('interfaces must be an object {<ticket id>: <text>}');
  else {
    for (const [k, t] of Object.entries(v.interfaces)) {
      if (typeof t !== 'string') { bad(`interfaces.${k} must be a string`); continue; }
      if (t.length > PLAN_IFACE_MAX || CTRL_TEXT.test(t)) { free(`interfaces.${k}: must be printable text of at most ${PLAN_IFACE_MAX} characters`); continue; }
      ifaceEntries.push([k, t.replace(/\r\n/g, '\n')]);
    }
  }
  return { plan: { version: PLAN_VERSION, tickets, interfaces: Object.fromEntries(ifaceEntries) }, reasons };
}

export const NAME_MAX = 80;
const HTTP_METHOD = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
/** Placeholders and filler that are one token but no name. */
const NOT_A_NAME = new Set(['it', 'this', 'that', 'the', 'thing', 'things', 'stuff', 'todo', 'tbd', 'tba', 'fixme', 'wip', 'none', 'na', 'n/a', 'name', 'names', 'foo', 'bar', 'baz', 'xxx', 'etc']);
/** A name is ONE token — an identifier / column / route / event (`orders.status`, `OrderCreated`, `/orders/:id`) — or `METHOD /path` (`POST /orders`): ≤ 80 chars, a letter in it, not a placeholder. A span of words is a sentence, not a name. */
export function isExactName(span: string): boolean {
  const n = span.trim();
  if (n.length < 2 || n.length > NAME_MAX || !/[A-Za-z]/.test(n) || CTRL_LINE.test(n)) return false;
  if (NOT_A_NAME.has(n.toLowerCase())) return false;
  const parts = n.split(/\s+/);
  if (parts.length === 1) return true;
  return parts.length === 2 && HTTP_METHOD.test(parts[0]) && parts[1].startsWith('/');
}

/** The exact names an interface text holds: its backticked spans that pass {@link isExactName}. Prose around the names is allowed; a backticked sentence is not a name. */
export function interfaceNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\n]{2,200})`/g)) if (isExactName(m[1])) out.push(m[1].trim());
  return out;
}

/** `raw` = the parsed JSON, or its text. Throws PlanError (every structural reason: bad JSON, a wrong type, a free-text key or an over-long label). The graph is checkPlan's. */
export function parsePlan(raw: unknown): Plan {
  const { plan, reasons } = readPlan(raw);
  if (reasons.length || !plan) throw new PlanError(reasons.length ? reasons : [{ code: 'plan-bad-json', detail: 'unreadable plan' }]);
  return plan;
}

/** The graph against the run's ticket list: every ticket present once, none unknown, dependencies inside the list, no cycle, an interface (with ≥ 1 exact name) for EVERY depended-on ticket. `ok` = no reason. */
export function checkPlan(plan: Plan, ticketIds: string[]): { ok: boolean; reasons: PlanReason[] } {
  const reasons: PlanReason[] = [];
  const want = [...new Set(ticketIds)];
  if (!plan.tickets.length) reasons.push({ code: 'plan-ticket-missing', detail: 'the plan holds no ticket' });
  const seen = new Map<string, number>();
  for (const t of plan.tickets) seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) reasons.push({ code: 'plan-duplicate-ticket', detail: `ticket ${id} appears ${n} times` });
  for (const id of want) if (!seen.has(id)) reasons.push({ code: 'plan-ticket-missing', detail: `ticket ${id} is in the run and not in the plan` });
  for (const id of seen.keys()) if (!want.includes(id)) reasons.push({ code: 'plan-ticket-unknown', detail: `ticket ${id} is in the plan and not in the run (${want.join(', ')})` });
  const known = new Set(plan.tickets.map((t) => t.id));
  for (const t of plan.tickets) for (const d of t.dependsOn) {
    if (d === t.id) reasons.push({ code: 'plan-bad-dependency', detail: `${t.id} depends on itself` });
    else if (!known.has(d)) reasons.push({ code: 'plan-bad-dependency', detail: `${t.id} depends on ${d}, which is not a ticket of the plan` });
  }
  const cycle = findCycle(plan);
  if (cycle) reasons.push({ code: 'plan-cycle', detail: `dependency cycle: ${cycle.join(' -> ')}` });
  for (const k of Object.keys(plan.interfaces)) if (!known.has(k)) reasons.push({ code: 'plan-ticket-unknown', detail: `interfaces.${k}: ${k} is not a ticket of the plan` });
  const depended = [...new Set(plan.tickets.flatMap((t) => t.dependsOn).filter((d) => known.has(d)))];
  for (const d of depended) {
    const text = Object.hasOwn(plan.interfaces, d) ? plan.interfaces[d] : undefined; // a ticket named `constructor` is not an inherited member
    if (text === undefined || !text.trim()) reasons.push({ code: 'plan-interface-missing', detail: `${d} is depended on by ${plan.tickets.filter((t) => t.dependsOn.includes(d)).map((t) => t.id).join(', ')} and has no interface — add interfaces.${d}` });
    else if (!interfaceNames(text).length) reasons.push({ code: 'plan-interface-no-name', detail: `interfaces.${d} holds no exact name in backticks — ONE token or \`METHOD /path\` (\`orders.status\`, \`POST /orders\`, \`OrderCreated\`), at most ${NAME_MAX} chars: "${short(text.trim())}"` });
  }
  return { ok: reasons.length === 0, reasons };
}

function findCycle(plan: Plan): string[] | null {
  const deps = new Map(plan.tickets.map((t) => [t.id, t.dependsOn]));
  const mark = new Map<string, 1 | 2>();
  const visit = (id: string, chain: string[]): string[] | null => {
    if (mark.get(id) === 2) return null;
    if (mark.get(id) === 1) return [...chain.slice(chain.indexOf(id)), id];
    mark.set(id, 1);
    for (const d of deps.get(id) ?? []) { if (!deps.has(d)) continue; const c = visit(d, [...chain, id]); if (c) return c; }
    mark.set(id, 2);
    return null;
  };
  for (const id of deps.keys()) { const c = visit(id, []); if (c) return c; }
  return null;
}

/** Shape + graph in one pass (what the submit verb answers with): ALL the reasons, so one retry can fix them all. */
export function validatePlan(raw: unknown, ticketIds: string[]): { ok: boolean; plan: Plan | null; reasons: PlanReason[] } {
  const { plan, reasons } = readPlan(raw);
  const graph = plan ? checkPlan(plan, ticketIds).reasons : [];
  const all = [...reasons, ...graph];
  return { ok: all.length === 0, plan: all.length === 0 ? plan : null, reasons: all };
}

/** sha256 of the normalised plan (tickets in the plan's order, fixed key order): the `loopPlan.hash`. */
export function planHash(plan: Plan): string {
  const norm = { version: plan.version, tickets: plan.tickets.map((t) => ({ id: t.id, title: t.title, spec: t.spec, dependsOn: t.dependsOn })), interfaces: Object.fromEntries(Object.keys(plan.interfaces).sort().map((k) => [k, plan.interfaces[k]])) };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

/** Record `plan` as the run's plan (#587): `setPlan`, per ticket `dependsOn` (+ `depsDeclared`), `spec`, the interface v1 of each depended-on ticket, and the `loopPlan` marker. Pure. Needs seatRecords=on
 *  (`[seat-records-off]`); a run that already holds a DIFFERENT loop plan is refused `[plan-already-applied]` (the same plan again is a no-op). `attempts` = submissions it took (default 1). The plan is re-checked here: a plan that does not pass is never recorded. */
export function applyPlan(state: FanoutState, plan: Plan, now: string, attempts = 1): FanoutState {
  const hash = planHash(plan);
  if (state.loopPlan) {
    if (state.loopPlan.hash === hash) return state;
    throw new SeatRefusal('plan-already-applied', `run ${state.run} already holds the plan of the loop (${state.loopPlan.at}, ${state.loopPlan.hash.slice(0, 12)}) — a plan is applied once`);
  }
  if (state.decisions?.length) throw new SeatRefusal('plan-after-decision', `run ${state.run} already holds ${state.decisions.length} run decision(s): they ride in every brief verbatim, and no order may exist next to a plan of the loop — start from a state with none`);
  if (state.planRefusal) throw new SeatRefusal(state.planRefusal.code, `the plan step of run ${state.run} ended (${state.planRefusal.at}): ${state.planRefusal.detail}`);
  const locked = switchesLockedWhy(stampDefaults(state)); // the plan is declared BEFORE the first spawn: after it, the tickets' seats, dependencies and interfaces are in use
  if (locked) throw new SeatRefusal('plan-after-spawn', `run ${state.run} already spawned (${locked}) — the plan of the loop is written before the first spawn`);
  const ids = plan.tickets.map((t) => t.id);
  const checked = checkPlan(plan, ids);
  if (!checked.ok) throw new SeatRefusal('plan-invalid', checked.reasons.map((r) => `[${r.code}] ${r.detail}`).join('; '));
  let st = setPlan(state, ids, 'declare', now); // seat-records-off / plan-frozen
  for (const t of plan.tickets) st = applyTicketPatchCore(st, t.id, { dependsOn: [], spec: t.spec }, now); // pass 1: every ticket exists (a dependency may name a later one)
  for (const t of plan.tickets) st = applyTicketPatchCore(st, t.id, { dependsOn: t.dependsOn }, now);
  for (const [id, text] of Object.entries(plan.interfaces)) st = applyTicketPatchCore(st, id, { interface: text }, now);
  const missing = planMissing(st);
  if (missing.length) throw new SeatRefusal('plan-incomplete', `the plan leaves ${missing.length} thing(s) missing: ${missing.join('; ')}`);
  return { ...st, loopPlan: { at: now, hash, attempts }, updatedAt: now };
}

// #604 (spec #601 decision 2; ledger #613 FROZEN NAMES v1) — the plan of a run of the Boucle: a JSON file written by a single-use agent, CHECKED BY CODE, then recorded as the run's plan (#587).
// Pure (no fs, no Electron). The form is the whole contract: every ticket present, no cycle, each depended-on ticket carries an interface with at least one exact name in backticks,
// and NO free text (any key beyond the schema is refused `plan-free-text`): a run decision ("wait for X") cannot ride in a plan. The submit flow (attempts, the agent) is fanout-plan-host.ts.
import { createHash } from 'node:crypto';
import { CONTRACT_ID, CONTRACT_MUST_MAX, SPEC_TEXT_MAX, SeatRefusal, applyTicketPatchCore, planMissing, setPlan, stampDefaults, switchesLockedWhy, type FanoutState } from './fanout-state.ts';

export const PLAN_VERSION = 1;
export const PLAN_TITLE_MAX = 120;
export const PLAN_SPEC_MAX = 500;
export const PLAN_IFACE_MAX = 20_000;
/** Same shape as the state's ticket id (fanout-state.ts SAFE_TICKET): what a plan may name a ticket. */
export const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._#:-]{0,63}$/;
const CTRL_LINE = /[\x00-\x1f\x7f]/;
const CTRL_TEXT = /[\x00-\x08\x0b-\x1f\x7f]/;

export const PLAN_REASON_CODES = ['plan-bad-json', 'plan-free-text', 'plan-ticket-missing', 'plan-ticket-unknown', 'plan-duplicate-ticket', 'plan-cycle', 'plan-interface-missing', 'plan-interface-no-name', 'plan-bad-dependency', 'plan-spec-text-missing', 'plan-spec-text-short', 'plan-contract-empty', 'plan-contract-unknown-ticket', 'plan-contract-self', 'plan-contract-duplicate', 'plan-interface-no-kind', 'plan-interface-no-shape', 'plan-interface-multi-name', 'plan-contract-missing', 'plan-no-shared-bad', 'plan-interface-no-where'] as const;
export type PlanReasonCode = (typeof PLAN_REASON_CODES)[number];
export interface PlanReason { code: PlanReasonCode; detail: string }

/** `specText` (#675) = the ticket's FULL description, verbatim (its sentences and numbered criteria are what the review is held to): recorded as `tickets.<id>.specText`. */
export interface PlanTicket { id: string; title: string; spec: string; specText: string; dependsOn: string[] }
/** #680 — a behaviour ONE ticket owns and others rely on (`must`, one line); the code renders it in the briefs of the owner, the consumers and their reviewers, and every approve answers it. */
export interface PlanContract { id: string; owner: string; must: string; consumers: string[] }
export interface Plan { version: 1; tickets: PlanTicket[]; interfaces: Record<string, string>; /** absent = none (a plan with no contract is what it was) */ contracts?: PlanContract[];
  /** #682 — `["A-B"]`: the dependency pairs the plan states share NO behaviour (no contract needed). Absent = none declared. */ noSharedBehaviour?: string[] }

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
  for (const k of Object.keys(v)) if (!['version', 'tickets', 'interfaces', 'contracts', 'noSharedBehaviour'].includes(k)) free(`unknown key "${k}" at the top of the plan — the plan holds only version, tickets, interfaces, contracts, noSharedBehaviour (no decisions, notes or order)`);
  if (v.version !== PLAN_VERSION) bad(`version must be ${PLAN_VERSION}`);
  if (!Array.isArray(v.tickets)) { bad('tickets must be a list of {id, title, spec, specText, dependsOn}'); return { plan: null, reasons }; }
  const tickets: PlanTicket[] = [];
  v.tickets.forEach((t, i) => {
    const at = `tickets[${i}]`;
    if (!isObj(t)) { bad(`${at} must be an object {id, title, spec, specText, dependsOn}`); return; }
    for (const k of Object.keys(t)) if (!['id', 'title', 'spec', 'specText', 'dependsOn'].includes(k)) free(`${at}: unknown key "${k}" — a ticket holds only id, title, spec, specText, dependsOn`);
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
    let specText = '';
    if (typeof t.specText !== 'string' || !t.specText.trim()) reasons.push({ code: 'plan-spec-text-missing', detail: `${where}: specText must be the ticket's full description, verbatim (the reviewer is held to its sentences and numbered criteria) — it is empty or absent` });
    else if (t.specText.length > SPEC_TEXT_MAX || CTRL_TEXT.test(t.specText)) free(`${where}: specText must be printable text of at most ${SPEC_TEXT_MAX} characters`);
    else if (title && t.specText.trim().length < title.length) reasons.push({ code: 'plan-spec-text-short', detail: `${where}: specText (${t.specText.trim().length} characters) is shorter than the title you give (${title.length}): copy the ticket's whole description, not a summary` });
    else specText = t.specText.replace(/\r\n/g, '\n');
    let dependsOn: string[] = [];
    if (!Array.isArray(t.dependsOn) || t.dependsOn.some((d) => typeof d !== 'string')) bad(`${where}: dependsOn must be a list of ticket ids ([] = none)`);
    else dependsOn = [...new Set((t.dependsOn as string[]).map((d) => d.trim()))];
    tickets.push({ id, title, spec, specText, dependsOn });
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
  const contracts: PlanContract[] = [];
  if (v.contracts !== undefined) {
    if (!Array.isArray(v.contracts)) bad('contracts must be a list of {id, owner, must, consumers} ([] = none)');
    else v.contracts.forEach((c, i) => {
      const at = `contracts[${i}]`;
      if (!isObj(c)) { bad(`${at} must be an object {id, owner, must, consumers}`); return; }
      for (const k of Object.keys(c)) if (!['id', 'owner', 'must', 'consumers'].includes(k)) free(`${at}: unknown key "${k}" — a contract holds only id, owner, must, consumers`);
      const id = typeof c.id === 'string' ? c.id : '';
      if (!CONTRACT_ID.test(id)) { bad(`${at}.id must be a short contract id (letters, digits, . _ # : -, at most 40), got ${JSON.stringify(c.id)}`); return; }
      const where = `contract ${id}`;
      let must = '';
      if (typeof c.must !== 'string' || !c.must.trim()) reasons.push({ code: 'plan-contract-empty', detail: `${where}: must is empty — name the behaviour the owner provides (one sentence)` });
      else if (c.must.length > CONTRACT_MUST_MAX || CTRL_LINE.test(c.must)) free(`${where}: must must be one printable line of at most ${CONTRACT_MUST_MAX} characters`);
      else must = c.must.trim();
      const owner = typeof c.owner === 'string' ? c.owner.trim() : '';
      if (!TICKET_ID.test(owner)) bad(`${where}: owner must be a ticket id, got ${JSON.stringify(c.owner)}`);
      let consumers: string[] = [];
      if (!Array.isArray(c.consumers) || c.consumers.some((d) => typeof d !== 'string')) bad(`${where}: consumers must be a list of ticket ids`);
      else if (!c.consumers.length) reasons.push({ code: 'plan-contract-empty', detail: `${where}: consumers is empty — a contract is a behaviour OTHER tickets rely on` });
      else consumers = [...new Set((c.consumers as string[]).map((d) => d.trim()))];
      contracts.push({ id, owner, must, consumers });
    });
  }
  let noShared: string[] = [];
  if (v.noSharedBehaviour !== undefined) {
    if (!Array.isArray(v.noSharedBehaviour) || v.noSharedBehaviour.some((d) => typeof d !== 'string' || !d.trim() || d.length > NO_SHARED_MAX)) bad(`noSharedBehaviour must be a list of "<ticket>-<ticket>" pairs (each at most ${NO_SHARED_MAX} characters; [] = none)`);
    else noShared = [...new Set((v.noSharedBehaviour as string[]).map((d) => d.trim()))];
  }
  return { plan: { version: PLAN_VERSION, tickets, interfaces: Object.fromEntries(ifaceEntries), ...(contracts.length ? { contracts } : {}), ...(noShared.length ? { noSharedBehaviour: noShared } : {}) }, reasons };
}

export const NO_SHARED_MAX = 130;
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

/** #682 — what an interface entry says it IS: the kinds a dependent can build against (a table column, a field, an event, a function, a route; a query / mutation of an API). */
export const INTERFACE_KINDS = ['field', 'column', 'event', 'function', 'route', 'query', 'mutation'] as const;
/** One interface entry = one line holding ONE name in backticks, then `kind: <kind>; shape: <type, or the payload's fields>; where: <path of the existing code it extends | new <module path>>` (no backticks after the name). */
export interface InterfaceEntry { line: string; names: string[]; kind: string | null; shape: string | null; where: string | null }
const WHERE_PATH = /^[\w@.\/-]+(?::\d+(?:-\d+)?)?$/;
/** #682: `where` = a path (`src/orders/order.ts`, `…:42`) of the code the name extends, or `new <module path>`; `new` alone or a sentence is none. */
export function isWhere(w: string): boolean {
  const rest = w.trim().replace(/^new\b\s*:?\s*/i, '');
  return rest.length > 0 && rest.length <= 200 && WHERE_PATH.test(rest) && /[/.]/.test(rest);
}
/** The entries of an interface text: every line that holds an exact name (a line with none is prose, ignored). `kind` null = absent or not one of {@link INTERFACE_KINDS}; `shape` null = absent or filler. */
export function interfaceEntries(text: string): InterfaceEntry[] {
  const out: InterfaceEntry[] = [];
  for (const raw of text.split('\n')) {
    const names = interfaceNames(raw);
    if (!names.length) continue;
    const k = /\bkind:\s*([A-Za-z]+)/.exec(raw)?.[1]?.toLowerCase() ?? null;
    const wm = /(?:;\s*|\s)where:\s*(\S.*?)\s*$/.exec(raw);
    const sh = /\bshape:\s*(\S.*?)\s*$/.exec(wm ? raw.slice(0, wm.index) : raw)?.[1] ?? null;
    const shapeOk = sh !== null && sh.length >= 2 && /[A-Za-z]/.test(sh) && !NOT_A_NAME.has(sh.toLowerCase());
    out.push({ line: raw.trim(), names, kind: k && (INTERFACE_KINDS as readonly string[]).includes(k) ? k : null, shape: shapeOk ? sh : null, where: wm && isWhere(wm[1]) ? wm[1].trim() : null });
  }
  return out;
}

/** #682 — `"A-B"` as a direct dependency pair of the plan, in either order (a ticket id may hold `-`: every split is tried). null = not a pair of tickets joined by a dependency. */
export function resolveDependencyPair(entry: string, plan: Plan): [string, string] | null {
  const known = new Set(plan.tickets.map((t) => t.id));
  const joined = (a: string, b: string): boolean => plan.tickets.some((t) => (t.id === b && t.dependsOn.includes(a)) || (t.id === a && t.dependsOn.includes(b)));
  for (let i = entry.indexOf('-'); i !== -1; i = entry.indexOf('-', i + 1)) {
    const a = entry.slice(0, i), b = entry.slice(i + 1);
    if (known.has(a) && known.has(b) && a !== b && joined(a, b)) return [a, b];
  }
  return null;
}
const sharesContract = (plan: Plan, a: string, b: string): boolean => (plan.contracts ?? []).some((c) => { const m = [c.owner, ...c.consumers]; return m.includes(a) && m.includes(b); });

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
  const cids = new Map<string, number>();
  for (const c of plan.contracts ?? []) {
    cids.set(c.id, (cids.get(c.id) ?? 0) + 1);
    if (!known.has(c.owner)) reasons.push({ code: 'plan-contract-unknown-ticket', detail: `contract ${c.id}: owner ${c.owner} is not a ticket of the plan (${[...known].join(', ')})` });
    for (const d of c.consumers) {
      if (d === c.owner) reasons.push({ code: 'plan-contract-self', detail: `contract ${c.id}: ${d} is both the owner and a consumer` });
      else if (known.has(d) === false) reasons.push({ code: 'plan-contract-unknown-ticket', detail: `contract ${c.id}: consumer ${d} is not a ticket of the plan (${[...known].join(', ')})` });
    }
  }
  for (const [id, n] of cids) if (n >= 2) reasons.push({ code: 'plan-contract-duplicate', detail: `contract ${id} appears ${n} times` });
  const depended = [...new Set(plan.tickets.flatMap((t) => t.dependsOn).filter((d) => known.has(d)))];
  for (const d of depended) {
    const text = Object.hasOwn(plan.interfaces, d) ? plan.interfaces[d] : undefined; // a ticket named `constructor` is not an inherited member
    if (text === undefined || !text.trim()) reasons.push({ code: 'plan-interface-missing', detail: `${d} is depended on by ${plan.tickets.filter((t) => t.dependsOn.includes(d)).map((t) => t.id).join(', ')} and has no interface — add interfaces.${d}` });
    else if (!interfaceNames(text).length) reasons.push({ code: 'plan-interface-no-name', detail: `interfaces.${d} holds no exact name in backticks — ONE token or \`METHOD /path\` (\`orders.status\`, \`POST /orders\`, \`OrderCreated\`), at most ${NAME_MAX} chars: "${short(text.trim())}"` });
    else {
      const by = plan.tickets.filter((t) => t.dependsOn.includes(d)).map((t) => t.id).join(', ');
      for (const e of interfaceEntries(text)) { // #682: a name alone is not frozen — its kind and its shape are
        const at = `interfaces.${d} (${by} build on it): "${short(e.line)}"`;
        if (e.names.length > 1) reasons.push({ code: 'plan-interface-multi-name', detail: `${at} holds ${e.names.length} names on one line — ONE entry per line: \`name\` — kind: <${INTERFACE_KINDS.join('|')}>; shape: <type or payload fields>` });
        if (!e.kind) reasons.push({ code: 'plan-interface-no-kind', detail: `${at} has no kind — add \`kind: <${INTERFACE_KINDS.join('|')}>\`` });
        if (!e.shape) reasons.push({ code: 'plan-interface-no-shape', detail: `${at} has no shape — add \`shape: <the type, or the payload's fields>\` (e.g. \`shape: string\`, \`shape: { parcelId: string, at: ISO date }\`)` });
        if (!e.where) reasons.push({ code: 'plan-interface-no-where', detail: `${at} has no where — add \`where: <path of the existing code it extends>\` or \`where: new <module path>\` (e.g. \`where: src/orders/order.ts\`, \`where: new src/orders/events.ts\`): read the target repo, do not guess` });
      }
    }
  }
  const pairs = new Map<string, [string, string]>(); // #682: every direct dependency, dependency first
  for (const t of plan.tickets) for (const d of t.dependsOn) if (known.has(d) && d !== t.id) pairs.set(`${d}-${t.id}`, [d, t.id]);
  const declared = new Set<string>();
  for (const entry of plan.noSharedBehaviour ?? []) {
    const pr = resolveDependencyPair(entry, plan);
    if (!pr) reasons.push({ code: 'plan-no-shared-bad', detail: `noSharedBehaviour "${entry}" is not a pair of tickets joined by a dependency (pairs: ${[...pairs.keys()].join(', ') || 'none'})` });
    else if (sharesContract(plan, pr[0], pr[1])) reasons.push({ code: 'plan-no-shared-bad', detail: `noSharedBehaviour "${entry}" contradicts a contract naming both ${pr[0]} and ${pr[1]} — keep the contract or drop the declaration` });
    else declared.add(`${pr[0]}-${pr[1]}`), declared.add(`${pr[1]}-${pr[0]}`);
  }
  for (const [label, [a, b]] of pairs) if (!sharesContract(plan, a, b) && !declared.has(label)) reasons.push({ code: 'plan-contract-missing', detail: `${label}: ${b} depends on ${a} and no contract names both — add a contract {owner, must, consumers} for the behaviour ${b} relies on, or state "noSharedBehaviour": ["${label}"] if they share none` });
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
  const norm = { version: plan.version, tickets: plan.tickets.map((t) => ({ id: t.id, title: t.title, spec: t.spec, specText: t.specText, dependsOn: t.dependsOn })), interfaces: Object.fromEntries(Object.keys(plan.interfaces).sort().map((k) => [k, plan.interfaces[k]])), ...(plan.contracts?.length ? { contracts: plan.contracts.map((c) => ({ id: c.id, owner: c.owner, must: c.must, consumers: c.consumers })) } : {}), ...(plan.noSharedBehaviour?.length ? { noSharedBehaviour: plan.noSharedBehaviour } : {}) };
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
  for (const t of plan.tickets) st = applyTicketPatchCore(st, t.id, { dependsOn: [], spec: t.spec }, now, { specText: t.specText }); // #675: the full text rides with the reference, as `state set --spec-text` does by hand. pass 1: every ticket exists (a dependency may name a later one)
  for (const t of plan.tickets) st = applyTicketPatchCore(st, t.id, { dependsOn: t.dependsOn }, now);
  for (const [id, text] of Object.entries(plan.interfaces)) st = applyTicketPatchCore(st, id, { interface: text }, now);
  if (plan.contracts?.length) st = { ...st, contracts: plan.contracts.map((c) => ({ id: c.id, owner: c.owner, must: c.must, consumers: [...c.consumers] })), updatedAt: now }; // #680: rendered in the briefs, answered in every approve
  if (plan.noSharedBehaviour?.length) st = { ...st, noSharedBehaviour: [...plan.noSharedBehaviour], updatedAt: now }; // #682: listed in the closing report
  const missing = planMissing(st);
  if (missing.length) throw new SeatRefusal('plan-incomplete', `the plan leaves ${missing.length} thing(s) missing: ${missing.join('; ')}`);
  return { ...st, loopPlan: { at: now, hash, attempts }, updatedAt: now };
}

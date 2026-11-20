// #466 — bounded agent lifetime: `orchestra handoff` + the host nudge. PURE (no Electron, no store): the summary shape check,
// the opening turn, the nudge text, the bound parsing and the per-session turn counter. Wiring: src/main/handoff-host.ts.

/** Hard cap on a summary (chars): a handoff exists to SHRINK the next context, not to carry the old one over. */
export const HANDOFF_SUMMARY_MAX_CHARS = 16_000;

/** The four required sections of a summary, in order. A line is a section header when, after an optional `#`s / `**` / `-`,
 *  it is the label (case-insensitive) optionally followed by `:` — the body is what follows up to the next header. */
export const HANDOFF_SECTIONS = [
  { key: 'state', label: 'STATE', pattern: /^state$/i },
  { key: 'next', label: 'NEXT STEPS', pattern: /^next[ _-]?steps?$/i },
  { key: 'refs', label: 'REFS', pattern: /^refs?$|^references$/i },
  { key: 'notVerified', label: 'NOT VERIFIED', pattern: /^not[ _-]?verified$/i },
] as const;
export type HandoffSectionKey = (typeof HANDOFF_SECTIONS)[number]['key'];

export type HandoffSummaryVerdict =
  | { ok: true; sections: Record<HandoffSectionKey, string> }
  | { ok: false; problems: string[] };

/** A REFS body must point at something findable: a URL, `#123`, a path (2+ slashes, or `dir/file.ext`), a file name with an extension, or a sha (hex WITH a digit — "defaced" is not one). */
const REF_TOKEN = /https?:\/\/\S+|(^|[\s(\[`])#\d+\b|[\w.~-]+\/[\w~-]+\/[\w./~-]+|[\w~-]+\/[\w~-]*\.[\w]+|\b[\w-]+\.(?:md|json|ts|tsx|mjs|sh|yml|yaml|txt)\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i;

function headerOf(line: string): { key: HandoffSectionKey; rest: string } | null {
  const m = /^\s*(?:#{1,6}\s*|[-*]\s+)?(?:\*\*|__)?\s*([A-Za-z][A-Za-z _-]*?)\s*(?:\*\*|__)?\s*(?::\s*(.*))?$/.exec(line);
  if (!m) return null;
  const word = m[1].trim();
  const sec = HANDOFF_SECTIONS.find((s) => s.pattern.test(word));
  if (!sec) return null;
  // `STATE: text` carries the body on the header line; a bare header line must be the WHOLE line (no trailing prose).
  const rest = (m[2] ?? '').replace(/(?:\*\*|__)\s*$/, '').trim();
  return { key: sec.key, rest };
}

/** Check the shape of a handoff summary: all four sections present, each non-empty, REFS naming at least one findable thing,
 *  size within the cap. Returns every problem at once (one round trip for the author). */
export function validateHandoffSummary(text: unknown): HandoffSummaryVerdict {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, problems: ['the summary is empty'] };
  const problems: string[] = [];
  if (text.length > HANDOFF_SUMMARY_MAX_CHARS) {
    problems.push(`the summary is ${text.length} chars (max ${HANDOFF_SUMMARY_MAX_CHARS}) — a handoff carries the state, not the history; put detail in the ledger/state file and reference it`);
  }
  const bodies: Partial<Record<HandoffSectionKey, string[]>> = {};
  const seen: HandoffSectionKey[] = [];
  let current: HandoffSectionKey | null = null;
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = fence ? null : headerOf(line);
    if (h) {
      current = h.key;
      if (!seen.includes(h.key)) seen.push(h.key);
      (bodies[h.key] ??= []).push(h.rest);
      continue;
    }
    if (current) (bodies[current] ??= []).push(line);
  }
  const sections = {} as Record<HandoffSectionKey, string>;
  for (const s of HANDOFF_SECTIONS) {
    const body = (bodies[s.key] ?? []).join('\n').trim();
    sections[s.key] = body;
    if (!seen.includes(s.key)) problems.push(`missing section ${s.label} (a line "${s.label}:" or "## ${s.label}" followed by its content)`);
    else if (!body) problems.push(`section ${s.label} is empty`);
  }
  if (sections.refs && !REF_TOKEN.test(sections.refs)) {
    problems.push('section REFS names nothing findable (a ledger/issue URL or #number, a state-file path, a branch/sha)');
  }
  const order = seen.map((k) => HANDOFF_SECTIONS.findIndex((s) => s.key === k));
  if (problems.length === 0 && order.some((v, i) => i > 0 && v < order[i - 1])) {
    problems.push('sections out of order — expected STATE, NEXT STEPS, REFS, NOT VERIFIED');
  }
  return problems.length ? { ok: false, problems } : { ok: true, sections };
}

/** The error the CLI prints for a refused summary (one named error, every problem listed). */
export function handoffSummaryError(problems: string[]): string {
  return `handoff-summary-invalid: ${problems.join('; ')}. Required shape: STATE, NEXT STEPS, REFS (ledger/state file), NOT VERIFIED — each non-empty.`;
}

/** Named refusals — the CLI prints them verbatim; the first token is the machine-readable name. */
export const HANDOFF_ERRORS = {
  outsideRun: (id: string) => `handoff-outside-run: workspace ${id} is not a member of an open run — a handoff continues work INSIDE a run (its ledger/state file are what the next context reads). Nothing was ended.`,
  closedRun: (runId: string) => `handoff-outside-run: the run ${runId} is closed — nothing was ended.`,
  unvouched: () => 'handoff-unvouched: the host cannot vouch for this session (no live session key for the workspace) — run `orchestra handoff` from the agent itself. Nothing was ended.',
  pending: () => 'handoff-already-pending: a handoff is already scheduled for this workspace — end your turn.',
  unavailable: (why: string) => `handoff-unavailable: ${why}. Nothing was ended.`,
} as const;

/** The opening turn of the fresh session: the summary VERBATIM under a one-paragraph frame. */
export function composeOpeningTurn(input: { summary: string; turns?: number; savedAt: string; file?: string }): string {
  const n = input.turns && input.turns > 0 ? ` after ${input.turns} turn${input.turns === 1 ? '' : 's'}` : '';
  return (
    `[Orchestra handoff] Your previous context ended${n} by your own \`orchestra handoff\` (${input.savedAt}). This is a FRESH session in the same workspace, worktree, branch and run: ` +
    `nothing was lost on disk, but you remember nothing else — re-read what REFS names before you act, and treat NOT VERIFIED as work still owed. ` +
    `A background run started by your previous context was STOPPED with it: relaunch it if the summary says it was still needed.` +
    (input.file ? ` The summary is also saved at ${input.file}.` : '') +
    `\n\n--- summary from your previous context ---\n${input.summary.trim()}\n--- end of summary ---`
  );
}

/** m4: the agent was told "end your turn" but its handoff will not run — it keeps its context and must say so again if it still wants one. */
export function composeDroppedNotice(why: string): string {
  return `[Orchestra] Your scheduled \`orchestra handoff\` did NOT run (${why}) — this context is unchanged and nothing was ended. Run \`orchestra handoff --summary-file <path>\` again, and end your turn, if you still want to hand off.`;
}

/** The one nudge a host sends an agent past the bound. */
export function composeNudge(turns: number, bound: number): string {
  return (
    `[Orchestra] This context has run ${turns} turns (bound ${bound}); every further turn re-reads all of it. ` +
    `Finish the step in hand, then hand off: write a summary file with the sections STATE, NEXT STEPS, REFS (ledger / state file / branch), NOT VERIFIED, ` +
    `and run \`orchestra handoff --summary-file <path>\` — then end your turn. The host ends this context at the turn end and opens a fresh one with your summary; ` +
    `worktree, branch and commits are untouched, BUT processes your context started in the background (a backgrounded test run, a dev server) are stopped with it — let them finish first or note in NOT VERIFIED that they must be relaunched. This is said ONCE; nothing is ended unless you run the command.`
  );
}

/** The smallest bound that can work: the fresh session's opening turn and the nudge turn both count, so a bound under this would nudge a context before it did any work. */
export const HANDOFF_MIN_BOUND_TURNS = 4;

/** ONE config value: the number of turns after which a session is nudged. Unset / 0 ⇒ off; a non-integer or a value under the minimum ⇒ off + a warning. */
export function parseHandoffBound(env: Record<string, string | undefined>): { bound: number; invalid?: string } {
  const raw = env.ORCHESTRA_HANDOFF_BOUND_TURNS;
  if (raw === undefined || raw.trim() === '') return { bound: 0 };
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) return { bound: 0, invalid: `ORCHESTRA_HANDOFF_BOUND_TURNS=${JSON.stringify(raw)} is not a non-negative integer — the nudge is off` };
  if (n > 0 && n < HANDOFF_MIN_BOUND_TURNS) return { bound: 0, invalid: `ORCHESTRA_HANDOFF_BOUND_TURNS=${n} is under the minimum ${HANDOFF_MIN_BOUND_TURNS} (the opening and nudge turns count) — the nudge is off` };
  return { bound: n };
}

/** #478: the bound in force for ONE workspace at a turn end. Order: env `ORCHESTRA_HANDOFF_BOUND_TURNS` (host-wide; set ⇒ wins, `0` forces off, an invalid value ⇒ off + `invalid`)
 *  > `roleBound` (the role's override file entry, else its built-in default; 0 / role-less ⇒ off). `roleBound` is resolved by the caller (roleSpec) so this file stays import-free. */
export function resolveHandoffBound(env: Record<string, string | undefined>, roleBound: number): { bound: number; source: 'env' | 'role' | 'off'; invalid?: string } {
  const raw = env.ORCHESTRA_HANDOFF_BOUND_TURNS;
  if (raw !== undefined && raw.trim() !== '') {
    const e = parseHandoffBound(env);
    return { ...e, source: e.bound > 0 ? 'env' : 'off' };
  }
  return roleBound > 0 ? { bound: roleBound, source: 'role' } : { bound: 0, source: 'off' };
}

/** Per-session turn counter + the once-per-session nudge latch. A session is identified by its SDK session id: a clear / handoff /
 *  fresh restart changes it, which resets the count AND re-arms the latch (a new context may be nudged once more). The count lives
 *  in memory: an app restart restarts it (an under-count — the nudge is late, never early). */
export class HandoffTurnCounter {
  private readonly rows = new Map<string, { session: string; turns: number; nudged: boolean }>();

  /** Record one turn end; `nudge` is true at every turn end at/past the bound until the caller confirms a send with {@link markNudged} (a nudge that was not sent is not consumed). */
  noteTurnEnd(wsId: string, session: string | undefined, bound: number): { turns: number; nudge: boolean } {
    const sid = session ?? '';
    let row = this.rows.get(wsId);
    if (!row || row.session !== sid) {
      row = { session: sid, turns: 0, nudged: false };
      this.rows.set(wsId, row);
    }
    row.turns++;
    return { turns: row.turns, nudge: bound > 0 && row.turns >= bound && !row.nudged };
  }

  /** The nudge for this workspace's current session was sent: never again for it. */
  markNudged(wsId: string): void {
    const row = this.rows.get(wsId);
    if (row) row.nudged = true;
  }

  turnsOf(wsId: string): number {
    return this.rows.get(wsId)?.turns ?? 0;
  }

  forget(wsId: string): void {
    this.rows.delete(wsId);
  }
}

/** When a scheduled handoff may run: at a turn end, with nothing queued behind it (a clear would discard the queue), not paused. */
export type HandoffRunDecision = 'run' | 'wait' | 'expired';
export const HANDOFF_PENDING_TTL_MS = 10 * 60_000;
export function decideHandoffRun(input: { queueLen: number; paused: boolean; ageMs: number }): HandoffRunDecision {
  if (input.ageMs > HANDOFF_PENDING_TTL_MS) return 'expired';
  if (input.queueLen > 0 || input.paused) return 'wait';
  return 'run';
}

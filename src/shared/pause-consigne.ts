// Consigne de reprise — what a member is told at a Reprise (#255, ledger #276 D3/D5, ADR 0003). Pure: no bus, no store.
//
// A Consigne is derived ONLY from the member's Bilan de pause row (`pause_records`) + its `pause_members` row — the host trap already
// recorded everything a member needs to know. Killed commands are LISTED, never re-run: the member decides.

import type { ConsigneDeReprise, PauseConfirmVia, PauseMode } from './pause-lifecycle.ts';

/** The structural subset of a Bilan row (`BilanRow` in src/main/bus-pause-records.ts) this module reads — kept structural so
 *  src/shared never imports from src/main. */
export interface BilanLike {
  snapshotRef: string | null;
  dirty: boolean | null;
  /** `killed_json`: a KillReport (`{killed, survivors, refused, …}`), `{skipped}` for a remote member, or null while the trap is still owed. */
  killed: unknown | null;
  error: string | null;
  activity: BilanActivityLike | null;
}

export interface BilanActivityLike {
  turnRunning?: boolean;
  /** `BilanActivity.interrupt`: how the turn interrupt ended for this member ('interrupted' | 'exempt' | 'unresponsive' | 'skipped' | …). Absent = not recorded. */
  interrupt?: string;
  inFlightTools?: Array<{ tool: string | null; input?: string | null }>;
  bgTasks?: Array<{ type?: string; description: string; status?: string }>;
  lastTask?: string;
  branch?: string | null;
  head?: string | null;
  snapshotIncomplete?: 'timeout';
  snapshotNotes?: string[];
  snapshotWarnings?: string[];
  skippedLargeCount?: number;
  skippedLarge?: Array<{ path: string }>;
  earlierKilled?: Array<{ pid: number; cmd: string; cwd?: string | null }>;
  observerKilled?: Array<{ pid: number; cmd: string; cwd?: string | null }>;
  notes?: string[];
}

interface KilledReportLike {
  killed?: Array<{ pid: number; cmd: string; cwd?: string | null }>;
  survivors?: Array<{ pid: number; cmd: string }>;
  refused?: Array<{ pid: number; cmd: string; reason: string }>;
  skipped?: string;
}

/** Facts the Consigne states that the FROZEN `ConsigneDeReprise` does not carry (optional on purpose: a plain `ConsigneDeReprise` from a stub still renders, as before). */
export interface ConsigneFacts {
  /** false = the member has NO Bilan row: nothing is known about what it was doing. */
  bilanRecorded: boolean;
  /** `activity.interrupt` of the Bilan, or null when not recorded. */
  interrupt: string | null;
  /** The calls in flight, grouped by the epoch (and so the interrupt outcome) that recorded them: the CURRENT Pause first (`earlierAt` null), then each EARLIER Pause the member was never released from. */
  inFlightGroups: Array<{ interrupt: string | null; lines: string[]; earlierAt: number | null }>;
}
export type ConsigneWithFacts = ConsigneDeReprise & Partial<ConsigneFacts>;

/** What the interrupt did to the calls that were in flight — decides whether "ABORTED" may be said. */
export type InterruptKind = 'aborted' | 'exempt' | 'unconfirmed' | 'not-interrupted' | 'unknown';
export function interruptKind(interrupt: string | null | undefined): InterruptKind {
  switch (interrupt) {
    case 'interrupted':
    case 'attached-then-interrupted':
      return 'aborted';
    case 'exempt':
      return 'exempt'; // the member that ran `orchestra run pause` keeps its turn: the interrupt did NOT abort its calls
    case 'unresponsive':
    case 'failed':
      return 'unconfirmed'; // the interrupt may not have taken effect: the call may have been aborted OR still running
    case 'idle':
    case 'no-session':
    case 'skipped':
      return 'not-interrupted';
    default:
      return 'unknown'; // not recorded (a row written before the interrupt step, or an older Bilan)
  }
}

export interface ConsigneInput {
  /** The pause CARRIER run and epoch (`runs.paused_at`). */
  runId: string;
  pausedAt: number;
  pausedBy: string | null;
  mode: PauseMode | null;
  wsId: string;
  /** `pause_members.pause_confirm_via` of this member, or null (no roster row / not confirmed). */
  confirmedVia: PauseConfirmVia | null;
  /** The member's Bilan row for this pause, or null when the host trap never reached it. */
  bilan: BilanLike | null;
  /** EARLIER Pauses of the same carrier that took this member and from which it was NEVER released (a re-Pause during a Reprise opens a new epoch: the member
   *  was never told what the first one killed). Their killed commands join the list; their snapshot refs are named in the notes. */
  earlier?: Array<{ pausedAt: number; snapshotRef: string | null; killed: Array<{ cmd: string; cwd: string | null }>; inFlight?: string[]; interrupt?: string | null }>;
}

/** Code-point ranges stripped from any recorded string: C0/DEL/C1, soft hyphen, ALM, Mongolian vowel separator, zero-width + bidi marks/overrides/isolates,
 *  line/paragraph separators, invisible formatting (U+2060-206F, deprecated format controls included), BOM and the TAG block. Built from NUMBERS so no invisible character lives in this source. */
const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x2029],
  [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xe0000, 0xe007f],
];
const cp = (n: number): string => `\\u{${n.toString(16)}}`;
const STRIP_RE = new RegExp(`[${STRIP_RANGES.map(([a, b]) => (a === b ? cp(a) : `${cp(a)}-${cp(b)}`)).join('')}]`, 'gu');

/** Control / invisible / bidi characters in a recorded string (argv, cwd, notes) must never forge a line in the member's prompt. */
export function stripControl(s: unknown): string {
  return String(s ?? '').replace(STRIP_RE, ' ');
}

const CMD_CHARS = 300;
const KILLED_LISTED = 20;
const NOTES_LISTED = 12;

function trimTo(s: string, n: number): string {
  const clean = stripControl(s);
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

/** Every command the Pause killed for this member — the trap's `killed_json` list, what a retry that stayed incomplete kept
 *  (`earlierKilled`) and what the turn observer killed afterwards (`observerKilled`) — deduplicated by pid + command. */
export function killedCommands(b: BilanLike | null): Array<{ cmd: string; cwd: string | null }> {
  if (!b) return [];
  const k = (b.killed && typeof b.killed === 'object' ? (b.killed as KilledReportLike) : null) ?? {};
  const all = [...(k.killed ?? []), ...(b.activity?.earlierKilled ?? []), ...(b.activity?.observerKilled ?? [])];
  const seen = new Set<string>();
  const out: Array<{ cmd: string; cwd: string | null }> = [];
  for (const p of all) {
    const key = `${p.pid}\u0000${p.cmd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cmd: p.cmd, cwd: p.cwd ?? null });
  }
  return out;
}

/** One line per call the INTERRUPT aborted: `Bash: npm test`, or `Bash (command text not recorded)` for a terminal agent / a call whose input never reached the host. */
export function inFlightLines(b: BilanLike | null): string[] {
  return (b?.activity?.inFlightTools ?? []).map((t) => (t.input ? `${t.tool ?? '?'}: ${t.input}` : `${t.tool ?? '?'} (command text not recorded)`));
}

/** Derive the Consigne of ONE member. Never throws on a partial/odd Bilan: a missing fact is `null`/`[]` and a note says so. */
export function consigneFromBilan(i: ConsigneInput): ConsigneWithFacts {
  const b = i.bilan;
  const a = b?.activity ?? null;
  const k = (b?.killed && typeof b.killed === 'object' ? (b.killed as KilledReportLike) : null) ?? {};
  const notes: string[] = [];
  if (!b) {
    notes.push(
      'no Bilan de pause was recorded for you (the host trap had not reached you when the Reprise began): nothing was snapshotted, ' +
        'interrupted or killed for you by the Pause — your worktree and processes are as you left them',
    );
  } else {
    if (b.snapshotRef === null && !a?.snapshotIncomplete) notes.push('no snapshot ref was taken (see the error below, if any): your worktree is the only copy of your uncommitted work');
    if (a?.snapshotIncomplete) notes.push(`the snapshot did NOT finish (${a.snapshotIncomplete}): no ref exists — your worktree is the only copy of your uncommitted work`);
    if (b.killed === null) notes.push('the host trap did not finish for you: some of your commands may NOT have been killed');
    if (k.skipped) notes.push(`not trapped: ${k.skipped}`);
    for (const s of k.survivors ?? []) notes.push(`STILL ALIVE after the Pause: ${s.cmd} (pid ${s.pid})`);
    for (const r of k.refused ?? []) notes.push(`not killed (identity not provable, pid ${r.pid}): ${r.reason}`);
    for (const w of a?.snapshotWarnings ?? []) notes.push(`NOT in your snapshot (unreadable): ${w}`);
    if (a?.skippedLarge?.length) {
      const n = a.skippedLargeCount ?? a.skippedLarge.length;
      notes.push(`NOT in your snapshot (too large, ${n}): ${a.skippedLarge.slice(0, 5).map((f) => f.path).join(', ')}${n > 5 ? ', …' : ''}`);
    }
    for (const n of a?.snapshotNotes ?? []) notes.push(n);
    for (const n of a?.notes ?? []) notes.push(n);
    if (b.error) notes.push(`trap error: ${b.error}`);
  }
  const killed = killedCommands(b);
  const seenKilled = new Set(killed.map((k) => `${k.cmd}\u0000${k.cwd ?? ''}`));
  const inFlight = inFlightLines(b);
  const groups: ConsigneFacts['inFlightGroups'] = inFlight.length ? [{ interrupt: a?.interrupt ?? null, lines: [...inFlight], earlierAt: null }] : [];
  for (const e of i.earlier ?? []) {
    // each epoch's calls keep THEIR interrupt outcome: a call an EARLIER Pause's interrupt aborted must not read "no turn was interrupted" because the latest Pause found the member idle
    const fresh = (e.inFlight ?? []).filter((t) => !inFlight.includes(t));
    if (fresh.length) groups.push({ interrupt: e.interrupt ?? null, lines: fresh, earlierAt: e.pausedAt });
    for (const t of e.inFlight ?? []) if (!inFlight.includes(t)) inFlight.push(t);
    for (const k of e.killed) {
      const key = `${k.cmd}\u0000${k.cwd ?? ''}`;
      if (!seenKilled.has(key)) { seenKilled.add(key); killed.push(k); }
    }
    notes.push(
      `an EARLIER Pause of this run (${iso(e.pausedAt)}) took you too and you were never released from it: its snapshot ref ${e.snapshotRef ?? 'none'}` +
        `${e.killed.length ? `; it killed ${e.killed.length} command(s) — merged into the list of killed commands` : '; it killed nothing'}` +
        `${e.inFlight?.length ? (interruptKind(e.interrupt) === 'aborted' ? `; the interrupt aborted ${e.inFlight.length} in-flight call(s) — listed with the calls in flight` : `; ${e.inFlight.length} call(s) were in flight then (interrupt: ${e.interrupt ? stripControl(e.interrupt) : 'not recorded'}) — listed with the calls in flight`) : ''}`,
    );
  }
  return {
    runId: i.runId,
    wsId: i.wsId,
    pausedAt: i.pausedAt,
    pausedBy: i.pausedBy,
    mode: i.mode ?? 'hard',
    confirmedVia: i.confirmedVia,
    wasDoing: {
      turnRunning: a?.turnRunning === true,
      inFlightTools: inFlight,
      bgTasks: (a?.bgTasks ?? []).map((t) => `${t.type ?? 'task'}: ${t.description}`),
      lastTask: a?.lastTask ?? null,
    },
    branch: a?.branch ?? null,
    head: a?.head ?? null,
    snapshotRef: b?.snapshotRef ?? null,
    snapshotIncomplete: a?.snapshotIncomplete ?? null,
    dirty: b?.dirty ?? null,
    killed,
    notes,
    bilanRecorded: b !== null,
    interrupt: a?.interrupt ?? null,
    inFlightGroups: groups,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The text a member reads at its release. Every field is LITERAL (the tests pin them): the snapshot ref, the killed commands (listed,
 * never re-run), the dirty tree. English on purpose — it is a prompt for an agent, like every other bus row.
 */
export function renderConsigne(c: ConsigneWithFacts, opts?: { releasedBy?: string | null }): string {
  const out: string[] = [];
  out.push(`CONSIGNE DE REPRISE — workspace ${stripControl(c.wsId)}, run ${stripControl(c.runId)}`);
  out.push(
    `The fleet Pause (${c.mode}, since ${iso(c.pausedAt)}${c.pausedBy ? ` by ${trimTo(c.pausedBy, 80)}` : ''}) is lifted for you` +
      `${opts?.releasedBy ? `: ${trimTo(opts.releasedBy, 80)} released you` : ''}. Nothing was restarted for you — you decide what to resume.`,
  );
  // no Bilan row ⇒ nothing is known about the member: "idle" would be a guess (the Pause landed while a douce still waited, or the app was down)
  const doing: string[] = [c.bilanRecorded === false ? 'unknown (no Bilan de pause was recorded for you)' : c.wasDoing.turnRunning ? 'a turn was running' : 'idle (no turn running)'];
  if (c.wasDoing.bgTasks.length) doing.push(`background tasks: ${c.wasDoing.bgTasks.slice(0, 5).map((t) => `"${trimTo(t, 80)}"`).join(', ')}${c.wasDoing.bgTasks.length > 5 ? ', …' : ''}`);
  out.push(`You were: ${doing.join(' · ')}.`);
  if (c.wasDoing.lastTask) out.push(`Your last task: ${trimTo(c.wasDoing.lastTask, 200)}`);
  out.push(`Branch: ${c.branch ? trimTo(c.branch, 120) : '(unknown)'}${c.head ? ` @ ${trimTo(c.head, 40)}` : ''}`);
  out.push(`Dirty tree: ${c.dirty === null ? 'unknown' : c.dirty ? 'YES — uncommitted work was in your worktree' : 'no — nothing uncommitted'}`);
  if (c.snapshotRef) {
    out.push(
      `Snapshot ref: ${trimTo(c.snapshotRef, 200)} — your save. Your worktree was NOT touched by the Pause (the uncommitted work is still in place); ` +
        `\`git diff ${c.head ? stripControl(c.head).slice(0, 12) : 'HEAD'} ${trimTo(c.snapshotRef, 200)}\` shows exactly the uncommitted non-ignored work the ref holds.`,
    );
  } else {
    out.push(`Snapshot ref: none${c.snapshotIncomplete ? ` (the snapshot did not finish: ${c.snapshotIncomplete})` : ''} — your worktree is the only copy of your work.`);
  }
  const aborted = c.wasDoing.inFlightTools;
  const kind = interruptKind(c.interrupt);
  const groups = c.inFlightGroups ?? (aborted.length ? [{ interrupt: c.interrupt ?? null, lines: aborted, earlierAt: null }] : []);
  for (const g of groups) {
    const gk = interruptKind(g.interrupt);
    const n = g.lines.length;
    const when = g.earlierAt === null ? 'the Pause' : `an EARLIER Pause (${iso(g.earlierAt)})`;
    // "ABORTED" is a claim about the interrupt: only when it is recorded as having taken effect. A FOREGROUND tool then dies with it (the host trap kills nothing for it) — name it, or "none" below would be a lie.
    out.push(
      gk === 'aborted'
        ? `Calls IN FLIGHT when ${when} interrupted your turn (${n}) — ${g.earlierAt === null ? 'the' : 'that'} interrupt ABORTED them: LISTED, NOT re-run. Re-run one only if you still need it, after checking the tree:`
        : gk === 'exempt'
          ? `Calls in flight when ${when} began (${n}) — you were EXEMPT from the interrupt (you ran the Pause yourself), so it did NOT abort them (the command that ran the Pause is among them): LISTED, NOT re-run. Check the tree before re-running anything:`
          : gk === 'unconfirmed'
            ? `Calls in flight when ${when} began (${n}) — the interrupt could NOT be confirmed for you (${stripControl(g.interrupt)}): they MAY have been aborted or MAY still have been running: LISTED, NOT re-run. Check the tree first:`
            : gk === 'not-interrupted'
              ? `Calls recorded in flight (${n}) — no turn was interrupted for you (${stripControl(g.interrupt)}): LISTED, NOT re-run. Check the tree first:`
              : `Calls recorded in flight when ${when} began (${n}) — how the interrupt ended for you is NOT recorded: they MAY have been aborted. LISTED, NOT re-run. Check the tree first:`,
    );
    for (const t of g.lines.slice(0, KILLED_LISTED)) out.push(`  - ${trimTo(t, CMD_CHARS)}`);
    if (n > KILLED_LISTED) out.push(`  - … +${n - KILLED_LISTED} more (orchestra run status --run ${stripControl(c.runId)})`);
  }
  // "none — aborted by the interrupt itself" only when the interrupt took effect for EVERY listed call (one exempt / unconfirmed group makes it a half-truth)
  const anyAborted = groups.length > 0 && groups.every((g) => interruptKind(g.interrupt) === 'aborted');
  // a turn WAS running but no call is recorded (a session that survived an app restart is not tracked): "none" would be a guess — say it is unrecorded. Not for a member whose turn the interrupt never touched.
  const unrecorded = c.wasDoing.turnRunning && aborted.length === 0 && (kind === 'aborted' || kind === 'unknown' || kind === 'unconfirmed');
  if (c.killed.length === 0) {
    out.push(
      aborted.length
        ? anyAborted
          ? 'Commands killed by the host trap: none — the in-flight call(s) above were aborted by the interrupt itself.'
          : 'Commands killed by the host trap: none.'
        : unrecorded
          ? 'Commands killed by the Pause: none recorded — but a turn was running and no call is recorded for it, so the interrupt may have aborted a call that is not listed here: check the tree before assuming nothing was lost.'
          : 'Commands killed by the Pause: none.',
    );
  } else {
    out.push(`Commands killed by the Pause (${c.killed.length}) — LISTED, NOT re-run. Re-run one only if you still need it, after checking the tree:`);
    for (const k of c.killed.slice(0, KILLED_LISTED)) out.push(`  - ${trimTo(k.cmd, CMD_CHARS)}${k.cwd ? `   (cwd ${trimTo(k.cwd, 200)})` : ''}`);
    if (c.killed.length > KILLED_LISTED) out.push(`  - … +${c.killed.length - KILLED_LISTED} more (orchestra run status --run ${stripControl(c.runId)})`);
    if (unrecorded) out.push('Calls in flight at the interrupt: none recorded — but a turn was running, so an aborted call may be missing from this list.');
  }
  if (c.confirmedVia) out.push(`Your Pause was taken: ${c.confirmedVia === 'member' ? 'you confirmed it yourself' : c.confirmedVia === 'host-idle' ? 'you were idle, the host confirmed for you' : 'by the host trap'}.`);
  if (c.notes.length) {
    out.push('Notes:');
    for (const n of c.notes.slice(0, NOTES_LISTED)) out.push(`  - ${trimTo(n, 400)}`);
    if (c.notes.length > NOTES_LISTED) out.push(`  - … +${c.notes.length - NOTES_LISTED} more notes (orchestra run status --run ${stripControl(c.runId)})`);
  }
  out.push('When you are back on your feet, confirm with: orchestra run confirm reprise');
  return out.join('\n');
}

/** One compact line per member for a COORDINATOR's wave Bilan (the full Consigne is sent to each member when its coordinator releases it). */
export function renderWaveLine(c: ConsigneWithFacts): string {
  const killed =
    c.bilanRecorded === false
      ? 'NO Bilan recorded (nothing known)'
      : c.killed.length
        ? `${c.killed.length} killed: ${c.killed.slice(0, 3).map((k) => trimTo(k.cmd, 60)).join('; ')}${c.killed.length > 3 ? '; …' : ''}`
        : 'nothing killed';
  const n = c.wasDoing.inFlightTools.length;
  const what = `${c.wasDoing.inFlightTools.slice(0, 2).map((t) => trimTo(t, 60)).join('; ')}${n > 2 ? '; …' : ''}`;
  // the outcome of EVERY epoch that recorded a call (a re-Pause's idle member keeps the EARLIER epoch's calls): "aborted" only when it took effect for all of them
  const outcomes = c.inFlightGroups ? c.inFlightGroups.map((g) => g.interrupt) : [c.interrupt ?? null];
  const aborted = !n
    ? ''
    : outcomes.every((o) => interruptKind(o) === 'aborted')
      ? `; ${n} in flight, aborted by the interrupt: ${what}`
      : `; ${n} in flight at the Pause (interrupt: ${[...new Set(outcomes.map((o) => (o ? trimTo(o, 30) : 'not recorded')))].join(' / ')}): ${what}`;
  return (
    `  • ${stripControl(c.wsId)}${c.branch ? ` [${trimTo(c.branch, 60)}]` : ''} — dirty tree: ${c.dirty === null ? 'unknown' : c.dirty ? 'yes' : 'no'}; ` +
    `snapshot ref: ${c.snapshotRef ? trimTo(c.snapshotRef, 160) : 'none'}; ${killed}${aborted}`
  );
}

/** What a COORDINATOR receives when the Reprise releases it: the Bilan de pause of ITS wave + what to do next. */
export function renderCoordinatorReprise(args: {
  runId: string;
  carrierRunId: string;
  pausedAt: number;
  pausedBy: string | null;
  mode: PauseMode | null;
  /** Members of this coordinator's wave (workers it must release), in roster order. */
  wave: ConsigneWithFacts[];
  /** Child-run coordinators — released by the host at the same time, shown for context. */
  coordinators: string[];
  /** The coordinator's OWN Consigne (its snapshot ref, dirty tree, the commands the Pause killed in ITS session): the host released it without one, so it rides here. */
  self?: ConsigneWithFacts;
}): string {
  const out: string[] = [];
  out.push(`REPRISE — you are released first (coordinator of run ${stripControl(args.runId)}; the Pause is carried by run ${stripControl(args.carrierRunId)}).`);
  out.push(
    `Pause (${args.mode ?? 'hard'}) since ${iso(args.pausedAt)}${args.pausedBy ? ` by ${trimTo(args.pausedBy, 80)}` : ''}. ` +
      'Your workers are STILL BLOCKED — nobody restarts on their own. Release them yourself; each one then receives its own Consigne de reprise built from its Bilan de pause:',
  );
  out.push('  orchestra run release <workspace-id>   (one member)      orchestra run release --all   (every member of YOUR OWN run — a worker of a run below yours is released by its own OPS, or by you with its explicit id)');
  if (args.coordinators.length) out.push(`Other coordinators released at the same time by the host: ${args.coordinators.map((c) => stripControl(c)).join(', ')}.`);
  out.push(`Bilan de pause of your wave (${args.wave.length} member${args.wave.length === 1 ? '' : 's'}):`);
  const SHOWN = 40;
  for (const c of args.wave.slice(0, SHOWN)) out.push(renderWaveLine(c));
  if (args.wave.length > SHOWN) out.push(`  … +${args.wave.length - SHOWN} more — orchestra run status --run ${stripControl(args.runId)}`);
  out.push('Killed commands are listed, never re-run automatically. Track who is back with: orchestra bus-status (N/M repris).');
  if (args.self) {
    out.push('');
    out.push('YOUR OWN Bilan de pause (the host released you without a separate Consigne):');
    out.push(renderConsigne(args.self));
  }
  return out.join('\n');
}

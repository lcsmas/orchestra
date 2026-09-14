// The bus verbs of the `orchestra` CLI: send / check / ack / ask / gate (#115).
//
// WHY THESE DO NOT GO THROUGH THE SOCKET, unlike every other verb in
// src/cli/index.ts. Decision #108 Q2: a message must land while the app is
// DOWN or restarting. Every other verb asks the running app to do something to
// a workspace, so "Orchestra is not running" is a legitimate refusal. A bus
// message is different — the bus IS the source of truth
// (docs/adr/0002-fleet-bus-sqlite-source-of-truth.md), and an agent whose peer
// happens to be mid-restart must not lose what it said. So these verbs open
// `$ORCHESTRA_HOME/bus.sqlite` themselves and write it directly, concurrently
// with the app's own connection. WAL + the mandatory busy_timeout in
// bus.ts `open()` is what makes that safe (spike #109 arm 1: 1000/1000 with it,
// 7-27% silent loss without).
//
// RUNTIME. The packaged CLI runs INSIDE the Electron binary
// (`Orchestra.AppImage cli …`, ELECTRON_RUN_AS_NODE, ABI 130), so it shares
// main's native better-sqlite3 build. A `node dist-electron/cli.js send …` on
// system node (ABI 127) therefore CANNOT construct a database — and must say so
// in a sentence a human can act on, not a NODE_MODULE_VERSION stack trace. That
// is `describeBusOpenFailure()` below, and it is the reason every verb here
// opens through one helper.
//
// EXIT DISCIPLINE. Nothing here calls `process.exit()`. Under Electron a bare
// exit after an await does not terminate in that tick (issue #59), so refusals
// go through index.ts's `fail()` (throws CliFailure). These functions therefore
// take a `fail` callback rather than exiting themselves — which also makes them
// unit-testable without spawning a process.

import type { BusDb, BusLot, BusMessageKind, BusMessage, BusDecisionGate } from '../main/bus.ts';

/** The eight kinds `bus.send()` accepts. Duplicated as a VALUE here because
 *  bus.ts exports the list only as a type; keep in sync with MESSAGE_KINDS. */
export const BUS_KINDS: readonly string[] = [
  'status',
  'dispatch',
  'worker_done',
  'escalation',
  'handoff',
  'decision_gate',
  'question',
  'heartbeat',
];

/** The run id used when nothing names one.
 *
 *  The run LIFECYCLE (creating rows in `runs`) is a later ticket; v1's `run_id`
 *  is an unconstrained scoping string (bus.ts's migration comment says so
 *  explicitly). A default is deliberate rather than a required flag: an agent
 *  that forgets `--run` should land its message where every other defaulting
 *  agent is reading, not in a private universe nobody checks — which is the
 *  exact failure mode that comment warns about. */
export const DEFAULT_RUN_ID = 'default';

export interface BusIdentity {
  runId: string;
  handle: string;
}

/**
 * Resolve `{ runId, handle }` from flags + env (pure; the unit tests drive it).
 *
 * Precedence, both axes: explicit flag > env > default. `handle` has NO default
 * — an anonymous sender would make `check` unable to say whose lot it is, and a
 * reader identified as `''` would collide with every other unidentified one on
 * the `(run_id, reader)` unique index. So it returns null and the caller fails
 * with a message naming both ways to supply it.
 */
export function resolveBusIdentity(
  flags: { run?: string; as?: string },
  env: {
    ORCHESTRA_RUN_ID?: string;
    ORCHESTRA_WS_ID?: string;
    ORCHESTRA_WS_ID_IDENTITY?: string;
  },
): BusIdentity | null {
  const runId =
    flags.run?.trim() || env.ORCHESTRA_RUN_ID?.trim() || DEFAULT_RUN_ID;
  const handle =
    flags.as?.trim() ||
    env.ORCHESTRA_WS_ID?.trim() ||
    env.ORCHESTRA_WS_ID_IDENTITY?.trim() ||
    '';
  if (!handle) return null;
  return { runId, handle };
}

/**
 * Turn a failure to OPEN the bus into a sentence naming the cause and the fix.
 *
 * The ABI mismatch is the one that will actually happen, and its native message
 * (`… was compiled against a different Node.js version using NODE_MODULE_VERSION
 * 130. This version of Node.js requires NODE_MODULE_VERSION 127…`) is accurate
 * and useless: nothing in it says "you launched the CLI with system node instead
 * of through the app". Ticket #115 Boundaries: "a system-node launch must fail
 * loudly with a clear message, not silently."
 *
 * Deliberately keyed on the message TEXT, not on `process.versions.modules`:
 * the mismatch is between the runtime and whatever binding actually resolved,
 * and only the thrown error knows which one that was.
 */
export function describeBusOpenFailure(err: unknown, file: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const abi = /NODE_MODULE_VERSION|different Node\.js version|was compiled against/i.test(raw);
  if (abi) {
    return (
      `bus: cannot open ${file} — the better-sqlite3 native binding does not match this runtime ` +
      `(node ABI ${process.versions.modules}${process.versions.electron ? `, electron ${process.versions.electron}` : ', no electron'}).\n` +
      `  The bus verbs must run under the SAME runtime as the app: the packaged CLI is the Electron ` +
      `binary itself (Orchestra.AppImage cli …, ELECTRON_RUN_AS_NODE=1), which is ABI 130.\n` +
      `  Running dist-electron/cli.js under system node (ABI ${process.versions.modules}) cannot work — ` +
      `use the packaged 'orchestra' binary, or run 'pnpm run build:bus-abi' for a dev build at this ABI.\n` +
      `  Underlying error: ${raw}`
    );
  }
  return `bus: cannot open ${file} — ${raw}`;
}

/** How a verb reports a refusal. index.ts passes `fail` (throws CliFailure). */
export type FailFn = (message: string) => never;

/** How a verb writes its output. index.ts passes stdout. */
export type OutFn = (text: string) => void;

/** What every bus verb needs. Injected so tests drive a real DB with no process. */
export interface BusVerbCtx {
  db: BusDb;
  id: BusIdentity;
  out: OutFn;
  fail: FailFn;
  bus: BusModule;
  /**
   * FENCING (#128). The coordinator generation this writer presents, or null when
   * it did not opt into fencing (the v1 unfenced path — every existing caller).
   * Resolved by index.ts from `--generation` / `$ORCHESTRA_COORDINATOR_GENERATION`.
   */
  generation: number | null;
  /**
   * The `fencing` switch, frozen on this run's row (#128). Resolved by index.ts
   * via busSwitch — passed in so bus-verbs.ts needs no bus-runs import. While OFF
   * a stale write is COUNTED, not rejected (coexistence).
   */
  fencingOn: boolean;
}

/** The slice of src/main/bus.ts the verbs use (injected so a test can drive the
 *  real module without index.ts's socket/env machinery). */
export interface BusModule {
  send(db: BusDb, input: {
    runId: string;
    sender: string;
    kind: BusMessageKind;
    body: string;
    recipient?: string | null;
    threadId?: string | null;
  }): number;
  check(db: BusDb, runId: string, reader: string, limit?: number): BusLot;
  ack(db: BusDb, runId: string, reader: string, lotId: number): boolean;
  openGate(
    db: BusDb,
    runId: string,
    askedBy: string,
    question: string,
    recipient?: string | null,
  ): number;
  resolveGate(db: BusDb, gateId: number, resolvedBy: string, resolution: string): boolean;
  /** Open gates addressed to `recipient` (#119) — surfaced by `check` and
   *  `gate list` so a gate-woken reader can see what it was woken for. */
  openGatesForRecipient(db: BusDb, runId: string, recipient: string): BusDecisionGate[];
  /** FENCING (#128): run `write` behind the coordinator-generation fence, as ONE
   *  IMMEDIATE transaction (closes the TOCTOU window, review F1). Throws
   *  StaleGenerationError when the switch is ON and the write is stale (the write
   *  never runs); records a counted shadow event then runs the write when the
   *  switch is OFF; runs the write directly when the caller presented no
   *  generation or is not stale. See bus.ts fencedWrite(). */
  fencedWrite<T>(
    db: BusDb,
    input: {
      runId: string;
      verb: string;
      presented: number | null | undefined;
      fencingOn: boolean;
      actor: string;
    },
    write: () => T,
  ): T | undefined;
}

// ─── fencing (#128) ───────────────────────────────────────────────────────────

/**
 * Run `write` behind the coordinator-generation fence, as ONE transaction.
 *
 * The fence and the write are ONE atomic unit (review F1, ledger #131): a bump
 * landing between a separate fence-check and a separate write would let a
 * superseded coordinator write. `bus.fencedWrite` takes the write as a closure and
 * runs read-decide-write inside one IMMEDIATE transaction, so no concurrent bump
 * can interleave. This function only adds the CLI-side error routing.
 *
 * `fencedWrite` THROWS a StaleGenerationError when the switch is ON and the write
 * is stale. That throw must become a CLI refusal, not an uncaught exception: under
 * Electron a bare throw of a non-CliFailure would escape runCli's catch and a bare
 * process.exit() cannot save it (issue #59). So we catch the typed error (by
 * `name`, which survives the boundaries `instanceof` does not) and route it
 * through `ctx.fail` (the CliFailure sentinel). Any OTHER error (a DB fault) is
 * re-thrown — it is not a fencing refusal and must not be disguised as one.
 */
function fenced<T>(ctx: BusVerbCtx, verb: string, write: () => T): T {
  try {
    return ctx.bus.fencedWrite(
      ctx.db,
      {
        runId: ctx.id.runId,
        verb,
        presented: ctx.generation,
        fencingOn: ctx.fencingOn,
        actor: ctx.id.handle,
      },
      write,
    ) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'StaleGenerationError') {
      ctx.fail(err.message);
    }
    throw err;
  }
}

// ─── send ───────────────────────────────────────────────────────────────────

export interface SendArgs {
  kind?: string;
  to?: string | null;
  thread?: string | null;
  body: string;
}

/** `orchestra send --type <kind> [--to <h>] [--thread <id>] <body...>` */
export function verbSend(ctx: BusVerbCtx, a: SendArgs): void {
  if (!a.kind) ctx.fail('usage: orchestra send --type <kind> [--to <handle>] [--thread <id>] <body...>');
  // Validated HERE as well as in bus.send(), because the CLI can say what the
  // legal set IS. bus.send() refuses too — this is the message, not the guard.
  if (!BUS_KINDS.includes(a.kind!)) {
    ctx.fail(`orchestra send: unknown --type ${JSON.stringify(a.kind)} (one of: ${BUS_KINDS.join(', ')})`);
  }
  if (!a.body.trim()) ctx.fail('orchestra send: the message body is empty');
  // FENCE + write as ONE transaction (#128, F1). A stale-generation send is
  // rejected with the switch ON (the send never runs), counted with it OFF, and
  // a straight write when the caller presented no generation.
  const seq = fenced(ctx, 'send', () =>
    ctx.bus.send(ctx.db, {
      runId: ctx.id.runId,
      sender: ctx.id.handle,
      kind: a.kind as BusMessageKind,
      body: a.body,
      recipient: a.to ?? null,
      threadId: a.thread ?? null,
    }),
  );
  ctx.out(`${seq}\n`);
}

// ─── check ──────────────────────────────────────────────────────────────────

export interface CheckArgs {
  ackPrevious: boolean;
  markdown: boolean;
  limit: number;
}

/** The JSON `check` prints. Its SHAPE is a published contract (ledger #123) —
 *  #117's wake orders a reader to run `orchestra check` and parse this. */
export interface CheckOutput {
  run: string;
  reader: string;
  lot: number | null;
  replay: boolean;
  from: number;
  to: number;
  count: number;
  messages: Array<{
    sequence: number;
    kind: string;
    sender: string;
    recipient: string | null;
    thread_id: string | null;
    body: string;
    created_at: number;
  }>;
  /**
   * Open decision gates addressed to this reader (#119). Surfaced HERE because
   * the wake order is `orchestra check` and nothing else — a gate-woken reader
   * must see the gate it was woken for without a second verb. Carried alongside
   * the lot rather than folded into `messages`: a gate is not a lot message, it
   * is not acked by `orchestra ack`, and it stays visible across checks until it
   * is resolved (unlike a lot, which clears on ack). Always present (possibly
   * empty) so a parser never has to distinguish "no gates" from "old build".
   */
  gates: Array<{
    id: number;
    asked_by: string;
    question: string;
    opened_at: number;
  }>;
}

export function lotToOutput(
  id: BusIdentity,
  lot: BusLot,
  gates: readonly BusDecisionGate[] = [],
): CheckOutput {
  return {
    run: id.runId,
    reader: id.handle,
    lot: lot.delivery ? lot.delivery.id : null,
    replay: lot.replay,
    from: lot.delivery ? lot.delivery.from_seq : 0,
    to: lot.delivery ? lot.delivery.to_seq : 0,
    count: lot.messages.length,
    messages: lot.messages.map((m: BusMessage) => ({
      sequence: m.sequence,
      kind: m.kind,
      sender: m.sender,
      recipient: m.recipient,
      thread_id: m.thread_id,
      body: m.body,
      created_at: m.created_at,
    })),
    gates: gates.map((g) => ({
      id: g.id,
      asked_by: g.asked_by,
      question: g.question,
      opened_at: g.opened_at,
    })),
  };
}

function renderGatesMarkdown(o: CheckOutput): string {
  if (o.gates.length === 0) return '';
  const head = `\n## Open decision gate(s) addressed to ${o.reader} — ${o.gates.length}\n`;
  const body = o.gates
    .map(
      (g) =>
        `\n### gate ${g.id} · from ${g.asked_by}\n${g.question}\n\nAnswer it (LEAD, after the human rules): orchestra gate resolve ${g.id} --resolution "<ruling>"\n`,
    )
    .join('');
  return `${head}${body}`;
}

export function renderLotMarkdown(o: CheckOutput): string {
  const gatesMd = renderGatesMarkdown(o);
  if (o.count === 0) {
    // A gate is pending even when the lot is empty — a reader woken FOR a gate
    // arrives with no lot messages, so "no messages" must still print the gate.
    return `No pending messages for ${o.reader} in run ${o.run}.\n${gatesMd}`;
  }
  const head = `## Lot ${o.lot}${o.replay ? ' (REPLAY — this lot was already outstanding)' : ''} — ${o.count} message(s), seq ${o.from + 1}..${o.to}\n`;
  const body = o.messages
    .map(
      (m) =>
        `\n### ${m.sequence} · ${m.kind} · from ${m.sender}${m.recipient ? ` → ${m.recipient}` : ''}${m.thread_id ? ` · thread ${m.thread_id}` : ''}\n${m.body}\n`,
    )
    .join('');
  return `${head}${body}\nAck it when you have acted on it: orchestra ack ${o.lot}\n${gatesMd}`;
}

/**
 * `orchestra check [--ack-previous]` — the relève.
 *
 * THE ONE INVARIANT THIS VERB EXISTS TO KEEP (#115 Boundaries, ADR 0002): a
 * plain `check` NEVER acks. Only the reader acks, and only by saying so. So the
 * ack below is gated on `--ack-previous` and nothing else — no "we already
 * handed it over, close it" shortcut, which is precisely the design the spike's
 * must-FAIL control used and which permanently loses a SIGKILLed reader's lot.
 *
 * `--ack-previous` acks the OUTSTANDING lot first and then takes the next one,
 * so a reader in a loop does one call per turn instead of two.
 */
export function verbCheck(ctx: BusVerbCtx, a: CheckArgs): void {
  // Open gates addressed to this reader (#119) accompany EVERY check response —
  // the wake order is `orchestra check`, so this one verb must surface both the
  // lot and the gate a reader may have been woken for.
  const gates = ctx.bus.openGatesForRecipient(ctx.db, ctx.id.runId, ctx.id.handle);
  if (a.ackPrevious) {
    const outstanding = ctx.bus.check(ctx.db, ctx.id.runId, ctx.id.handle, a.limit);
    if (outstanding.delivery && outstanding.replay) {
      ctx.bus.ack(ctx.db, ctx.id.runId, ctx.id.handle, outstanding.delivery.id);
    } else if (outstanding.delivery && !outstanding.replay) {
      // No lot was outstanding, so `check` just took a FRESH one. Acking it now
      // would ack messages the caller has not seen — the caller asked to close
      // the PREVIOUS lot, and there was none. Hand this one back unacked.
      ctx.out(emit(ctx, a, lotToOutput(ctx.id, outstanding, gates)));
      return;
    }
  }
  const lot = ctx.bus.check(ctx.db, ctx.id.runId, ctx.id.handle, a.limit);
  ctx.out(emit(ctx, a, lotToOutput(ctx.id, lot, gates)));
}

function emit(_ctx: BusVerbCtx, a: CheckArgs, o: CheckOutput): string {
  return a.markdown ? renderLotMarkdown(o) : `${JSON.stringify(o)}\n`;
}

// ─── ack ────────────────────────────────────────────────────────────────────

/** `orchestra ack <lot-id>` — the accusé. */
export function verbAck(ctx: BusVerbCtx, lotIdRaw: string | undefined): void {
  if (!lotIdRaw) ctx.fail('usage: orchestra ack <lot-id>');
  const lotId = Number(lotIdRaw);
  if (!Number.isInteger(lotId) || lotId <= 0) {
    ctx.fail(`orchestra ack: ${JSON.stringify(lotIdRaw)} is not a lot id (an integer, printed by 'orchestra check')`);
  }
  // FENCE + ack as ONE transaction (#128, F1) — a stale coordinator's ack is
  // refused with the switch ON, leaving the lot's acked_at unchanged (T128.1's
  // "row unchanged"); the ack never runs.
  const closed = fenced(ctx, 'ack', () =>
    ctx.bus.ack(ctx.db, ctx.id.runId, ctx.id.handle, lotId),
  );
  if (!closed) {
    // NOT silent: an ack that closes nothing means either a wrong id, someone
    // else's lot, or a double ack — all three are worth knowing about, and a
    // reader that treats "ack returned" as "cursor advanced" would otherwise
    // loop forever on the same lot with no signal.
    ctx.fail(
      `orchestra ack: lot ${lotId} is not an outstanding lot for ${ctx.id.handle} in run ${ctx.id.runId} ` +
        '(already acked, unknown id, or another reader\'s lot)',
    );
  }
  ctx.out(`acked ${lotId}\n`);
}

// ─── ask ────────────────────────────────────────────────────────────────────

/**
 * `orchestra ask --to <handle> "<question>"` — park a question and EXIT.
 *
 * NO BLOCKING WAIT, and that is the ticket's word (#115 Intent, decision #108):
 * an agent's Bash tool caps at 600s, so a verb that waited would be a verb that
 * times out and reports a false negative. The wait is HOST-driven — the answer
 * arrives as an ordinary bus message and the réveil (#117) starts a turn. So
 * this writes one `question` row, prints its sequence, and returns.
 */
export function verbAsk(ctx: BusVerbCtx, to: string | undefined, question: string): void {
  if (!to?.trim()) ctx.fail('usage: orchestra ask --to <handle> <question...>');
  if (!question.trim()) ctx.fail('orchestra ask: the question is empty');
  const seq = ctx.bus.send(ctx.db, {
    runId: ctx.id.runId,
    sender: ctx.id.handle,
    kind: 'question',
    body: question,
    recipient: to,
    // The question's own sequence cannot be its thread id (it does not exist
    // yet), so the answer threads by REPLYING to it: `send --thread <seq>`.
    threadId: null,
  });
  ctx.out(`${seq}\n`);
}

// ─── gate ───────────────────────────────────────────────────────────────────

/** Pull one `--flag value` out of a token list (first occurrence). Local to the
 *  gate verb so it stays unit-testable from a raw `rest` array with no index.ts
 *  machinery. `present` distinguishes "flag absent" from "flag with no value". */
function pullFlag(tokens: string[], flag: string): { value?: string; present: boolean; rest: string[] } {
  const idx = tokens.indexOf(flag);
  if (idx === -1) return { present: false, rest: tokens };
  const value = tokens[idx + 1];
  const rest = [...tokens.slice(0, idx), ...tokens.slice(idx + 2)];
  return { value, present: true, rest };
}

/**
 * `orchestra gate open [--to <recipient>] <question...>`
 * `orchestra gate resolve <id> --resolution <text...>`  (also accepts a
 *     positional ruling, for back-compat with the pre-#119 form)
 * `orchestra gate list`  — open gates addressed to the caller.
 *
 * A Ruling is the HUMAN's decision (CONTEXT.md), recorded by the LEAD after the
 * human has ruled — so `resolve` is a recording verb, never a deciding one, and
 * it is idempotent-by-refusal: bus.resolveGate() returns false on an already
 * resolved gate and we report that rather than overwriting the first ruling.
 *
 * `--to` (#119): who the gate is addressed to. That reader is woken (via the
 * pending predicate) and sees the gate in `orchestra check` until it is resolved.
 * Omitting `--to` opens a gate addressed to nobody — recorded, but it wakes no
 * one; the coexistence-safe default.
 */
export function verbGate(ctx: BusVerbCtx, sub: string | undefined, rest: string[]): void {
  if (sub === 'open') {
    const to = pullFlag(rest, '--to');
    if (to.present && !to.value?.trim()) {
      ctx.fail('orchestra gate open: --to needs a recipient handle');
    }
    const question = to.rest.join(' ');
    if (!question.trim()) ctx.fail('usage: orchestra gate open [--to <recipient>] <question...>');
    const gateId = ctx.bus.openGate(
      ctx.db,
      ctx.id.runId,
      ctx.id.handle,
      question,
      to.value?.trim() || null,
    );
    ctx.out(`${gateId}\n`);
    return;
  }
  if (sub === 'resolve') {
    const res = pullFlag(rest, '--resolution');
    if (res.present && !res.value?.trim()) {
      ctx.fail('orchestra gate resolve: --resolution needs a ruling');
    }
    const positional = res.rest;
    const gateId = Number(positional[0]);
    if (!Number.isInteger(gateId) || gateId <= 0) {
      ctx.fail('usage: orchestra gate resolve <gate-id> --resolution <ruling...>');
    }
    // Prefer --resolution; fall back to the positional tail so the pre-#119
    // `gate resolve <id> <ruling...>` form keeps working.
    const ruling = (res.present ? res.value! : positional.slice(1).join(' ')).trim();
    if (!ruling) ctx.fail('orchestra gate resolve: the ruling is empty');
    // FENCE + resolve as ONE transaction (#128, F1) — a superseded coordinator
    // cannot resolve a gate with the switch ON; the resolution never runs and the
    // gate's resolution stays unchanged.
    const ok = fenced(ctx, 'gate-resolve', () =>
      ctx.bus.resolveGate(ctx.db, gateId, ctx.id.handle, ruling),
    );
    if (!ok) {
      ctx.fail(
        `orchestra gate resolve: gate ${gateId} is not open (already resolved, or unknown id) — ` +
          'the first ruling stands and was NOT overwritten',
      );
    }
    ctx.out(`resolved ${gateId}\n`);
    return;
  }
  if (sub === 'list') {
    const gates = ctx.bus.openGatesForRecipient(ctx.db, ctx.id.runId, ctx.id.handle);
    ctx.out(`${JSON.stringify(gates.map((g) => ({
      id: g.id,
      asked_by: g.asked_by,
      question: g.question,
      opened_at: g.opened_at,
    })))}\n`);
    return;
  }
  ctx.fail(
    'usage: orchestra gate open [--to <recipient>] <question...> | ' +
      'orchestra gate resolve <gate-id> --resolution <ruling...> | ' +
      'orchestra gate list',
  );
}

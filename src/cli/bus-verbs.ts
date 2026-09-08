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

import type { BusDb, BusLot, BusMessageKind, BusMessage } from '../main/bus.ts';

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
  openGate(db: BusDb, runId: string, askedBy: string, question: string): number;
  resolveGate(db: BusDb, gateId: number, resolvedBy: string, resolution: string): boolean;
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
  const seq = ctx.bus.send(ctx.db, {
    runId: ctx.id.runId,
    sender: ctx.id.handle,
    kind: a.kind as BusMessageKind,
    body: a.body,
    recipient: a.to ?? null,
    threadId: a.thread ?? null,
  });
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
}

export function lotToOutput(id: BusIdentity, lot: BusLot): CheckOutput {
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
  };
}

export function renderLotMarkdown(o: CheckOutput): string {
  if (o.count === 0) return `No pending messages for ${o.reader} in run ${o.run}.\n`;
  const head = `## Lot ${o.lot}${o.replay ? ' (REPLAY — this lot was already outstanding)' : ''} — ${o.count} message(s), seq ${o.from + 1}..${o.to}\n`;
  const body = o.messages
    .map(
      (m) =>
        `\n### ${m.sequence} · ${m.kind} · from ${m.sender}${m.recipient ? ` → ${m.recipient}` : ''}${m.thread_id ? ` · thread ${m.thread_id}` : ''}\n${m.body}\n`,
    )
    .join('');
  return `${head}${body}\nAck it when you have acted on it: orchestra ack ${o.lot}\n`;
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
  if (a.ackPrevious) {
    const outstanding = ctx.bus.check(ctx.db, ctx.id.runId, ctx.id.handle, a.limit);
    if (outstanding.delivery && outstanding.replay) {
      ctx.bus.ack(ctx.db, ctx.id.runId, ctx.id.handle, outstanding.delivery.id);
    } else if (outstanding.delivery && !outstanding.replay) {
      // No lot was outstanding, so `check` just took a FRESH one. Acking it now
      // would ack messages the caller has not seen — the caller asked to close
      // the PREVIOUS lot, and there was none. Hand this one back unacked.
      ctx.out(emit(ctx, a, lotToOutput(ctx.id, outstanding)));
      return;
    }
  }
  const lot = ctx.bus.check(ctx.db, ctx.id.runId, ctx.id.handle, a.limit);
  ctx.out(emit(ctx, a, lotToOutput(ctx.id, lot)));
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
  const closed = ctx.bus.ack(ctx.db, ctx.id.runId, ctx.id.handle, lotId);
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

/**
 * `orchestra gate open <question...>` / `gate resolve <id> <ruling...>`.
 *
 * A Ruling is the HUMAN's decision (CONTEXT.md), recorded by the LEAD after the
 * human has ruled — so `resolve` is a recording verb, never a deciding one, and
 * it is idempotent-by-refusal: bus.resolveGate() returns false on an already
 * resolved gate and we report that rather than overwriting the first ruling.
 */
export function verbGate(ctx: BusVerbCtx, sub: string | undefined, rest: string[]): void {
  if (sub === 'open') {
    const question = rest.join(' ');
    if (!question.trim()) ctx.fail('usage: orchestra gate open <question...>');
    const gateId = ctx.bus.openGate(ctx.db, ctx.id.runId, ctx.id.handle, question);
    ctx.out(`${gateId}\n`);
    return;
  }
  if (sub === 'resolve') {
    const gateId = Number(rest[0]);
    if (!Number.isInteger(gateId) || gateId <= 0) {
      ctx.fail('usage: orchestra gate resolve <gate-id> <ruling...>');
    }
    const ruling = rest.slice(1).join(' ');
    if (!ruling.trim()) ctx.fail('orchestra gate resolve: the ruling is empty');
    const ok = ctx.bus.resolveGate(ctx.db, gateId, ctx.id.handle, ruling);
    if (!ok) {
      ctx.fail(
        `orchestra gate resolve: gate ${gateId} is not open (already resolved, or unknown id) — ` +
          'the first ruling stands and was NOT overwritten',
      );
    }
    ctx.out(`resolved ${gateId}\n`);
    return;
  }
  ctx.fail('usage: orchestra gate open <question...> | orchestra gate resolve <gate-id> <ruling...>');
}

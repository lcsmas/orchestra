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

import type {
  BusDb,
  BusLot,
  BusMessageKind,
  BusMessage,
  BusDecisionGate,
  MintedCapability,
} from '../main/bus.ts';
import type { BusMutationKind, ReceiptOutcome } from '../main/bus-receipts.ts';

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

/**
 * #155 — the refusal a `send` prints when its `run_id` names a run with NO row
 * in `runs`.
 *
 * THE BUG (canary-4 close-out, ledger #152 F-C4-2b): a send with a typo'd/stale
 * `$ORCHESTRA_RUN_ID` (there, a member's OWN ws id instead of its wave anchor)
 * landed a row under a run that never existed in `runs`. That mail is ORPHANED:
 * `readWakeSwitch(<unknown run>)` safe-defaults OFF so the recipient is never
 * woken, and the row is invisible to every run-scoped `check` — only a reader who
 * already knows the phantom id can retrieve it. Refusing here (same family as
 * #142's stale-marker pre-send gate and #144's refuse-ambiguous-recipient) keeps
 * a mistyped env from writing mail no wake path can reach.
 *
 * The `default` sentinel is EXEMPTED by the caller (never passed here): it never
 * gets a `runs` row (rows are created only at orchestrator anchors, #134) and is
 * the documented fallback for a manual / standalone send. This message is for a
 * run id that LOOKS anchored (a uuid) but has no row — the F-C4-2b shape.
 *
 * The message NAMES the remedy (issue #155): restart so the anchor is re-derived,
 * or correct/unset the env. Keyed here (not inlined at the call site) so the gate
 * and its test read the same string.
 */
export function unknownRunRefusalMessage(runId: string): string {
  return (
    `refused: run ${JSON.stringify(runId)} has no row in the bus 'runs' table, so a message ` +
    `sent to it would be ORPHANED — never woken (the wake switch safe-defaults OFF for an ` +
    `unknown run) and invisible to every run-scoped 'check'.\n` +
    `  This usually means $ORCHESTRA_RUN_ID is stale or typo'd (it should be your wave ANCHOR ` +
    `= your nearest orchestrator's run, not your own workspace id).\n` +
    `  fix: run 'orchestra restart' to re-derive this workspace's run anchor, or correct/unset ` +
    `$ORCHESTRA_RUN_ID (or pass --run <anchor-run-id>) before sending.`
  );
}

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
  /**
   * #129 — is the `capability` switch ON for this run? (ledger #131 RULING D1:
   * one switch PER bus-v2 mechanism, not the `delivery` switch.) Reads the FROZEN
   * run-row flag (bus-runs.ts `busSwitch`), never the live store. Injected rather
   * than imported so the unit tests can drive both ON and OFF without a run row,
   * and so bus-verbs.ts stays free of a main-process import. Defaults to OFF (the
   * coexistence-safe direction) when the caller does not supply it — a build that
   * forgets to wire it keeps the old channel authoritative rather than firing a
   * half-adopted mechanism.
   *
   * COUNTED-not-FIRED (T129.3): a stale capability token is COUNTED whether this
   * is ON or OFF, but the completion is only REJECTED when it is ON. OFF = the
   * old channel accepts the completion as v1.
   */
  capabilityEnabled?: () => boolean;
  /** #129 — record that a would-be capability rejection was observed (shadow
   *  counter). Called on every stale/absent token regardless of the switch, so
   *  the counter moves in shadow mode. No-op if unwired (unit tests without a
   *  counter). */
  countCapabilityReject?: () => void;
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
  /** Read one gate back (#158) — the resolve verb reads it to route the
   *  resolution reply back to the ASKER in the gate's run. */
  getGate(db: BusDb, gateId: number): BusDecisionGate | null;
  /** Re-wake the asker with a resolved gate's ruling (#158, shared at #161). ONE
   *  definition for the CLI resolve verb and the #161 UI resolve IPC — a gate
   *  carries no reply of its own, so this threads a `decision_gate` message to
   *  `asked_by` in the gate's run. Caller resolves FIRST and passes the pre-resolve
   *  gate row; never called on an idempotent replay. */
  sendGateResolutionRewake(
    db: BusDb,
    gate: BusDecisionGate,
    resolvedBy: string,
    ruling: string,
  ): void;
  /** Open gates addressed to `recipient` in a SINGLE run (#119) — the CLI's
   *  own-run resolution (`check --run <r>` / `gate list`). */
  openGatesForRecipient(db: BusDb, runId: string, recipient: string): BusDecisionGate[];
  /** Open gates addressed to `recipient` in ANY related run (#158) — the
   *  cross-run widening `check` (plain, own∪related) and the wake predicate use so
   *  an OPS→LEAD ruling gate opened in another run is visible to its recipient.
   *  The related-run set is computed with getRelatedRunIds, exactly like the lot
   *  half. */
  openGatesForRecipientInRuns(
    db: BusDb,
    runIds: readonly string[],
    recipient: string,
  ): BusDecisionGate[];
  /** The reader's related run set (own ∪ ancestors ∪ descendants) (#134/#158).
   *  `check` uses `.ids` to widen the gate lookup beyond the caller's own run. */
  getRelatedRunIds(db: BusDb, readerRunId: string): { ids: string[]; depth: Map<string, number> };
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
  /** #129 — mint a capability for the dispatch at `dispatchSeq`, returning the
   *  CLEAR token (printed once, never stored/logged). */
  mintCapability(
    db: BusDb,
    runId: string,
    dispatchSeq: number,
    recipient?: string | null,
  ): MintedCapability;
  /** #129 — is this clear token an ACTIVE capability for the run? Pure lookup. */
  verifyCapability(db: BusDb, runId: string, token: string): boolean;
  /** #167 — ROTATE-ON-RETRIEVE: re-mint the recipient's ACTIVE capability's clear
   *  token IN PLACE and return it, or null if the recipient has no active cap. The
   *  shipped surface a recipient uses to obtain a usable token (the clear token is
   *  never stored, so it cannot be re-read — only rotated). */
  rotateCapabilityForRecipient(db: BusDb, runId: string, recipient: string): string | null;
  /** Idempotent mutation wrapper (#130). Present so a `--request-id` retry of
   *  send/ack/gate-resolve short-circuits to the original receipt when the
   *  gating switch is ON, and merely COUNTS while it is OFF (coexistence). */
  withReceipt<T>(
    db: BusDb,
    input: {
      callerFingerprint: string;
      requestId: string;
      mutation: BusMutationKind;
      runId: string;
      switchOn: boolean;
    },
    exec: () => T,
  ): ReceiptOutcome<T>;
  /** The run's FROZEN gating flag for a mechanism (#118/#130). Reads the run
   *  row, never the live store. #130 gates receipts on the `receipts` switch
   *  (ledger #131 ruling D1 — a per-feature switch, not `delivery`). */
  busSwitch(db: BusDb, runId: string, mechanism: string): boolean;
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

// ─── mutation receipts (#130) ──────────────────────────────────────────────────

/**
 * The receipt-gating mechanism for #130 (ledger #131 §Decisions, ruling D1): a
 * NEW per-feature `receipts` switch, one per write-path v2 mechanism (#128
 * `fencing`, #129 `capability`, #130 `receipts`) — NOT the `delivery` switch, so
 * receipts flip independently of message delivery. #118 contract: frozen on the
 * run row at wave start, COUNTED-not-FIRED while OFF. While `receipts=OFF` a
 * retry is COUNTED but the mutation re-executes (v1); while ON, a retry short-
 * circuits to the original receipt. One constant names the mechanism.
 */
export const RECEIPT_SWITCH = 'receipts';

/**
 * The caller's stable fingerprint for a receipt key: the bus handle.
 *
 * The handle already identifies the caller uniquely on the bus (it is the
 * reader/sender key on the unique delivery index), so it is the natural
 * fingerprint. Kept in one function so the two vocabularies — "handle" on the
 * identity and "caller_fingerprint" on the receipt — meet in exactly one place.
 */
export function callerFingerprint(id: BusIdentity): string {
  return id.handle;
}

/**
 * Run a mutation through a receipt IF the caller supplied a `--request-id`,
 * otherwise run it bare (v1). Returns the mutation's receipt value either way.
 *
 * WHY OPTIONAL: existing callers (and every pre-#130 script) pass no request id,
 * and a receipt with no key is meaningless — so the receipt path engages ONLY
 * when the caller opts in with `--request-id`. That keeps the verbs' default
 * behaviour byte-identical to v1, which is the coexistence-safe direction and
 * what the switch-OFF arm asserts.
 */
function runMutationOutcome<T>(
  ctx: BusVerbCtx,
  requestId: string | null | undefined,
  mutation: BusMutationKind,
  exec: () => T,
): { value: T; replayed: boolean } {
  if (!requestId?.trim()) return { value: exec(), replayed: false };
  const switchOn = ctx.bus.busSwitch(ctx.db, ctx.id.runId, RECEIPT_SWITCH);
  const out = ctx.bus.withReceipt(
    ctx.db,
    {
      callerFingerprint: callerFingerprint(ctx.id),
      requestId: requestId.trim(),
      mutation,
      runId: ctx.id.runId,
      switchOn,
    },
    exec,
  );
  return { value: out.value, replayed: out.replayed };
}

/** The common case: just the receipt value. */
function runMutation<T>(
  ctx: BusVerbCtx,
  requestId: string | null | undefined,
  mutation: BusMutationKind,
  exec: () => T,
): T {
  return runMutationOutcome(ctx, requestId, mutation, exec).value;
}

// ─── send ───────────────────────────────────────────────────────────────────

export interface SendArgs {
  kind?: string;
  to?: string | null;
  thread?: string | null;
  body: string;
  /** #129 — the capability token a `worker_done` completion carries, minted by
   *  the dispatch it answers. Ignored for other kinds (a `status` may carry it
   *  for attribution but is never required to — #165). */
  cap?: string | null;
  /** #130: an idempotency key. A retry of `send` with the same `--request-id`
   *  from the same caller is a NO-OP returning the original sequence when the
   *  receipt switch is ON; absent, `send` behaves exactly as v1. */
  requestId?: string | null;
}

/** #129 — the completion kinds that a capability token gates. Only `worker_done`
 *  RESOLVES a dispatch; that is the single row a stale/absent token must not be
 *  able to forge. Every other kind carries NO capability and passes untokened:
 *  `dispatch` (mints the token), gates, questions, heartbeats, escalations,
 *  handoffs — and `status` (#165). `status` resolves no dispatch and is the
 *  fleet's highest-volume kind; most senders (LEAD, orchestrators, agents
 *  between dispatches) hold no token, so gating it made status unusable the
 *  moment `capability` flipped ON. A status FROM a token-holder MAY carry `--cap`
 *  for attribution, but it is never REQUIRED — an untokened status is accepted. */
export const CAPABILITY_COMPLETION_KINDS: readonly string[] = ['worker_done'];

/**
 * `orchestra send --type <kind> [--to <h>] [--thread <id>] [--cap <token>] <body...>`
 *
 * #129 capability tokens, two write-path hooks, both named:
 *
 *  - `--type dispatch`: after the row lands, MINT a `dcap_<32B>` for it (scoped
 *    to `--to`), store only its hash, and print the CLEAR token on a second line
 *    so the dispatcher can hand it to the worker. The token is NEVER in the
 *    message body, the log, or the pane (T129.2).
 *  - `--type worker_done` with `--cap <token>`: VERIFY the token. A stale token
 *    (superseded by a respawn, or from a failed dispatch) is COUNTED as a
 *    divergence always, and REJECTED only when the `capability` switch is ON
 *    (T129.1 / T129.3 COUNTED-not-FIRED). With the switch OFF the completion
 *    lands exactly as v1 — the old channel stays authoritative. `status` (#165)
 *    is NOT a completion — it resolves no dispatch, so it never enters this
 *    branch and passes untokened even under capability=ON.
 */
export function verbSend(ctx: BusVerbCtx, a: SendArgs): void {
  if (!a.kind) ctx.fail('usage: orchestra send --type <kind> [--to <handle>] [--thread <id>] [--cap <token>] [--request-id <id>] <body...>');
  // Validated HERE as well as in bus.send(), because the CLI can say what the
  // legal set IS. bus.send() refuses too — this is the message, not the guard.
  if (!BUS_KINDS.includes(a.kind!)) {
    ctx.fail(`orchestra send: unknown --type ${JSON.stringify(a.kind)} (one of: ${BUS_KINDS.join(', ')})`);
  }
  if (!a.body.trim()) ctx.fail('orchestra send: the message body is empty');

  // #129 — capability verification BEFORE the write, so a rejected (fired)
  // completion never lands at all. Independent of #128's fence: fencing gates on
  // the WRITER's coordinator generation, capability on the DISPATCH the
  // completion answers. Both may apply to one worker_done.
  //
  // FAIL-CLOSED (review F1): the gate is on the KIND, not on the presence of
  // --cap. The ticket says a completion "must carry" its token, so an ABSENT cap
  // is as invalid as a stale one — otherwise a hung worker bypasses the whole
  // mechanism by simply omitting the flag, which is the exact threat #129 exists
  // to stop. A missing token and a stale token therefore take the SAME path:
  // COUNTED always, REJECTED when the switch is ON. Only `worker_done` is a
  // completion (#165) — a `status` (or any other kind) skips this branch and is
  // accepted untokened even under capability=ON; a `--cap` on it is ignored.
  const cap = a.cap?.trim() || null;
  if (CAPABILITY_COMPLETION_KINDS.includes(a.kind!)) {
    const valid = cap !== null && ctx.bus.verifyCapability(ctx.db, ctx.id.runId, cap);
    if (!valid) {
      // COUNTED always (shadow counter moves in shadow mode) …
      ctx.countCapabilityReject?.();
      // … FIRED only when the `capability` switch is ON. OFF => fall through and
      // land the completion as v1 (coexistence: old channel authoritative).
      const fired = ctx.capabilityEnabled?.() === true;
      if (fired) {
        // Neutral wording (review F2): a rejected token may be a legitimate
        // completion whose dispatch was superseded by a newer dispatch to the
        // same recipient, not necessarily a "stale/hung" one. Name the two
        // real causes without accusing the sender.
        const why = cap === null
          ? 'no --cap token was presented, and a completion must carry the token minted by its dispatch'
          : 'the token is not an active capability — its dispatch was superseded by a newer dispatch to this recipient, or has been marked failed';
        ctx.fail(
          `orchestra send: ${a.kind} rejected — ${why}. The completion was NOT recorded.`,
        );
      }
    }
  }

  // Idempotency (#130) OUTERMOST, fencing (#128) INNER: a `--request-id` replay
  // short-circuits to the original sequence WITHOUT re-running the fence or the
  // write; a first call runs the fence + write as ONE transaction (a stale-
  // generation send is rejected with fencing ON, counted with it OFF, straight
  // write when no generation presented) and its sequence is what the receipt
  // stores. So a retried send is a no-op AND still respects the fence on its
  // first landing.
  const sent = runMutationOutcome(ctx, a.requestId, 'send', () =>
    fenced(ctx, 'send', () =>
      ctx.bus.send(ctx.db, {
        runId: ctx.id.runId,
        sender: ctx.id.handle,
        kind: a.kind as BusMessageKind,
        body: a.body,
        recipient: a.to ?? null,
        threadId: a.thread ?? null,
      }),
    ),
  );
  const seq = sent.value;

  // #129 — mint AFTER the dispatch row exists (the capability is keyed on its
  // sequence). The clear token goes to stdout only; the DB holds its hash.
  //
  // SEAM WITH #130 (receipts): a receipt REPLAY short-circuits the send WITHOUT
  // re-running it, so the dispatch row (and its capability) already exist from
  // the first call. Re-minting here would hit the (run_id, dispatch_seq) PK and
  // throw. So a replayed dispatch does NOT re-mint — it prints the original
  // sequence only. The clear token is unrecoverable (only its hash is stored),
  // which is correct: the dispatcher already received it on the first, non-replay
  // call; a retry that reprinted it would leak a token the caller already holds.
  if (a.kind === 'dispatch' && !sent.replayed) {
    const minted = ctx.bus.mintCapability(ctx.db, ctx.id.runId, seq, a.to ?? null);
    ctx.out(`${seq}\n${minted.token}\n`);
    return;
  }
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
  //
  // #158: WIDENED to the reader's related run set (own ∪ ancestors ∪
  // descendants), symmetric with the lot half. A gate opened in the ASKER's run
  // with THIS reader as recipient (an OPS→LEAD ruling ask) sits in a related run,
  // never the caller's own. The pre-#158 own-run-only lookup made every such gate
  // invisible to its recipient's `check` — no surface, no staleness (ledger #157
  // F-C5-1). The wake order names the gate's run so `check --run <gateRun>` also
  // resolves it directly; this widening makes a PLAIN `check` (own run) surface it
  // too, so a recipient that checks on its own initiative is not blind to it.
  const related = ctx.bus.getRelatedRunIds(ctx.db, ctx.id.runId);
  const gates = ctx.bus.openGatesForRecipientInRuns(ctx.db, related.ids, ctx.id.handle);
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

/** `orchestra ack <lot-id> [--request-id <id>]` — the accusé. */
export function verbAck(
  ctx: BusVerbCtx,
  lotIdRaw: string | undefined,
  requestId?: string | null,
): void {
  if (!lotIdRaw) ctx.fail('usage: orchestra ack <lot-id> [--request-id <id>]');
  const lotId = Number(lotIdRaw);
  if (!Number.isInteger(lotId) || lotId <= 0) {
    ctx.fail(`orchestra ack: ${JSON.stringify(lotIdRaw)} is not a lot id (an integer, printed by 'orchestra check')`);
  }
  // Idempotency (#130) OUTERMOST wraps the fence (#128): a `--request-id` replay
  // returns the stored ack result WITHOUT re-running the fence or the ack; a
  // first call runs the fence + ack as ONE transaction — a stale coordinator's
  // ack is refused with fencing ON, leaving acked_at unchanged (T128.1's "row
  // unchanged"), the ack never runs.
  const closed = runMutation(ctx, requestId, 'ack', () =>
    fenced(ctx, 'ack', () => ctx.bus.ack(ctx.db, ctx.id.runId, ctx.id.handle, lotId)),
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

// ─── token (#167) ─────────────────────────────────────────────────────────────

/**
 * `orchestra token` — retrieve THIS workspace's CURRENT active capability token.
 *
 * THE SURFACE the recipient uses (canary-6 F-C6-2). Before this, a dispatch's
 * token printed to the DISPATCHER's stdout only; a member that never received the
 * relay, or whose first token was superseded by a re-dispatch mid-task, had NO
 * shipped way to obtain a valid token, and its legitimate `worker_done` was
 * refused. `token` reads the ONE active capability addressed to the caller and
 * prints a usable clear token, so the member can `--cap` it on its completion.
 *
 * ROTATE-ON-RETRIEVE, not read-back: the clear token is never stored (T129.2), so
 * it cannot be re-read from the hash. `rotateCapabilityForRecipient` re-mints a
 * fresh token for the caller's active dispatch IN PLACE (new hash, same seq/state/
 * recipient) and returns the clear form. This does NOT touch supersession or
 * fencing — it only ever rotates an ALREADY-active cap's secret. The pre-rotate
 * token (e.g. a stale one from a superseded dispatch, or the dispatcher's copy)
 * stops verifying, which is exactly C1: an OLD token at `worker_done` stays
 * rejected + counted.
 *
 * No active capability → a non-zero refusal naming the absence, never a silent
 * empty print: a member that reads "" as a token would `--cap ` an empty string
 * and be rejected with a confusing message. The caller identity is the `--as`
 * handle (default $ORCHESTRA_WS_ID), the same recipient the dispatch addressed.
 */
export function verbToken(ctx: BusVerbCtx): void {
  const token = ctx.bus.rotateCapabilityForRecipient(ctx.db, ctx.id.runId, ctx.id.handle);
  if (token === null) {
    ctx.fail(
      `orchestra token: no active dispatch capability for ${ctx.id.handle} in run ${ctx.id.runId} ` +
        '(nothing was dispatched to you, or your dispatch has completed/been superseded). ' +
        'A completion needs a token minted by a live dispatch addressed to you.',
    );
  }
  ctx.out(`${token}\n`);
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
    // Pull --request-id (#130) BEFORE --resolution so its value is not mistaken
    // for the positional ruling tail.
    const req = pullFlag(rest, '--request-id');
    if (req.present && !req.value?.trim()) {
      ctx.fail('orchestra gate resolve: --request-id needs a value');
    }
    const res = pullFlag(req.rest, '--resolution');
    if (res.present && !res.value?.trim()) {
      ctx.fail('orchestra gate resolve: --resolution needs a ruling');
    }
    const positional = res.rest;
    const gateId = Number(positional[0]);
    if (!Number.isInteger(gateId) || gateId <= 0) {
      ctx.fail('usage: orchestra gate resolve <gate-id> --resolution <ruling...> [--request-id <id>]');
    }
    // Prefer --resolution; fall back to the positional tail so the pre-#119
    // `gate resolve <id> <ruling...>` form keeps working.
    const ruling = (res.present ? res.value! : positional.slice(1).join(' ')).trim();
    if (!ruling) ctx.fail('orchestra gate resolve: the ruling is empty');
    // Idempotency (#130) OUTERMOST wraps the fence (#128): a `--request-id`
    // replay returns the stored resolve result WITHOUT re-running the fence or
    // the resolve; a first call runs the fence + resolve as ONE transaction — a
    // superseded coordinator cannot resolve with fencing ON, the resolution never
    // runs and the gate's resolution stays unchanged.
    // Read the gate BEFORE resolving so we know the ASKER and the gate's run for
    // the resolution reply (#158 arm 4). Reading after would race an idempotent
    // replay path; the gate row's asked_by/run_id are immutable once opened.
    const gateBefore = ctx.bus.getGate(ctx.db, gateId);
    const ok = runMutation(ctx, req.value, 'gate_resolve', () =>
      fenced(ctx, 'gate-resolve', () =>
        ctx.bus.resolveGate(ctx.db, gateId, ctx.id.handle, ruling),
      ),
    );
    if (!ok) {
      ctx.fail(
        `orchestra gate resolve: gate ${gateId} is not open (already resolved, or unknown id) — ` +
          'the first ruling stands and was NOT overwritten',
      );
    }
    // #158 arm 4: re-wake the ASKER with the resolution. A gate carries no reply
    // message (unlike a `question`, whose answer threads back and wakes the asker
    // — T119.1), so pre-#158 a resolved gate left its opener idle with no signal;
    // for a CROSS-RUN gate the opener was never woken at all. Route the resolution
    // as a threaded message to `asked_by` IN THE GATE'S RUN (where the opener
    // authored it, so it lands in the opener's own-run lot), threaded to the gate
    // id. The normal lot wake path (own ∪ related, #134/#144) then delivers it —
    // one mechanism for both shapes. Sent only on the resolving call, never on an
    // idempotent replay (which returns without re-running this block).
    if (gateBefore && gateBefore.asked_by) {
      ctx.bus.sendGateResolutionRewake(ctx.db, gateBefore, ctx.id.handle, ruling);
    }
    ctx.out(`resolved ${gateId}\n`);
    return;
  }
  if (sub === 'list') {
    // #158 (F-R158-1): WIDENED to the caller's related run set, exactly like the
    // `check` gate surface. A gate opened in the ASKER's run addressed to this
    // caller (an OPS→LEAD ruling ask) sits in a related run, never the caller's
    // own — so an own-run `gate list` was blind to the same cross-run gate the
    // ticket makes visible to `check`. Same helper, same related set.
    const related = ctx.bus.getRelatedRunIds(ctx.db, ctx.id.runId);
    const gates = ctx.bus.openGatesForRecipientInRuns(ctx.db, related.ids, ctx.id.handle);
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

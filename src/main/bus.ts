// The fleet bus — one SQLite database per ORCHESTRA_HOME holding every fleet
// message in total order. See docs/adr/0002-fleet-bus-sqlite-source-of-truth.md
// (the bus is the SOURCE OF TRUTH; the GitHub ledger is a projection) and
// docs/codebase-map/bus.md for the design decisions behind this file.
//
// Schema and delivery model lifted from stablyai/orca (MIT): `messages.sequence`
// AUTOINCREMENT as the total order, and a `deliveries` row guarded by a unique
// partial index giving exactly ONE outstanding lot per reader. Vocabulary is
// CONTEXT.md's (Lot / Relève / Accusé / Ruling); ruling Q13 on #108 puts English
// in code and the CLI, so the exported verbs are send/check/ack/openGate/
// resolveGate.
//
// SCOPE (#114): this module and a boot-time open, nothing else. No CLI verbs, no
// wake, no UI, no shadow mirror — those are #115–#121. Opening the DB changes
// nothing for any agent.

import path from 'node:path';
import type Database from 'better-sqlite3';
import { loadDatabaseCtor } from './bus-binding.ts';
import { orchestraHome } from './platform/index.ts';
import { decideFence } from '../shared/bus-fencing.ts';

/** A live connection to the bus. */
export type BusDb = Database;

/**
 * FENCING (#128). A write carrying a coordinator generation OLDER than the run's
 * current generation is rejected with THIS typed error — not a bare `Error`, so
 * a caller can catch fencing specifically (`err instanceof StaleGenerationError`)
 * and distinguish "you are a superseded coordinator" from every other write
 * failure. T128.1 requires the refusal to be TYPED: an untyped throw would force
 * callers to string-match the message, which is the exact brittleness the ADR's
 * source-of-truth guarantee cannot rest on.
 */
export class StaleGenerationError extends Error {
  /** Discriminant that survives a structured-clone / IPC boundary where the
   *  prototype chain does not — `err.name === 'StaleGenerationError'` still works. */
  readonly name = 'StaleGenerationError';
  /** The run whose generation was violated. */
  readonly runId: string;
  /** The generation the caller presented. */
  readonly presented: number;
  /** The run's current (authoritative) generation. */
  readonly current: number;
  // Explicit field assignment, NOT constructor parameter properties: the
  // `node --test --experimental-strip-types` runner rejects parameter properties
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), and every bus test imports this file.
  constructor(runId: string, presented: number, current: number) {
    super(
      `bus: stale coordinator generation for run ${JSON.stringify(runId)} — ` +
        `write presented generation ${presented}, but the run is at ${current}. ` +
        `A newer coordinator has superseded this one; the write was REFUSED.`,
    );
    this.runId = runId;
    this.presented = presented;
    this.current = current;
  }
}

/** The message kinds the bus carries (#108 round 3, Q12 v1 adoption set). */
export type BusMessageKind =
  | 'status'
  | 'dispatch'
  | 'worker_done'
  | 'escalation'
  | 'handoff'
  | 'decision_gate'
  | 'question'
  | 'heartbeat';

const MESSAGE_KINDS: readonly BusMessageKind[] = [
  'status',
  'dispatch',
  'worker_done',
  'escalation',
  'handoff',
  'decision_gate',
  'question',
  'heartbeat',
];

/** One row of `messages`, as `check()` hands it to a reader. */
export interface BusMessage {
  sequence: number;
  run_id: string;
  thread_id: string | null;
  sender: string;
  recipient: string | null;
  kind: BusMessageKind;
  body: string;
  created_at: number;
}

/** One row of `deliveries` — a lot handed to one reader, outstanding until acked. */
export interface BusDelivery {
  id: number;
  run_id: string;
  reader: string;
  from_seq: number;
  to_seq: number;
  taken_at: number;
  acked_at: number | null;
}

/** What a relève returns. `replay: true` means this lot was already outstanding. */
export interface BusLot {
  delivery: BusDelivery | null;
  replay: boolean;
  messages: BusMessage[];
}

export interface BusDecisionGate {
  id: number;
  run_id: string;
  asked_by: string;
  question: string;
  opened_at: number;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  /** Who this gate is addressed to (#119, MIGRATIONS[4]). NULL for a gate opened
   *  before #119 or addressed to no one in particular — such a gate wakes nobody
   *  (the pending predicate matches on an exact recipient), which is the
   *  coexistence-safe direction. */
  recipient: string | null;
}

// ─── Schema ─────────────────────────────────────────────────────────────────

/** Bumped by appending a migration to MIGRATIONS; never edit a shipped one. */
export const SCHEMA_VERSION = 5;

/**
 * Forward-only migrations, indexed by the version they PRODUCE. `migrate()`
 * applies every entry above the DB's current `schema_version` in order, so a DB
 * written by an older Orchestra upgrades in place and a DB written by a NEWER
 * one is left alone (a downgrade is refused rather than silently corrupted).
 */
/**
 * EXPORTED for the C11 gate only (ledger #123): a test that replays the chain to
 * an intermediate version must run the SHIPPED SQL. A hand-copied migration body
 * in the test file would certify the copy, and would keep passing after the real
 * one changed. Nothing in production reads this map directly — go through
 * {@link migrate}.
 */
export const MIGRATIONS: Record<number, string> = {
  1: `
    -- NOT YET WRITTEN BY ANYTHING, AND DELIBERATELY UNCONSTRAINED IN v1.
    -- No verb in #114 creates a run, and messages.run_id carries NO
    -- REFERENCES runs(id) -- so a foreign_keys pragma reading back 1 is inert
    -- here, and send() will accept a run_id that was never declared. That is
    -- intentional for this ticket (the run lifecycle is #115) but it is a real
    -- gap, not an oversight: until #115 lands, a mistyped run_id silently
    -- creates a parallel universe of messages no reader is checking. Add the FK
    -- WITH the writer, not before -- a REFERENCES against a table nothing
    -- populates would reject every send() the CLI makes today.
    CREATE TABLE IF NOT EXISTS runs (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,          -- 'mission' | 'vague' (CONTEXT.md)
      coordinator   TEXT NOT NULL,          -- handle of the LEAD / OPS
      parent_run_id TEXT,                   -- nested runs: a vague inside a mission
      title         TEXT,
      created_at    INTEGER NOT NULL,
      closed_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      -- AUTOINCREMENT, not a bare INTEGER PRIMARY KEY: a plain rowid alias can
      -- REUSE the id of a deleted row, which would silently reorder the bus.
      -- AUTOINCREMENT is what makes the sequence a monotone TOTAL ORDER.
      sequence   INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT NOT NULL,
      thread_id  TEXT,
      sender     TEXT NOT NULL,
      recipient  TEXT,
      kind       TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, sequence);

    CREATE TABLE IF NOT EXISTS deliveries (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id   TEXT NOT NULL,
      reader   TEXT NOT NULL,
      from_seq INTEGER NOT NULL,   -- exclusive lower bound, frozen at take time
      to_seq   INTEGER NOT NULL,   -- inclusive upper bound of the lot
      taken_at INTEGER NOT NULL,
      acked_at INTEGER             -- NULL => outstanding
    );
    -- THE correctness primitive (spike #109 arm 2b measured it load-bearing):
    -- at most ONE outstanding lot per (run, reader). Without it a second check
    -- opens a second lot and a killed reader's lot is silently skipped past.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_outstanding
      ON deliveries(run_id, reader) WHERE acked_at IS NULL;

    -- The durable cursor is advanced ONLY by ack(), never at take time.
    CREATE TABLE IF NOT EXISTS cursors (
      run_id    TEXT NOT NULL,
      reader    TEXT NOT NULL,
      acked_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, reader)
    );

    CREATE TABLE IF NOT EXISTS decision_gates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      TEXT NOT NULL,
      asked_by    TEXT NOT NULL,
      question    TEXT NOT NULL,
      opened_at   INTEGER NOT NULL,
      resolution  TEXT,
      resolved_by TEXT,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_gates_open
      ON decision_gates(run_id) WHERE resolved_at IS NULL;
  `,
  2: `
    -- SHADOW MIRROR (#116). Every send on an OLD, still-authoritative channel
    -- also lands as a messages row; THIS table records what the old channel
    -- actually did with that same send, so the two can be compared.
    --
    -- Separate table rather than a column on messages, deliberately: messages
    -- is the bus's own total order and will outlive shadow mode, whereas every
    -- column here is scaffolding that gets DROPPED when the last mechanism is
    -- promoted (ADR 0002: "the old channel is removed two waves after
    -- promotion"). Keeping the temporary shape out of the permanent table is
    -- what makes that removal a DROP TABLE instead of a migration.
    CREATE TABLE IF NOT EXISTS mirror_records (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT NOT NULL,
      mechanism  TEXT NOT NULL,     -- 'peer-message' (shared/bus-mirror.ts)
      send_id    TEXT NOT NULL,     -- one id per SEND, minted by the host
      sequence   INTEGER,           -- the messages.sequence mirrored, NULL if the insert failed
      outcome    TEXT NOT NULL,     -- 'live' | 'inbox' | 'withdrawn' (the OLD channel's fate)
      sender     TEXT NOT NULL,
      recipient  TEXT,
      created_at INTEGER NOT NULL
    );
    -- The duplicate detector's primitive. NOT a unique index: a duplicate must
    -- be RECORDABLE, not refused -- refusing it at the DB would make the
    -- divergence counter structurally unable to ever leave zero, which is the
    -- exact "counter that never moves" this ticket's T116.4 calls a disproof.
    CREATE INDEX IF NOT EXISTS idx_mirror_send ON mirror_records(run_id, send_id);
    CREATE INDEX IF NOT EXISTS idx_mirror_mechanism ON mirror_records(run_id, mechanism, id);
  `,
  // #118 — the per-mechanism switch snapshot FROZEN at wave start.
  //
  // A SIDECAR TABLE, not `ALTER TABLE runs ADD COLUMN`: SQLite has no
  // `ADD COLUMN IF NOT EXISTS`, so a re-run throws `duplicate column name` and
  // any caller that swallows it is also swallowing every real DDL failure.
  //
  // SLOT NUMBERING (ledger #123 §Open-questions Q-B1): wave B has four tickets
  // that each need DDL, and `migrate()` applies BY VERSION INDEX — so two
  // tickets both claiming a number means the second one's SQL is skipped forever
  // on any DB already stamped it, silently. OPS-B's ruling: write the next free
  // number and RENUMBER AT REBASE. #116 merged first and took `2` (mirror_records
  // above); per OPS-B2's rebase instruction this block is renumbered `2 -> 3` and
  // SCHEMA_VERSION bumped 2 -> 3, SQL body untouched. #116's merged `2` is never
  // edited. C11 asserts run_flags survives migrate() from v1 AND the merged v2.
  3: `
    CREATE TABLE IF NOT EXISTS run_flags (
      run_id     TEXT PRIMARY KEY,
      -- JSON object, one boolean per mechanism. Not a bitmask: a bitmask
      -- silently reassigns meaning when the mechanism list grows, and this
      -- string is read back by builds that know more mechanisms than the
      -- writer did. See src/shared/bus-switches.ts.
      flags      TEXT NOT NULL,
      frozen_at  INTEGER NOT NULL
    );
  `,
  // #119 — decision gates get a RECIPIENT so a wake can be addressed and `check`
  // can surface it. Wave B ruling D2 (ledger #123) deliberately left gates out of
  // the #117 wake predicate because they had no recipient and no surfacing verb;
  // this column and the `openGatesForRecipient` read below are what let #119 put
  // "open gate addressed to the reader" back into the pending predicate.
  //
  // ALTER TABLE ADD COLUMN, not a table rebuild: it is a single metadata change,
  // and every pre-existing gate row reads back `recipient = NULL` (SQLite fills
  // the new column with NULL for existing rows) — which matches BusDecisionGate's
  // `recipient: string | null` and wakes nobody, the coexistence-safe direction.
  // There is NO `ADD COLUMN IF NOT EXISTS`, but that is fine here precisely
  // because migrate() applies each MIGRATIONS index EXACTLY ONCE per DB (guarded
  // by user_version), so this never runs twice against the same file.
  //
  // SLOT NUMBERING (ledger #125 §Briefing, inherited Q-B1 rule): the next free
  // index after master's 3. Only #119 needs a migration this wave (#120 confirmed
  // it reuses existing kinds). If a sibling migration lands on 4 first, RENUMBER
  // this to the next free integer at rebase and bump SCHEMA_VERSION with it —
  // never edit a merged migration.
  4: `
    ALTER TABLE decision_gates ADD COLUMN recipient TEXT;
    CREATE INDEX IF NOT EXISTS idx_gates_recipient
      ON decision_gates(run_id, recipient) WHERE resolved_at IS NULL;
  `,
  // #128 — FENCING: every run carries a monotone `coordinator_generation`. An
  // OPS respawn BUMPS it (bumpCoordinatorGeneration), and a send/ack/gate-resolve
  // carrying an OLDER generation is REJECTED (assertCoordinatorGeneration →
  // StaleGenerationError). This formalizes what waves B/C did by hand (an
  // OPS-B → OPS-B2 recovery had to be trusted to stop writing manually).
  //
  // ALTER TABLE ADD COLUMN with a NOT NULL DEFAULT 0: SQLite backfills every
  // EXISTING run row with 0 (a constant default is legal for ADD COLUMN, unlike
  // a non-constant one). A pre-#128 run therefore reads generation 0, and the
  // FIRST bump takes it to 1 — the coexistence-safe direction: an un-bumped run
  // fences nobody (a caller at 0 is never < 0). There is no `ADD COLUMN IF NOT
  // EXISTS`, but migrate() applies each index EXACTLY ONCE per DB (guarded by
  // user_version), so this never runs twice against the same file.
  //
  // SLOT NUMBERING (ledger #131 §Seams, inherited Q-B1 rule): the next free
  // index after master's 4. The schema trio #128 → #129 → #130 serializes on
  // MIGRATIONS; each RENUMBERS to the next free integer at rebase and bumps
  // SCHEMA_VERSION with it — never edit a merged migration. If a sibling lands on
  // 5 first, renumber this to 6 (etc.) at rebase.
  5: `
    ALTER TABLE runs ADD COLUMN coordinator_generation INTEGER NOT NULL DEFAULT 0;

    -- The COUNTED-not-FIRED shadow trail. While the \`fencing\` switch is OFF a
    -- stale-generation write is NOT rejected (the old channel stays
    -- authoritative) — instead ONE row lands here recording that the write WOULD
    -- have been fenced. This is what makes the switch-off state OBSERVABLE (C5):
    -- an OFF fencing switch with a growing fence_events count is measurably
    -- different from a build with no fencing at all. Deliberately NOT a
    -- main-memory counter like #116/#117: those events happen in-process, but a
    -- fenced write happens in the CLI's OWN bus connection (the five verbs write
    -- the DB directly), so the only place a CLI-side count survives to the pane
    -- is the bus itself. No unique index: a duplicate stale write must be
    -- RECORDABLE, not refused, or the counter could never leave zero.
    CREATE TABLE IF NOT EXISTS fence_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT NOT NULL,
      verb       TEXT NOT NULL,   -- 'send' | 'ack' | 'gate-resolve'
      presented  INTEGER NOT NULL,
      current    INTEGER NOT NULL,
      fired      INTEGER NOT NULL, -- 1 = write rejected (switch ON); 0 = counted only (switch OFF)
      actor      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fence_events_run ON fence_events(run_id, id);
  `,
};

// ─── open() — the ONE place PRAGMAs are set ─────────────────────────────────

export interface OpenOptions {
  /**
   * Milliseconds SQLite waits for a lock before returning SQLITE_BUSY.
   * Spike #109 condition 1: this is MANDATORY on every connection, read-only
   * ones included — without it, 10 concurrent writers lose 7–27% of inserts
   * with no error the caller would notice. It lives here and nowhere else
   * precisely so no call site can forget it.
   * Set to 0 ONLY by the must-FAIL control arm of scripts/verify-bus-contention.mjs.
   */
  busyTimeoutMs?: number;
  readonly?: boolean;
}

/** `<ORCHESTRA_HOME>/bus.sqlite` — one DB per home (#108 ruling Q3). */
export function busPath(): string {
  return path.join(orchestraHome(), 'bus.sqlite');
}

/**
 * Open a connection to the bus with the PRAGMA set the spike measured.
 *
 * WAL so readers never block on the writer (spike arm 1: 0 read-BUSY across
 * 452–492 reads during a 10-writer run) and so CLI writers can land messages
 * while the app holds the DB open.
 */
export function open(file: string = busPath(), opts: OpenOptions = {}): BusDb {
  // Resolved lazily, not at module load: importing bus.ts must never be able to
  // throw an ABI error, because the whole point is that the CONSTRUCTOR is the
  // gate. See bus-binding.ts.
  const Ctor = loadDatabaseCtor();
  const db = new Ctor(file, { readonly: !!opts.readonly }) as BusDb;
  // A readonly connection cannot CHANGE the journal mode; setting WAL on it is
  // both unnecessary and an error on a fresh file, so only writers set it.
  if (!opts.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  return db;
}

/** The version currently stored in the DB (0 for a fresh file). */
export function schemaVersion(db: BusDb): number {
  const row = db.pragma('user_version', { simple: true });
  return Number(row) || 0;
}

/**
 * Apply every migration above the DB's current version. Returns the version the
 * DB is at afterwards. Idempotent, and safe to call from N processes at once —
 * each migration runs inside a transaction, and busy_timeout covers the lock.
 */
export function migrate(db: BusDb): number {
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) {
    // A newer Orchestra wrote this file. Refuse rather than run an older
    // schema's expectations against it.
    throw new Error(
      `bus: database schema v${current} is newer than this build supports (v${SCHEMA_VERSION}) — upgrade Orchestra`,
    );
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) throw new Error(`bus: no migration to produce schema v${v}`);
    db.exec(`BEGIN IMMEDIATE; ${sql}; PRAGMA user_version = ${v}; COMMIT;`);
  }
  return schemaVersion(db);
}

/** open() + migrate() — the single call the app boot and every rig uses. */
export function openBus(file: string = busPath(), opts: OpenOptions = {}): BusDb {
  const db = open(file, opts);
  migrate(db);
  return db;
}

// ─── Verbs ──────────────────────────────────────────────────────────────────

export interface SendInput {
  runId: string;
  sender: string;
  kind: BusMessageKind;
  body: string;
  recipient?: string | null;
  threadId?: string | null;
}

/**
 * Append a message. Returns its `sequence` — its position in the total order.
 *
 * Validated at the WRITE boundary, not at read time: an unknown `kind` reaching
 * the table would be invisible to every reader that switches on the eight known
 * kinds, and no downstream check could tell it from a legitimate row.
 */
export function send(db: BusDb, input: SendInput): number {
  if (!MESSAGE_KINDS.includes(input.kind)) {
    throw new Error(`bus.send: unknown message kind ${JSON.stringify(input.kind)}`);
  }
  // Trim-then-check: '' was already refused, but '   ' was accepted, so a
  // whitespace handle became a distinct reader no relève would ever match.
  if (!input.runId?.trim()) throw new Error('bus.send: runId is required');
  if (!input.sender?.trim()) throw new Error('bus.send: sender is required');
  const info = db
    .prepare(
      `INSERT INTO messages (run_id, thread_id, sender, recipient, kind, body, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      input.runId,
      input.threadId ?? null,
      input.sender,
      input.recipient ?? null,
      input.kind,
      input.body,
      Date.now(),
    );
  return Number(info.lastInsertRowid);
}

/**
 * Relève: hand `reader` its pending lot for `runId`.
 *
 * If a lot is already outstanding it is REPLAYED — the same `from_seq`/`to_seq`,
 * so the same messages, byte for byte. Messages that arrived while the lot was
 * outstanding are deliberately NOT folded in: a reader that crashed mid-lot gets
 * back exactly what it was handed, which is what makes redelivery safe (spike
 * #109 arm 2).
 *
 * The cursor is NOT advanced here. Advancing at take time is the naive design
 * the spike's must-FAIL control used, and it permanently loses a SIGKILLed
 * reader's lot.
 *
 * BEGIN IMMEDIATE (better-sqlite3's `db.transaction(...).immediate()`) so the
 * write lock is taken up front — a deferred transaction that upgrades mid-flight
 * is the classic SQLITE_BUSY-on-upgrade source.
 */
export function check(db: BusDb, runId: string, reader: string, limit = 100): BusLot {
  const getOutstanding = db.prepare(
    'SELECT * FROM deliveries WHERE run_id=? AND reader=? AND acked_at IS NULL',
  );
  const getCursor = db.prepare('SELECT acked_seq FROM cursors WHERE run_id=? AND reader=?');
  const rowsInRange = db.prepare(
    'SELECT * FROM messages WHERE run_id=? AND sequence>? AND sequence<=? ORDER BY sequence',
  );
  const rowsAfter = db.prepare(
    'SELECT * FROM messages WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?',
  );
  const insertDelivery = db.prepare(
    'INSERT INTO deliveries (run_id, reader, from_seq, to_seq, taken_at) VALUES (?,?,?,?,?)',
  );

  const tx = db.transaction((): BusLot => {
    const out = getOutstanding.get(runId, reader) as BusDelivery | undefined;
    if (out) {
      return {
        delivery: out,
        replay: true,
        messages: rowsInRange.all(runId, out.from_seq, out.to_seq) as BusMessage[],
      };
    }
    const cur = getCursor.get(runId, reader) as { acked_seq: number } | undefined;
    const from = cur ? cur.acked_seq : 0;
    const messages = rowsAfter.all(runId, from, limit) as BusMessage[];
    if (messages.length === 0) return { delivery: null, replay: false, messages: [] };
    const to = messages[messages.length - 1].sequence;
    const taken_at = Date.now();
    const id = Number(insertDelivery.run(runId, reader, from, to, taken_at).lastInsertRowid);
    return {
      delivery: { id, run_id: runId, reader, from_seq: from, to_seq: to, taken_at, acked_at: null },
      replay: false,
      messages,
    };
  });
  return tx.immediate();
}

/**
 * Accusé: the reader confirms it has read lot `lotId`, closing it and advancing
 * the durable cursor past it. Returns true if this call closed an outstanding
 * lot, false if there was nothing to close (already acked, or not this reader's).
 *
 * The ack belongs to the READER (#108 round-4 hardening 1) — nothing in the app
 * may ack on a reader's behalf, which is why this takes the reader's handle and
 * refuses a lot belonging to anyone else.
 */
export function ack(db: BusDb, runId: string, reader: string, lotId: number): boolean {
  const close = db.prepare(
    'UPDATE deliveries SET acked_at=? WHERE id=? AND run_id=? AND reader=? AND acked_at IS NULL',
  );
  const get = db.prepare('SELECT * FROM deliveries WHERE id=?');
  const bump = db.prepare(`
    INSERT INTO cursors (run_id, reader, acked_seq) VALUES (?,?,?)
    ON CONFLICT(run_id, reader) DO UPDATE SET acked_seq=MAX(acked_seq, excluded.acked_seq)
  `);
  const tx = db.transaction((): boolean => {
    const row = get.get(lotId) as BusDelivery | undefined;
    if (!row) return false;
    const changed = close.run(Date.now(), lotId, runId, reader).changes;
    if (changed === 0) return false;
    // MAX() so an out-of-order ack of an older lot can never rewind the cursor
    // and re-deliver messages the reader already acked.
    bump.run(runId, reader, row.to_seq);
    return true;
  });
  return tx.immediate();
}

/**
 * Open a decision gate — a question parked on the bus awaiting a Ruling.
 *
 * `recipient` (#119) is who the gate is addressed to; the wake predicate matches
 * on it exactly, so an open gate wakes that reader until it is resolved. NULL (a
 * gate addressed to no one, or opened by a pre-#119 caller) wakes nobody — the
 * coexistence-safe direction, and what the D2 baseline arm in
 * bus-wake-sweep.test.ts asserts.
 */
export function openGate(
  db: BusDb,
  runId: string,
  askedBy: string,
  question: string,
  recipient: string | null = null,
): number {
  const info = db
    .prepare(
      'INSERT INTO decision_gates (run_id, asked_by, question, opened_at, recipient) VALUES (?,?,?,?,?)',
    )
    .run(runId, askedBy, question, Date.now(), recipient ?? null);
  return Number(info.lastInsertRowid);
}

/**
 * Resolve a gate with a Ruling. Returns true if this call resolved an OPEN gate.
 *
 * A gate resolves exactly once: a second resolve returns false and leaves the
 * first resolution intact, so two agents racing to record the human's answer
 * cannot overwrite each other.
 */
export function resolveGate(
  db: BusDb,
  gateId: number,
  resolvedBy: string,
  resolution: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE decision_gates SET resolution=?, resolved_by=?, resolved_at=?
       WHERE id=? AND resolved_at IS NULL`,
    )
    .run(resolution, resolvedBy, Date.now(), gateId);
  return info.changes > 0;
}

/** Read one gate back (null when the id is unknown). */
export function getGate(db: BusDb, gateId: number): BusDecisionGate | null {
  return (db.prepare('SELECT * FROM decision_gates WHERE id=?').get(gateId) as
    | BusDecisionGate
    | undefined) ?? null;
}

/** Every gate of a run still awaiting a Ruling, oldest first. */
export function openGates(db: BusDb, runId: string): BusDecisionGate[] {
  return db
    .prepare(
      'SELECT * FROM decision_gates WHERE run_id=? AND resolved_at IS NULL ORDER BY opened_at, id',
    )
    .all(runId) as BusDecisionGate[];
}

/**
 * Open gates of a run addressed to `recipient`, oldest first (#119).
 *
 * The read behind both the wake predicate ("is this reader gate-pending") and
 * `check`'s gate surface ("show the woken reader the gate it was woken for").
 * Matches on the EXACT recipient — a NULL-recipient gate is addressed to nobody
 * and never appears here, so it wakes nobody, which is what keeps a pre-#119 gate
 * (recipient NULL after the migration backfill) from waking the whole fleet.
 */
export function openGatesForRecipient(
  db: BusDb,
  runId: string,
  recipient: string,
): BusDecisionGate[] {
  return db
    .prepare(
      `SELECT * FROM decision_gates
        WHERE run_id=? AND recipient=? AND resolved_at IS NULL
        ORDER BY opened_at, id`,
    )
    .all(runId, recipient) as BusDecisionGate[];
}

// ─── Fencing: coordinator generation (#128) ─────────────────────────────────

/**
 * The run's current coordinator generation. 0 for a run with no `runs` row (the
 * generation column lives on that row) OR a run that has never been bumped — both
 * read 0, which is the coexistence-safe floor: no caller can present a generation
 * BELOW 0, so an un-bumped run fences nobody.
 *
 * Read from `runs`, not `run_flags`: the generation is a property of the run's
 * coordinator lineage, not of the switch snapshot. An unknown run returns 0
 * rather than throwing — a fencing check on a run that does not exist yet must
 * not itself become a write failure (D1 shape: the mechanism degrades to inert).
 */
export function coordinatorGeneration(db: BusDb, runId: string): number {
  const row = db
    .prepare('SELECT coordinator_generation AS g FROM runs WHERE id=?')
    .get(runId) as { g: number } | undefined;
  return row ? Number(row.g) : 0;
}

/**
 * BUMP the run's coordinator generation (an OPS respawn calls this). Returns the
 * NEW generation. Formalizes the manual OPS-B → OPS-B2 handover: the moment a new
 * coordinator takes over, it bumps, and every write the OLD coordinator still has
 * in flight (carrying the pre-bump generation) is fenced out.
 *
 * Refuses a run with no `runs` row: you cannot fence a run nobody has started, and
 * a silent no-op here would let a respawn THINK it superseded the old coordinator
 * while every stale write kept landing. The caller (an OPS lifecycle) must have a
 * run row — created by startRun (#118) — before it can bump.
 *
 * `+1` inside one IMMEDIATE transaction so two racing respawns cannot both read N
 * and both write N+1 (which would leave two live coordinators at the same
 * generation, the exact split fencing exists to prevent).
 */
export function bumpCoordinatorGeneration(db: BusDb, runId: string): number {
  const tx = db.transaction((): number => {
    const info = db
      .prepare(
        'UPDATE runs SET coordinator_generation = coordinator_generation + 1 WHERE id=?',
      )
      .run(runId);
    if (info.changes === 0) {
      throw new Error(
        `bus.bumpCoordinatorGeneration: run ${JSON.stringify(runId)} has no runs row — ` +
          'start the run before bumping its coordinator generation',
      );
    }
    return coordinatorGeneration(db, runId);
  });
  return tx.immediate();
}

/**
 * THE FENCE. Assert that a write presenting `presented` is at or above the run's
 * current generation. Throws {@link StaleGenerationError} otherwise, and does NOT
 * touch any row — the caller's write must be conditioned on this returning.
 *
 * `presented === undefined | null` means the caller did not opt into fencing (the
 * v1 unfenced write path, and the shadow default while the switch is OFF). Such a
 * write is NEVER fenced — coexistence: an old-channel write carries no generation
 * and must keep working. Only a caller that presents a generation can be fenced,
 * and it is fenced only when strictly BELOW the current one (equal is the live
 * coordinator itself; above is impossible without a bump it performed).
 */
export function assertCoordinatorGeneration(
  db: BusDb,
  runId: string,
  presented: number | null | undefined,
): void {
  if (presented === null || presented === undefined) return;
  const current = coordinatorGeneration(db, runId);
  if (presented < current) {
    throw new StaleGenerationError(runId, presented, current);
  }
}

/** One `fence_events` row — the COUNTED-not-FIRED shadow trail (#128). */
export interface BusFenceEvent {
  id: number;
  run_id: string;
  verb: string;
  presented: number;
  current: number;
  /** 1 = the write was REJECTED (switch ON); 0 = counted only (switch OFF). */
  fired: number;
  actor: string;
  created_at: number;
}

export interface FenceEventInput {
  runId: string;
  verb: string;
  presented: number;
  current: number;
  fired: boolean;
  actor: string;
}

/**
 * Record ONE would-have-fenced (or did-fence) event. Called on every stale write
 * — both when counted (switch OFF, write proceeds) and when fired (switch ON,
 * write rejected) — so the pane can show the divergence in either state. A write
 * that is NOT stale records nothing.
 */
export function recordFenceEvent(db: BusDb, input: FenceEventInput): number {
  const info = db
    .prepare(
      `INSERT INTO fence_events (run_id, verb, presented, current, fired, actor, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      input.runId,
      input.verb,
      input.presented,
      input.current,
      input.fired ? 1 : 0,
      input.actor,
      Date.now(),
    );
  return Number(info.lastInsertRowid);
}

/** Every fence event of a run, oldest first — the pane's read. */
export function fenceEvents(db: BusDb, runId: string): BusFenceEvent[] {
  return db
    .prepare('SELECT * FROM fence_events WHERE run_id=? ORDER BY id')
    .all(runId) as BusFenceEvent[];
}

/**
 * How many fence events a run has recorded, split by whether they FIRED (write
 * rejected, switch ON) or were merely COUNTED (write proceeded, switch OFF). The
 * pane and bus-status read this to make the switch-off state observable (C5).
 */
export function fenceEventCounts(
  db: BusDb,
  runId: string,
): { counted: number; fired: number } {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN fired=0 THEN 1 ELSE 0 END) AS counted,
         SUM(CASE WHEN fired=1 THEN 1 ELSE 0 END) AS fired
       FROM fence_events WHERE run_id=?`,
    )
    .get(runId) as { counted: number | null; fired: number | null };
  return { counted: Number(row.counted ?? 0), fired: Number(row.fired ?? 0) };
}

export interface FencedWriteInput {
  runId: string;
  /** Which mutation this is, for the shadow trail: 'send' | 'ack' | 'gate-resolve'. */
  verb: string;
  /** The generation the caller presented; null/undefined = the unfenced v1 path. */
  presented: number | null | undefined;
  /** The frozen `fencing` switch for this run (read via busSwitch in the caller,
   *  which owns the bus-runs import — passed in so bus.ts stays cycle-free). */
  fencingOn: boolean;
  /** Who is writing, for the shadow trail. */
  actor: string;
}

/**
 * THE FENCE, applied around a write, honouring the coexistence switch.
 *
 * Reads the run's current generation, decides with the PURE {@link decideFence},
 * and:
 *   - 'pass'   → runs `write` (if given) and returns.
 *   - 'count'  → records a `fence_events` row with `fired=0`, then STILL runs
 *                `write` (switch OFF, old channel authoritative — COUNTED, not
 *                FIRED).
 *   - 'reject' → records a `fence_events` row with `fired=1` and THROWS
 *                {@link StaleGenerationError}; `write` never runs.
 *
 * ATOMICITY (review F1, ledger #131). The read-decide and the write MUST be one
 * transaction, or a generation bump landing between them lets a superseded
 * coordinator write (the TOCTOU window: `fencedWrite` reads gen G, a respawn bumps
 * to G+1, the write then lands under the stale gen). So the SHIPPED path passes
 * its write as the `write` closure and the whole read-decide-write runs inside ONE
 * `db.transaction(...).immediate()`: IMMEDIATE takes the write lock up front, so no
 * other connection can bump the generation between the read and the write. The
 * inner `send`/`ack`/`resolveGate` open their own IMMEDIATE tx — better-sqlite3
 * nests that as a SAVEPOINT under the outer one, which is correct (the outer lock
 * is already held). A caller with no atomicity need (the direct-call unit tests,
 * and the read-only pane) may omit `write`; it then fences-only, unchanged.
 *
 * Keeping the decision here (not in send/ack/resolveGate) means those primitives
 * stay usable by unfenced callers, and the switch is read exactly once per write
 * at the boundary that owns it. The `fencing` boolean is injected rather than
 * read here because busSwitch lives in bus-runs.ts, which imports bus.ts — taking
 * the dependency the other way would be a cycle.
 */
export function fencedWrite<T = void>(
  db: BusDb,
  input: FencedWriteInput,
  write?: () => T,
): T | undefined {
  const run = (): T | undefined => {
    if (input.presented !== null && input.presented !== undefined) {
      const current = coordinatorGeneration(db, input.runId);
      const decision = decideFence({
        presented: input.presented,
        current,
        fencingOn: input.fencingOn,
      });
      if (decision !== 'pass') {
        recordFenceEvent(db, {
          runId: input.runId,
          verb: input.verb,
          presented: input.presented,
          current,
          fired: decision === 'reject',
          actor: input.actor,
        });
        if (decision === 'reject') {
          // Throws INSIDE the transaction → better-sqlite3 rolls it back, so the
          // fence_events row is NOT persisted on a rejection that aborts. To keep
          // the FIRED shadow trail durable we record it in its own committed
          // statement before re-throwing (see the catch below).
          throw new StaleGenerationError(input.runId, input.presented, current);
        }
      }
    }
    return write ? write() : undefined;
  };

  if (!write) {
    // Fence-only (unit tests, pane). No enclosing write to serialize with, so no
    // transaction — recordFenceEvent + throw behave exactly as before.
    return run();
  }

  // The SHIPPED path: read-decide-write as ONE IMMEDIATE transaction (F1).
  try {
    return db.transaction(run).immediate();
  } catch (err) {
    if (err instanceof StaleGenerationError) {
      // The rejection rolled back the transaction, discarding the fence_events
      // row written inside it. Re-record it in an autonomous statement so the
      // shadow trail (the COUNTED/FIRED observable) survives the rollback.
      recordFenceEvent(db, {
        runId: err.runId,
        verb: input.verb,
        presented: err.presented,
        current: err.current,
        fired: true,
        actor: input.actor,
      });
    }
    throw err;
  }
}

// ─── Shadow mirror (#116) ───────────────────────────────────────────────────

/** One `mirror_records` row — what the OLD channel did with a send the bus
 *  shadowed. `sequence` is NULL when the messages insert itself failed. */
export interface BusMirrorRecord {
  id: number;
  run_id: string;
  mechanism: string;
  send_id: string;
  sequence: number | null;
  outcome: string;
  sender: string;
  recipient: string | null;
  created_at: number;
}

export interface MirrorRecordInput {
  runId: string;
  mechanism: string;
  sendId: string;
  sequence: number | null;
  outcome: string;
  sender: string;
  recipient?: string | null;
}

/** Record what the old channel did with one shadowed send. */
export function recordMirror(db: BusDb, input: MirrorRecordInput): number {
  const info = db
    .prepare(
      `INSERT INTO mirror_records
         (run_id, mechanism, send_id, sequence, outcome, sender, recipient, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.runId,
      input.mechanism,
      input.sendId,
      input.sequence,
      input.outcome,
      input.sender,
      input.recipient ?? null,
      Date.now(),
    );
  return Number(info.lastInsertRowid);
}

/** How many bus `messages` rows exist for one shadowed send.
 *
 *  Counted from mirror_records rather than from messages because a message body
 *  is not unique — two agents can legitimately send identical text — so only the
 *  host-minted `send_id` can tell "mirrored twice" from "sent twice". */
export function mirroredRowCount(db: BusDb, runId: string, sendId: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM mirror_records WHERE run_id=? AND send_id=? AND sequence IS NOT NULL',
    )
    .get(runId, sendId) as { n: number };
  return Number(row.n);
}

/** Every mirror record of a run, oldest first — the pane's and bus-status's read. */
export function mirrorRecords(db: BusDb, runId: string): BusMirrorRecord[] {
  return db
    .prepare('SELECT * FROM mirror_records WHERE run_id=? ORDER BY id')
    .all(runId) as BusMirrorRecord[];
}

// ─── Boot ───────────────────────────────────────────────────────────────────

let booted: BusDb | null = null;

/**
 * Open the bus at app boot. Returns the schema version it reached.
 *
 * THE BOOT GATE (#114 acceptance 1). This CONSTRUCTS a Database — `require()`
 * alone is not a gate. better-sqlite3 defers the native binding load until the
 * first `new Database()`, so under the WRONG ABI a bare require SUCCEEDS and
 * returns a plausible false pass. Measured on this machine while implementing
 * #114: under system node (ABI 127) with the Electron (ABI 130) build present,
 * `require('better-sqlite3')` printed OK and `new Database(':memory:')` threw
 * `NODE_MODULE_VERSION 130 … requires 127`. That asymmetry is why the log line
 * below is emitted only after a real open + migrate.
 */
export function initBus(): number {
  if (booted) return schemaVersion(booted);
  booted = openBus();
  return schemaVersion(booted);
}

/** The boot connection, or null before initBus()/after closeBus(). */
export function getBus(): BusDb | null {
  return booted;
}

export function closeBus(): void {
  if (!booted) return;
  try {
    booted.close();
  } finally {
    booted = null;
  }
}

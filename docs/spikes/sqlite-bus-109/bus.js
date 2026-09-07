'use strict'
// Spike #109 — shared bus helpers. THROWAWAY. Never imported by src/.
// Schema modelled on stablyai/orca (MIT): messages.sequence AUTOINCREMENT = total
// order; deliveries with a unique partial index = ONE outstanding batch per consumer.
// ABI SELECTION (arm 5). node and Electron have DIFFERENT ABIs here (127 vs 130)
// and a .node built for one is UNUSABLE under the other. Two traps this encodes:
//  1) better-sqlite3 defers the native load until the first `new Database()`, so a
//     bare require() SUCCEEDS under both and proves nothing. Only constructing a
//     DB tests an ABI. (This produced a false "node can load it" pass once.)
//  2) Arm 5 runs Electron and node CONCURRENTLY, so we must NOT swap a shared
//     file in place — each runtime loads its own binary directly, no mutation.
const path = require('path')
const fs = require('fs')
const abiDir = path.join(__dirname, 'abi')
const abiFile = path.join(
  abiDir,
  `better_sqlite3-${process.versions.modules === '130' ? 'electron-abi130' : 'node-abi127'}.node`,
)
const pkgDir = path.join(
  __dirname,
  'node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3',
)
let Database
if (fs.existsSync(abiFile)) {
  // Load the JS wrapper but hand it OUR per-ABI binding, bypassing `bindings`.
  Database = require(path.join(pkgDir, 'lib/database.js'))
  const bindingPath = abiFile
  const orig = Database
  Database = function (file, opts) { return new orig(file, { ...opts, nativeBinding: bindingPath }) }
  Database.prototype = orig.prototype
} else {
  Database = require('better-sqlite3')
}

/**
 * @param {string} file
 * @param {{busyTimeout?: number|null, readonly?: boolean}} opts
 *   busyTimeout: null => DO NOT set it (negative-control arm; SQLite's default is 0ms).
 */
function open(file, opts = {}) {
  const db = new Database(file, { readonly: !!opts.readonly })
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  if (opts.busyTimeout !== null) db.pragma(`busy_timeout = ${opts.busyTimeout ?? 5000}`)
  else db.pragma('busy_timeout = 0') // explicit: the control must actually have no wait
  return db
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      sequence   INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT NOT NULL,
      sender     TEXT NOT NULL,
      kind       TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id, sequence);

    CREATE TABLE IF NOT EXISTS deliveries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      TEXT NOT NULL,
      consumer    TEXT NOT NULL,
      from_seq    INTEGER NOT NULL,   -- exclusive lower bound at take time
      to_seq      INTEGER NOT NULL,   -- inclusive upper bound of the batch
      taken_at    INTEGER NOT NULL,
      acked_at    INTEGER             -- NULL => outstanding
    );
    -- THE correctness primitive: at most ONE outstanding batch per (run, consumer).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_outstanding
      ON deliveries(run_id, consumer) WHERE acked_at IS NULL;

    CREATE TABLE IF NOT EXISTS cursors (
      run_id   TEXT NOT NULL,
      consumer TEXT NOT NULL,
      acked_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, consumer)
    );
  `)
  return db
}

/** Append a message. Returns its sequence. */
function makeInsert(db) {
  const stmt = db.prepare(
    'INSERT INTO messages (run_id, sender, kind, body, created_at) VALUES (?,?,?,?,?)',
  )
  return (runId, sender, kind, body) =>
    Number(stmt.run(runId, sender, kind, body, Date.now()).lastInsertRowid)
}

/**
 * check(): return the outstanding batch if one exists (REPLAY — same ids, byte for
 * byte), else claim a new batch of up to `limit` rows above the acked cursor.
 * IMMEDIATE so the write lock is taken up front — a deferred txn that upgrades
 * mid-flight is the classic SQLITE_BUSY-on-upgrade source.
 */
function makeCheck(db, { limit = 100 } = {}) {
  const getOutstanding = db.prepare(
    'SELECT * FROM deliveries WHERE run_id=? AND consumer=? AND acked_at IS NULL',
  )
  const getCursor = db.prepare('SELECT acked_seq FROM cursors WHERE run_id=? AND consumer=?')
  const rowsIn = db.prepare(
    'SELECT * FROM messages WHERE run_id=? AND sequence>? AND sequence<=? ORDER BY sequence',
  )
  const rowsAfter = db.prepare(
    'SELECT * FROM messages WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?',
  )
  const insertDelivery = db.prepare(
    'INSERT INTO deliveries (run_id, consumer, from_seq, to_seq, taken_at) VALUES (?,?,?,?,?)',
  )

  return db.transaction((runId, consumer) => {
    const out = getOutstanding.get(runId, consumer)
    if (out) {
      // REPLAY: identical batch, no new rows folded in, regardless of arrivals since.
      return { delivery: out, replay: true, rows: rowsIn.all(runId, out.from_seq, out.to_seq) }
    }
    const cur = getCursor.get(runId, consumer)
    const from = cur ? cur.acked_seq : 0
    const rows = rowsAfter.all(runId, from, limit)
    if (rows.length === 0) return { delivery: null, replay: false, rows: [] }
    const to = rows[rows.length - 1].sequence
    const id = Number(insertDelivery.run(runId, consumer, from, to, Date.now()).lastInsertRowid)
    return { delivery: { id, run_id: runId, consumer, from_seq: from, to_seq: to }, replay: false, rows }
  })
}

/** ack(): close the outstanding batch and advance the durable cursor. */
function makeAck(db) {
  const close = db.prepare('UPDATE deliveries SET acked_at=? WHERE id=? AND acked_at IS NULL')
  const bump = db.prepare(`
    INSERT INTO cursors (run_id, consumer, acked_seq) VALUES (?,?,?)
    ON CONFLICT(run_id, consumer) DO UPDATE SET acked_seq=MAX(acked_seq, excluded.acked_seq)
  `)
  return db.transaction((runId, consumer, deliveryId, toSeq) => {
    const r = close.run(Date.now(), deliveryId)
    bump.run(runId, consumer, toSeq)
    return r.changes
  })
}

/**
 * NAIVE consumer — the must-FAIL control for arm 2. No deliveries table, no
 * outstanding index: it advances the cursor at TAKE time. A crash between take
 * and processing LOSES the batch (rows never re-delivered).
 */
function makeNaiveCheck(db, { limit = 100 } = {}) {
  const getCursor = db.prepare('SELECT acked_seq FROM cursors WHERE run_id=? AND consumer=?')
  const rowsAfter = db.prepare(
    'SELECT * FROM messages WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?',
  )
  const bump = db.prepare(`
    INSERT INTO cursors (run_id, consumer, acked_seq) VALUES (?,?,?)
    ON CONFLICT(run_id, consumer) DO UPDATE SET acked_seq=excluded.acked_seq
  `)
  return db.transaction((runId, consumer) => {
    const cur = getCursor.get(runId, consumer)
    const from = cur ? cur.acked_seq : 0
    const rows = rowsAfter.all(runId, from, limit)
    if (rows.length) bump.run(runId, consumer, rows[rows.length - 1].sequence)
    return { rows }
  })
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b)
  const r = (x) => (x == null ? null : Math.round(x * 1000) / 1000)
  return {
    n: s.length,
    min: r(s[0]),
    p50: r(percentile(s, 50)),
    p95: r(percentile(s, 95)),
    p99: r(percentile(s, 99)),
    max: r(s[s.length - 1]),
    mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  }
}

module.exports = { open, migrate, makeInsert, makeCheck, makeAck, makeNaiveCheck, stats }

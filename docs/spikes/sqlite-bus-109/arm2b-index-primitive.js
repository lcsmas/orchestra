'use strict'
// ARM 2b — is the unique partial index actually LOAD-BEARING?
// Arm 2 shows the safe impl behaves correctly, but its check() could be correct
// for a different reason (it reads the outstanding row first). This arm probes
// the index DIRECTLY: try to insert a SECOND outstanding delivery for the same
// (run, consumer) and require the DB to REFUSE it.
//   must-FAIL control: same insert on a table built WITHOUT the index -> accepted.
// If both are accepted, the index is decoration and the design has no primitive.
const fs = require('fs')
const path = require('path')
const { open, migrate } = require('./bus')

const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })

function probe(withIndex) {
  const file = path.join(OUT, `arm2b-${withIndex ? 'indexed' : 'noindex'}.db`)
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true })
  const db = open(file, { busyTimeout: 5000 })
  if (withIndex) migrate(db)
  else {
    db.exec(`CREATE TABLE deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, consumer TEXT NOT NULL,
      from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, taken_at INTEGER NOT NULL,
      acked_at INTEGER);`)
  }
  const ins = db.prepare(
    'INSERT INTO deliveries (run_id, consumer, from_seq, to_seq, taken_at) VALUES (?,?,?,?,?)',
  )
  const first = ins.run('run1', 'ops', 0, 5, Date.now()).lastInsertRowid
  let secondAccepted, err = null
  try { ins.run('run1', 'ops', 5, 9, Date.now()); secondAccepted = true }
  catch (e) { secondAccepted = false; err = e.code }

  // Positive control on the SAME index: a DIFFERENT consumer must still be allowed,
  // and an ACKED first batch must free the slot. An index that refuses everything
  // would also produce "secondAccepted:false" — that must not pass as success.
  let otherConsumerAllowed, afterAckAllowed
  try { ins.run('run1', 'other', 0, 5, Date.now()); otherConsumerAllowed = true }
  catch { otherConsumerAllowed = false }
  db.prepare('UPDATE deliveries SET acked_at=? WHERE id=?').run(Date.now(), first)
  try { ins.run('run1', 'ops', 5, 9, Date.now()); afterAckAllowed = true }
  catch { afterAckAllowed = false }

  const outstanding = db.prepare(
    "SELECT COUNT(*) c FROM deliveries WHERE acked_at IS NULL AND run_id='run1' AND consumer='ops'",
  ).get().c
  db.close()
  return { withIndex, secondOutstandingAccepted: secondAccepted, errorCode: err,
    otherConsumerAllowed, allowedAgainAfterAck: afterAckAllowed, outstandingForOpsAtEnd: outstanding }
}

const indexed = probe(true)
const noindex = probe(false)
const report = {
  arm: 'arm2b-unique-partial-index',
  date: new Date().toISOString(),
  rig: { node: process.version, platform: `${process.platform}/${process.arch}`,
    sqlite: open(':memory:').prepare('select sqlite_version() v').get().v },
  mustPass: indexed,
  mustFail: noindex,
  controlValid: noindex.secondOutstandingAccepted === true,
  verdict:
    indexed.secondOutstandingAccepted === false &&
    indexed.errorCode === 'SQLITE_CONSTRAINT_UNIQUE' &&
    indexed.otherConsumerAllowed === true &&   // not refusing everything
    indexed.allowedAgainAfterAck === true &&   // ack frees the slot
    indexed.outstandingForOpsAtEnd === 1
      ? 'PASS' : 'FAIL',
}
console.log(JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(OUT, 'arm2b.json'), JSON.stringify(report, null, 2))

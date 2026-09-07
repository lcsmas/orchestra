'use strict'
// A short-lived CLI writer — the `orchestra` CLI shape: open, N inserts, exit.
// argv: <dbfile> <writerId> <nInserts> <busyTimeoutMs|none>
const { open, makeInsert } = require('./bus')

const [file, writerId, nStr, btStr] = process.argv.slice(2)
const n = Number(nStr)
const busyTimeout = btStr === 'none' ? null : Number(btStr)

const t0 = process.hrtime.bigint()
const db = open(file, { busyTimeout })
const openMs = Number(process.hrtime.bigint() - t0) / 1e6

const insert = makeInsert(db)
const lat = []
let busy = 0
let otherErr = 0
let ok = 0
const seqs = []

for (let i = 0; i < n; i++) {
  const s = process.hrtime.bigint()
  try {
    seqs.push(insert('run1', writerId, 'note', `${writerId}:${i}`))
    ok++
  } catch (e) {
    if (String(e.code || '').startsWith('SQLITE_BUSY')) busy++
    else otherErr++
  }
  lat.push(Number(process.hrtime.bigint() - s) / 1e6)
}
db.close()
process.stdout.write(
  JSON.stringify({ writerId, attempted: n, ok, busy, otherErr, openMs, lat, seqs }) + '\n',
)

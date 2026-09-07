'use strict'
// The long-lived process (Electron main simulation): holds the DB open for the
// whole run and reads continuously, so the writers contend against a real
// concurrent reader rather than an idle file.
// argv: <dbfile> <busyTimeoutMs|none>
const { open } = require('./bus')

const [file, btStr] = process.argv.slice(2)
const db = open(file, { busyTimeout: btStr === 'none' ? null : Number(btStr) })
const count = db.prepare('SELECT COUNT(*) c, MAX(sequence) m FROM messages')
let reads = 0
let readBusy = 0
let last = { c: 0, m: null }

const t = setInterval(() => {
  try { last = count.get(); reads++ } catch (e) {
    if (String(e.code || '').startsWith('SQLITE_BUSY')) readBusy++
  }
}, 1)

function bye() {
  clearInterval(t)
  process.stdout.write(JSON.stringify({ reads, readBusy, lastSeen: last }) + '\n')
  try { db.close() } catch {}
  process.exit(0)
}
process.on('SIGTERM', bye)
process.on('SIGINT', bye)

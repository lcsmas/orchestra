'use strict'
// A CLI writer that commits N rows, then OPENS a transaction, writes M rows
// inside it, and parks — waiting to be SIGKILLed mid-transaction.
// It prints the committed high-water mark BEFORE parking so the harness knows
// exactly what durability to demand (rather than inferring it after the fact).
// argv: <dbfile> <committedCount> <uncommittedCount> <stateFile>
const { open, migrate, makeInsert } = require('./bus')

const [file, cStr, uStr] = process.argv.slice(2)
const db = open(file, { busyTimeout: 5000 })
migrate(db)
const insert = makeInsert(db)

const committed = []
for (let i = 0; i < Number(cStr); i++) committed.push(insert('run1', 'cli', 'note', `committed${i}`))

// Now go inside an explicit transaction and DO NOT commit.
db.exec('BEGIN IMMEDIATE')
const uncommitted = []
for (let i = 0; i < Number(uStr); i++) uncommitted.push(insert('run1', 'cli', 'note', `dirty${i}`))

// Report via a FILE, not stdout: the harness is synchronous (it must be, to kill
// at a controlled instant), so it can never drain an async pipe. Written
// atomically (tmp+rename) so a partial read is impossible.
const out = process.argv[5]
require('fs').writeFileSync(out + '.tmp', JSON.stringify({ committed, uncommitted, pid: process.pid }))
require('fs').renameSync(out + '.tmp', out)
// Park forever, holding the write txn open, until SIGKILLed.
setInterval(() => {}, 1000)

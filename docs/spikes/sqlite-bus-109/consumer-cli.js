'use strict'
// A short-lived consumer CLI. Takes a batch, prints it, then either acks, or
// SIGKILLs ITSELF before acking (the crash arm — a real SIGKILL, not a
// simulated one, so nothing in-process gets a chance to clean up).
// argv: <dbfile> <consumer> <mode: ack|crash|takeonly> <impl: safe|naive>
const { open, migrate, makeCheck, makeAck, makeNaiveCheck } = require('./bus')

const [file, consumer, mode, impl = 'safe'] = process.argv.slice(2)
const db = open(file, { busyTimeout: 5000 })
migrate(db)

if (impl === 'naive') {
  const check = makeNaiveCheck(db)
  const { rows } = check('run1', consumer)
  process.stdout.write(JSON.stringify({ impl, mode, ids: rows.map((r) => r.sequence) }) + '\n')
  if (mode === 'crash') { try { process.kill(process.pid, 'SIGKILL') } catch {} }
  process.exit(0)
}

const check = makeCheck(db)
const ack = makeAck(db)
const res = check('run1', consumer)
process.stdout.write(
  JSON.stringify({
    impl, mode,
    replay: res.replay,
    deliveryId: res.delivery ? res.delivery.id : null,
    ids: res.rows.map((r) => r.sequence),
  }) + '\n',
)

if (mode === 'crash') {
  // Batch taken, delivery row committed, NOT acked. Die hard.
  process.kill(process.pid, 'SIGKILL')
} else if (mode === 'ack' && res.delivery) {
  ack('run1', consumer, res.delivery.id, res.delivery.to_seq)
}
process.exit(0)

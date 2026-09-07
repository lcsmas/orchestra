'use strict'
// ARM 2 — ack-replay correctness across a SIGKILLed consumer.
//
// Sequence, each step a SEPARATE short-lived process (real CLI shape):
//   seed 5 msgs -> C1 takes batch, SIGKILL before ack
//                -> 3 MORE msgs arrive while the batch is outstanding
//                -> C2 check MUST return the SAME ids (replay), NOT the new ones
//                -> C2 acks
//                -> C3 check MUST return ONLY the 3 newer rows
//
// must-PASS : impl=safe  (deliveries + unique partial index)
// must-FAIL : impl=naive (cursor advanced at take time) -> the killed batch is
//             LOST: the next check skips straight past it.
// The naive arm is what makes this rig capable of failing.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { open, migrate, makeInsert } = require('./bus')

const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })

function consumer(file, name, mode, impl) {
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'consumer-cli.js'), file, name, mode, impl],
    { encoding: 'utf8' },
  )
  const line = r.stdout.trim().split('\n').filter(Boolean).pop()
  return {
    ...(line ? JSON.parse(line) : { ids: null }),
    signal: r.signal, // must be 'SIGKILL' on the crash arm — proof the kill happened
    status: r.status,
  }
}

function runArm(impl) {
  const file = path.join(OUT, `arm2-${impl}.db`)
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true })
  const db = migrate(open(file, { busyTimeout: 5000 }))
  const insert = makeInsert(db)
  const seeded = []
  for (let i = 0; i < 5; i++) seeded.push(insert('run1', 'lead', 'note', `seed${i}`))

  // 1) take a batch, then die before acking
  const crashed = consumer(file, 'ops', 'crash', impl)

  // 2) more traffic arrives while the batch is outstanding
  const later = []
  for (let i = 0; i < 3; i++) later.push(insert('run1', 'lead', 'note', `later${i}`))
  db.close()

  // 3) next check — MUST replay the same batch (safe) / skips it (naive)
  const afterCrash = consumer(file, 'ops', 'ack', impl)

  // 4) check after ack — MUST return only the newer rows
  const afterAck = consumer(file, 'ops', 'ack', impl)

  const db2 = open(file, { busyTimeout: 5000 })
  const outstanding = db2
    .prepare('SELECT COUNT(*) c FROM deliveries WHERE acked_at IS NULL')
    .get().c
  db2.close()

  const same = JSON.stringify(afterCrash.ids) === JSON.stringify(crashed.ids)
  // THE OBSERVABLE THAT DISCRIMINATES: count only what reached a consumer process
  // that SURVIVED to process it. The crashed process "received" its batch and then
  // died — counting that as delivered makes the naive arm look correct, which is
  // exactly the vacuous metric this rig exists to avoid. Delivery means: handed to
  // a run that lived long enough to act on it.
  const deliveredToSurvivor = new Set([...(afterCrash.ids || []), ...(afterAck.ids || [])])
  const allSeen = [...seeded, ...later].every((s) => deliveredToSurvivor.has(s))

  return {
    impl,
    seeded, later,
    killSignal: crashed.signal,
    batchTakenThenKilled: crashed.ids,
    checkAfterCrash: afterCrash.ids,
    replayFlag: afterCrash.replay,
    replayedSameIds: same,
    checkAfterAck: afterAck.ids,
    outstandingDeliveriesAtEnd: outstanding,
    everyMessageDeliveredToASurvivingConsumer: allSeen,
    lostMessages: [...seeded, ...later].filter((s) => !deliveredToSurvivor.has(s)),
  }
}

const safe = runArm('safe')
const naive = runArm('naive')

const report = {
  arm: 'arm2-ack-replay',
  date: new Date().toISOString(),
  rig: {
    node: process.version, platform: `${process.platform}/${process.arch}`,
    sqlite: open(':memory:').prepare('select sqlite_version() v').get().v,
    betterSqlite3: require('better-sqlite3/package.json').version,
  },
  mustPass: safe,
  mustFail: naive,
  // the rig can only be trusted if the kill really happened and the naive arm really lost data
  killWasReal: safe.killSignal === 'SIGKILL' && naive.killSignal === 'SIGKILL',
  controlValid: naive.lostMessages.length > 0,
  verdict:
    safe.replayedSameIds &&
    safe.lostMessages.length === 0 &&
    safe.outstandingDeliveriesAtEnd === 0 &&
    JSON.stringify(safe.checkAfterAck) === JSON.stringify(safe.later)
      ? 'PASS' : 'FAIL',
}
console.log(JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(OUT, 'arm2.json'), JSON.stringify(report, null, 2))

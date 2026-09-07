'use strict'
// ARM 4b — does fs.watch on -wal actually fire CROSS-PROCESS?
// Arm 4 armed the watcher in the SAME process that did the insert. inotify is a
// kernel facility so it should not matter, but "should not matter" is not a
// measurement: if it did matter, arm 4's headline number would be an in-process
// artifact and the whole wake design would rest on it. Here the writer is a
// SEPARATE short-lived CLI process (the real topology).
//   must-FAIL control: the same watcher while the writer inserts into a
//   DIFFERENT database -> no wake for our file.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { open, migrate, makeInsert, stats } = require('./bus')

const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const SAMPLES = Number(process.env.SAMPLES || 100)

async function measure({ writeElsewhere }) {
  const file = path.join(OUT, `arm4b-${writeElsewhere ? 'control-otherdb' : 'crossproc'}.db`)
  const other = path.join(OUT, 'arm4b-otherdb.db')
  for (const f of [file, other]) for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true })
  migrate(open(file, { busyTimeout: 5000 })).close()
  const seed = open(file, { busyTimeout: 5000 })
  makeInsert(seed)('run1', 'lead', 'note', 'warmup') // create -wal
  seed.close()
  migrate(open(other, { busyTimeout: 5000 })).close()
  makeInsert(open(other, { busyTimeout: 5000 }))('run1', 'lead', 'note', 'warmup')

  const readDb = open(file, { busyTimeout: 5000 })
  const maxSeq = readDb.prepare('SELECT MAX(sequence) m FROM messages')
  const samples = []
  let timeouts = 0
  const target = () => maxSeq.get().m

  for (let i = 0; i < SAMPLES; i++) {
    const before = target()
    let bell = null
    const w = fs.watch(file + '-wal', () => { if (bell) bell() })
    const seen = new Promise((resolve) => {
      let done = false
      bell = () => {
        if (done) return
        if (target() <= before) return // woken but row not visible — not a wake
        done = true; resolve(Number(process.hrtime.bigint()))
      }
      setTimeout(() => { if (!done) { done = true; timeouts++; resolve(null) } }, 2000)
    })
    await new Promise((r) => setTimeout(r, 10))

    const t0 = Number(process.hrtime.bigint())
    // a REAL separate CLI process does the insert
    spawnSync(process.execPath, [path.join(__dirname, 'writer-cli.js'),
      writeElsewhere ? other : file, `x${i}`, '1', '5000'], { encoding: 'utf8' })
    const t1 = await seen
    w.close()
    if (t1 !== null) samples.push((t1 - t0) / 1e6)
  }
  readDb.close()
  return { mode: writeElsewhere ? 'control-writes-to-OTHER-db' : 'cross-process',
    samples: samples.length, timeouts, latencyMs: stats(samples) }
}

;(async () => {
  const crossproc = await measure({ writeElsewhere: false })
  const control = await measure({ writeElsewhere: true })
  const report = {
    arm: 'arm4b-crossprocess-fswatch',
    date: new Date().toISOString(),
    rig: { node: process.version, platform: `${process.platform}/${process.arch}`,
      samplesPerMode: SAMPLES,
      note: 'writer is a separate short-lived CLI process; latency INCLUDES node process spawn' },
    mustPass: crossproc,
    mustFailControl: control,
    controlValid: control.samples === 0,
    verdict: crossproc.samples === SAMPLES ? 'PASS' : 'FAIL',
  }
  console.log(JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(OUT, 'arm4b.json'), JSON.stringify(report, null, 2))
})()

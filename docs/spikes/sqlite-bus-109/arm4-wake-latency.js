'use strict'
// ARM 4 — insert-to-wake latency for the cheapest cross-process wake primitive.
// The long-lived process must NOT poll hot; #108 requires a push wake that
// TRIGGERS A SESSION TURN and is level-triggered from durable state.
//
// Candidates, 100 samples each:
//   fswatch  — fs.watch on the -wal file (no extra process, no extra socket)
//   socket   — a unix-socket "bell": writer connects and sends 1 byte, no content
//   poll250  — a 250ms setInterval doing the check query (the baseline to beat)
//
// The measured quantity is deliberately END-TO-END and observed on the WAKER'S
// side: t0 is taken by the writer immediately BEFORE COMMIT, t1 when the waiter
// has actually SEEN THE ROW via a query. A wake that fires before the row is
// visible is not a wake — so this cannot be gamed by a notification that
// arrives early. Both timestamps come from the same clock domain (one process
// tree, Date.now()/hrtime on the same host).
//
// must-FAIL control: a waiter armed on a file NOBODY writes must record ZERO
// wakes and time out. Without it, "fswatch is fast" could just be the harness
// measuring its own setTimeout.
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { open, migrate, makeInsert, stats } = require('./bus')

const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const SAMPLES = Number(process.env.SAMPLES || 100)
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

async function measure(mode, { deadFile = false } = {}) {
  const file = path.join(OUT, `arm4-${mode}${deadFile ? '-deadcontrol' : ''}.db`)
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true })
  const sock = file + '.sock'
  fs.rmSync(sock, { force: true })
  const db = migrate(open(file, { busyTimeout: 5000 }))
  const insert = makeInsert(db)
  // force the -wal file to exist so fs.watch has something to bind to
  insert('run1', 'lead', 'note', 'warmup')

  const readDb = open(file, { busyTimeout: 5000 })
  const maxSeq = readDb.prepare('SELECT MAX(sequence) m FROM messages')

  const samples = []
  let timeouts = 0
  let target = maxSeq.get().m

  // ---- arm the waiter ----
  let waiter = null, bell = null, server = null
  const watchPath = deadFile ? file + '.nobody-writes-this' : file + '-wal'
  if (deadFile) fs.writeFileSync(watchPath, 'x')

  if (mode === 'fswatch') {
    waiter = fs.watch(watchPath, () => { if (bell) bell() })
  } else if (mode === 'socket') {
    server = net.createServer((c) => { c.on('data', () => { if (bell) bell() }); c.resume() })
    await new Promise((r) => server.listen(sock, r))
  }

  for (let i = 0; i < SAMPLES; i++) {
    // Wait for the wake, then confirm the ROW IS VISIBLE. Resolve only then.
    const seen = new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        const m = maxSeq.get().m
        if (m == null || m <= target) return   // woken but row not visible yet — keep waiting
        done = true
        resolve(Number(process.hrtime.bigint()))
      }
      bell = finish
      if (mode === 'poll250') {
        const iv = setInterval(() => { finish(); if (done) clearInterval(iv) }, 250)
      }
      // hard bound so a dead primitive cannot hang the arm forever
      setTimeout(() => { if (!done) { done = true; timeouts++; resolve(null) } }, 3000)
    })

    await sleepMs(5) // let the waiter settle before the write
    const t0 = Number(process.hrtime.bigint())
    const seq = insert('run1', 'lead', 'note', `m${i}`)   // commits here
    if (mode === 'socket' && !deadFile) {
      await new Promise((r) => {
        const c = net.connect(sock, () => { c.write('1'); c.end(); r() })
        c.on('error', r)
      })
    }
    target = seq - 1
    const t1 = await seen
    if (t1 !== null) samples.push((t1 - t0) / 1e6)
    target = seq
  }

  if (waiter) waiter.close()
  if (server) await new Promise((r) => server.close(r))
  fs.rmSync(sock, { force: true })
  readDb.close(); db.close()
  return { mode: deadFile ? `${mode}-DEADCONTROL` : mode, samples: samples.length, timeouts,
    latencyMs: stats(samples) }
}

;(async () => {
  const fswatch = await measure('fswatch')
  const socket = await measure('socket')
  const poll250 = await measure('poll250')
  // must-FAIL control: watcher armed on a file nobody ever writes
  const dead = await measure('fswatch', { deadFile: true })

  const report = {
    arm: 'arm4-wake-latency',
    date: new Date().toISOString(),
    rig: { node: process.version, platform: `${process.platform}/${process.arch}`,
      sqlite: open(':memory:').prepare('select sqlite_version() v').get().v,
      samplesPerMode: SAMPLES,
      measures: 'commit(t0) -> waiter has QUERIED AND SEEN the row(t1), same clock domain' },
    results: { fswatch, socket, poll250 },
    mustFailControl: dead,
    controlValid: dead.samples === 0 && dead.timeouts === SAMPLES,
    verdict: fswatch.samples === SAMPLES && socket.samples === SAMPLES ? 'PASS' : 'FAIL',
  }
  console.log(JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(OUT, 'arm4.json'), JSON.stringify(report, null, 2))
})()

'use strict'
// ARM 1 — write contention: 10 concurrent short-lived CLI writers x 100 inserts
// each, against a long-lived reader (Electron-main simulation) polling hot.
//
// Controls:
//   must-PASS : busy_timeout=5000  -> expect 0 BUSY, 0 lost, no sequence gaps
//   must-FAIL : busy_timeout=none  -> expect BUSY errors AND lost inserts
// If the must-FAIL arm shows zero BUSY, the rig cannot fail and is decoration.
const { execFileSync, spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { open, migrate, stats } = require('./bus')

const WRITERS = Number(process.env.WRITERS || 10)
const INSERTS = Number(process.env.INSERTS || 100)
const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })

function runArm(label, busyTimeout) {
  const file = path.join(OUT, `arm1-${label}.db`)
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true })
  migrate(open(file, { busyTimeout: 5000 })).close()

  // Long-lived reader: a separate process holding the DB open and reading
  // continuously — this is the Electron main process in the real topology.
  const reader = spawn(process.execPath, [path.join(__dirname, 'reader-loop.js'), file,
    busyTimeout === null ? 'none' : String(busyTimeout)], { stdio: ['ignore', 'pipe', 'inherit'] })
  let readerOut = ''
  reader.stdout.on('data', (d) => (readerOut += d))

  // Give the reader time to actually open the DB before the writers start.
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},400)'])

  const t0 = Date.now()
  const procs = []
  for (let w = 0; w < WRITERS; w++) {
    procs.push(
      new Promise((resolve) => {
        const p = spawn(
          process.execPath,
          [path.join(__dirname, 'writer-cli.js'), file, `w${w}`, String(INSERTS),
            busyTimeout === null ? 'none' : String(busyTimeout)],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        )
        let o = ''
        p.stdout.on('data', (d) => (o += d))
        p.on('exit', () => resolve(JSON.parse(o)))
      }),
    )
  }

  return Promise.all(procs).then(async (results) => {
    const wallMs = Date.now() - t0
    // Wait for the reader to actually EXIT before reading its stdout — killing and
    // reading in the same tick captured an empty string (a silent null that reads
    // as "no contention measured"). The reader's report is the proof the writers
    // contended against a LIVE reader, so it must not be allowed to be empty.
    const readerReport = await new Promise((resolve) => {
      reader.on('exit', () => resolve(readerOut.trim().split('\n').filter(Boolean).pop() || null))
      reader.kill('SIGTERM')
    })
    const db = open(file, { busyTimeout: 5000 })
    const rows = db.prepare('SELECT sequence FROM messages ORDER BY sequence').all()
    const seqs = rows.map((r) => r.sequence)
    // A "gap" = a hole in the AUTOINCREMENT total order among committed rows.
    let gaps = 0
    for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1] + 1) gaps++
    const walSize = fs.existsSync(file + '-wal') ? fs.statSync(file + '-wal').size : 0
    db.close()

    const expected = WRITERS * INSERTS
    const lat = results.flatMap((r) => r.lat)
    return {
      label,
      busyTimeout: busyTimeout === null ? 'none (0ms)' : `${busyTimeout}ms`,
      writers: WRITERS, insertsPerWriter: INSERTS, expected,
      committed: rows.length,
      lostInserts: expected - rows.length,
      busyErrors: results.reduce((a, r) => a + r.busy, 0),
      otherErrors: results.reduce((a, r) => a + r.otherErr, 0),
      sequenceGaps: gaps,
      wallMs,
      throughputInsertsPerSec: Math.round((rows.length / wallMs) * 1000),
      insertLatencyMs: stats(lat),
      walBytesAtEnd: walSize,
      readerReport: readerReport ? JSON.parse(readerReport) : null,
    }
  })
}

;(async () => {
  const passArm = await runArm('busytimeout-5000', 5000)
  const failArm = await runArm('control-no-busytimeout', null)
  const report = {
    arm: 'arm1-write-contention',
    date: new Date().toISOString(),
    rig: {
      node: process.version, platform: `${process.platform}/${process.arch}`,
      sqlite: open(':memory:').prepare('select sqlite_version() v').get().v,
      betterSqlite3: require('better-sqlite3/package.json').version,
      cpus: require('os').cpus().length,
      dbOn: 'tmpfs? -> ' + execFileSync('df', ['-T', OUT]).toString().trim().split('\n').pop(),
    },
    mustPass: passArm,
    mustFail: failArm,
    controlValid: failArm.busyErrors > 0 || failArm.lostInserts > 0,
    verdict:
      passArm.busyErrors === 0 && passArm.lostInserts === 0 && passArm.sequenceGaps === 0
        ? 'PASS' : 'FAIL',
  }
  console.log(JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(OUT, 'arm1.json'), JSON.stringify(report, null, 2))
})()

'use strict'
// ARM 3 — app restart with a live keeper: the long-lived process (Electron main)
// is SIGKILLed while a CLI writer is mid-transaction. On reopen the WAL must
// recover with ZERO lost COMMITTED rows, and the uncommitted rows must be gone.
//
// must-PASS : every row the writer reported as committed is readable after both
//             processes are SIGKILLed and the DB is reopened by a fresh process.
// must-FAIL controls, so the rig can fail:
//   (a) the uncommitted rows MUST be absent — if they survive, the rig is not
//       measuring durability at all (it would mean nothing was ever isolated).
//   (b) a DELETED -wal file (simulating losing the WAL) MUST lose rows — proof
//       that the reopen genuinely reads the WAL rather than a checkpointed DB.
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { open, migrate } = require('./bus')

const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const sizes = (f) => ({
  db: fs.existsSync(f) ? fs.statSync(f).size : 0,
  wal: fs.existsSync(f + '-wal') ? fs.statSync(f + '-wal').size : 0,
  shm: fs.existsSync(f + '-shm') ? fs.statSync(f + '-shm').size : 0,
})
const sleep = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`])

function run({ deleteWal }) {
  const file = path.join(OUT, `arm3-${deleteWal ? 'control-walDeleted' : 'normal'}.db`)
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true })
  migrate(open(file, { busyTimeout: 5000 })).close()

  // long-lived "Electron main" holding the DB open
  const keeper = spawn(process.execPath, [path.join(__dirname, 'reader-loop.js'), file, '5000'],
    { stdio: ['ignore', 'pipe', 'inherit'] })
  sleep(400)

  // CLI writer: commits rows, then parks inside an open transaction.
  // It reports through a FILE, not a pipe: this harness is synchronous (it has to
  // be, to kill at a controlled instant), so it can never drain an async stdout —
  // the first version of this rig hung forever waiting on a callback that could
  // not fire while the main thread spun.
  const stateFile = file + '.writer-state.json'
  fs.rmSync(stateFile, { force: true })
  const w = spawn(process.execPath,
    [path.join(__dirname, 'writer-midtxn.js'), file, '50', '10', stateFile],
    { stdio: 'ignore', detached: false })

  // Bounded wait on PROGRESS (the state file appearing), never a blind sleep: a
  // blind sleep could kill the writer before it committed anything and the arm
  // would then "pass" having measured nothing.
  const deadline = Date.now() + 20000
  while (!fs.existsSync(stateFile) && Date.now() < deadline) sleep(50)
  if (!fs.existsSync(stateFile)) {
    try { process.kill(w.pid, 'SIGKILL') } catch {}
    try { process.kill(keeper.pid, 'SIGKILL') } catch {}
    throw new Error('RIG FAULT: writer never reported; nothing was measured')
  }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))

  const atCrash = sizes(file)
  // Kill BOTH hard, writer still inside its transaction.
  process.kill(w.pid, 'SIGKILL')
  process.kill(keeper.pid, 'SIGKILL')
  sleep(300)
  const afterKill = sizes(file)

  if (deleteWal) fs.rmSync(file + '-wal', { force: true })

  // Fresh process reopens — this is the app restarting.
  const probe = spawnSync(process.execPath, ['-e', `
    const {open}=require('${path.join(__dirname, 'bus.js')}');
    const db=open('${file}',{busyTimeout:5000});
    const rows=db.prepare('SELECT sequence,body FROM messages ORDER BY sequence').all();
    const integrity=db.pragma('integrity_check');
    process.stdout.write(JSON.stringify({seqs:rows.map(r=>r.sequence),
      bodies:rows.map(r=>r.body), integrity}));
    db.close();
  `], { encoding: 'utf8' })
  if (probe.status !== 0) throw new Error('RIG FAULT: reopen failed: ' + probe.stderr)
  const after = JSON.parse(probe.stdout)
  const afterReopen = sizes(file)

  const seen = new Set(after.seqs)
  return {
    label: deleteWal ? 'control-walDeleted' : 'normal-crash',
    reportedCommitted: state.committed.length,
    reportedUncommitted: state.uncommitted.length,
    lostCommittedRows: state.committed.filter((s) => !seen.has(s)),
    survivingUncommittedRows: state.uncommitted.filter((s) => seen.has(s)),
    rowsAfterReopen: after.seqs.length,
    integrityCheck: after.integrity,
    dirtyBodiesPresent: after.bodies.filter((b) => b.startsWith('dirty')).length,
    fileSizes: { atCrash, afterKill, afterReopen },
  }
}

const normal = run({ deleteWal: false })
const walGone = run({ deleteWal: true })

const report = {
  arm: 'arm3-restart-recovery',
  date: new Date().toISOString(),
  rig: { node: process.version, platform: `${process.platform}/${process.arch}`,
    sqlite: open(':memory:').prepare('select sqlite_version() v').get().v,
    betterSqlite3: require('better-sqlite3/package.json').version,
    note: 'both the long-lived keeper and the mid-transaction CLI writer are SIGKILLed' },
  mustPass: normal,
  mustFailControl: walGone,
  controlValid: walGone.lostCommittedRows.length > 0,
  verdict:
    normal.lostCommittedRows.length === 0 &&
    normal.survivingUncommittedRows.length === 0 &&
    normal.dirtyBodiesPresent === 0 &&
    JSON.stringify(normal.integrityCheck) === JSON.stringify([{ integrity_check: 'ok' }])
      ? 'PASS' : 'FAIL',
}
console.log(JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(OUT, 'arm3.json'), JSON.stringify(report, null, 2))

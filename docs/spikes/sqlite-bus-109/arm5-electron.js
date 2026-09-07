'use strict'
// ARM 5 — arms 1 and 2 rerun with the REAL Electron main process (33.4.11,
// arm64) as the long-lived reader, instead of a node stand-in.
//
// Two runtimes are in play and they have DIFFERENT ABIs (node 127 vs electron
// 130), so this arm also records which better_sqlite3.node serves which — that
// is the packaging decision, not a detail.
//
// Containment: Electron is spawned under `env -i` with DISPLAY and
// WAYLAND_DISPLAY ABSENT, and electron-main.js creates no BrowserWindow and
// aborts (exit 97) if a display env var is present. Nothing can appear on
// screen.
//
// Controls, per sub-arm:
//   5a contention : must-PASS busy_timeout=5000 / must-FAIL busy_timeout=0
//   5b ack-replay : must-PASS safe impl        / must-FAIL naive impl
// Plus a rig-validity gate: if the Electron main never reports, or reports a
// window, the arm is VOID rather than passing.
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { open, migrate, makeInsert, stats } = require('./bus')

const REPO = path.resolve(__dirname, '../../..')
const ELECTRON = path.join(REPO, 'node_modules/.bin/electron')
const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const WRITERS = Number(process.env.WRITERS || 10)
const INSERTS = Number(process.env.INSERTS || 100)
const sleep = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`])

// env -i equivalent: an ALLOWLIST, never a blocklist. No DISPLAY, no
// WAYLAND_DISPLAY, so a window is impossible even if code tried.
function containedEnv() {
  return {
    PATH: '/usr/bin:/bin',
    HOME: process.env.HOME,
    XDG_RUNTIME_DIR: '/tmp/arm5-xdg',
  }
}

function startElectronMain(file, busyTimeout, tag) {
  const report = path.join(OUT, `arm5-main-${tag}.json`)
  fs.rmSync(report, { force: true })
  fs.rmSync(report + '.ready', { force: true })
  const p = spawn(
    ELECTRON,
    ['--no-sandbox', '--disable-gpu', '--headless', path.join(__dirname, 'electron-main.js'),
      file, busyTimeout === null ? 'none' : String(busyTimeout), report],
    { env: containedEnv(), stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let err = ''
  p.stderr.on('data', (d) => (err += d))
  // Wait for the main process to signal it has the DB OPEN — not a blind sleep:
  // starting writers against an unattached main would measure nothing.
  const deadline = Date.now() + 60000
  while (!fs.existsSync(report + '.ready') && p.exitCode === null && Date.now() < deadline) sleep(100)
  if (!fs.existsSync(report + '.ready')) {
    try { p.kill('SIGKILL') } catch {}
    throw new Error(`RIG FAULT: electron main never became ready (exit=${p.exitCode}). stderr: ${err.slice(-800)}`)
  }
  return { proc: p, report }
}

function stopElectronMain(h) {
  h.proc.kill('SIGTERM')
  const deadline = Date.now() + 20000
  while (!fs.existsSync(h.report) && Date.now() < deadline) sleep(100)
  if (!fs.existsSync(h.report)) throw new Error('RIG FAULT: electron main never wrote its report')
  return JSON.parse(fs.readFileSync(h.report, 'utf8'))
}

// ---------- 5a: write contention against a real Electron main ----------
function contention(label, busyTimeout) {
  const file = path.join(OUT, `arm5a-${label}.db`)
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true })
  migrate(open(file, { busyTimeout: 5000 })).close()
  const main = startElectronMain(file, busyTimeout, label)

  const t0 = Date.now()
  const results = []
  // Short-lived CLI writers, spawned concurrently, under plain node.
  const procs = []
  for (let w = 0; w < WRITERS; w++) {
    const outFile = path.join(OUT, `arm5a-${label}-w${w}.json`)
    fs.rmSync(outFile, { force: true })
    procs.push({ outFile, p: spawn(process.execPath, ['-e', `
      const {open,makeInsert}=require(${JSON.stringify(path.join(__dirname, 'bus.js'))});
      const db=open(${JSON.stringify(file)},{busyTimeout:${busyTimeout === null ? 'null' : busyTimeout}});
      const ins=makeInsert(db); const lat=[]; let ok=0,busy=0,other=0; const seqs=[];
      for(let i=0;i<${INSERTS};i++){const s=process.hrtime.bigint();
        try{seqs.push(ins('run1','w${w}','note','w${w}:'+i));ok++}
        catch(e){String(e.code||'').startsWith('SQLITE_BUSY')?busy++:other++}
        lat.push(Number(process.hrtime.bigint()-s)/1e6);}
      db.close();
      require('fs').writeFileSync(${JSON.stringify(outFile)},JSON.stringify({ok,busy,other,lat,seqs}));
    `], { stdio: 'ignore' }) })
  }
  // wait for all writers to exit
  const deadline = Date.now() + 120000
  for (const { p } of procs) while (p.exitCode === null && Date.now() < deadline) sleep(20)
  const wallMs = Date.now() - t0
  for (const { outFile } of procs) {
    if (!fs.existsSync(outFile)) throw new Error('RIG FAULT: a writer produced no result file')
    results.push(JSON.parse(fs.readFileSync(outFile, 'utf8')))
  }

  const mainReport = stopElectronMain(main)
  const db = open(file, { busyTimeout: 5000 })
  const seqs = db.prepare('SELECT sequence FROM messages ORDER BY sequence').all().map((r) => r.sequence)
  db.close()
  let gaps = 0
  for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1] + 1) gaps++
  const expected = WRITERS * INSERTS

  return {
    label, busyTimeout: busyTimeout === null ? 'none (0ms)' : `${busyTimeout}ms`,
    expected, committed: seqs.length, lostInserts: expected - seqs.length,
    busyErrors: results.reduce((a, r) => a + r.busy, 0),
    otherErrors: results.reduce((a, r) => a + r.other, 0),
    sequenceGaps: gaps, wallMs,
    throughputInsertsPerSec: Math.round((seqs.length / wallMs) * 1000),
    insertLatencyMs: stats(results.flatMap((r) => r.lat)),
    electronMain: mainReport,
  }
}

// ---------- 5b: ack-replay with an Electron main holding the DB open ----------
function ackReplay(impl) {
  const file = path.join(OUT, `arm5b-${impl}.db`)
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true })
  const db = migrate(open(file, { busyTimeout: 5000 }))
  const insert = makeInsert(db)
  const seeded = []
  for (let i = 0; i < 5; i++) seeded.push(insert('run1', 'lead', 'note', `seed${i}`))
  db.close()

  // A REAL Electron main is attached for the whole scenario.
  const main = startElectronMain(file, 5000, `ack-${impl}`)

  const consumer = (mode) => {
    const r = spawnSync(process.execPath,
      [path.join(__dirname, 'consumer-cli.js'), file, 'ops', mode, impl], { encoding: 'utf8' })
    const line = r.stdout.trim().split('\n').filter(Boolean).pop()
    return { ...(line ? JSON.parse(line) : { ids: null }), signal: r.signal }
  }

  const crashed = consumer('crash')             // takes a batch, SIGKILLs itself
  const db2 = open(file, { busyTimeout: 5000 })
  const later = []
  const ins2 = makeInsert(db2)
  for (let i = 0; i < 3; i++) later.push(ins2('run1', 'lead', 'note', `later${i}`))
  db2.close()

  const afterCrash = consumer('ack')
  const afterAck = consumer('ack')
  const mainReport = stopElectronMain(main)

  const survivor = new Set([...(afterCrash.ids || []), ...(afterAck.ids || [])])
  return {
    impl, seeded, later,
    killSignal: crashed.signal,
    batchTakenThenKilled: crashed.ids,
    checkAfterCrash: afterCrash.ids,
    replayedSameIds: JSON.stringify(afterCrash.ids) === JSON.stringify(crashed.ids),
    checkAfterAck: afterAck.ids,
    lostMessages: [...seeded, ...later].filter((s) => !survivor.has(s)),
    electronMain: mainReport,
  }
}

// ---------- ABI facts (measured earlier, re-measured here) ----------
function abiFacts() {
  const nodeAbi = process.versions.modules
  const r = spawnSync(ELECTRON, ['-e',
    "console.log(JSON.stringify({abi:process.versions.modules,electron:process.versions.electron,node:process.versions.node}))"],
    { env: { ...containedEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
  const el = JSON.parse(r.stdout.trim().split('\n').pop())
  return { nodeAbi, electronAbi: el.abi, electronVersion: el.electron,
    electronBundledNode: el.node, sameAbi: nodeAbi === el.abi,
    electronRunAsNodeAbi: el.abi }
}

const abi = abiFacts()
const a5Pass = contention('busytimeout-5000', 5000)
const a5Fail = contention('control-no-busytimeout', null)
const b5Pass = ackReplay('safe')
const b5Fail = ackReplay('naive')

const mainOk = (m) => m && m.runtime === 'electron-main' && m.browserWindowsCreated === 0 &&
  m.hadDisplayEnv === false && m.reads > 0

const report = {
  arm: 'arm5-real-electron-main',
  date: new Date().toISOString(),
  rig: {
    hostNode: process.version, platform: `${process.platform}/${process.arch}`,
    electron: abi.electronVersion,
    sqlite: open(':memory:').prepare('select sqlite_version() v').get().v,
    betterSqlite3: require('better-sqlite3/package.json').version,
    longLivedProcess: 'REAL Electron main (no BrowserWindow), env -i, no DISPLAY/WAYLAND_DISPLAY',
    cliClients: 'short-lived plain-node processes',
  },
  abi,
  contention: { mustPass: a5Pass, mustFail: a5Fail,
    controlValid: a5Fail.busyErrors > 0 || a5Fail.lostInserts > 0 },
  ackReplay: { mustPass: b5Pass, mustFail: b5Fail,
    controlValid: b5Fail.lostMessages.length > 0 },
  // The arm is only meaningful if a real, windowless Electron main was attached.
  // Hoisted so the one-line gate command cannot read `undefined` as a pass.
  controlValid: (a5Fail.busyErrors > 0 || a5Fail.lostInserts > 0) && b5Fail.lostMessages.length > 0,
  rigValid: [a5Pass, a5Fail].every((a) => mainOk(a.electronMain)) &&
            [b5Pass, b5Fail].every((a) => mainOk(a.electronMain)),
  verdict:
    a5Pass.busyErrors === 0 && a5Pass.lostInserts === 0 && a5Pass.sequenceGaps === 0 &&
    b5Pass.replayedSameIds && b5Pass.lostMessages.length === 0 &&
    JSON.stringify(b5Pass.checkAfterAck) === JSON.stringify(b5Pass.later)
      ? 'PASS' : 'FAIL',
}
console.log(JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(OUT, 'arm5.json'), JSON.stringify(report, null, 2))

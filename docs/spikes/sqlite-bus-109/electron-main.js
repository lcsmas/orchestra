'use strict'
// ARM 5 — the REAL Electron main process as the long-lived bus reader.
// No BrowserWindow is ever created: this is a windowless main process, so
// nothing can appear on the user's screen. It is launched under `env -i` with
// DISPLAY/WAYLAND_DISPLAY absent (see arm5-electron.js), which is also why the
// harness must NOT depend on a display being reachable.
//
// argv after the script path: <dbfile> <busyTimeoutMs|none> <reportFile>
const { app } = require('electron')

// Belt: refuse to run if anything would let a window reach a display. If this
// ever fires, the containment claim in findings.md is false and we must know.
if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
  console.error('ARM5 ABORT: DISPLAY/WAYLAND_DISPLAY present; refusing to run')
  process.exit(97)
}

const args = process.argv.slice(process.argv.indexOf(__filename) + 1)
const [file, btStr, reportFile] = args
const fs = require('fs')

app.disableHardwareAcceleration()

app.whenReady().then(() => {
  // require the bus INSIDE whenReady so a native-ABI failure is attributable
  const { open } = require('./bus')
  const db = open(file, { busyTimeout: btStr === 'none' ? null : Number(btStr) })
  const count = db.prepare('SELECT COUNT(*) c, MAX(sequence) m FROM messages')

  let reads = 0, readBusy = 0
  let last = { c: 0, m: null }
  const started = Date.now()

  const t = setInterval(() => {
    try { last = count.get(); reads++ } catch (e) {
      if (String(e.code || '').startsWith('SQLITE_BUSY')) readBusy++
    }
  }, 1)

  const finish = () => {
    clearInterval(t)
    fs.writeFileSync(reportFile + '.tmp', JSON.stringify({
      runtime: 'electron-main',
      versions: {
        electron: process.versions.electron, node: process.versions.node,
        modules: process.versions.modules, chrome: process.versions.chrome,
      },
      // proof no window was ever made, recorded by the process itself
      browserWindowsCreated: require('electron').BrowserWindow.getAllWindows().length,
      hadDisplayEnv: !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
      reads, readBusy, lastSeen: last, upMs: Date.now() - started,
    }))
    fs.renameSync(reportFile + '.tmp', reportFile)
    try { db.close() } catch {}
    app.exit(0)
  }

  process.on('SIGTERM', finish)
  process.on('SIGINT', finish)

  // Signal readiness only once the DB is genuinely open and queryable — the
  // harness waits on this file, so it can never start writers against a main
  // process that has not actually attached to the DB.
  count.get()
  fs.writeFileSync(reportFile + '.ready', String(process.pid))
})

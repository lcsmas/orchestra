// #404 rig — the NODE-MODE probe: arm A (`ELECTRON_RUN_AS_NODE=1 electron`) and arm C (system node).
// Tries the two Electron-bound deps exactly as the host would reach them, then prints
// one line `R404 {json}`. Env: R404_BLOB, R404_BINDING, R404_BSQL_PKG, R404_DBDIR.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const out = {
  arm: process.versions.electron ? 'electron-as-node' : 'system-node',
  electron: process.versions.electron ?? null,
  abi: process.versions.modules,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
};

// 1. safeStorage the way platform/electron.ts gets it: require('electron').
try {
  const e = require('electron');
  out.requireElectron = typeof e === 'string' ? `string(${e.slice(-40)})` : typeof e;
  out.safeStorage = typeof e?.safeStorage;
  if (e?.safeStorage) {
    const blob = Buffer.from(fs.readFileSync(process.env.R404_BLOB, 'utf8'), 'base64');
    out.plain = e.safeStorage.decryptString(blob);
  }
} catch (err) {
  out.requireElectron = 'threw: ' + String(err.message).split('\n')[0].slice(0, 120);
}
// The internal binding — is the browser-side safeStorage linked into the node-mode process?
// Opt-in (R404_LINKED=1): measured to SIGSEGV the process, so it runs alone.
if (process.versions.electron && process.env.R404_LINKED === '1') {
  try {
    const b = process._linkedBinding('electron_browser_safe_storage');
    out.linkedBinding = Object.keys(b).join(',');
    try { out.linkedAvailable = b.isEncryptionAvailable(); } catch (err) { out.linkedAvailable = 'threw: ' + err.message; }
  } catch (err) {
    out.linkedBinding = 'threw: ' + String(err.message).split('\n')[0].slice(0, 120);
  }
}

// 2. bus: require (the trap) then a REAL open + WAL + write + read.
const binding = process.env.R404_BINDING;
if (binding) {
  out.bus = { binding: path.basename(binding) };
  try {
    const Base = require(path.join(process.env.R404_BSQL_PKG, 'lib/database.js'));
    out.bus.require = 'ok';
    const db = new Base(path.join(process.env.R404_DBDIR, `bus-probe-${process.pid}.sqlite`), { nativeBinding: binding });
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT)');
    const id = db.prepare('INSERT INTO messages(body) VALUES (?)').run('r404').lastInsertRowid;
    const row = db.prepare('SELECT body, sqlite_version() AS v FROM messages WHERE id = ?').get(id);
    db.close();
    Object.assign(out.bus, { ok: row.body === 'r404', journal: mode, sqlite: row.v });
  } catch (err) {
    Object.assign(out.bus, { ok: false, err: String(err.message).replace(/\s+/g, ' ').replace(/^.*?(was compiled)/, '$1').slice(0, 220) });
  }
}
process.stdout.write('R404 ' + JSON.stringify(out) + '\n');

// #404 rig — the WINDOWLESS Electron main process (arm B and the positive control).
// Never creates a BrowserWindow. Scratch userData only (R404_USERDATA, required).
//
//   electron electron-probe.cjs            (env below)
//   R404_OP        encrypt | decrypt
//   R404_USERDATA  scratch userData dir (refused unless under R404_SCRATCH_ROOT)
//   R404_BLOB      file the base64 ciphertext is written to / read from
//   R404_SECRET    plaintext to encrypt (encrypt op)
//   R404_APPNAME   app.setName() value — names the keyring item, keeps it apart from Orchestra's
//   R404_PASSWORD_STORE  optional --password-store switch (gnome-libsecret | basic | …)
//   R404_BINDING   optional better-sqlite3 .node to open+query a WAL db under userData
//   R404_BSQL_PKG  the better-sqlite3 package dir (lib/database.js)
//   R404_PLAINTEXT_OK=1  call safeStorage.setUsePlainTextEncryption(true) (basic_text v10 arm)
//
// Prints exactly one line `R404 {json}` and exits 0; the matrix script judges it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const out = { arm: 'electron-main', electron: process.versions.electron, abi: process.versions.modules };
function done(code = 0) {
  process.stdout.write('R404 ' + JSON.stringify(out) + '\n');
  app.exit(code);
}

const root = process.env.R404_SCRATCH_ROOT;
const ud = process.env.R404_USERDATA;
if (!root || !ud || !path.resolve(ud).startsWith(path.resolve(root) + path.sep)) {
  out.error = `refused: userData ${ud} not under scratch root ${root}`;
  process.stdout.write('R404 ' + JSON.stringify(out) + '\n');
  process.exit(3);
}
fs.mkdirSync(ud, { recursive: true });
if (process.env.R404_APPNAME) app.setName(process.env.R404_APPNAME);
app.setPath('userData', ud); // before ready: nothing lands in ~/.config/<name>
if (process.env.R404_PASSWORD_STORE) {
  app.commandLine.appendSwitch('password-store', process.env.R404_PASSWORD_STORE);
}

app.on('window-all-closed', () => {}); // no windows, ever

function busQuery() {
  const binding = process.env.R404_BINDING;
  if (!binding) return;
  try {
    const Base = require(path.join(process.env.R404_BSQL_PKG, 'lib/database.js'));
    const db = new Base(path.join(ud, 'bus-probe.sqlite'), { nativeBinding: binding });
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    db.exec('CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, body TEXT)');
    const id = db.prepare('INSERT INTO messages(body) VALUES (?)').run('r404-' + process.pid).lastInsertRowid;
    const row = db.prepare('SELECT body, sqlite_version() AS v FROM messages WHERE id = ?').get(id);
    db.close();
    out.bus = { ok: row.body === 'r404-' + process.pid, journal: mode, sqlite: row.v, binding: path.basename(binding) };
  } catch (e) {
    out.bus = { ok: false, err: String(e.message).split('\n')[0].slice(0, 220), binding: path.basename(binding) };
  }
}

app.whenReady().then(() => {
  out.display = { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? null, DISPLAY: process.env.DISPLAY ?? null };
  out.desktop = process.env.XDG_CURRENT_DESKTOP ?? null;
  out.windows = require('electron').BrowserWindow.getAllWindows().length;
  // R404_PLAINTEXT_OK=1: opt in to the basic_text "v10" (hard-coded key) encryption.
  if (process.env.R404_PLAINTEXT_OK === '1') safeStorage.setUsePlainTextEncryption(true);
  out.backend = safeStorage.getSelectedStorageBackend();
  out.available = safeStorage.isEncryptionAvailable();
  const op = process.env.R404_OP;
  try {
    if (op === 'encrypt') {
      const blob = safeStorage.encryptString(process.env.R404_SECRET);
      fs.writeFileSync(process.env.R404_BLOB, blob.toString('base64'));
      out.prefix = blob.subarray(0, 3).toString('latin1');
      out.roundtrip = safeStorage.decryptString(blob) === process.env.R404_SECRET;
    } else if (op === 'decrypt') {
      const blob = Buffer.from(fs.readFileSync(process.env.R404_BLOB, 'utf8'), 'base64');
      out.prefix = blob.subarray(0, 3).toString('latin1');
      out.plain = safeStorage.decryptString(blob);
    }
  } catch (e) {
    out.err = String(e.message).split('\n')[0].slice(0, 220);
  }
  busQuery();
  done(0);
}).catch((e) => { out.err = 'whenReady: ' + e; done(1); });

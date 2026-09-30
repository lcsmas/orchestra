// PROTOTYPE — throwaway, never ship. Wayfinder #247 (map #243).
// Question: can an embedded Orchestra window with an isolated session complete
// claude.ai sign-in, driven by `claude auth login` as a plain child (pipes, no PTY)?
// Two variants: 'stdin'  = open the MANUAL url, catch the code page, pipe code#state to stdin
//               'loopback' = open the AUTOMATIC url (via $BROWSER -> file), CLI's localhost listener catches it
// Run: pnpm proto:compte-signin   (config dir is a /tmp scratch; wiped on quit)
const { app, BrowserWindow, session, ipcMain } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const CLAUDE = fs.realpathSync(execFileSync('sh', ['-c', 'command -v claude']).toString().trim());
// Electron's cache writer can recreate electron-userdata/Cache after the wipe: sweep leftovers (never credentials)
for (const d of fs.readdirSync(os.tmpdir())) if (/^PROTOTYPE-compte-signin-[A-Za-z0-9]{6}$/.test(d)) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'PROTOTYPE-compte-signin-'));
const cfg = path.join(scratch, 'config'), home = path.join(scratch, 'home');
fs.mkdirSync(cfg); fs.mkdirSync(home);
if (!cfg.startsWith(os.tmpdir() + '/PROTOTYPE-')) throw new Error('refusing non-scratch config dir ' + cfg);
const browserFile = path.join(scratch, 'browser-url.txt');
const browserScript = path.join(scratch, 'browser.sh');
fs.writeFileSync(browserScript, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${browserFile}'\n`, { mode: 0o755 });
app.setPath('userData', path.join(scratch, 'electron-userdata')); // never ~/.config/Electron
const logFile = path.join(os.tmpdir(), `PROTOTYPE-compte-signin-log-${Date.now()}.txt`);

let control, signin, child, t0, attempt = 0;
const redact = (u) => String(u).replace(/(code|state|code_challenge|token)=([^&#\s]{6})[^&#\s]*/g, '$1=$2…');
function log(msg) {
  const line = `[${t0 ? ((Date.now() - t0) / 1000).toFixed(1) + 's' : '-'}] ${redact(msg)}`;
  fs.appendFileSync(logFile, line + '\n');
  control?.webContents.send('log', line);
}
const env = (mode) => ({
  PATH: process.env.PATH, HOME: home, LANG: process.env.LANG || 'C.UTF-8',
  CLAUDE_CONFIG_DIR: cfg, BROWSER: mode === 'loopback' ? browserScript : '/bin/true',
});

function openSignin(url, partition) {
  signin = new BrowserWindow({ width: 560, height: 760, title: 'PROTOTYPE — Se connecter à Claude',
    webPreferences: { partition } });
  const ses = session.fromPartition(partition);
  ses.setUserAgent(app.userAgentFallback.replace(/\s(Electron|orchestra)\/\S+/gi, ''));
  const wire = (wc, tag) => {
    wc.on('did-navigate', (_e, u) => log(`${tag} nav ${u}`));
    wc.on('did-redirect-navigation', (_e, u) => log(`${tag} redirect ${u}`));
    wc.on('did-fail-load', (_e, c, d, u) => log(`${tag} FAIL ${c} ${d} ${u}`));
    wc.on('will-navigate', (_e, u) => maybeCode(u, tag));
    wc.on('did-redirect-navigation', (_e, u) => maybeCode(u, tag));
    wc.setWindowOpenHandler(({ url: u }) => { log(`${tag} popup -> ${u}`); return { action: 'allow',
      overrideBrowserWindowOptions: { webPreferences: { partition } } }; });
    wc.on('did-create-window', (w) => wire(w.webContents, tag + '/popup'));
  };
  wire(signin.webContents, 'signin');
  signin.on('closed', () => { log('signin window closed'); signin = null; });
  signin.loadURL(url);
}

let codeSent = false;
function maybeCode(u, tag) {
  if (codeSent || !child || child.mode !== 'stdin') return;
  let p; try { p = new URL(u); } catch { return; }
  const code = p.searchParams.get('code'), state = p.searchParams.get('state');
  if (/\/oauth\/code\/callback/.test(p.pathname) && code && state) {
    codeSent = true; child.stdin.write(`${code}#${state}\n`);
    log(`${tag} caught code page -> piped code#state to CLI stdin`);
  }
}

function start(mode) {
  if (child) return log('already running');
  attempt++; t0 = Date.now(); codeSent = false;
  const partition = `proto-${attempt}-${Date.now()}`; // in-memory: no persist:
  log(`=== attempt ${attempt} mode=${mode} cli=${CLAUDE} cfg=${cfg} partition=${partition}`);
  try { fs.unlinkSync(browserFile); } catch {}
  child = spawn(CLAUDE, ['auth', 'login', '--claudeai'], { env: env(mode), stdio: ['pipe', 'pipe', 'pipe'] });
  child.mode = mode;
  let opened = false;
  const onOut = (tag) => (b) => b.toString().split('\n').filter(Boolean).forEach((l) => {
    log(`cli ${tag}: ${l}`);
    const m = l.match(/(https:\/\/\S+)/);
    if (mode === 'stdin' && m && !opened) { opened = true; openSignin(m[1], partition); }
  });
  child.stdout.on('data', onOut('out')); child.stderr.on('data', onOut('err'));
  if (mode === 'loopback') {
    const iv = setInterval(() => {
      if (!fs.existsSync(browserFile)) return;
      clearInterval(iv); const u = fs.readFileSync(browserFile, 'utf8').split('\n')[0];
      log(`$BROWSER was handed ${u}`); opened = true; openSignin(u, partition);
    }, 200);
    child.on('exit', () => clearInterval(iv));
  }
  child.on('exit', async (code, sig) => {
    log(`cli exited code=${code} sig=${sig}`); child = null;
    status();
    const cookies = await session.fromPartition(partition).cookies.get({});
    log(`partition cookies: ${cookies.length} (${[...new Set(cookies.map((c) => c.domain))].join(', ')})`);
    if (code === 0 && signin) { signin.close(); log('signin window auto-closed'); }
  });
}

function status() {
  try {
    const out = execFileSync(CLAUDE, ['auth', 'status', '--json'], { env: env('stdin') }).toString();
    const j = JSON.parse(out);
    log(`auth status: loggedIn=${j.loggedIn} method=${j.authMethod} email=${j.email} org=${j.orgName} plan=${j.subscriptionType}`);
  } catch (e) { log(`auth status: not logged in (${e.status})`); }
  log(`.credentials.json present: ${fs.existsSync(path.join(cfg, '.credentials.json'))}`);
}
function logout() {
  try { execFileSync(CLAUDE, ['auth', 'logout'], { env: env('stdin') }); log('logged out (scratch)'); }
  catch (e) { log('logout failed ' + e.status); }
  status();
}

ipcMain.on('cmd', (_e, c) => ({
  stdin: () => start('stdin'), loopback: () => start('loopback'), status, logout,
  cancel: () => { child?.kill(); signin?.close(); },
}[c]?.()));

app.whenReady().then(() => {
  control = new BrowserWindow({ width: 900, height: 640, title: 'PROTOTYPE #247 — Compte sign-in',
    webPreferences: { nodeIntegration: true, contextIsolation: false } });
  control.loadFile(path.join(__dirname, 'control.html'));
  control.webContents.once('did-finish-load', () => {
    log(`log file: ${logFile}`);
    if (process.env.PROTO_AUTOSTART === 'window') openSignin('https://claude.ai/login', 'proto-w'); // bisect
    else if (process.env.PROTO_AUTOSTART) start(process.env.PROTO_AUTOSTART); // smoke only
    if (process.env.PROTO_QUIT_AFTER_MS) setTimeout(() => app.quit(), +process.env.PROTO_QUIT_AFTER_MS);
  });
});
app.on('window-all-closed', () => app.quit());
app.on('quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
app.on('will-quit', () => {
  // the child's async 'exit' handler touches session/execFileSync during shutdown and wedged quit
  if (child) { child.removeAllListeners('exit'); child.kill('SIGKILL'); }
  try { execFileSync(CLAUDE, ['auth', 'logout'], { env: env('stdin') }); } catch {}
  fs.rmSync(cfg, { recursive: true, force: true }); // userData is still in use until exit
  fs.appendFileSync(logFile, `scratch ${scratch} wiped\n`);
  // FINDING: a closed window that had loaded claude.ai still wedges Electron 33 shutdown ('quit'
  // never fires; a blank window quits fine). Prototype just hard-exits; production must handle it.
  fs.rmSync(scratch, { recursive: true, force: true });
  process.kill(process.pid, 'SIGKILL'); // sync: timers never fire once shutdown wedges
});

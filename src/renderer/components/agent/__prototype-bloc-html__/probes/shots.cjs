// PROTOTYPE — throwaway. Screenshots of the three mockups, taken in the contained rig (hidden compositor).
// Usage (through scripts/e2e-contained-rig.sh): electron --ozone-platform=wayland shots.cjs --out=<dir> --url=http://127.0.0.1:<port>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const OUT = arg('out'); const URL_BASE = arg('url');
if (!OUT || !URL_BASE) { console.error('need --out and --url'); process.exit(2); }
app.setPath('userData', path.join(OUT, 'ud'));
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = `JSON.stringify({ state: (document.querySelector('.pb-switcher-state') || {}).textContent, listW: document.querySelector('.av-message-list').clientWidth, frames: [...document.querySelectorAll('iframe')].map((f) => Math.round(f.getBoundingClientRect().height)), pending: !!document.querySelector('.pb-pending') })`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 980, show: true, webPreferences: { contextIsolation: true } });
  const shot = async (name, q, before) => {
    await win.loadURL(`${URL_BASE}/?${q}`);
    await sleep(1800);
    if (before) { await win.webContents.executeJavaScript(before); await sleep(900); }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log(`SHOT ${name} ${await win.webContents.executeJavaScript(STATE)}`);
  };
  await shot('A-dark-top', 'variant=A&theme=dark');
  await shot('A-dark-bottom', 'variant=A&theme=dark', "document.querySelector('.av-message-list').scrollTo(0, 1e6)");
  await shot('A-light-top', 'variant=A&theme=light');
  await shot('B-dark-top', 'variant=B&theme=dark');
  await shot('B-dark-bottom', 'variant=B&theme=dark', "document.querySelector('.av-message-list').scrollTo(0, 1e6)");
  await shot('C-dark-closed', 'variant=C&theme=dark');
  await shot('C-dark-open', 'variant=C&theme=dark', "document.querySelectorAll('.pb-c')[1].click()");
  await shot('A-dark-overlay', 'variant=A&theme=dark', "document.querySelectorAll('.pb-a-tools button')[3].click()");
  app.exit(0);
}).catch((e) => { console.error('SHOT_CRASH', e); app.exit(1); });
setTimeout(() => { console.error('SHOT_TIMEOUT'); app.exit(3); }, 80_000);

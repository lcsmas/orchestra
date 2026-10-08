// #320 (H2 review F1, ledger OPS Q5) — does a Chromium launched from INSIDE a member-style scope leave it? Measured, not assumed: Chromium moves its main process into its own transient
// scope (`app-org.chromium.Chromium-<pid>.scope`) through the session bus. This probe runs a headless Chromium (scratch profile) as a child of a bash that is the MAIN process of a disposable
// scope (`orchestra-rig-wh-h1-chrome-*`, ≤300M, MemorySwapMax=0, OOMPolicy=continue — the production properties), under a chosen environment, and prints the cgroup of every process of the
// browser's tree. The browser tree is stopped BY IDENTITY at the end (pid + start time re-read; it never signals a pid it did not start); the escaped scope empties and vanishes by itself.
//
//   node scripts/memory-cap/chromium-escape.mjs <variant>      variants: as-is | no-dbus-addr | no-dbus-no-xdg | cleared
//   Needs the heavy-rig token. Chromium: $CHROMIUM or /usr/lib64/chromium-browser/chromium-browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const variant = process.argv[2] ?? 'as-is';
const CHROMIUM = process.env.CHROMIUM ?? '/usr/lib64/chromium-browser/chromium-browser';
if (!fs.existsSync(CHROMIUM)) { console.log(`VOID no chromium at ${CHROMIUM}`); process.exit(3); }
const REAL_HOME = os.homedir();
const root = path.join(REAL_HOME, '.cache', 'memory-cap-rig', `chrome-${variant}-${Math.random().toString(16).slice(2, 6)}`);
fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
const unit = `orchestra-rig-wh-h1-chrome-${variant.replace(/[^a-z]/g, '')}-${Math.random().toString(16).slice(2, 6)}.scope`;
const out = path.join(root, 'tree.txt');
const unsetVars = { 'as-is': [], 'no-dbus-addr': ['DBUS_SESSION_BUS_ADDRESS'], 'no-dbus-no-xdg': ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'], cleared: ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY'] }[variant];
if (!unsetVars) { console.log(`unknown variant ${variant}`); process.exit(2); }
// the member-style main process: a bash that starts the browser, waits 6 s, records the tree, then exits. The browser's marker is its scratch --user-data-dir.
const prof = path.join(root, 'profile');
const script = `
${unsetVars.map((v) => `unset ${v}`).join('\n')}
${CHROMIUM} --headless=new --no-sandbox --disable-gpu --no-first-run --disable-extensions --user-data-dir=${prof} --remote-debugging-port=0 about:blank >${root}/chrome.log 2>&1 &
sleep 6
echo "member bash cgroup: $(cut -d: -f3 /proc/self/cgroup)" > ${out}
for p in $(pgrep -f -- "--user-data-dir=${prof}"); do
  printf '%s %s %s %s\\n' "$p" "$(awk '{print $22}' /proc/$p/stat 2>/dev/null)" "$(cut -d: -f3 /proc/$p/cgroup 2>/dev/null)" "$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-90)" >> ${out}
done
`;
fs.writeFileSync(path.join(root, 'member.sh'), script, { mode: 0o755 });
const r = spawnSync('systemd-run', ['--user', '--scope', '--collect', '--quiet', `--unit=${unit}`, '-p', 'OOMPolicy=continue', '-p', 'MemoryMax=300M', '-p', 'MemorySwapMax=0', '--', 'bash', path.join(root, 'member.sh')], { encoding: 'utf8', timeout: 60_000, env: process.env });
const memberCg = (fs.readFileSync(out, 'utf8').split('\n')[0] ?? '').replace('member bash cgroup: ', '');
const rows = fs.readFileSync(out, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => { const [pid, st, cg, ...cmd] = l.split(' '); return { pid: Number(pid), st, cg, cmd: cmd.join(' ') }; });
// Stop the browser tree BY IDENTITY: re-read each pid's start time right before signalling; only processes recorded above, only if --user-data-dir is still ours.
let killed = 0;
for (const row of rows) {
  try {
    const stat = fs.readFileSync(`/proc/${row.pid}/stat`, 'utf8');
    const st = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const cmd = fs.readFileSync(`/proc/${row.pid}/cmdline`, 'latin1');
    if (st === row.st && cmd.includes(prof)) { process.kill(row.pid, 'SIGKILL'); killed++; }
  } catch { /* gone */ }
}
await new Promise((res) => setTimeout(res, 800));
const left = [];
for (const n of fs.readdirSync('/proc')) { if (!/^\d+$/.test(n)) continue; try { if (fs.readFileSync(`/proc/${n}/cmdline`, 'latin1').includes(prof)) left.push(Number(n)); } catch { /* gone */ } }
const inside = rows.filter((x) => x.cg === memberCg);
const outside = rows.filter((x) => x.cg !== memberCg);
console.log(`variant=${variant} unset=[${unsetVars.join(',')}] systemd-run rc=${r.status} member scope=${memberCg}`);
for (const x of rows) console.log(`  ${x.cg === memberCg ? 'INSIDE ' : 'OUTSIDE'} pid ${x.pid} ${x.cg === memberCg ? '' : `cgroup ${x.cg}  `}${x.cmd}`);
console.log(`RESULT variant=${variant}: browser processes=${rows.length} inside=${inside.length} outside=${outside.length}${outside.length ? '  ← ESCAPED the member scope' : rows.length ? '  ← contained' : '  ← no browser process seen (VOID)'}`);
console.log(`SURVIVORS (processes carrying the scratch profile) after identity teardown: ${left.length}${left.length ? ' ← LEAK' : ''}; killed by identity: ${killed}; leftover member scope: ${spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', unit], { encoding: 'utf8' }).stdout.trim() ? 'YES' : 'no'}`);
for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
fs.rmSync(root, { recursive: true, force: true });

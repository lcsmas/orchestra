// Must-FAIL proof for the debugger seat + the proxy lease (#398, ledger #405).
// Mutates src/main/browser-cdp-seat.ts and src/shared/cdp-proxy-core.ts IN PLACE, one clause at a time; each mutant MUST redden its test file,
// and every file is restored from a byte-exact backup and compared after each mutant (and on any exit path).
// Run: node scripts/mutate-cdp-seat.mjs   (RC 0 = every mutant killed)
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEAT = 'src/main/browser-cdp-seat.ts', CORE = 'src/shared/cdp-proxy-core.ts';
const TESTS = { [SEAT]: ['src/main/browser-cdp-seat.test.ts'], [CORE]: ['src/shared/cdp-proxy-core.test.ts'] };
const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'seat-mut-'));
const backups = Object.fromEntries([SEAT, CORE].map((f) => { const b = path.join(dir, path.basename(f) + '.orig'); copyFileSync(path.join(root, f), b); return [f, b]; }));
const origs = Object.fromEntries([SEAT, CORE].map((f) => [f, readFileSync(path.join(root, f), 'utf8')]));

const MUTANTS = [
  [SEAT, 'a second holder attaches again instead of sharing (the fake throws on a double attach)',
    'if (!wc.debugger.isAttached()) wc.debugger.attach(\'1.3\');', 'wc.debugger.attach(\'1.3\');'],
  [SEAT, 'the last release never detaches (grace 0)',
    '    drop(wc, seat);\n    note(wc, seat, \'release detached\');', '    note(wc, seat, \'release detached\');'],
  [SEAT, 'a release detaches although other holders remain',
    'if (--seat.count > 0) {', 'if (--seat.count > 99) {'],
  [SEAT, 'a holder coming back inside the grace does not cancel the reset',
    '    clearTimeout(seat.timer); // a holder came back inside the grace period: the reset is off\n    seat.timer = null;', ''],
  [SEAT, 'a holder arriving mid-reset does not keep the debugger',
    'if (seats.get(wc) === seat && seat.count === 0) {', 'if (seats.get(wc) === seat) {'],
  [SEAT, 'the grace-over detaches without clearing the agent\'s overrides',
    'for (const [method, params] of resetCommands(wc.getUserAgent())) {\n        note(wc, seat, `reset-command ${method}`);\n        await wc.debugger.sendCommand(method, params).catch(() => undefined);\n      }', ''],
  [SEAT, 'the last release detaches at once (no grace period)',
    'if (graceMs <= 0) {', 'if (true) {'],
  [SEAT, 'force-detach (tab destroyed) leaves the seat and its timer behind',
    "  drop(wc, seat);\n  note(wc, seat, 'force-detached');", "  note(wc, seat, 'force-detached');"],
  [SEAT, 'the debugger vanishing under the seat does not empty it',
    '        if (seats.get(wc) === made) seats.delete(wc);', ''],
  [SEAT, 'the reset runs even though no agent session held the seat (design mode alone writes to the human\'s tab)',
    'if (seat.reset) {\n      ensureAttached(wc);', 'if (true) {\n      ensureAttached(wc);'],
  [SEAT, 'an agent release never marks the seat (its leftovers are never undone)',
    'if (agentTouched) seat.reset = true;', ''],
  [SEAT, 'the agent mark is not sticky: a later in-process release erases it',
    'if (agentTouched) seat.reset = true;', 'seat.reset = agentTouched;'],
  [SEAT, 'an external detach leaves the seat\'s own listener behind',
    "        wc.debugger.off('detach', made.onDetach);\n      },", '      },'],
  [CORE, 'a client session does not mark the tab as agent-touched',
    '    st.agent = true;\n', ''],
  [CORE, 'an in-process lease marks the tab as agent-touched (every design pick would trigger the reset)',
    '    const st = await this.acquireTab(tabId);\n    let held = true;', '    const st = await this.acquireTab(tabId);\n    st.agent = true;\n    let held = true;'],
  [CORE, 'sendOnLease never gives the lease back',
    '    if (timer) clearTimeout(timer);\n    lease.release();', '    if (timer) clearTimeout(timer);'],
  [CORE, 'sendOnLease waits forever on a command that never settles',
    '(the lease on the tab was given back)`)), maxMs);', '(the lease on the tab was given back)`)), maxMs + 1e6);'],
  [CORE, 'a lease that outlived a detach decrements the NEXT attach',
    'if (this.tabs.get(tabId) === st) this.releaseTab(tabId);', 'this.releaseTab(tabId);'],
  [CORE, 'a lease released twice releases twice',
    '        if (!held) return;\n        held = false;', '        held = true;'],
  [CORE, 'a lease does not count as a holder (the debugger is released under it)',
    '    const st = await this.acquireTab(tabId);\n    let held = true;', '    const st = await this.acquireTab(tabId);\n    st.refs--;\n    let held = true;'],
];

const run = (files) => spawnSync('node', ['--test', '--experimental-strip-types', ...files], { cwd: root, encoding: 'utf8' });
function restoreAll() {
  for (const f of Object.keys(backups)) copyFileSync(backups[f], path.join(root, f));
  return Object.keys(backups).every((f) => readFileSync(path.join(root, f)).equals(readFileSync(backups[f])));
}
process.on('exit', () => { try { restoreAll(); } catch {} });

for (const f of Object.keys(TESTS)) {
  const base = run(TESTS[f]);
  if (base.status !== 0) { console.log(`BASELINE FAILS for ${f} — abort\n${base.stdout.slice(-1500)}`); process.exit(2); }
}
console.log('baseline PASS (seat + core tests)');

let killed = 0; const survivors = [];
for (const [file, name, find, replace] of MUTANTS) {
  const n = origs[file].split(find).length - 1;
  if (n !== 1) { console.log(`ABORT: mutant "${name}" find-string occurs ${n}x in ${file} (need exactly 1)`); restoreAll(); process.exit(2); }
  writeFileSync(path.join(root, file), origs[file].replace(find, replace));
  const r = run(TESTS[file]);
  restoreAll();
  const dead = r.status !== 0;
  if (dead) killed++; else survivors.push(name);
  console.log(`${dead ? 'KILLED  ' : 'SURVIVED'} ${name}${dead ? `  (${(r.stdout.match(/^not ok .*/gm) || []).length} arm(s) red)` : ''}`);
}
const same = restoreAll();
console.log(`\n${killed}/${MUTANTS.length} killed; restore byte-exact: ${same}`);
process.exit(survivors.length || !same ? 1 : 0);

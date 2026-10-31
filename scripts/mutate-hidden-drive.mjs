// #406 phase 2 — unit-level must-FAIL proof for the hidden-drive fixes: each mutant is applied IN PLACE to the real source, the test that owns the clause
// must go RED, and the file is restored byte-exact (cmp'd against a backup) whatever happens (also on SIGINT / SIGTERM). Each `from` string is checked
// LIVE (exactly one occurrence), so a drifted source fails loudly instead of "killing" nothing.
// Run: node scripts/mutate-hidden-drive.mjs [id ...]   (exit 0 = baseline green AND every mutant killed AND every file restored)
// Built-bundle mutants (the real app, real rig) live in scripts/e2e-browser-hidden-drive.mjs (`--mutant <name>`); this script needs no Electron.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BP = 'src/main/browser-panel.ts';
const CORE = 'src/shared/cdp-proxy-core.ts';
const DRIVE = 'src/shared/browser-hidden-drive.ts';
const TABS = 'src/main/browser-panel-tabs.test.ts';
const PROF = 'src/main/browser-panel-profiles.test.ts';
const CORE_T = 'src/shared/cdp-proxy-core-hidden-drive.test.ts';
const DRIVE_T = 'src/shared/browser-hidden-drive.test.ts';

const MUTANTS = [
  { id: 'lease-forgotten-on-removeView', file: BP, test: TABS, pattern: 'navigation under a LEASE',
    from: "  if (driveLeases.isHeld(id)) {\n    try {\n      liveContents(tab)?.setBackgroundThrottling(true); // the lease dies with the view's place in the window: nobody else would flip it back\n    } catch {\n      /* contents gone */\n    }\n  }\n", to: '' },
  { id: 'unpin-capture-not-owed-again', file: BP, test: TABS, pattern: 'unpin capture is owed again',
    from: '          if (driveLeases.isHeld(id)) pinnedLeases.add(id);\n', to: '' },
  { id: 'pulse-ignores-its-cover-leaving-hideView', file: BP, test: TABS, pattern: 'F2 the cover leaves',
    from: '  abortPulsesUnder(tab); // BEFORE the cover leaves the screen: a pulse hiding under it must not show in the vacated pane\n', to: '' },
  { id: 'pulse-ignores-its-cover-leaving-removeView', file: BP, test: TABS, pattern: 'F2 the cover TAB is closed',
    from: 'function removeView(tab: Tab): void {\n  abortPulsesUnder(tab);\n', to: 'function removeView(tab: Tab): void {\n' },
  { id: 'activated-pulsing-tab-not-protected', file: BP, test: TABS, pattern: 'F5 \\(a\\)',
    from: '  if (tab === coverTab()) {\n    // the human activated', to: '  if (false as boolean) {\n    // the human activated' },
  { id: 'load-wait-back-to-1.5s', file: BP, test: TABS, pattern: 'F3 a screenshot of a tab whose load',
    from: 'Date.now() - t0 < LOAD_SETTLE_MAX_MS && liveContents(tab)', to: 'Date.now() - t0 < SURFACE_PULSE_MAX_MS && liveContents(tab)' },
  { id: 'still-loading-not-refused-with-the-true-cause', file: BP, test: TABS, pattern: 'F3 a page that NEVER',
    from: '  if (stillLoading) {\n    removeView(tab); // it keeps loading detached; hiding a loading view is what hideView refuses\n    throw new Error(STILL_LOADING_MESSAGE);\n  }\n', to: '' },
  { id: 'paint-gate-removed', file: BP, test: TABS, pattern: 'F1 \\(a\\)',
    from: "  if (kind !== 'other' && !(await windowPaints())) throw new Error(OFFSCREEN_MESSAGE);", to: '' },
  { id: 'paint-probe-not-single-flight', file: BP, test: TABS, pattern: 'long absence costs ONE',
    from: '    if (!paintProbe) {\n      const probe', to: '    if (true as boolean) {\n      const probe' },
  { id: 'sway-answer-ignored', file: BP, test: TABS, pattern: 'sway KNOWS',
    from: '  if (sway !== null) {\n    paintVerdict', to: '  if (false as boolean) {\n    paintVerdict' },
  { id: 'hung-wake-not-a-stall', file: BP, test: TABS, pattern: 'F1 \\(b\\)',
    from: '  if (!done) paintVerdict = { at: Date.now(), ok: false };', to: '' },
  { id: 'navigation-detaches-the-VISIBLE-tab', file: BP, test: TABS, pattern: 'F5 \\(b\\)',
    from: "&& !(d.isSameDocument ?? isInPlace) && tab.surface === 'hidden') removeView(tab);", to: '&& !(d.isSameDocument ?? isInPlace)) removeView(tab);' },
  { id: 'reprofile-detaches-only-the-attached-view', file: BP, test: PROF, pattern: 'F5 \\(c\\)',
    from: '  for (const t of oldTabs) detachTab(panel, t); // every old view leaves the window (hidden ones included)', to: '  const attachedTab = oldTabs.find((t) => t.id === panel.attachedId);\n  if (attachedTab) detachTab(panel, attachedTab);' },
  { id: 'action-during-a-pulse-does-not-wait', file: BP, test: TABS, pattern: 'arrives during another action',
    from: "  if (inPulse) await inPulse; // another action's surface pulse on this tab: wait for it, then decide on the settled state\n", to: '' },
  { id: 'captures-of-one-tab-overlap', file: BP, test: TABS, pattern: 'never overlap',
    from: '(captureQueue.get(tab) ?? Promise.resolve()).then(() => captureTabFrameNow(wsId, tabId, opts))', to: 'captureTabFrameNow(wsId, tabId, opts)' },
  { id: 'surfaced-mark-reusable', file: BP, test: TABS, pattern: 'needs no prime',
    from: '    surfacedAt.delete(tab); // single use: only the capture of the action that surfaced the tab skips the prime\n', to: '' },
  { id: 'core-lease-never-capped', file: CORE, test: CORE_T, pattern: 'HANGS on a client',
    from: 'if (c?.closed || Date.now() - t0 >= this.leaseMaxMs) {', to: 'if (c?.closed) {' },
  { id: 'core-dispatches-for-a-client-that-left', file: CORE, test: CORE_T, pattern: 'disconnects while the lease is still being TAKEN',
    from: "        if (c?.closed) { // the client gave up while the lease was being taken (a surface pulse can take seconds): do not dispatch for nobody\n          lease.end();\n          throw new CdpError('Target closed.', ERR_SERVER);\n        }\n", to: '' },
  { id: 'core-forgets-the-device-metrics-override', file: CORE, test: CORE_T, pattern: 'told when the agent has an Emulation',
    from: "      if (method === 'Emulation.setDeviceMetricsOverride') st.metricsOverride = true;", to: "      if (method === 'Emulation.setDeviceMetricsOverride') st.metricsOverride = false;" },
  { id: 'scaled-clip-not-refused', file: DRIVE, test: DRIVE_T, pattern: 'hiddenCaptureRefusal',
    from: "if ((typeof scale === 'number' && scale !== 1) || info.deviceMetricsOverride) return DEVICE_METRICS_MESSAGE;", to: 'if (info.deviceMetricsOverride) return DEVICE_METRICS_MESSAGE;' },
];

const only = process.argv.slice(2);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? os.tmpdir() };
const node = (...a) => spawnSync('node', ['--test', '--experimental-strip-types', ...a], { cwd: ROOT, encoding: 'utf8', env });
const backups = new Map();
const backup = (file) => {
  if (!backups.has(file)) {
    const b = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mhd-')), path.basename(file));
    fs.copyFileSync(path.join(ROOT, file), b);
    backups.set(file, b);
  }
  return backups.get(file);
};
const restoreAll = () => {
  let ok = true;
  for (const [file, b] of backups) {
    fs.copyFileSync(b, path.join(ROOT, file));
    const same = fs.readFileSync(b).equals(fs.readFileSync(path.join(ROOT, file)));
    console.log(`restored ${file} byte-exact: ${same}`);
    ok &&= same;
  }
  return ok;
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restoreAll(); process.exit(130); });

let ok = true;
try {
  for (const t of [...new Set(MUTANTS.map((m) => m.test))]) {
    const r = node(t);
    const green = r.status === 0 && /# fail 0/.test(r.stdout) && /# skipped 0/.test(r.stdout);
    console.log(`baseline ${t}: ${green ? 'green' : 'RED'}`);
    ok &&= green;
  }
  if (!ok) throw new Error('baseline is not green: no mutant result would mean anything');
  for (const m of MUTANTS.filter((x) => !only.length || only.includes(x.id))) {
    const b = backup(m.file);
    const src = fs.readFileSync(b, 'utf8');
    const n = src.split(m.from).length - 1;
    if (n !== 1) { console.log(`INVALID  ${m.id}: the mutant string occurs ${n}x in ${m.file} (must be exactly 1) — the source drifted, update the mutant`); ok = false; continue; }
    fs.writeFileSync(path.join(ROOT, m.file), src.replace(m.from, () => m.to));
    const r = node('--test-name-pattern', m.pattern, m.test);
    fs.copyFileSync(b, path.join(ROOT, m.file));
    const failed = /^not ok /m.test(r.stdout), ran = /^ok |^not ok /m.test(r.stdout);
    const killed = r.status !== 0 && failed && ran;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${m.id}  <- ${killed ? (r.stdout.match(/^not ok \d+ - .{0,90}/m) ?? [''])[0] : `test pattern /${m.pattern}/ stayed green or did not run`}`);
    ok &&= killed;
  }
} finally {
  ok = restoreAll() && ok;
}
console.log(ok ? `\n${MUTANTS.length} mutants defined; all selected killed; all clean` : '\nFAILED');
process.exit(ok ? 0 : 1);

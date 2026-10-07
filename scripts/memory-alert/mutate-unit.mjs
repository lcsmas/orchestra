#!/usr/bin/env node
// In-place mutants of every clause of the memory ALERT (#289, wave G ledger #295). Each mutant edits the REAL source file, runs the unit files that can reach the clause, requires ≥1 test to go RED NAMING the expected
// arm, then restores the file from a BYTE-EXACT backup and `cmp`s it — never a reverse sed. A clean control run (0 red, 0 skipped) gates the whole harness, and every anchor must match EXACTLY ONCE (else PATTERN-GONE).
//   node scripts/memory-alert/mutate-unit.mjs [--only <id[,id]>] [--anchors-only]   →  last line: MUTATE-UNIT: PASS|FAIL (n/N caught)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const ONLY_SET = ONLY ? new Set(ONLY.split(',')) : null;
const POL = 'src/shared/memory-alert.ts', CORE = 'src/main/memory-alert.ts', HOST = 'src/main/memory-alert-host.ts', IDX = 'src/main/index.ts';
const T = { pure: 'src/shared/memory-alert.test.ts', unit: 'src/main/memory-alert.test.ts', wiring: 'src/main/memory-alert-wiring.test.ts', pm: 'src/main/pause-memory.test.ts' };

const M = [
  // ── pure half
  { id: 'sender-changed', file: POL, find: "export const ALERT_SENDER = 'host';", rep: "export const ALERT_SENDER = 'memory-guard';", tests: [T.pure, T.unit], expect: /constants|EPISODE row/ },
  { id: 'settle-changed', file: POL, find: "export const ALERT_SETTLE_MS = 20_000;", rep: "export const ALERT_SETTLE_MS = 5_000;", tests: [T.pure], expect: /constants/ },
  { id: 'body-next-step-dropped', file: POL, find: "    ep.critical\n      ? ''", rep: "    true\n      ? ''", tests: [T.pure, T.unit], expect: /BODY: threshold|EPISODE row/ },
  { id: 'body-next-step-even-when-critical', file: POL, find: "    ep.critical\n      ? ''", rep: "    false\n      ? ''", tests: [T.pure], expect: /BODY critical/ },
  { id: 'body-now-undated', file: POL, find: "`Now (${iso(f.at)}): ${now}.${over}`", rep: "`Now: ${now}.${over}`", tests: [T.pure, T.unit], expect: /BODY|EPISODE row/ },
  { id: 'body-no-critical', file: POL, find: "    (ep.critical ? ` and below the CRITICAL threshold (${formatGb(ep.critical.thresholdBytes, 2)}) at ${formatGb(ep.critical.availBytes, 2)}` : '');", rep: "    '';", tests: [T.pure, T.unit], expect: /BODY critical|EPISODE critical/ },
  { id: 'body-reopen-without-margin', file: POL, find: "const reopen = f.admissionBytes + f.releaseMarginBytes;", rep: "const reopen = f.admissionBytes;", tests: [T.pure, T.unit], expect: /BODY|EPISODE/ },
  { id: 'body-no-held-starts', file: POL, find: "`${f.heldStarts} automatic fleet start(s) HELD", rep: "`automatic fleet start(s) HELD", tests: [T.pure, T.unit], expect: /BODY|EPISODE row/ },
  { id: 'body-toggle-ignored', file: POL, find: "const held = f.admissionEnabled ? `", rep: "const held = true ? `", tests: [T.pure, T.unit], expect: /BODY states|toggle OFF/ },
  { id: 'body-no-veille', file: POL, find: " · ${f.veille} member(s) put in Veille since the crossing", rep: "", tests: [T.pure, T.unit], expect: /BODY|EPISODE row/ },
  { id: 'body-no-paused-runs', file: POL, find: "const paused = f.pausedRuns.length > 0 ? `memory Pause on run(s) ${f.pausedRuns.join(', ')} (lifted by the host above ${formatGb(f.admissionBytes, 2)})` : 'no run under the memory Pause';", rep: "const paused = 'no run under the memory Pause';", tests: [T.pure, T.unit], expect: /BODY critical|EPISODE row/ },
  { id: 'body-no-unattributed-field', file: POL, find: " · ${f.unattributedContainers} unattributed container(s) (not measured yet — #293)", rep: "", tests: [T.pure, T.unit], expect: /BODY|EPISODE row/ },
  { id: 'body-over-clause-removed', file: POL, find: "const over = ep.endedAt !== null ? ` The episode is already OVER (memory back above ${formatGb(reopen, 2)} at ${iso(ep.endedAt)}).` : '';", rep: "const over = '';", tests: [T.pure, T.unit], expect: /BODY states|EPISODE end before settle/ },
  { id: 'body-now-unmeasured-shown', file: POL, find: "MemAvailable ${f.nowAvailBytes === null ? 'unreadable' : formatGb(f.nowAvailBytes, 2)}", rep: "MemAvailable ${formatGb(f.nowAvailBytes ?? 0, 2)}", tests: [T.pure], expect: /BODY states/ },
  // ── bus half
  { id: 'recipients-all-fleet-runs', file: CORE, find: "  return topmostRunIds(db, deps, [...readers.keys()]).map((runId) => ({ runId, coordinator: readers.get(runId)! }));", rep: "  return [...readers.keys()].map((runId) => ({ runId, coordinator: readers.get(runId)! }));", tests: [T.unit], expect: /LEAD rule/ },
  { id: 'recipients-topmost-before-readers', file: CORE, find: "topmostRunIds(db, deps, [...readers.keys()])", rep: "topmostRunIds(db, deps, liveFleetRuns(db, deps).map((f) => f.id)).filter((id) => readers.has(id))", tests: [T.unit, T.wiring], expect: /LEAD rule: readers are filtered BEFORE|WIRING memory-alert\.ts is Electron-free/ },
  { id: 'recipients-delivery-ignored', file: CORE, find: "    if (r.flags.delivery !== true) continue; // a run without the delivery mechanism has nobody who can read a bus row\n", rep: "", tests: [T.unit, T.wiring], expect: /LEAD rule|WIRING memory-alert\.ts is Electron-free/ },
  { id: 'recipients-gone-coordinator-told', file: CORE, find: "    if (!run || !w || w.archived) continue; // a gone coordinator reads nothing\n", rep: "    if (!run) continue;\n", tests: [T.unit], expect: /LEAD rule/ },
  { id: 'recipients-no-fleet-told', file: CORE, find: "  for (const r of liveFleetRuns(db, deps)) {", rep: "  for (const r of db.prepare('SELECT id FROM runs').all().map((x) => ({ id: String((x as { id: string }).id), flags: { delivery: true } as never }))) {", tests: [T.unit], expect: /LEAD rule/ },
  { id: 'recipient-wrong-run', file: CORE, find: "send(db, { runId: r.runId, sender: ALERT_SENDER, recipient: r.coordinator, kind: 'escalation', body })", rep: "send(db, { runId: 'default', sender: ALERT_SENDER, recipient: r.coordinator, kind: 'escalation', body })", tests: [T.unit, T.wiring], expect: /EPISODE row|WIRING memory-alert\.ts is Electron-free/ },
  { id: 'row-not-escalation', file: CORE, find: "kind: 'escalation', body });", rep: "kind: 'status', body });", tests: [T.unit, T.wiring], expect: /EPISODE oscillation|EPISODE row|WIRING memory-alert\.ts is Electron-free/ },
  { id: 'send-failure-aborts-the-other-leads', file: CORE, find: "          deps.log.warn(`memory-alert: episode ${t.ep.episode} NOT written to ${r.coordinator} (run ${r.runId}) — the other lead(s) are still told`, e); // at-most-once per recipient", rep: "          throw e;", tests: [T.unit], expect: /RETRY: an unavailable bus/ },
  { id: 'prepare-failure-not-retried', file: CORE, find: "      if (retry) (t.tries++, arm(t));", rep: "", tests: [T.unit], expect: /RETRY: a failure BEFORE/ },
  { id: 'prepare-retry-unbounded', file: CORE, find: "const retry = !t.sent && t.tries + 1 < MAX_TRIES;", rep: "const retry = !t.sent;", tests: [T.unit], expect: /RETRY: a failure BEFORE/ },
  // ── G6 review (F1/F4): the EFFECTIVE state in the row, and the clauses the reviewer's sweep found unpinned
  { id: 'now-pause-from-guard-flag', file: CORE, find: "nowPause: pausedRuns.length > 0,", rep: "nowPause: snap.pause === 'held',", tests: [T.unit], expect: /ROW now-line/ },
  { id: 'now-pause-always-off', file: CORE, find: "nowPause: pausedRuns.length > 0,", rep: "nowPause: false,", tests: [T.unit], expect: /ROW now-line|EPISODE row/ },
  { id: 'now-admission-from-raw-flag', file: CORE, find: "nowAdmissionHeld: isAdmissionHolding(snap),", rep: "nowAdmissionHeld: snap.admission === 'held',", tests: [T.unit], expect: /ROW now-line/ },
  { id: 'now-admission-always-held', file: CORE, find: "nowAdmissionHeld: isAdmissionHolding(snap),", rep: "nowAdmissionHeld: true,", tests: [T.unit], expect: /ROW now-line|BODY now-line/ },
  { id: 'body-toggle-off-reads-held', file: POL, find: "${f.nowAdmissionHeld ? 'HELD' : !f.admissionEnabled ? 'OFF (toggle)' : 'open'}", rep: "${f.nowAdmissionHeld ? 'HELD' : 'open'}", tests: [T.pure, T.unit], expect: /BODY now-line|ROW now-line/ },
  { id: 'closing-act-yourself-dropped', file: POL, find: "    ep.critical && !anyPaused && ep.endedAt === null\n", rep: "    false\n", tests: [T.pure, T.unit], expect: /BODY closing|ROW now-line/ },
  { id: 'closing-act-yourself-ignores-paused', file: POL, find: "    ep.critical && !anyPaused && ep.endedAt === null\n", rep: "    ep.critical && ep.endedAt === null\n", tests: [T.pure, T.unit], expect: /BODY closing|ROW now-line/ },
  { id: 'closing-act-yourself-when-over', file: POL, find: "    ep.critical && !anyPaused && ep.endedAt === null\n", rep: "    ep.critical && !anyPaused\n", tests: [T.pure, T.unit], expect: /BODY closing|ROW now-line/ },
  { id: 'closing-need-not-act-lists-held-always', file: POL, find: "f.admissionEnabled ? 'releases the held starts' : null", rep: "'releases the held starts'", tests: [T.pure], expect: /BODY closing/ },
  { id: 'closing-need-not-act-lists-paused-always', file: POL, find: "anyPaused ? 'lifts its own memory Pause' : null", rep: "'lifts its own memory Pause'", tests: [T.pure], expect: /BODY closing/ },
  { id: 'closing-toggle-off-line-dropped', file: POL, find: "!f.admissionEnabled && !anyPaused ?", rep: "false ?", tests: [T.pure, T.unit], expect: /BODY closing|ROW now-line/ },
  { id: 'next-ignores-eligibility', file: POL, find: "      : f.eligibleRuns > 0\n", rep: "      : true\n", tests: [T.pure, T.unit], expect: /BODY next-step|ROW now-line|BODY now-line|EPISODE row/ },
  { id: 'eligible-runs-constant', file: CORE, find: "eligibleRuns: memoryPauseCandidates(db, deps).length,", rep: "eligibleRuns: 1,", tests: [T.unit], expect: /ROW now-line/ },
  { id: 'over-closing-dropped', file: POL, find: "      : ep.endedAt !== null\n        ? `", rep: "      : false\n        ? `", tests: [T.pure, T.unit], expect: /BODY closing|ROW now-line/ },
  { id: 'act-yourself-names-no-action', file: POL, find: "if it is still running at critical memory, pause it (`orchestra run pause --hard --run <id>`).", rep: "", tests: [T.pure, T.unit], expect: /BODY closing|ROW now-line/ },
  { id: 'reconcile-open-no-settle', file: CORE, find: "          for (const t of tracked.values()) if (!t.sent && t.ep.endedAt === null) (t.ep.endedAt = deps.now(), settle(t));\n", rep: "", tests: [T.unit], expect: /RECONCILE open branch/ },
  { id: 'pause-due-untracked-never-opens', file: CORE, find: "const t = tracked.get(tr.episode) ?? open(tr.episode, { at: e.snapshot.heldSince ?? now, availBytes: tr.availBytes, thresholdBytes: e.snapshot.admissionBytes });", rep: "const t = tracked.get(tr.episode);\n          if (!t) return;", tests: [T.unit], expect: /EDGE pause_due for an episode/ },
  { id: 'pause-due-untracked-at-now', file: CORE, find: "{ at: e.snapshot.heldSince ?? now, availBytes: tr.availBytes, thresholdBytes: e.snapshot.admissionBytes }", rep: "{ at: now, availBytes: tr.availBytes, thresholdBytes: e.snapshot.admissionBytes }", tests: [T.unit], expect: /EDGE pause_due for an episode/ },
  { id: 'reconcile-since-is-now', file: CORE, find: "open(snapshot.episode, { at: snapshot.heldSince ?? deps.now(),", rep: "open(snapshot.episode, { at: deps.now(),", tests: [T.unit], expect: /RECONCILE stamps/ },
  { id: 'bus-retry-off-by-one', file: CORE, find: "if (++t.tries < MAX_TRIES) arm(t);", rep: "if (t.tries++ < MAX_TRIES) arm(t);", tests: [T.unit], expect: /RETRY is bounded/ },
  { id: 'prepare-retry-off-by-one', file: CORE, find: "const retry = !t.sent && t.tries + 1 < MAX_TRIES;", rep: "const retry = !t.sent && t.tries < MAX_TRIES;", tests: [T.unit], expect: /RETRY is bounded/ },
  { id: 'told-marked-after-writes', file: CORE, find: "      t.sent = true; // BEFORE the writes: a throw half-way must not make the next edge write the same episode again\n", rep: "", tests: [T.unit, T.wiring], expect: /RETRY: an unavailable bus|WIRING memory-alert\.ts is Electron-free/ },
  // TWO LAYERS cover each other (the write's own `sent` guard AND the reopen edge's `!t.sent`): the mutant removes BOTH — the reopen edge then writes an episode that is already told.
  { id: 'sent-guard-removed', file: CORE, edits: [
    { find: "    if (t.sent) return;\n    try {", rep: "    try {" },
    { find: "            if (!t.sent) settle(t); // the episode ended before its settle window: tell it now", rep: "            settle(t);" },
  ], tests: [T.unit], expect: /EPISODE oscillation|EPISODE end before settle/ },
  { id: 'timer-not-armed', file: CORE, find: "    tracked.set(episode, t);\n    arm(t);\n    return t;", rep: "    tracked.set(episode, t);\n    return t;", tests: [T.unit], expect: /EPISODE oscillation|EPISODE row|EPISODE critical|RECONCILE/ },
  { id: 'episode-reopen-on-every-edge', file: CORE, find: "          if (!tracked.has(tr.episode)) open(tr.episode, { at: now, availBytes: tr.availBytes, thresholdBytes: tr.thresholdBytes });", rep: "          open(tr.episode, { at: now, availBytes: tr.availBytes, thresholdBytes: tr.thresholdBytes });", tests: [T.unit], expect: /RECONCILE then the SAME episode/ },
  { id: 'reconcile-always-opens', file: CORE, find: "        if (tracked.has(snapshot.episode)) return;\n", rep: "", tests: [T.unit], expect: /RECONCILE \(FI-2\.5\)/ },
  { id: 'reconcile-unmeasured-opens', file: CORE, find: "if (!snapshot.sampled || !snapshot.measured || snapshot.availBytes === null) return;", rep: "if (!snapshot.sampled) return;", tests: [T.unit], expect: /RECONCILE unknown/ },
  { id: 'reconcile-no-critical', file: CORE, find: "        if (snapshot.pause === 'held') criticalOf(t, snapshot.pauseSince ?? deps.now(), snapshot.availBytes, snapshot.criticalBytes, snapshot.pauseCycle);\n", rep: "", tests: [T.unit], expect: /RECONCILE: a boot while the memory Pause/ },
  { id: 'end-not-told-at-once', file: CORE, find: "            if (!t.sent) settle(t); // the episode ended before its settle window: tell it now\n", rep: "", tests: [T.unit], expect: /EPISODE end before settle/ },
  { id: 'end-time-not-recorded', file: CORE, find: "            t.ep.endedAt = now;\n", rep: "", tests: [T.unit], expect: /EPISODE end before settle/ },
  { id: 'critical-edge-ignored', file: CORE, find: "          criticalOf(t, now, tr.availBytes, tr.thresholdBytes, tr.pauseCycle);", rep: "          void t;", tests: [T.unit], expect: /EPISODE critical/ },
  { id: 'critical-last-wins', file: CORE, find: "    if (!t.ep.critical) t.ep.critical = { at, availBytes, thresholdBytes, pauseCycle };", rep: "    t.ep.critical = { at, availBytes, thresholdBytes, pauseCycle };", tests: [T.unit], expect: /EPISODE critical|RECONCILE: a boot while the memory Pause/ },
  { id: 'store-not-ready-writes', file: CORE, find: "      if (!db || (deps.storeReady && !deps.storeReady())) {", rep: "      if (!db) {", tests: [T.unit], expect: /RETRY: a store that is not loaded/ },
  { id: 'retries-unbounded-one', file: CORE, find: "const MAX_TRIES = 6;", rep: "const MAX_TRIES = 1;", tests: [T.unit], expect: /RETRY: an unavailable bus/ },
  { id: 'no-retry-rearm', file: CORE, find: "        if (++t.tries < MAX_TRIES) arm(t);", rep: "        if (++t.tries < 0) arm(t);", tests: [T.unit], expect: /RETRY: an unavailable bus|RETRY: a store/ },
  { id: 'facts-held-starts-zero', file: CORE, find: "        heldStarts: deps.heldStarts(),", rep: "        heldStarts: 0,", tests: [T.unit], expect: /EPISODE row/ },
  { id: 'facts-veille-zero', file: CORE, find: "        veille: deps.veilleSince(t.ep.admission.at),", rep: "        veille: 0,", tests: [T.unit], expect: /EPISODE row/ },
  { id: 'facts-paused-runs-empty', file: CORE, find: "        veille: deps.veilleSince(t.ep.admission.at),\n        pausedRuns,\n", rep: "        veille: deps.veilleSince(t.ep.admission.at),\n        pausedRuns: [],\n", tests: [T.unit], expect: /EPISODE row/ },
  { id: 'facts-unattributed-constant', file: CORE, find: "        unattributedContainers: deps.unattributedContainers(),", rep: "        unattributedContainers: 0,", tests: [T.unit], expect: /EPISODE row|facts/ },
  { id: 'facts-now-memory-stale', file: CORE, find: "        nowAvailBytes: snap.availBytes === null ? null : snap.measured ? snap.availBytes : null,", rep: "        nowAvailBytes: t.ep.admission.availBytes,", tests: [T.unit], expect: /EPISODE end before settle|EPISODE row/ },
  { id: 'stop-leaves-timers', file: CORE, find: "      for (const t of tracked.values()) {\n        if (t.timer !== null) deps.cancel(t.timer);\n        t.timer = null;\n      }", rep: "", tests: [T.unit], expect: /STOP/ },
  { id: 'edge-throw-propagates', file: CORE, find: "        deps.log.warn(`memory-alert: handling ${tr.kind} failed`, err);", rep: "        throw err;", tests: [T.unit], expect: /EDGE failure/ },
  // ── host binding + wiring
  { id: 'host-reconcile-before-subscribe', file: HOST, edits: [
    { find: "  if (unsubscribe) return;\n  unsubscribe = subscribeMemoryGuard((e) => alert.onEdge(e));\n  alert.reconcile(getMemoryGuardSnapshot());\n", rep: "  if (unsubscribe) return;\n  alert.reconcile(getMemoryGuardSnapshot());\n  unsubscribe = subscribeMemoryGuard((e) => alert.onEdge(e));\n" },
  ], tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'host-edges-not-subscribed', file: HOST, find: "  unsubscribe = subscribeMemoryGuard((e) => alert.onEdge(e));", rep: "  unsubscribe = subscribeMemoryGuard(() => undefined);", tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'host-held-starts-unbound', file: HOST, find: "  heldStarts: () => listHeldStarts().length,", rep: "  heldStarts: () => 0,", tests: [T.wiring], expect: /WIRING host: the real store/ },
  { id: 'host-veille-wrong-field', file: HOST, find: "(w.hibernatedAt ?? 0) >= at)", rep: "(w.lastTaskAt ?? 0) >= at)", tests: [T.wiring], expect: /WIRING host: the real store/ },
  { id: 'host-store-ready-dropped', file: HOST, find: "  storeReady: () => store.loadedFromDisk,\n", rep: "", tests: [T.wiring], expect: /WIRING host: the real store/ },
  { id: 'index-alert-removed', file: IDX, find: "  startMemoryAlert();\n", rep: "", tests: [T.wiring], expect: /WIRING index\.ts/ },
  { id: 'index-alert-before-pause', file: IDX, edits: [
    { find: "  startMemoryAlert();\n", rep: "" },
    { find: "  startMemoryPause();\n", rep: "  startMemoryAlert();\n  startMemoryPause();\n" },
  ], tests: [T.wiring], expect: /WIRING index\.ts/ },
  { id: 'index-alert-stop-removed', file: IDX, find: "  stopMemoryAlert();\n", rep: "", tests: [T.wiring], expect: /WIRING index\.ts/ },
  { id: 'core-imports-store', file: CORE, find: "import { getRun } from './bus-runs.ts';", rep: "import { getRun } from './bus-runs.ts';\nimport { store as _s } from './store.ts';", tests: [T.wiring], expect: /WIRING memory-alert\.ts is Electron-free/ },
];

const sel = ONLY ? M.filter((m) => ONLY_SET.has(m.id)) : M;
if (sel.length === 0) { console.error(`unknown mutant ${ONLY}`); process.exit(2); }

// --anchors-only: every anchor must match the CURRENT source exactly once, and every `expect` must match the TITLE of a test in the mutant's own files (an expect naming a renamed test can never be "caught").
if (process.argv.includes('--anchors-only')) {
  let gone = 0;
  for (const m of sel) {
    const src = fs.readFileSync(path.join(REPO, m.file), 'utf8');
    for (const e of (m.edits ?? [{ find: m.find }])) {
      const hits = src.split(e.find).length - 1;
      if (hits !== 1) { gone++; console.log(`✗ ${m.id}: anchor matched ${hits}× in ${m.file}: ${e.find.slice(0, 70)}`); }
    }
  }
  const titlesOf = (f) => [...fs.readFileSync(path.join(REPO, f), 'utf8').matchAll(/\btest\((['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((x) => x[2].replace(/\\'/g, "'"));
  for (const m of sel) {
    const titles = m.tests.flatMap(titlesOf);
    if (!titles.some((t) => m.expect.test(t.replace(/#/g, '\\#')) || m.expect.test(t))) { gone++; console.log(`✗ ${m.id}: expect ${m.expect} matches no test title in ${m.tests.join(', ')}`); }
  }
  console.log(`ANCHORS: ${gone === 0 ? 'OK' : 'FAIL'} (${sel.length} mutants, ${gone} stale)`);
  process.exit(gone === 0 ? 0 : 1);
}

// ASYNC on purpose: a synchronous spawn keeps the event loop busy for the whole run, so the SIGINT/SIGTERM restore handler below could never fire and a killed harness left the source MUTATED.
function runTests(files) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', ...files], { cwd: REPO });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('close', () => { clearTimeout(timer); resolve(parseRun(out)); });
  });
}
function parseRun(out) {
  const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN);
  const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(out)?.[1] ?? NaN);
  const red = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { fail, pass, skipped, red, raw: out };
}
function rebuildCli() { // the CLI-side mutants (run-status.ts) exec the BUILT bundle: rebuild it under the mutation and again after the restore
  const r = spawnSync('pnpm', ['run', 'build:cli'], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) { console.error(`build:cli failed rc=${r.status}: ${(r.stderr ?? '').slice(-300)}`); process.exit(3); }
}
rebuildCli(); // a stale bundle makes the control vacuous
const allFiles = [...new Set(sel.flatMap((m) => m.tests))];
const control = await runTests(allFiles);
console.log(`control (clean tree, ${allFiles.length} files): pass ${control.pass}, fail ${control.fail}, skipped ${control.skipped}`);
if (control.fail !== 0 || !(control.pass > 0) || control.skipped !== 0) { console.log(`MUTATE-UNIT: FAIL — the clean control is not green with 0 skipped (${control.red.join(' | ')})`); process.exit(1); }

let caught = 0;
const bak = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-unit-memory-alert-'));
let activeRestore = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { activeRestore?.(); } catch { /* best effort */ } process.exit(130); });
for (const m of sel) {
  const abs = path.join(REPO, m.file);
  const backup = path.join(bak, `${m.id}.bak`);
  fs.copyFileSync(abs, backup);
  const src = fs.readFileSync(abs, 'utf8');
  const edits = m.edits ?? [{ find: m.find, rep: m.rep }];
  const bad = edits.map((e) => ({ e, hits: src.split(e.find).length - 1 })).find((x) => x.hits !== 1);
  if (bad) { console.log(`✗ ${m.id}: PATTERN-GONE — anchor matched ${bad.hits}× in ${m.file} (want exactly 1): ${bad.e.find.slice(0, 70)}`); continue; }
  let res;
  activeRestore = () => fs.copyFileSync(backup, abs);
  try {
    fs.writeFileSync(abs, edits.reduce((acc, e) => acc.replace(e.find, () => e.rep), src));
    if (m.build) rebuildCli();
    res = await runTests(m.tests);
  } finally {
    fs.copyFileSync(backup, abs); // byte-exact restore
    activeRestore = null;
    if (m.build) rebuildCli();
  }
  const restored = spawnSync('cmp', [abs, backup]).status === 0;
  const named = res.red.filter((n) => m.expect.test(n) || m.expect.test(n.replace(/\\#/g, '#')));
  const ok = restored && res.red.length > 0 && named.length > 0;
  if (ok) caught++;
  console.log(`${ok ? '✓' : '✗'} ${m.id}: ${res.red.length} red${named.length ? ` — named arm: ${named[0].slice(0, 90)}` : res.red.length ? ` — RED BUT NOT THE EXPECTED ARM (${res.red[0].slice(0, 80)})` : ' — SURVIVED'}${restored ? '' : ' — NOT RESTORED'}`);
}
const gitDirty = spawnSync('git', ['diff', '--quiet', '--', ...[...new Set(sel.map((m) => m.file))]], { cwd: REPO }).status;
fs.rmSync(bak, { recursive: true, force: true });
const post = await runTests(allFiles);
console.log(`post-restore control: pass ${post.pass}, fail ${post.fail}, skipped ${post.skipped}; changed vs index for mutated files: ${gitDirty === 0 ? 'no' : 'yes (uncommitted edits exist — compare with cmp above)'}`);
const ok = caught === sel.length && post.fail === 0 && post.skipped === 0;
console.log(`MUTATE-UNIT: ${ok ? 'PASS' : 'FAIL'} (${caught}/${sel.length} caught)`);
process.exit(ok ? 0 : 1);

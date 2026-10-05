#!/usr/bin/env node
// In-place mutants of every clause of the fleet-Pause UI layer (#257, wave F ledger #281 G2). Same mechanics as scripts/pause-trap/mutate-unit.mjs: each mutant edits the REAL
// source file, runs the unit files that can reach the clause, requires ≥1 test to go RED AND one whose title matches `expect`, then restores the file from a BYTE-EXACT backup and
// `cmp`s it — never a reverse sed. A clean control run gates the harness, and every anchor must match EXACTLY ONCE (else PATTERN-GONE: a mutant that matched nothing would "survive" vacuously).
//   node scripts/pause-ui/mutate-unit.mjs [--only <id>[,<id>…]] [--anchors-only]   →  last line: MUTATE-UNIT: PASS|FAIL (n/N caught)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argIdx = process.argv.indexOf('--only');
const ONLY_SET = argIdx >= 0 ? new Set(process.argv[argIdx + 1].split(',')) : null;
const MAIN = 'src/main/pause-ui.ts', SH = 'src/shared/pause-ui.ts', HOST = 'src/main/pause-ui-host.ts', IDX = 'src/main/index.ts', PRE = 'src/preload/index.ts', API = 'src/main/api-handlers.ts';
const T = { main: 'src/main/pause-ui.test.ts', shared: 'src/shared/pause-ui.test.ts', wiring: 'src/main/pause-ui-wiring.test.ts' };

const M = [
  // ── who acts / which run (pause-ui.ts)
  { id: 'actor-is-run-coordinator', file: MAIN, find: '  const actor = uiActor(req.wsId);\n  // an unknown mode is REFUSED', rep: '  const actor = t.runId;\n  // an unknown mode is REFUSED', tests: [T.main], expect: /REFUSAL — a WORKER row/ },
  { id: 'target-run-is-the-clicked-ws', file: MAIN, find: 'return { ws, runId: own ? ws.id : nearestOrchestratorId(ws, deps.getWorkspace) };', rep: 'return { ws, runId: ws.id };', tests: [T.main], expect: /REFUSAL — a WORKER row/ },
  { id: 'pause-mode-dropped', file: MAIN, find: 'setRunPause(db, t.runId, true, actor, req.mode)', rep: 'setRunPause(db, t.runId, true, actor)', tests: [T.main], expect: /uiPause as an ORCHESTRATOR row/ },
  { id: 'resume-cover-dropped', file: MAIN, find: '    if (c && c.runId !== t.runId) cover = {', rep: '    if (false && c && c.runId !== t.runId) cover = {', tests: [T.main], expect: /uiResume: not-paused/ },
  { id: 'resume-reason-not-manual', file: MAIN, find: "beginReprise(db, t.runId, actor, { reason: 'manual' })", rep: "beginReprise(db, t.runId, actor, { host: true, reason: 'usage_limit' })", tests: [T.main], expect: /uiResume: not-paused/ },
  { id: 'release-wrong-carrier', file: MAIN, find: 'result = releaseMembers(db, carrier ?? t.runId, actor, req.targets);', rep: 'result = releaseMembers(db, t.runId, actor, req.targets);', tests: [T.main], expect: /FULL CYCLE/ },
  { id: 'release-carrier-not-resolved', file: MAIN, find: 'carrier = req.carrierRunId ?? resumingCarrierFor(db, t.runId, liveChainIds(deps, req.wsId));', rep: 'carrier = req.carrierRunId ?? null;', tests: [T.main], expect: /FULL CYCLE/ },
  // ── the read
  { id: 'overview-trusts-stale-column', file: MAIN, find: '  if (!pv || pv.carrierRunId !== carrierId) return null;', rep: '  if (!pv) return null;', tests: [T.main], expect: /stale pause column on a switch-OFF CHILD/ },
  { id: 'overview-down-bus-looks-empty', file: MAIN, find: "  if (!db) return unavailableOverview('The fleet bus is not open (see the log for the open failure).', at);", rep: "  if (!db) return { available: true, error: null, at, runs: [], controls: {}, byWorkspace: {} };", tests: [T.main], expect: /overview with no bus/ },
  { id: 'overview-throw-looks-empty', file: MAIN, find: "    return unavailableOverview(`pause overview failed: ${e instanceof Error ? e.message : String(e)}`, at);", rep: "    return { available: true, error: null, at, runs: [], controls: {}, byWorkspace: {} };", tests: [T.main], expect: /overview survives a read that throws/ },
  { id: 'badge-released-before-blocking', file: MAIN, find: 'const carrier = pausedCarrierForWorkspace(db, ws, deps.getWorkspace) ?? pausedCarrierForWorkspace(db, ws, deps.getWorkspace, { includeReleased: true });', rep: 'const carrier = pausedCarrierForWorkspace(db, ws, deps.getWorkspace, { includeReleased: true });', tests: [T.main], expect: /RELEASED by an inner carrier/ },
  { id: 'badge-unenrolled-reads-none', file: MAIN, find: "ui: row ? memberUiState(phase, row) : phase === 'resuming' ? 'blocked' : 'pausing',", rep: "ui: row ? memberUiState(phase, row) : phase === 'resuming' ? 'blocked' : 'paused',", tests: [T.main], expect: /uiPause as an ORCHESTRATOR row/ },
  { id: 'badge-unenrolled-resuming-open', file: MAIN, find: "ui: row ? memberUiState(phase, row) : phase === 'resuming' ? 'blocked' : 'pausing',", rep: "ui: row ? memberUiState(phase, row) : 'pausing',", tests: [T.main], expect: /JOINS the tree during the Reprise/ },
  { id: 'controls-for-workers', file: MAIN, find: '      if (!nodeOrchestrates(ws) && !ownsRun) continue;', rep: '      if (false) continue;', tests: [T.main], expect: /nothing paused: no run, no badge/ },
  { id: 'anchored-always-true', file: MAIN, find: 'const anchored = run !== null && isCoordinatorHandle(run.coordinator, ws.id);', rep: 'const anchored = run !== null;', tests: [T.main], expect: /ANOTHER coordinator is not anchored/ },
  { id: 'controls-phase-ignores-switch', file: MAIN, find: '      const phase: PausePhase = cols && switchOn === true\n', rep: '      const phase: PausePhase = cols\n', tests: [T.main], expect: /FROZEN switch is OFF is not a pause/ },
  { id: 'bilan-killed-uncapped', file: MAIN, find: 'killed: merged.slice(-KILLED_CAP).map(', rep: 'killed: merged.map(', tests: [T.main], expect: /toBilanLine reads the REAL killed_json/ },
  { id: 'bilan-pauser-flag-forced', file: MAIN, find: "exempt: a?.exempt === 'pauser' || a?.interrupt === 'exempt',", rep: 'exempt: true,', tests: [T.main], expect: /FULL CYCLE/ },
  { id: 'closed-reprise-untracked', file: MAIN, find: "  if (!rp || rp.carrier !== carrierId || rp.phase !== 'active') return null;", rep: '  return null;', tests: [T.main], expect: /FULL CYCLE/ },
  // ── pure explainers / state (shared)
  { id: 'member-state-resumed-lost', file: SH, find: "return row.repriseConfirmedAt !== null ? 'resumed' : 'released';", rep: "return 'released';", tests: [T.shared], expect: /memberUiState/ },
  { id: 'member-state-hard-unconfirmed-paused', file: SH, find: "return row.pauseConfirmedAt !== null ? 'paused' : 'pausing';", rep: "return 'paused';", tests: [T.shared], expect: /memberUiState/ },
  { id: 'member-state-release-ignored', file: SH, find: "    if (row.releasedAt === null) return 'blocked';", rep: "    if (row.releasedAt === null) return 'released';", tests: [T.shared], expect: /memberUiState/ },
  { id: 'explain-refused-names-nobody', file: SH, find: "        fix: c.mayBe.map((id, i) =>", rep: "        fix: ([] as string[]).map((id, i) =>", tests: [T.shared], expect: /explainPauseOutcome/ },
  { id: 'explain-switch-off-silent', file: SH, find: "    case 'switch-off':\n      return {", rep: "    case 'switch-off':\n      return null;\n      return {", tests: [T.shared, T.main], expect: /explainPauseOutcome|REFUSAL — switch OFF/ },
  { id: 'explain-covered-unnamed', file: SH, find: "      return c.cover\n        ? {", rep: "      return false && c.cover\n        ? {", tests: [T.shared], expect: /explainResumeOutcome/ },
  { id: 'explain-below-silent', file: SH, find: '  if (r.below.length) {', rep: '  if (false && r.below.length) {', tests: [T.shared], expect: /explainReleaseResult/ },
  { id: 'explain-release-refused-silent', file: SH, find: '  if (r.refused.length) {', rep: '  if (false && r.refused.length) {', tests: [T.shared], expect: /explainReleaseResult/ },
  { id: 'explain-unknown-outcome-invented', file: SH, find: "    default:\n      return null;\n  }\n}\n\n/** The `beginReprise` outcome", rep: "    default:\n      return { tone: 'error', title: 'Erreur', why: outcome, fix: [] };\n  }\n}\n\n/** The `beginReprise` outcome", tests: [T.shared], expect: /explainPauseOutcome/ },
  { id: 'avail-switch-off-ignored', file: SH, find: "const pausable: PauseUiAvailability = i.switchOn === false ? no('switch-off') : authority;", rep: 'const pausable: PauseUiAvailability = authority;', tests: [T.shared], expect: /availabilityFor/ },
  { id: 'avail-worker-allowed', file: SH, find: "const authority = i.anchored ? ok : no('refused');", rep: 'const authority = ok;', tests: [T.shared], expect: /availabilityFor/ },
  { id: 'avail-covered-resume-allowed', file: SH, find: "resume: i.phase === 'active' ? (i.covered ? no('covered') : no('not-paused'))", rep: "resume: i.phase === 'active' ? no('not-paused')", tests: [T.shared], expect: /availabilityFor/ },
  { id: 'avail-release-outside-reprise', file: SH, find: "release: i.phase === 'resuming' ? authority : no('not-resuming'),", rep: 'release: authority,', tests: [T.shared], expect: /availabilityFor/ },
  // ── host wiring
  { id: 'host-write-not-republished', file: HOST, find: "as ${res.actor ?? '?'} → ${res.outcome}`);\n    return afterWrite(res);\n  });\n  ipcMain.handle('pause:resume'", rep: "as ${res.actor ?? '?'} → ${res.outcome}`);\n    return res;\n  });\n  ipcMain.handle('pause:resume'", tests: [T.wiring], expect: /every write re-publishes/ },
  { id: 'host-fingerprint-skip-removed', file: HOST, find: '  if (!force && key === lastKey) return null;', rep: '', tests: [T.wiring], expect: /every write re-publishes/ },
  { id: 'host-overview-marked-write', file: HOST, find: "{ channel: 'pause:overview', writes: false,", rep: "{ channel: 'pause:overview', writes: true,", tests: [T.wiring], expect: /enumerated with their read\/write marks/ },
  { id: 'host-write-unlisted', file: HOST, find: "  { channel: 'pause:release', writes: true, what: 'releaseMembers (<ws>… | all) as the workspace row' },\n", rep: '', tests: [T.wiring], expect: /enumerated with their read\/write marks/ },
  { id: 'ui-raw-sql-write-after-a-select', file: MAIN, find: 'const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;', rep: "const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;\n  db.exec('UPDATE runs SET paused_at = NULL');", tests: [T.wiring], expect: /NO SECOND WRITE PATH/ },
  { id: 'index-register-inside-window', file: IDX, find: '\nregisterPauseUiIpc();', rep: '\n  registerPauseUiIpc();', tests: [T.wiring], expect: /MODULE scope/ },
  { id: 'index-no-watcher-stop', file: IDX, find: '  stopPauseUiWatcher();', rep: '', tests: [T.wiring], expect: /MODULE scope/ },
  { id: 'preload-channel-typo', file: PRE, find: "ipcRenderer.invoke('pause:resume', wsId)", rep: "ipcRenderer.invoke('pause:resumee', wsId)", tests: [T.wiring], expect: /preload maps every/ },
  { id: 'preload-push-channel-typo', file: PRE, find: "ipcRenderer.on('pause:update', listener);", rep: "ipcRenderer.on('pause:updated', listener);", tests: [T.wiring], expect: /preload maps every/ },
  { id: 'api-write-served-generically', file: API, find: "  | 'pausePause'\n", rep: '', tests: [T.wiring], expect: /NOT registered through the read-only/ },
];
// the UI components' own clause mutants (phase 2) live in their own file, same schema
if (fs.existsSync(path.join(REPO, 'scripts/pause-ui/mutants-ui.mjs'))) M.push(...(await import('./mutants-ui.mjs')).MUTANTS);

const sel = ONLY_SET ? M.filter((m) => ONLY_SET.has(m.id)) : M;
if (sel.length === 0) { console.error('unknown mutant'); process.exit(2); }

if (process.argv.includes('--anchors-only')) {
  let gone = 0;
  for (const m of sel) {
    const src = fs.readFileSync(path.join(REPO, m.file), 'utf8');
    for (const e of (m.edits ?? [{ find: m.find }])) {
      const hits = src.split(e.find).length - 1;
      if (hits !== 1) { gone++; console.log(`✗ ${m.id}: anchor matched ${hits}× in ${m.file}: ${e.find.slice(0, 70)}`); }
    }
  }
  const titlesOf = (f) => [...fs.readFileSync(path.join(REPO, f), 'utf8').matchAll(f.endsWith('.mjs') ? /\bcheck\((['"`])((?:\\.|(?!\1)[^\\])*)\1/g : /\btest\((['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((x) => x[2].replace(/\\'/g, "'"));
  for (const m of sel) {
    const titles = m.tests.flatMap(titlesOf);
    if (!titles.some((t) => m.expect.test(t.replace(/#/g, '\\#')))) { gone++; console.log(`✗ ${m.id}: expect ${m.expect} matches no test title in ${m.tests.join(', ')}`); }
  }
  console.log(`ANCHORS: ${gone === 0 ? 'OK' : 'FAIL'} (${sel.length} mutants, ${gone} stale)`);
  process.exit(gone === 0 ? 0 : 1);
}

// ASYNC on purpose: a synchronous spawn keeps the event loop busy, so the restore handler below could never fire on a signal.
// `*-render-smoke.mjs` files are NOT TAP: they print `  ok …` / `  FAIL <label>` lines and exit 0/1 — run each on its own and fold the counts into the same shape.
function spawnCollect(args, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ out, code }); });
  });
}
async function runTests(files) {
  const tap = files.filter((f) => !f.endsWith('-render-smoke.mjs'));
  const smokes = files.filter((f) => f.endsWith('-render-smoke.mjs'));
  const agg = { fail: 0, pass: 0, skipped: 0, red: [], raw: '' };
  if (tap.length) {
    const { out } = await spawnCollect(['--test', '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', ...tap]);
    const r = parseRun(out);
    agg.fail += r.fail; agg.pass += r.pass; agg.skipped += r.skipped; agg.red.push(...r.red); agg.raw += out;
  }
  for (const f of smokes) {
    const { out, code } = await spawnCollect([f]);
    const reds = [...out.matchAll(/^  FAIL (.+?)(?: — .*)?$/gm)].map((m) => m[1]);
    const oks = (out.match(/^  ok /gm) || []).length;
    // a crash (no FAIL line, non-zero exit) is red too — never a silent pass
    if (reds.length === 0 && (code !== 0 || oks === 0)) reds.push(`${path.basename(f)} crashed or ran no check`);
    agg.fail += reds.length; agg.pass += oks; agg.red.push(...reds); agg.raw += out;
  }
  return agg;
}
function parseRun(out) {
  const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN);
  const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(out)?.[1] ?? NaN);
  const red = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { fail, pass, skipped, red, raw: out };
}
const allFiles = [...new Set(sel.flatMap((m) => m.tests))];
const control = await runTests(allFiles);
console.log(`control (clean tree, ${allFiles.length} files): pass ${control.pass}, fail ${control.fail}, skipped ${control.skipped}`);
if (control.fail !== 0 || !(control.pass > 0) || control.skipped !== 0) { console.log(`MUTATE-UNIT: FAIL — the clean control is not green (${control.red.join(' | ')})`); process.exit(1); }

let caught = 0;
const bak = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'mutate-pause-ui-'));
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
    res = await runTests(m.tests);
  } finally {
    fs.copyFileSync(backup, abs); // byte-exact restore
    activeRestore = null;
  }
  const restored = spawnSync('cmp', [abs, backup]).status === 0;
  const named = res.red.filter((n) => m.expect.test(n));
  const ok = restored && res.red.length > 0 && named.length > 0;
  if (ok) caught++;
  console.log(`${ok ? '✓' : '✗'} ${m.id}: ${res.red.length} red${named.length ? ` — named arm: ${named[0].slice(0, 90)}` : res.red.length ? ` — RED BUT NOT THE EXPECTED ARM (${res.red[0].slice(0, 80)})` : ' — SURVIVED'}${restored ? '' : ' — RESTORE FAILED'}`);
}
fs.rmSync(bak, { recursive: true, force: true });
const post = await runTests(allFiles);
console.log(`post-restore control: pass ${post.pass}, fail ${post.fail}, skipped ${post.skipped}`);
const ok = caught === sel.length && post.fail === 0 && post.skipped === 0;
console.log(`MUTATE-UNIT: ${ok ? 'PASS' : 'FAIL'} (${caught}/${sel.length} caught)`);
process.exit(ok ? 0 : 1);

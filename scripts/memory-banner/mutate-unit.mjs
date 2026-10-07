#!/usr/bin/env node
// In-place mutants of every clause of the memory BANNER (#289, D5 D-pick3; wave G ledger #295). Each mutant edits the REAL source file, runs the unit files that can reach the clause, requires ≥1 test to go RED NAMING the
// expected arm, then restores the file from a BYTE-EXACT backup and `cmp`s it — never a reverse sed. A clean control run (0 red, 0 skipped) gates the whole harness, and every anchor must match EXACTLY ONCE (else PATTERN-GONE).
//   node scripts/memory-banner/mutate-unit.mjs [--only <id[,id]>] [--anchors-only]   →  last line: MUTATE-UNIT: PASS|FAIL (n/N caught)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const ONLY_SET = ONLY ? new Set(ONLY.split(',')) : null;
const POL = 'src/shared/memory-banner.ts', CORE = 'src/main/memory-banner.ts', HOST = 'src/main/memory-banner-host.ts', IDX = 'src/main/index.ts', STORE = 'src/renderer/store.ts', COMP = 'src/renderer/components/MemoryBanner.tsx', APP = 'src/renderer/App.tsx', PRE = 'src/preload/index.ts', CSS = 'src/renderer/styles.css';
const T = { pure: 'src/shared/memory-banner.test.ts', unit: 'src/main/memory-banner.test.ts', wiring: 'src/main/memory-banner-wiring.test.ts', guard: 'src/main/memory-guard-wiring.test.ts' };

const M = [
  // ── pure half
  { id: 'state-pause-from-guard-dropped', file: POL, find: "const inPause = s.pause === 'held' || pausedRuns.length > 0;", rep: "const inPause = pausedRuns.length > 0;", tests: [T.pure, T.unit], expect: /STATE kind|PUBLISH walk/ },
  { id: 'state-pause-from-runs-dropped', file: POL, find: "const inPause = s.pause === 'held' || pausedRuns.length > 0;", rep: "const inPause = s.pause === 'held';", tests: [T.pure, T.unit], expect: /STATE kind|PUBLISH walk/ },
  { id: 'state-toggle-ignored', file: POL, find: "const holding = s.measured && isAdmissionHolding(s);", rep: "const holding = s.measured && s.admission === 'held';", tests: [T.pure, T.unit], expect: /STATE unknown|PUBLISH unknown/ },
  { id: 'state-unmeasured-held', file: POL, find: "const holding = s.measured && isAdmissionHolding(s);", rep: "const holding = isAdmissionHolding(s);", tests: [T.pure, T.unit], expect: /STATE unknown|PUBLISH unknown/ },
  { id: 'state-stale-reading-shown', file: POL, find: "    availBytes: s.measured ? s.availBytes : null,", rep: "    availBytes: s.availBytes,", tests: [T.pure], expect: /STATE unknown/ },
  { id: 'state-none-not-normalised', file: POL, find: "  if (kind === 'none') return { ...NO_MEMORY_BANNER, rev }; // nothing to show: the figures of an idle guard are not a change worth pushing\n", rep: "", tests: [T.pure, T.unit], expect: /STATE unknown|PUBLISH unknown/ },
  { id: 'state-pause-wins-over-held', file: POL, find: "const kind: MemoryBannerKind = inPause ? 'pause' : holding ? 'held' : 'none';", rep: "const kind: MemoryBannerKind = holding ? 'held' : inPause ? 'pause' : 'none';", tests: [T.pure, T.unit], expect: /STATE kind|PUBLISH walk/ },
  { id: 'fingerprint-includes-rev', file: POL, find: "return JSON.stringify({ ...b, rev: 0 });", rep: "return JSON.stringify(b);", tests: [T.pure], expect: /PUSH/ },
  { id: 'newer-banner-inverted', file: POL, find: "return prev && prev.rev > next.rev ? prev : next;", rep: "return prev && prev.rev < next.rev ? prev : next;", tests: [T.pure], expect: /PUSH/ },
  { id: 'key-pause-cycle-dropped', file: POL, find: "return `${b.episode}:${b.kind}:${b.kind === 'pause' ? b.pauseCycle : 0}`;", rep: "return `${b.episode}:${b.kind}:0`;", tests: [T.pure], expect: /DISMISS|KEY/ },
  { id: 'key-episode-dropped', file: POL, find: "return `${b.episode}:${b.kind}:${b.kind === 'pause' ? b.pauseCycle : 0}`;", rep: "return `0:${b.kind}:${b.kind === 'pause' ? b.pauseCycle : 0}`;", tests: [T.pure], expect: /DISMISS|KEY/ },
  { id: 'key-kind-dropped', file: POL, find: "return `${b.episode}:${b.kind}:${b.kind === 'pause' ? b.pauseCycle : 0}`;", rep: "return `${b.episode}:x:${b.kind === 'pause' ? b.pauseCycle : 0}`;", tests: [T.pure], expect: /DISMISS|KEY/ },
  { id: 'visible-none-shown', file: POL, find: "  if (!b || b.kind === 'none') return false;\n", rep: "  if (!b) return false;\n", tests: [T.pure], expect: /DISMISS/ },
  { id: 'visible-ignores-dismissal', file: POL, find: "  return dismissedKey !== bannerKey(b);", rep: "  return true;", tests: [T.pure], expect: /DISMISS/ },
  { id: 'visible-always-hidden-once-dismissed', file: POL, find: "  return dismissedKey !== bannerKey(b);", rep: "  return dismissedKey === null;", tests: [T.pure], expect: /DISMISS/ },
  { id: 'go-comma-lost', file: POL, find: "toFixed(1).replace('.', ',')", rep: "toFixed(1)", tests: [T.pure, T.wiring], expect: /FRENCH go|COPY/ },
  { id: 'go-whole-with-decimal', file: POL, find: "`${Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',')} Go`", rep: "`${v.toFixed(1).replace('.', ',')} Go`", tests: [T.pure], expect: /FRENCH go|COPY/ },
  { id: 'copy-pause-tone', file: POL, find: "      tone: 'crit',\n      title: `Pause mémoire", rep: "      tone: 'warn',\n      title: `Pause mémoire", tests: [T.pure], expect: /COPY Pause/ },
  { id: 'copy-held-tone', file: POL, find: "    tone: 'warn',\n    title: `Mémoire basse", rep: "    tone: 'crit',\n    title: `Mémoire basse", tests: [T.pure], expect: /COPY held/ },
  { id: 'copy-reopen-without-margin', file: POL, find: "relâchés dès ${frGo(b.admissionBytes + b.releaseMarginBytes)}", rep: "relâchés dès ${frGo(b.admissionBytes)}", tests: [T.pure], expect: /COPY held/ },
  { id: 'copy-held-singular-lost', file: POL, find: "`${b.heldStarts} démarrage${b.heldStarts > 1 ? 's' : ''} retenu${b.heldStarts > 1 ? 's' : ''}`", rep: "`${b.heldStarts} démarrages retenus`", tests: [T.pure], expect: /COPY held/ },
  { id: 'copy-no-held-zero-case', file: POL, find: "const held = b.heldStarts === 0 ? 'Aucun démarrage retenu pour l\\'instant' :", rep: "const held = false ? 'x' :", tests: [T.pure], expect: /COPY held/ },
  { id: 'copy-paused-runs-uncut', file: POL, find: "const frList = (xs: readonly string[]): string => (xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 3).join(', ')} +${xs.length - 3}`);", rep: "const frList = (xs: readonly string[]): string => xs.join(', ');", tests: [T.pure], expect: /COPY Pause/ },
  { id: 'copy-pause-reprise-threshold', file: POL, find: "sub: `Reprise automatique dès ${frGo(b.admissionBytes)} ·", rep: "sub: `Reprise automatique dès ${frGo(b.criticalBytes)} ·", tests: [T.pure], expect: /COPY Pause/ },
  { id: 'copy-unreadable-hidden', file: POL, find: "const mem = b.availBytes === null ? 'mémoire illisible' : `${frGo(b.availBytes)} disponibles`;", rep: "const mem = `${frGo(b.availBytes ?? 0)} disponibles`;", tests: [T.pure], expect: /COPY Pause/ },
  // ── publisher
  { id: 'publish-every-refresh', file: CORE, find: "      if (bannerFingerprint(next) !== bannerFingerprint(last)) {", rep: "      if (true as boolean) {", tests: [T.unit], expect: /PUBLISH walk|PUBLISH counts/ },
  { id: 'publish-never-pushes-changes', file: CORE, find: "        deps.push(last);\n", rep: "", tests: [T.unit], expect: /PUBLISH/ },
  { id: 'publish-rev-not-bumped', file: CORE, find: "        last = { ...next, rev: ++rev };", rep: "        last = { ...next, rev };", tests: [T.unit], expect: /PUBLISH walk/ },
  { id: 'publish-timer-never-armed', file: CORE, find: "    if (timer !== null) return;\n    timer = deps.schedule(", rep: "    if (timer !== null || true) return;\n    timer = deps.schedule(", tests: [T.unit], expect: /PUBLISH counts|PUBLISH pull/ },
  { id: 'publish-timer-never-disarmed', file: CORE, find: "    if (!active) {\n      if (timer !== null) deps.cancel(timer);\n      timer = null;\n      return;\n    }", rep: "    if (!active) return;", tests: [T.unit], expect: /PUBLISH counts/ },
  { id: 'publish-refresh-throw-propagates', file: CORE, find: "      deps.log.warn('memory-banner: refresh failed — retried at the next edge / tick', e);", rep: "      throw e;", tests: [T.unit], expect: /PUBLISH pull/ },
  { id: 'publish-edge-ignored', file: CORE, find: "    onEdge: () => refresh(),", rep: "    onEdge: () => undefined,", tests: [T.unit], expect: /PUBLISH walk|PUBLISH unknown/ },
  { id: 'publish-stop-leaves-timer', file: CORE, find: "    stop() {\n      if (timer !== null) deps.cancel(timer);\n      timer = null;\n    },", rep: "    stop() {},", tests: [T.unit], expect: /PUBLISH pull/ },
  { id: 'publish-paused-runs-dropped', file: CORE, find: "heldStarts: deps.heldStarts(), pausedRuns: deps.pausedRuns() }", rep: "heldStarts: deps.heldStarts(), pausedRuns: [] }", tests: [T.unit], expect: /PUBLISH walk|PUBLISH counts/ },
  { id: 'publish-held-starts-dropped', file: CORE, find: "heldStarts: deps.heldStarts(), pausedRuns: deps.pausedRuns() }", rep: "heldStarts: 0, pausedRuns: deps.pausedRuns() }", tests: [T.unit], expect: /PUBLISH counts/ },
  // ── host binding + preload + store + component wiring
  { id: 'host-refresh-before-subscribe', file: HOST, edits: [
    { find: "  if (unsubscribe) return;\n  unsubscribe = subscribeMemoryGuard((e) => publisher.onEdge(e));\n  publisher.refresh();\n", rep: "  if (unsubscribe) return;\n  publisher.refresh();\n  unsubscribe = subscribeMemoryGuard((e) => publisher.onEdge(e));\n" },
  ], tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'host-edges-not-subscribed', file: HOST, find: "  unsubscribe = subscribeMemoryGuard((e) => publisher.onEdge(e));", rep: "  unsubscribe = subscribeMemoryGuard(() => undefined);", tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'host-pull-not-fresh', file: HOST, find: "    publisher.refresh(); // a pull is also a fresh read (the renderer just booted / reloaded)\n", rep: "", tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'host-push-channel-renamed', file: HOST, find: "export const MEMORY_BANNER_PUSH_CHANNEL = 'memoryGuard:bannerUpdate';", rep: "export const MEMORY_BANNER_PUSH_CHANNEL = 'memoryGuard:banner-update';", tests: [T.wiring], expect: /WIRING channels/ },
  { id: 'host-held-starts-unbound', file: HOST, find: "  heldStarts: () => listHeldStarts().length,", rep: "  heldStarts: () => 0,", tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'host-paused-runs-unbound', file: HOST, find: "    return memoryPausedRuns(db).map((r) => {", rep: "    return [].map((r: { runId: string }) => {", tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'host-push-not-broadcast', file: HOST, find: "  push: (state) => platform.broadcast(MEMORY_BANNER_PUSH_CHANNEL, state),", rep: "  push: () => undefined,", tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'preload-pull-renamed', file: PRE, find: "memoryBanner: () => ipcRenderer.invoke('memoryGuard:banner'),", rep: "memoryBanner: () => ipcRenderer.invoke('memoryGuard:bannerX'),", tests: [T.wiring], expect: /WIRING channels/ },
  { id: 'preload-push-renamed', file: PRE, find: "ipcRenderer.on('memoryGuard:bannerUpdate', listener);", rep: "ipcRenderer.on('memoryGuard:bannerUpdateX', listener);", tests: [T.wiring], expect: /WIRING channels/ },
  { id: 'index-register-removed', file: IDX, find: "registerMemoryBannerIpc(); // #289 — the memory banner's pull channel (ONCE, module scope)\n", rep: "", tests: [T.wiring], expect: /WIRING index\.ts/ },
  { id: 'index-start-removed', file: IDX, find: "  startMemoryBanner();\n", rep: "", tests: [T.wiring], expect: /WIRING index\.ts/ },
  { id: 'index-stop-removed', file: IDX, find: "  stopMemoryBanner();\n", rep: "", tests: [T.wiring], expect: /WIRING index\.ts/ },
  { id: 'store-push-not-subscribed', file: STORE, find: "window.orchestra.onMemoryBanner((banner) => {", rep: "window.orchestra.onMemoryBannerX?.((banner) => {", tests: [T.wiring], expect: /WIRING renderer store/ },
  { id: 'store-dismissal-kept-when-gone', file: STORE, find: ", ...(banner.kind === 'none' ? { memoryBannerDismissed: null } : {}) }));", rep: " }));", tests: [T.wiring], expect: /WIRING renderer store/ },
  { id: 'store-stale-pull-wins', file: STORE, find: "memoryBanner: memoryBanner ? newerBanner(get().memoryBanner, memoryBanner) : get().memoryBanner,", rep: "memoryBanner: memoryBanner ?? get().memoryBanner,", tests: [T.wiring], expect: /WIRING renderer store/ },
  { id: 'store-dismiss-wrong-key', file: STORE, find: "memoryBannerDismissed: st.memoryBanner && st.memoryBanner.kind !== 'none' ? bannerKey(st.memoryBanner) : st.memoryBannerDismissed", rep: "memoryBannerDismissed: st.memoryBanner ? 'x' : st.memoryBannerDismissed", tests: [T.wiring], expect: /WIRING renderer store/ },
  { id: 'component-ignores-dismissal', file: COMP, find: "  if (!banner || !bannerVisible(banner, dismissed)) return null;", rep: "  if (!banner || banner.kind === 'none') return null;", tests: [T.wiring], expect: /WIRING component/ },
  { id: 'component-no-dismiss-button', file: COMP, find: "      <button className=\"memory-banner-dismiss\" onClick={dismiss}", rep: "      <button className=\"memory-banner-dismiss\"", tests: [T.wiring], expect: /WIRING component/ },
  { id: 'app-banner-not-mounted-with-workspace', file: APP, find: "            <MemoryBanner />\n            <SetupBanner", rep: "            <SetupBanner", tests: [T.wiring], expect: /WIRING component/ },
  { id: 'app-banner-not-mounted-on-welcome', file: APP, find: "        {loaded && !active && <MemoryBanner />}\n", rep: "", tests: [T.wiring], expect: /WIRING component/ },
  { id: 'css-warn-tone-dropped', file: CSS, find: ".memory-banner.warn { background: rgba(255, 200, 87, 0.10); box-shadow: inset 3px 0 0 var(--yellow); }", rep: ".memory-banner.warn { background: transparent; }", tests: [T.wiring], expect: /WIRING css/ },
  { id: 'core-imports-electron', file: CORE, find: "import { NO_MEMORY_BANNER, bannerFingerprint, memoryBannerOf, type MemoryBannerState } from '../shared/memory-banner.ts';", rep: "import { NO_MEMORY_BANNER, bannerFingerprint, memoryBannerOf, type MemoryBannerState } from '../shared/memory-banner.ts';\nimport { store as _s } from './store.ts';", tests: [T.wiring], expect: /WIRING memory-banner\.ts is Electron-free/ },
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
const bak = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-unit-memory-banner-'));
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

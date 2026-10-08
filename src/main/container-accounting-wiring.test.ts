// #293 — text pins on the un-importable wiring (Electron-bound modules): the monitor tick, the production deps, the page snapshot + fold, /busStatus + the CLI line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const mon = read('src/main/resource-monitor.ts');
const producer = read('src/main/container-accounting.ts');

test('W1 the producer\'s OWN client is the REAL socket (never a member relay — member-pinned daemons are INJECTED by the monitor, not resolved here) and it imports no store/bus/Electron module', () => {
  assert.match(producer, /import \{ createDockerApi, type DockerApi, type DockerContainerSummary \} from '\.\/docker-api\.ts';/);
  assert.doesNotMatch(producer, /dockerApiForMember|readRelayUpstream|keeperSock/, 'a member\'s relay-pinned client would see only that member\'s daemon — the app must see every container');
  assert.doesNotMatch(producer, /from '\.\/(store|bus|bus-runs|platform|workspaces)(\.ts)?'/);
  assert.match(producer, /return \(sharedApi \?\?= createDockerApi\(\)\);/, 'no socketPath pinned: resolved per use like Pause');
});

test('W2 the container pass sits in sampleTick AFTER the reap and BEFORE the line is built, is bounded, and a failure never breaks the tick', () => {
  const body = mon.slice(mon.indexOf('export async function sampleTick('), mon.indexOf('let timer: NodeJS.Timeout | null = null;'));
  const reap = body.indexOf('await reapPass(');
  const pass = body.indexOf('d.refreshContainers()');
  const build = body.indexOf('buildResourceLogLine(');
  assert.ok(reap > 0 && pass > reap && build > pass, 'reap → container pass → line');
  assert.match(body, /const budgetMs = d\.containerBudgetMs \?\? CONTAINER_PASS_BUDGET_MS;\s*\n\s*if \(\(await withBudget\(d\.refreshContainers\(\), budgetMs\)\) === 'budget'\)/);
  assert.match(body, /catch \(e\) \{\s*\n\s*d\.warn\('resources: container accounting pass failed', e\);/);
  assert.match(body, /containers: d\.containerView\?\.\(\) \?\? undefined,/);
  assert.match(mon, /export const CONTAINER_PASS_BUDGET_MS = 15_000;/);
});

test('W3 only the PRODUCTION timer measures containers: defaultDeps has no container hook (a rig calling sampleTick() never hits the host Docker); the timer runs productionDeps()', () => {
  const dflt = mon.slice(mon.indexOf('const defaultDeps: ResourceMonitorDeps = {'), mon.indexOf('/** Boot pass (#203)'));
  assert.doesNotMatch(dflt, /refreshContainers|containerView/);
  const prod = mon.slice(mon.indexOf('export function productionDeps()'), mon.indexOf('async function withBudget('));
  assert.match(prod, /\.\.\.defaultDeps,\s*\n\s*refreshContainers: async \(\) => \{\s*\n\s*await refreshContainerAccounting\(cad\);/);
  assert.match(prod, /containerView: \(\) => accountingView\(getContainerAccounting\(\)\),/);
  assert.match(mon, /const deps = productionDeps\(\);\s*\n\s*timer = setInterval\(\(\) => \{\s*\n\s*void sampleTick\(deps\)/);
  // the first pass runs AT START (the alert must not read "not sampled yet" for the first minute) — after the timer is armed, and bounded like the tick's
  assert.match(mon, /if \(timer\.unref\) timer\.unref\(\);\s*\n(?:\s*\/\/[^\n]*\n)?\s*if \(deps\.refreshContainers\) void withBudget\(deps\.refreshContainers\(\), CONTAINER_PASS_BUDGET_MS\)\.catch\(\(e\) => rlog\.swallow\('resource-monitor first container pass', e\)\);/);
});

test('W4 the production deps feed the window from container-window.ts (liveFleetRuns — the SAME "live fleet run" as the alert LEAD / memory Pause, no keeper condition), member-pinned daemons and orphan detection (FI-3 v1.3)', () => {
  assert.match(mon, /const windowDeps: ContainerWindowDeps = \{\s*\n\s*getBus,\s*\n\s*getWorkspace: \(id\) => store\.getWorkspace\(id\),\s*\n\s*listWorkspaces: \(\) => store\.workspaces,\s*\n\s*storeReady: \(\) => store\.loadedFromDisk,/);
  assert.match(mon, /export const earliestLiveRunStartMs = \(\): number \| null => earliestLiveFleetRunStart\(windowDeps\);/);
  assert.match(mon, /realContainerAccountingDeps\(earliestLiveRunStartMs\)/);
  assert.match(mon, /extraApis: memberPinnedApis,/);
  assert.match(mon, /workspaceKnown: workspaceKnownIn\(windowDeps\),\s*\n\s*runKnown: runKnownIn\(windowDeps\),/);
  assert.doesNotMatch(mon, /listKeeperRoots\(\)\.map\(\(r\) => r\.workspaceId\)/, 'no keeper condition on the window: a hibernated LEAD still leads its run');
  const win = read('src/main/container-window.ts');
  assert.match(win, /for \(const r of liveFleetRuns\(db, deps\)\) \{\s*\n\s*const run = getRun\(db, r\.id\);/);
});

test('W5 the Resources page snapshot carries the LAST tick\'s accounting (never a Docker call from the 2 s poll) and the row figure is process memory PLUS the workspace\'s containers', () => {
  const res = read('src/main/resources.ts');
  assert.match(res, /containers: accountingView\(getContainerAccounting\(\)\),/);
  assert.doesNotMatch(res, /refreshContainerAccounting|createDockerApi|docker-api/);
  const view = read('src/renderer/components/ResourcesView.tsx');
  assert.match(view, /const grouped = groupSnapshot\(snap\);/, 'the page uses the SAME pure function the unit tests (G1/G2/G9) and the rigs drive');
  assert.match(read('src/shared/resources.ts'), /return groupSessionsByWorkspace\(snap\?\.sessions \?\? \[\], snap\?\.containers, snap\?\.members\);/, 'groupSnapshot hands the container accounting to the grouping (#328 added the member report beside it)');
  assert.match(read('src/shared/resources.ts'), /\+ \(remote \? 0 : viewBytesFor\(containers, key\)\),/);
  assert.match(read('src/shared/resources.ts'), /containers\?: ContainerAccountingView;/);
});

test('W6 /busStatus returns the accounting + workspace labels, and the CLI prints ONE `containers:` line only when the app returned it (older app → unchanged output)', () => {
  const hs = read('src/main/hooks-server.ts');
  assert.match(hs, /const containersView = accountingView\(getContainerAccounting\(\)\);/, 'ONE read: the view and its labels come from the same snapshot');
  assert.equal((hs.match(/getContainerAccounting\(\)/g) ?? []).length, 1, '/busStatus reads the accounting exactly once');
  assert.match(hs, /containers: containersView,/);
  assert.match(hs, /containerLabels: Object\.fromEntries\(containersView\.attributed\.map\(\(a\) => \[a\.wsId, heldStartLabel\(store\.getWorkspace\(a\.wsId\), a\.wsId\)\]\)\),/);
  const cli = read('src/cli/index.ts');
  assert.match(cli, /if \(res\.containers && typeof res\.containers === 'object'\) \{\s*\n\s*const clabels = \(res\.containerLabels \?\? \{\}\) as Record<string, string>;\s*\n\s*process\.stdout\.write\(`\$\{formatContainersLine\(res\.containers as ContainerAccountingView, \(id\) => clabels\[id\] \?\? id\)\}\\n`\);/);
});

test('W7 who imports the producer: the monitor, the page sampler, /busStatus and the LEAD\'s memory alert (FI-3.4)', () => {
  const importers = fs
    .readdirSync(path.join(root, 'src/main'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => /from '\.\/container-accounting(\.ts)?'/.test(read(`src/main/${f}`)))
    .sort();
  assert.deepEqual(importers, ['hooks-server.ts', 'memory-alert-host.ts', 'resource-monitor.ts', 'resources.ts']);
});

test('W8 (D-pick4 A) the Resources page: keeper-hosted structured agents are SAMPLED (the PTY listing never saw them), the row shows the 🐳 chip and a container-only row, the unattributed line renders under the table, and a keeper-hosted row has NO stop button (the page stops PTYs only)', () => {
  const res = read('src/main/resources.ts');
  assert.match(res, /const sessions = \[\.\.\.ptySessions, \.\.\.aggregateKeeperSessions\(listKeeperRoots\(\), ptyList\.flatMap\(\(s\) => \(s\.remote \|\| s\.pid === undefined \? \[\] : \[s\.pid\]\)\), table, cpuPcts\)\];/, 'a keeper is skipped only when it sits INSIDE a PTY root\'s tree (by pid), never because its workspace also has a terminal agent');
  const view = read('src/renderer/components/ResourcesView.tsx');
  assert.match(view, /warning=\{unattributedWarning\(snap\?\.containers\)\}/);
  assert.match(view, /\{warning && \(\s*\n\s*<div className="res-unattributed" role="note" data-res-unattributed="">/);
  assert.match(view, /<SessionChips sessions=\{row\.sessions\} containers=\{row\.containers\} reliquats=\{row\.reliquats\} \/>/);
  assert.match(view, /\) : row\.containerOnly \|\| row\.scopeOnly \? \(/, 'a workspace whose only footprint is a container (or, #328, only its Reliquats) gets its own row (cpu / procs « — »)');
  assert.match(view, /className="res-chip docker" data-res-containers=\{containers\.count\} title=\{containersChipTitle\(containers\)\}/);
  assert.match(view, /const agentCount = rows\.filter\(\(r\) => r\.sessions\.some\(\(s\) => s\.kind === 'agent' \|\| s\.kind === 'sdk'\)\)\.length;/, 'the Live agents tile counts structured agents too — it agrees with the table');
  assert.match(view, /const agentSession = row\.sessions\.find\(\(s\) => s\.kind === 'agent'\);/, 'the stop target is the PTY agent ONLY — an sdk / container-only row has none');
  assert.match(read('src/renderer/styles.css'), /\.res-chip\.docker \{/);
  assert.match(read('src/renderer/styles.css'), /\.res-unattributed \{/);
  assert.ok(fs.existsSync(path.join(root, 'scripts/container-memory-screenshot.mjs')), 'the screenshot gate exists (UI gate: pixels + assertions under a headless sway)');
});

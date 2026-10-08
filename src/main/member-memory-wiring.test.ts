// #328 — text pins on the un-importable wiring (Electron-bound modules): the monitor tick, the production deps, the page snapshot, /busStatus + the CLI line, and the two FI-1 rules this consumer must keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const mon = read('src/main/resource-monitor.ts');
const host = read('src/main/member-memory-host.ts');
const producer = read('src/main/member-memory.ts');
const pure = read('src/shared/member-memory.ts');

test('W1 FI-1.3: the consumer resolves a scope ONLY through memberScopes/readScopeMemory/listScopeProcs/scopeSupport — no hard-coded slice or cgroup path anywhere in it', () => {
  for (const [name, src] of [['member-memory.ts', producer], ['member-memory-host.ts', host], ['shared/member-memory.ts', pure]] as const) {
    assert.doesNotMatch(src, /\/sys\/fs\/cgroup|user\.slice|app\.slice|user@|readFileSync|readdirSync/, `${name} must not know where a scope lives (FI-1.3)`);
  }
  assert.match(producer, /support: \(\) => scopeSupportCached\(\)/, 'the 2 s page poll must use H1\'s 30 s support cache');
  assert.match(producer, /import \{ countMemberScopes, listKeeperTreeOutsideScope, listScopeProcs, memberScopes, readScopeMemory, scopeSupportCached, type MemberScope \} from '\.\/memory-scope\.ts';/);
});

test('W2 FI-1.4: the consumer only READS — no signal, no systemctl, no child process, no process move', () => {
  for (const [name, src] of [['member-memory.ts', producer], ['member-memory-host.ts', host], ['shared/member-memory.ts', pure]] as const) {
    assert.doesNotMatch(src, /process\.kill|\.kill\(|systemctl|child_process|execFile|spawn\(|SIGTERM|SIGKILL|cgroup\.kill|writeFile/, `${name} must never signal, stop or write (FI-1.4: the Pause/stop tracks own that)`);
  }
});

test('W3 the monitor line carries the scope reading: ONLY productionDeps installs it (a rig calling sampleTick() never reads the host cgroups), FRESH (a record, not a poll), after the container pass and before the line is built; a failing read never breaks the tick', () => {
  const dflt = mon.slice(mon.indexOf('const defaultDeps: ResourceMonitorDeps = {'), mon.indexOf('/** Boot pass (#203)'));
  assert.doesNotMatch(dflt, /memberMemory/);
  const prod = mon.slice(mon.indexOf('export function productionDeps()'), mon.indexOf('async function withBudget('));
  assert.match(prod, /memberMemory: \(\) => currentMemberMemory\(\{ fresh: true \}\),/);
  const body = mon.slice(mon.indexOf('export async function sampleTick('), mon.indexOf('let timer: NodeJS.Timeout | null = null;'));
  assert.ok(body.indexOf('d.refreshContainers()') < body.indexOf('buildResourceLogLine('));
  assert.match(body, /members: readMembers\(d\),/);
  const rd = mon.slice(mon.indexOf('function readMembers('), mon.indexOf('/** One sample + detect'));
  assert.match(rd, /if \(!d\.memberMemory\) return undefined;/);
  assert.match(rd, /catch \(e\) \{\s*\n\s*d\.warn\('resources: member scope read failed — this line carries no member figures', e\);/);
});

test('W4 the host facade shares a SHORT cache with the page + bus-status and lets the monitor bypass it; ids = the store\'s workspaces ∪ live keepers', () => {
  assert.match(host, /export const MEMBER_MEMORY_TTL_MS = 1_500;/);
  assert.match(host, /if \(!opts\.fresh && cache && now - cache\.at >= 0 && now - cache\.at < MEMBER_MEMORY_TTL_MS\) return cache\.report;/);
  assert.match(host, /workspaceIds: \(\) => \[\.\.\.store\.workspaces\.map\(\(w\) => w\.id\), \.\.\.live\]/);
});

test('W5 the Resources snapshot carries the member report next to the container accounting', () => {
  const res = read('src/main/resources.ts');
  assert.match(res, /containers: accountingView\(getContainerAccounting\(\)\),\s*\n\s*\/\/[^\n]*\n\s*members: currentMemberMemory\(\), \/\/ read AFTER the awaits above/);
  assert.match(read('src/shared/resources.ts'), /members\?: MemberMemoryReport;/);
});

test('W6 /busStatus returns the member report + its labels from ONE read, and the CLI prints the `reliquats:` line between `containers:` and the held starts', () => {
  const hs = read('src/main/hooks-server.ts');
  assert.match(hs, /const membersView = currentMemberMemory\(\);/);
  assert.match(hs, /members: membersView,\s*\n\s*memberLabels: Object\.fromEntries\(membersView\.tracked\.map\(\(m\) => \[m\.wsId, heldStartLabel\(store\.getWorkspace\(m\.wsId\), m\.wsId\)\]\)\),/);
  const cli = read('src/cli/index.ts');
  const c = cli.indexOf('formatContainersLine(res.containers');
  const r = cli.indexOf('formatReliquatsLine(res.members as MemberMemoryReport');
  const h = cli.indexOf('formatHeldStartsLine(res.heldStarts');
  assert.ok(c > 0 && r > c && h > r, 'containers → reliquats → held starts');
  assert.match(cli, /if \(res\.members && typeof res\.members === 'object'\) \{/);
});

test('W7 the Reliquat advisory rides the same tick: it reads the LINE\'s member report, after the tree advisory, WARN only (no signal anywhere in it)', () => {
  const body = mon.slice(mon.indexOf('export async function sampleTick('), mon.indexOf('let timer: NodeJS.Timeout | null = null;'));
  assert.match(body, /for \(const w of \[\.\.\.decideThresholdWarnings\(line\.sessions, electron\), \.\.\.decideReliquatWarnings\(line\.members\)\]\) \{/);
  assert.match(body, /if \(w\.kind === 'reliquat-rss'\) d\.warn\(/);
  assert.doesNotMatch(body.slice(body.indexOf('decideReliquatWarnings')), /d\.signal\(/);
});

test('W8 the Resources page (D-Q3 option A): the call site hands the snapshot\'s members to the grouping; a ⚠ chip only at count > 0 with the RSS tooltip; the Reliquat-only row renders like the container-only one; the dim line is information (dim), the chip a problem state (yellow)', () => {
  const view = read('src/renderer/components/ResourcesView.tsx');
  const css = read('src/renderer/styles.css');
  assert.match(view, /const grouped = groupSnapshot\(snap\);/);
  assert.match(read('src/shared/resources.ts'), /return groupSessionsByWorkspace\(snap\?\.sessions \?\? \[\], snap\?\.containers, snap\?\.members\);/);
  assert.match(view, /\{reliquats && reliquats\.count > 0 && \(\s*\n\s*<span className="res-chip reliquat" data-res-reliquats=\{reliquats\.count\} title=\{reliquatChipTitle\(reliquats\)\}>/);
  assert.match(view, /<SessionChips sessions=\{row\.sessions\} containers=\{row\.containers\} reliquats=\{row\.reliquats\} browsers=\{browsers\} \/>/);
  assert.match(view, /\) : row\.containerOnly \|\| row\.scopeOnly \? \(/);
  assert.match(view, /reliquatsLine=\{reliquatsNote\(snap\?\.members\)\}/);
  assert.match(view, /const nameById = new Map\(workspaces\.map\(\(w\) => \[w\.id, w\.branch\]\)\);/);
  assert.match(view, /fallbackName: nameById\.get\(g\.key\) \?\? g\.key \}\)\);/, 'a Reliquat-only row of an ARCHIVED workspace reads its branch, never a raw id');
  assert.match(view, /\{reliquatsLine && \(\s*\n\s*<div className="res-reliquats-note" role="note" data-res-reliquats-note="">/);
  assert.match(css, /\.res-chip\.reliquat \{ color: var\(--yellow\);/);
  assert.match(css, /\.res-reliquats-note \{[^}]*color: var\(--text-dim\);/);
  assert.doesNotMatch(css.slice(css.indexOf('.res-reliquats-note')), /^\.res-reliquats-note \{[^}]*yellow/);
});

test('W9 the keeper-outside-its-scopes rule: a live member whose keeper is in none of its scopes is listed untracked for its live session, the scope reading carries FI-1\'s own keeper identity (never its own guess)', () => {
  assert.match(producer, /const untracked = \[\.\.\.new Set\(live\)\]\.filter\(\(id\) => !trackedIds\.has\(id\) \|\| keeperless\.has\(id\)\);/);
  assert.match(producer, /return \{ unit: s\.unit, gen: s\.gen, currentBytes, procs, keeperPid: s\.keeperPid \};/);
  assert.match(producer, /countScopes: \(\) => countMemberScopes\(\)\?\.total \?\? null,/);
});

test('W10 (#328 review F1) the escaped keeper tree comes from FI-1 v1.9 `listKeeperTreeOutsideScope` (never a /proc walk of this consumer), asked for the scope that HOLDS the keeper, and only then', () => {
  assert.match(producer, /import \{ countMemberScopes, listKeeperTreeOutsideScope, listScopeProcs,/);
  assert.match(producer, /const keeperAt = readings\.findIndex\(\(r\) => r\.keeperPid !== null\);/);
  assert.match(producer, /if \(keeperAt >= 0 && d\.escaped\) \{/);
  assert.match(producer, /outside = d\.escaped\(scopes\[keeperAt\]\) \?\? \[\];/);
  assert.match(producer, /escaped: \(s\) => listKeeperTreeOutsideScope\(s\),/);
  assert.equal(fs.existsSync(path.join(root, 'src/main/member-tree.ts')), false, 'the consumer must not carry a second /proc walk next to FI-1\'s');
});

test('W11 the page and bus-status share the walk through a 10 s memo, the monitor line bypasses it (fresh)', () => {
  const hostSrc = read('src/main/member-memory-host.ts');
  assert.match(hostSrc, /if \(deps\.escaped\) deps\.escaped = memoizeEscaped\(deps\.escaped, \{ fresh: opts\.fresh, now: \(\) => now \}\);/);
  assert.match(producer, /export const ESCAPED_TTL_MS = 10_000;/);
  assert.match(producer, /if \(!opts\.fresh && hit && t - hit\.at >= 0 && t - hit\.at < ESCAPED_TTL_MS\) return hit\.value;/);
});

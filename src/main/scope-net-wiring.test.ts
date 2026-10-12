// #343 — source-binding gate (the memory-cap-binding.test.ts pattern): keeper-client.ts and index.ts cannot load under `node --test`, so this reads the SHIPPED source and asserts every hop of the
// scope-backstop report is wired: launch → ledger, session end (exit by a signal / keeper vanished) → check, boot → adopt + sweep, check → the SAME sink as every other memory notice.
// The decisions are proven in scope-net.test.ts / shared/scope-net.test.ts; the real scope, the real journal and the real sink end to end in scripts/e2e-memory-cap.mjs (net_* arms).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(path.join(here, rel), 'utf8');
const keeperClient = src('keeper-client.ts');
const mainIndex = src('index.ts');
const live = (s: string, needle: string): boolean => s.split('\n').some((l) => l.includes(needle) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));

test('W1 a scope is REMEMBERED when it is launched (the cgroup vanishes with its last process): right after the keeper answers, only for a launch that carries limits', () => {
  assert.ok(live(keeperClient, 'if (cap?.limits) noteScopeLaunch(wsId, cap, launchedAt);'));
  const at = keeperClient.indexOf('const launchedAt = Date.now();');
  assert.ok(at > 0 && at < keeperClient.indexOf('sock = await launchKeeperDaemon(wsId, cap);'), 'the launch time is taken BEFORE the launch (kernel lines older than the scope never match, none of the scope\'s can be older than this)');
  assert.ok(live(keeperClient, 'scopeNet().note(cap.unit, {'));
  assert.match(keeperClient, /backstopBytes: scopeMemoryMaxBytes\(cap\.limits\.hardBytes, reserveBytesFromEnv\(process\.env\)\)/, 'the backstop is derived the way the launch argv derives it');
});

test('W2 the check runs when the session ends ABNORMALLY — the CLI exits by a signal / non-zero, or the keeper vanished under a live session — and not on a clean exit or at app quit', () => {
  assert.ok(live(keeperClient, 'if (f.signal !== null || (f.code !== null && f.code !== 0)) scopeNetSessionEnded(wsId);'));
  const closeAt = keeperClient.indexOf("s.on('close', () => {");
  const closeBlock = keeperClient.slice(closeAt, keeperClient.indexOf("s.on('error'", closeAt));
  assert.match(closeBlock, /if \(!exited && !appQuitting\) \{\s*exited = true;\s*scopeNetSessionEnded\(wsId\);/, 'inside the guard that excludes app quit (the keepers survive it) and an already-reported exit');
  assert.ok(live(keeperClient, 'void scopeNet().sessionEnded(wsId).catch(() => {});'), 'fire and forget, never throws into the stream');
  // negative control: a comment-only mention is not wiring
  assert.ok(!live('// scopeNetSessionEnded(wsId);', 'scopeNetSessionEnded(wsId);'));
});

test('W3 the check reads the REAL kernel journal and hands the record to the SAME listeners as every other memory notice (one sink: the member\'s row + one bus message), failing loudly when nobody listens', () => {
  assert.ok(live(keeperClient, 'readKernelKills: (sinceMs, needle) => readKernelOomKills(sinceMs, { match: needle, maxBufferBytes: 32 * 1024 * 1024, timeoutMs: 20_000, allBoots: true }),'), 'the real journal, grepped for the units asked about, with room for a long window');
  assert.ok(live(keeperClient, 'deliver: deliverScopeNetKill,'));
  const fn = keeperClient.slice(keeperClient.indexOf('function deliverScopeNetKill('), keeperClient.indexOf('/** Remember a scope this app launched'));
  assert.match(fn, /if \(memKillListeners\.length === 0\) throw new Error/, 'no listener yet ⇒ the line stays OWED, never marked reported');
  assert.match(fn, /for \(const fn of \[\.\.\.memKillListeners\]\)/);
  assert.match(fn, /if \(failure !== null\) throw failure;/, 'a listener that throws (bus down) leaves it owed');
  assert.ok(live(keeperClient, "ledgerFile: path.join(keeperDir(), 'memscopes.json'),"), 'the ledger lives with the keepers\' files');
});

test('W4 at app start the live scopes are ADOPTED (a keeper an older app launched) and every remembered scope that ended while the app was down is checked — AFTER the notice sink is subscribed', () => {
  const sweep = keeperClient.slice(keeperClient.indexOf('export async function sweepScopeNet('), keeperClient.indexOf('/** A listener that throws'));
  assert.match(sweep, /adoptHostScopes\(\);\s*await scopeNet\(\)\.sweep\(isKnownWorkspace\);/);
  assert.ok(live(mainIndex, 'void sweepScopeNet((id) => !!store.getWorkspace(id));'));
  assert.ok(mainIndex.indexOf('startMemoryNotices(') < mainIndex.indexOf('void sweepScopeNet('), 'the sink exists before the sweep delivers into it');
  assert.ok(mainIndex.indexOf('drainAllMemNotices((id)') < mainIndex.indexOf('void sweepScopeNet('));
  const adopt = keeperClient.slice(keeperClient.indexOf('function adoptHostScopes('), keeperClient.indexOf('/** App start (after the memory-notice sink'));
  assert.match(adopt, /parseMemoryScopeUnit\(prefix, unit\)/, 'only units of THIS prefix (production, or a rig\'s)');
  assert.match(adopt, /path\.join\(dir, SCOPE_LEAF_WORK, 'memory\.max'\)/, 'the tool cap is read from the work leaf');
});

test('W5 the keeper\'s watch is NOT the source: the backstop report is the APP\'s (nothing in the keeper bundle mentions it) — a killed keeper cannot say anything', () => {
  const keeperSrc = src('../keeper/index.ts') + src('../keeper/memory-watch.ts');
  assert.ok(!/scope-net|netKillsForUnit|SCOPE BACKSTOP/.test(keeperSrc));
});

test('W6 bus-status prints the keeper-leaf margin right after the reliquats line, from the SAME /busStatus report (no new route), and the report carries `room` per member', () => {
  const cli = src('../cli/index.ts');
  const at = cli.indexOf('formatReliquatsLine(res.members as MemberMemoryReport');
  assert.ok(at > 0);
  const next = cli.indexOf('formatRoomLine(res.members as MemberMemoryReport', at);
  assert.ok(next > at && next - at < 700, 'the margin line follows the reliquats line, inside the same `res.members` block');
  assert.ok(live(cli, "import { formatReliquatsLine, formatRoomLine, type MemberMemoryReport } from '../shared/member-memory.ts';"));
  assert.ok(live(src('../shared/member-memory.ts'), 'room: roomOf(readings),'), 'every tracked member view carries its room');
  const hooks = src('hooks-server.ts');
  assert.ok(!/formatRoomLine|keeperRoomOf/.test(hooks), 'the server only relays the report; the words are the CLI\'s');
});

test('W7 (gap 2) the keeper PUSHES its cap state every time it is set or changes — including the tripwire flip — and the app caches it from the push, from every helloAck and from the spawn-time probe', () => {
  const keeper = src('../keeper/index.ts');
  assert.ok(live(keeper, 'function announceCap(): void {'));
  assert.ok(live(keeper, "if (capInfo) send({ t: 'capState', cap: capInfo });"));
  // every place that assigns capInfo announces right after (5 sites: no-scope, 2 × not-applied, the decided state, the tripwire flip)
  const assigns = keeper.split('\n').flatMap((l, i, all) => (/^\s*(?:if \(capInfo\) )?capInfo = \{/.test(l) && !l.includes('let capInfo') ? [all.slice(i, i + 3).join('\n')] : []));
  assert.equal(assigns.length, 5, 'five assignments of capInfo');
  for (const a of assigns) assert.match(a, /announceCap\(\);/, `announced: ${a.split('\n')[0].trim()}`);
  assert.ok(live(keeperClient, "} else if (f.t === 'capState') {"));
  assert.ok(live(keeperClient, 'rememberCapState(wsId, f.cap);'));
  assert.ok(live(keeperClient, 'if (f.cap) rememberCapState(wsId, f.cap);'), 'an attach reads the CURRENT state (it may have flipped while the app was down)');
  assert.ok(live(keeperClient, 'if (pr.cap) rememberCapState(wsId, pr.cap);'));
  assert.ok(live(keeperClient, 'export function capStateOf(wsId: string): KeeperCapState | null {'));
  assert.ok(live(src('member-memory-host.ts'), 'liveMemberIds: () => live, capState: capStateOf });'), 'the Resources page, bus-status and the monitor all read it through the one facade');
});

test('W8 (gap 2) the producer attaches the keeper\'s state only to the scope that holds the keeper AND whose unit it names; the renderer draws the unprotected cell instead of a bar', () => {
  const producer = src('member-memory.ts');
  assert.match(producer, /kcap && kcap\.unit === s\.unit && s\.keeperPid !== null \? \{ capState: kcap\.state as ScopeReading\['capState'\] \} : \{\}/);
  const view = src('../renderer/components/ResourcesView.tsx');
  assert.match(view, /row\.capNote === 'unprotected' \? \(\s*<span className="res-cell res-mem-nocap res-mem-unprotected" title=\{CAP_UNPROTECTED_TIP\} data-res-unprotected="" tabIndex=\{0\} role="note"/);
  const cap = view.indexOf('{row.cap ? (');
  assert.ok(cap > 0 && cap < view.indexOf("row.capNote === 'unprotected'") && view.indexOf("row.capNote === 'unprotected'") < view.indexOf('<span className="res-cell">{formatBytes(row.memBytes)}</span>', cap), 'bar → no-limit note → unprotected note → plain cell');
});

test('W9 (D-pick B) the Resources page hands the room to the chip, to the MEM tooltip and to the grey line — the three places the LEAD chose', () => {
  const view = src('../renderer/components/ResourcesView.tsx');
  assert.ok(live(view, '<SessionChips sessions={row.sessions} containers={row.containers} reliquats={row.reliquats} browsers={browsers} room={row.room} />'));
  assert.ok(live(view, '<CapBar cap={row.cap} levels={capLevels} room={row.room} />'));
  assert.ok(live(view, "capLine={capSummaryLine(rows.map((r) => ({ key: r.key, name: r.ws ? r.ws.branch : r.fallbackName, cap: r.cap, room: r.room })))}"));
  assert.match(view, /\{roomChip && \(\s*<span className=\{`res-chip room tone-\$\{roomChip\.tone\}`\} data-res-room=\{room\?\.pct\} data-res-room-tone=\{roomChip\.tone\} title=\{roomChip\.title\}>/);
  assert.ok(live(src('../renderer/components/CapBar.tsx'), 'const tip = capTooltip(cap, levels, room); // #343: the tooltip also says how close keeper + CLI are to the room'));
});

test('W10 (review M3) an UNATTACHED keeper\'s cap state is probed: at app start for every live keeper, and at every look of the Resources page / bus-status / monitor for the ones not heard from lately', () => {
  assert.ok(live(src('index.ts'), 'primeCapStates(); // #343 gap 2 (review M3): every live keeper\'s cap state, before the Resources page asks (keepers are unattached after a restart)'));
  assert.ok(src('index.ts').indexOf('void sweepScopeNet(') < src('index.ts').indexOf('primeCapStates();'), 'after the notice sink exists, with the other boot work');
  assert.ok(live(src('member-memory-host.ts'), 'refreshCapStates(live); // #343 review M3: an unattached keeper never pushes — ask the ones we have not heard from lately (the answer is there for the next look)'));
  assert.ok(live(keeperClient, 'probe: (wsId) => probeKeeper(wsId),'));
  assert.ok(live(keeperClient, 'capCache.refresh(listKeeperRoots().map((r) => r.workspaceId));'));
  assert.ok(live(keeperClient, 'const capCache = createCapStateCache({'));
});

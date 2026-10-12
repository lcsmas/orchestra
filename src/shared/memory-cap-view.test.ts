import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAP_NEAR_FRACTION, CAP_NOT_APPLIED_TIP, CAP_UNPROTECTED_TIP, capSummaryLine, capSwitchSummary, capTooltip, capUsage, pressureFrac } from './memory-cap-view.ts';
import { keeperRoomOf } from './keeper-room.ts';
import type { MemberCapView } from './member-memory.ts';

// #323 — the usage-vs-cap view logic. Every arm names the clause; a must-PASS (the tone fires) sits beside its must-FAIL (it must not).
const GB = 1024 ** 3;
const cap = (billGb: number, wsGb: number | null, hardGb = 6, peakGb: number | null = null): MemberCapView => ({ unit: 'u.scope', hardBytes: hardGb * GB, billBytes: billGb * GB, workingSetBytes: wsGb === null ? null : wsGb * GB, peakBytes: peakGb === null ? null : peakGb * GB });
const SOFT = 3 * GB;

test('V1 tone: the SOFT warning AND (since #343) the red key on the WORKING SET — a big page cache alone (bill high, working set low) raises neither', () => {
  assert.equal(capUsage(cap(2.1, 1.6), SOFT).tone, 'ok', 'comfortable');
  assert.equal(capUsage(cap(3.4, 3.1), SOFT).tone, 'warn', 'working set ≥ soft ⇒ amber');
  assert.equal(capUsage(cap(4.5, 1.2), SOFT).tone, 'ok', 'bill 4.5 GB but only 1.2 GB working set (reclaimable cache): no soft warning — the keeper would not warn either');
  assert.equal(capUsage(cap(5.5, 2.0), SOFT).tone, 'ok', '#343: bill ≥ 90 % of hard but the working set is 2 GB — reclaimable cache, the kernel kills nothing: NOT red (master: crit, the cry-wolf of the #323 review m1)');
  assert.equal(capUsage(cap(5.5, 5.5), SOFT).tone, 'crit', 'bill AND working set ≥ 90 % of hard ⇒ red');
  assert.equal(capUsage(cap(5.5, 5.4), SOFT).tone, 'crit', 'crit wins over warn (working set past both the soft level and the red line)');
});

test('V2 thresholds are strict where the keeper is: exactly AT the soft level warns, a working set exactly at 90 % of hard is red, just under neither', () => {
  assert.equal(capUsage(cap(3, 3), SOFT).tone, 'warn');
  assert.equal(capUsage(cap(2.99, 2.99), SOFT).tone, 'ok');
  assert.equal(capUsage(cap(6 * CAP_NEAR_FRACTION, 6 * CAP_NEAR_FRACTION), SOFT).tone, 'crit');
  assert.equal(capUsage(cap(6 * CAP_NEAR_FRACTION, 6 * CAP_NEAR_FRACTION - 0.01), SOFT).tone, 'warn', 'just under the red line on the working set: still above the soft level, so amber — not red');
  assert.equal(capUsage(cap(6 * CAP_NEAR_FRACTION - 0.01, 1), SOFT).tone, 'ok');
});

test('V2b #343 the red keys on the WORKING SET: a bill at 95 % of hard that is mostly page cache is NOT red; an unreadable working set falls back to the bill (cautious); the soft-level amber is unchanged', () => {
  assert.equal(capUsage(cap(5.7, 0.4), SOFT).tone, 'ok', 'cache-heavy: bill 95 %, working set 7 % — master turned this red');
  assert.equal(capUsage(cap(5.7, 3.2), SOFT).tone, 'warn', 'working set above the soft level, below the red line: amber');
  assert.equal(capUsage(cap(5.7, 5.5), SOFT).tone, 'crit', 'working set 92 %: red');
  assert.equal(capUsage(cap(5.7, null), SOFT).tone, 'crit', 'no working-set reading ⇒ we cannot tell cache from anonymous memory ⇒ the bill decides (never silence)');
  assert.equal(capUsage(cap(5.0, null), SOFT).tone, 'ok');
  assert.equal(pressureFrac(cap(5.7, 0.4)), (0.4 * GB) / (6 * GB));
  assert.equal(pressureFrac(cap(5.7, null)), (5.7 * GB) / (6 * GB));
});

test('V3 an unreadable working set never raises the soft tone (we cannot tell) but the bill can still turn the bar red (#343: only then); no soft level ⇒ no tick and no warn', () => {
  assert.equal(capUsage(cap(3.5, null), SOFT).tone, 'ok');
  assert.equal(capUsage(cap(3.5, null), SOFT).workingFrac, null);
  assert.equal(capUsage(cap(5.6, null), SOFT).tone, 'crit');
  assert.equal(capUsage(cap(3.5, 3.4), null).tone, 'ok');
  assert.equal(capUsage(cap(3.5, 3.4), null).softFrac, null);
  assert.equal(capUsage(cap(3.5, 3.4), 7 * GB).softFrac, null, 'a soft level at/above the hard level marks nothing');
  assert.equal(capUsage(cap(3.5, 3.4), 6 * GB).softFrac, null, 'a soft level EQUAL to the hard level marks nothing either (the tick would sit on the end of the track)');
  assert.equal(capUsage(cap(3.5, 3.4), 6 * GB).tone, 'ok');
  assert.equal(capUsage(cap(3.5, 3.4), 7 * GB).tone, 'ok');
});

test('V4 fractions and the whole percent a CAP column prints', () => {
  const u = capUsage(cap(2.1, 1.6), SOFT);
  assert.equal(Math.round(u.billFrac * 1000), 350);
  assert.equal(Math.round((u.workingFrac ?? 0) * 1000), 267);
  assert.equal(u.softFrac, 0.5);
  assert.equal(u.billPct, 35);
  assert.equal(capUsage(cap(6.2, 6), SOFT).billPct, 103, 'a bill past the limit for an instant reads over 100, never clamped to a lie');
});

test('V4b the printed percent is FLOORED so « 90 % » never reads 90 while the bill is still under it: 89.6 % reads 89; 90.0 % reads 90 (and, with the working set at the bill, is red)', () => {
  const almost = capUsage(cap(5.376, 5.376), SOFT); // 89.6 % of 6 GB
  assert.equal(almost.billPct, 89);
  assert.notEqual(almost.tone, 'crit');
  const at = capUsage(cap(5.4, 5.4), SOFT);
  assert.equal(at.billPct, 90);
  assert.equal(at.tone, 'crit');
  for (let pct = 0; pct <= 110; pct++) {
    const u = capUsage(cap((6 * pct) / 100, (6 * pct) / 100), SOFT); // working set = bill (no cache): the printed figure and the colour never disagree
    assert.equal(u.billPct >= 90, u.tone === 'crit', `${pct} %: the printed figure and the colour never disagree`);
  }
});

test('V5 tooltip: both figures named with what each is compared to; the kernel-held hard level; a settings change since the start is SAID', () => {
  const t = capTooltip(cap(2.1, 1.6, 6, 2.4), { softGb: 3, hardGb: 6 });
  assert.match(t, /2\.1 GB kernel bill \(what the hard level compares\)/);
  assert.match(t, /1\.6 GB working set \(what the soft level compares\)/);
  assert.match(t, /peak 2\.4 GB/);
  assert.match(t, /hard 6 GB \(held by the kernel for this session\)/);
  assert.doesNotMatch(t, /settings now say/, 'unchanged settings: nothing to warn about');
  const changed = capTooltip(cap(2.1, 1.6, 6), { softGb: 4, hardGb: 8 });
  assert.match(changed, /settings now say hard 8 GB — they apply to sessions started from now on/);
  assert.doesNotMatch(capTooltip(cap(2.1, null, 6), { softGb: 3, hardGb: 6 }), /working set/, 'no working set ⇒ not named');
});

test('V5c the « settings now say hard » note fires in BOTH directions and only past a 0.01 GB tolerance; a member with several scopes says the bar is the session\'s scope only', () => {
  assert.match(capTooltip(cap(2.1, 1.6, 6), { softGb: 2, hardGb: 4 }), /settings now say hard 4 GB/, 'the hard level was LOWERED since the member started');
  assert.match(capTooltip(cap(2.1, 1.6, 6), { softGb: 3, hardGb: 8 }), /settings now say hard 8 GB/, '… or RAISED');
  assert.doesNotMatch(capTooltip(cap(2.1, 1.6, 6), { softGb: 3, hardGb: 6.005 }), /settings now say/, 'within 0.01 GB of what the kernel holds: the same level');
  assert.match(capTooltip(cap(2.1, 1.6, 6), { softGb: 3, hardGb: 6.05 }), /settings now say hard 6.05 GB/, 'past the tolerance: said');
  assert.doesNotMatch(capTooltip(cap(2.1, 1.6, 6), { softGb: 3, hardGb: 6 }), /scopes/, 'one scope: nothing to explain');
  assert.match(capTooltip({ ...cap(2.1, 1.6, 6), scopes: 2 }, { softGb: 3, hardGb: 6 }), /the bar is the session's scope only — the member has 2 scopes and the figure beside adds them/);
});

test('V5d figures: one decimal under 10 GB, none from 10 GB; the hard level is shown EXACT (0.25 GB is not 0.3)', () => {
  const t = capTooltip(cap(12.3, 11.8, 16), { softGb: 8, hardGb: 16 });
  assert.match(t, /^12 GB kernel bill/);
  assert.match(t, /11\.8? GB|12 GB working set/);
  assert.match(capTooltip(cap(0.2, 0.1, 0.25), { softGb: 0.1, hardGb: 0.25 }), /hard 0\.25 GB \(held by the kernel/);
  assert.match(capTooltip(cap(2.14, 1.6), null), /^2\.1 GB kernel bill/);
});

test('V6 summary line: none capped ⇒ nothing; otherwise the count and the member closest to its cap', () => {
  const row = (name: string, c: MemberCapView | null) => ({ key: name, name, cap: c });
  assert.equal(capSummaryLine([row('a', null), row('b', null)]), null);
  assert.equal(capSummaryLine([]), null);
  assert.equal(capSummaryLine([row('feat-x', cap(2.1, 1.6)), row('feat-y', null)]), '1 capped member · closest: feat-x 35 % of 6 GB');
  assert.equal(capSummaryLine([row('feat-x', cap(2.1, 1.6)), row('big-job', cap(5.6, 4)), row('small', cap(0.6, 0.5, 3))]), '3 capped members · closest: big-job 93 % of 6 GB');
});

test('V6c (gate S10) « closest » is ranked in PERCENT of each member\'s own hard level, not in absolute bytes: two members with DIFFERENT hard levels', () => {
  const row = (name: string, c: MemberCapView | null) => ({ key: name, name, cap: c });
  // small: 3.0 of 3.2 GB = 93 % (3 GB absolute); big: 5.0 of 12 GB = 41 % (5 GB absolute) — an absolute-bytes ranking would name `big`
  assert.equal(capSummaryLine([row('big', cap(5.0, 4.0, 12)), row('small', cap(3.0, 2.5, 3.2))]), '2 capped members · closest: small 93 % of 3.2 GB');
  assert.equal(capSummaryLine([row('small', cap(3.0, 2.5, 3.2)), row('big', cap(5.0, 4.0, 12))]), '2 capped members · closest: small 93 % of 3.2 GB', 'the order of the rows does not matter');
  // and the other way round, so a ranking by hard level alone (or by the smallest cap) cannot pass either
  assert.equal(capSummaryLine([row('tight', cap(2.0, 1.0, 3.0)), row('roomy', cap(11.2, 9.0, 12))]), '2 capped members · closest: roomy 93 % of 12 GB');
});

test('V6b « closest » is ranked by the BILL / hard (what the kernel kills on), not the working set; the percent is floored; the cap is named exactly like the tooltip', () => {
  const row = (name: string, c: MemberCapView | null) => ({ key: name, name, cap: c });
  assert.equal(capSummaryLine([row('cache-heavy', cap(5.0, 0.5)), row('lean', cap(3.0, 2.9))]), '2 capped members · closest: cache-heavy 83 % of 6 GB', 'the bill 5.0 beats the bill 3.0 although its working set is smaller');
  assert.equal(capSummaryLine([row('a', cap(5.376, 1))]), '1 capped member · closest: a 89 % of 6 GB', '89.6 % reads 89, like the bar');
  assert.equal(capSummaryLine([row('tiny', cap(0.2, 0.1, 0.25))]), '1 capped member · closest: tiny 80 % of 0.25 GB', 'a quarter-GB cap is not rounded to 0.3');
});

test('V7 the activation as the window may say it — read-only: live default + frozen copies on OPEN runs only; a closed run does not count', () => {
  const runs = [
    { closedAt: null, flags: { memoryCap: true } },
    { closedAt: null, flags: { memoryCap: false } },
    { closedAt: 123, flags: { memoryCap: true } },
  ];
  assert.deepEqual(capSwitchSummary({ memoryCap: false }, runs), { liveOn: false, runsOn: 1, runsOpen: 2, hostOk: null, text: 'Cap is OFF for new runs · ON on 1 of 2 open runs' });
  assert.equal(capSwitchSummary({ memoryCap: true }, []).text, 'Cap is ON for new runs · ON on 0 of 0 open runs', 'a healthy bus with no open run IS « 0 of 0 »');
  assert.equal(capSwitchSummary({ memoryCap: false }, [{ closedAt: null, flags: { memoryCap: true } }]).text, 'Cap is OFF for new runs · ON on 1 of 1 open run');
});

test('V7b the activation line never invents a count: a bus that is not open ⇒ « open runs unknown » with null counts (not « 0 of 0 »); a host that cannot hold a scope limit is SAID', () => {
  const down = capSwitchSummary({ memoryCap: true }, null);
  assert.deepEqual(down, { liveOn: true, runsOn: null, runsOpen: null, hostOk: null, text: 'Cap is ON for new runs · open runs unknown (the fleet bus is not open)' });
  const bad = capSwitchSummary({ memoryCap: true }, [{ closedAt: null, flags: { memoryCap: true } }], { ok: false, reason: 'systemd-run not found' });
  assert.equal(bad.hostOk, false);
  assert.equal(bad.text, 'Cap is ON for new runs · ON on 1 of 1 open run · no effect on this host: systemd-run not found');
  const good = capSwitchSummary({ memoryCap: false }, [], { ok: true });
  assert.equal(good.hostOk, true);
  assert.equal(good.text, 'Cap is OFF for new runs · ON on 0 of 0 open runs', 'a supporting host adds nothing');
  assert.equal(capSwitchSummary({ memoryCap: true }, null, { ok: false, reason: 'x' }).text, 'Cap is ON for new runs · open runs unknown (the fleet bus is not open) · no effect on this host: x');
});

test('V5b tooltip with no known levels (an older main): only what the kernel holds — never a guessed soft level or a « settings now » claim', () => {
  const t = capTooltip(cap(2.1, 1.6, 6, 2.4), null);
  assert.match(t, /hard 6 GB \(held by the kernel for this session\)/);
  assert.doesNotMatch(t, /soft [0-9]|settings now/);
  assert.match(t, /2\.1 GB kernel bill/);
});

// ─── #343: the room in the tooltip and the grey line; the two tooltips of a member the cap does not protect ────────────────────────────────────

const roomAt = (kGb: number) => keeperRoomOf({ backstopBytes: 7 * GB, hardBytes: 6 * GB, kWorkingSetBytes: kGb * GB, kCurrentBytes: kGb * GB, scopeCurrentBytes: 2 * GB, kOomKills: 0, scopeEpisodes: 0 })!;

test('V8 (#343) the MEM tooltip ALWAYS carries the keeper+CLI room line when it can be stated — also at 41 %, where no chip shows — and nothing when it cannot', () => {
  const t = capTooltip(cap(2.1, 1.6, 6), { softGb: 3, hardGb: 6 }, roomAt(0.41));
  assert.match(t, /keeper \+ CLI 420 MB of the 1 GB room above the tool level \(41 %\)/);
  assert.equal(capTooltip(cap(2.1, 1.6, 6), { softGb: 3, hardGb: 6 }, null), capTooltip(cap(2.1, 1.6, 6), { softGb: 3, hardGb: 6 }), 'no margin ⇒ the tooltip is byte-for-byte today\'s');
  assert.match(capTooltip(cap(2.1, 1.6, 6), null, roomAt(0.41)), /room above the tool level/, 'also for an older main that sends no levels');
});

test('V9 (#343) the grey line gains « least room: <member> N % of X » when any member has a margin — and is byte-for-byte today\'s when none does', () => {
  const row = (name: string, c: MemberCapView | null, room?: ReturnType<typeof roomAt> | null) => ({ key: name, name, cap: c, room });
  assert.equal(capSummaryLine([row('feat-x', cap(2.1, 1.6)), row('big-job', cap(5.6, 4))]), '2 capped members · closest: big-job 93 % of 6 GB');
  assert.equal(capSummaryLine([row('feat-x', cap(2.1, 1.6), roomAt(0.91)), row('big-job', cap(5.6, 4), roomAt(0.2)), row('free', null, roomAt(0.99))]), '2 capped members · closest: big-job 93 % of 6 GB · least room: feat-x 91 % of 1 GB', 'a member without a cap is not counted (its room is not shown)');
});

test('V10 (#343 gap 1) the « no cap applied » tooltip does not claim « a scope with no limit »: on a two-leaf scope only the TOOL leaf is unlimited and the scope may still hold its backstop', () => {
  assert.doesNotMatch(CAP_NOT_APPLIED_TIP, /scope with no limit/);
  assert.match(CAP_NOT_APPLIED_TIP, /^No memory cap applied — /);
  assert.match(CAP_NOT_APPLIED_TIP, /tool commands of this session run in a leaf with no limit/);
  assert.match(CAP_NOT_APPLIED_TIP, /scope may still hold a backstop/);
  assert.match(CAP_NOT_APPLIED_TIP, /nothing stops them at the hard level/);
  assert.doesNotMatch(CAP_NOT_APPLIED_TIP, /because|disabled|off for its run/i, 'names no cause it cannot know');
});

test('V11 (#343 gap 2) the « unprotected » tooltip is its own sentence: NOT holding, why the keeper says so, and it never reads like a healthy cap', () => {
  assert.match(CAP_UNPROTECTED_TIP, /^Memory cap NOT holding — /);
  assert.match(CAP_UNPROTECTED_TIP, /unprotected/);
  assert.match(CAP_UNPROTECTED_TIP, /not confined to the capped leaf/);
  assert.doesNotMatch(CAP_UNPROTECTED_TIP, /^No memory cap applied/, 'distinct from the « no limit at all » note');
  assert.notEqual(CAP_UNPROTECTED_TIP, CAP_NOT_APPLIED_TIP);
  assert.doesNotMatch(CAP_UNPROTECTED_TIP, /because|disabled|off for its run/i);
});

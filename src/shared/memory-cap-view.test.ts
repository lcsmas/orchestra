import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAP_NEAR_FRACTION, capSummaryLine, capSwitchSummary, capTooltip, capUsage } from './memory-cap-view.ts';
import type { MemberCapView } from './member-memory.ts';

// #323 — the usage-vs-cap view logic. Every arm names the clause; a must-PASS (the tone fires) sits beside its must-FAIL (it must not).
const GB = 1024 ** 3;
const cap = (billGb: number, wsGb: number | null, hardGb = 6, peakGb: number | null = null): MemberCapView => ({ unit: 'u.scope', hardBytes: hardGb * GB, billBytes: billGb * GB, workingSetBytes: wsGb === null ? null : wsGb * GB, peakBytes: peakGb === null ? null : peakGb * GB });
const SOFT = 3 * GB;

test('V1 tone: the SOFT warning keys on the WORKING SET, the red on the BILL — a big page cache alone (bill high, working set low) is not a soft warning', () => {
  assert.equal(capUsage(cap(2.1, 1.6), SOFT).tone, 'ok', 'comfortable');
  assert.equal(capUsage(cap(3.4, 3.1), SOFT).tone, 'warn', 'working set ≥ soft ⇒ amber');
  assert.equal(capUsage(cap(4.5, 1.2), SOFT).tone, 'ok', 'bill 4.5 GB but only 1.2 GB working set (reclaimable cache): no soft warning — the keeper would not warn either');
  assert.equal(capUsage(cap(5.5, 2.0), SOFT).tone, 'crit', 'bill ≥ 90 % of hard ⇒ red, whatever the working set');
  assert.equal(capUsage(cap(5.4, 5.0), SOFT).tone, 'crit', 'crit wins over warn');
});

test('V2 thresholds are strict where the keeper is: exactly AT the soft level warns, exactly at 90 % of hard is red, just under neither', () => {
  assert.equal(capUsage(cap(3, 3), SOFT).tone, 'warn');
  assert.equal(capUsage(cap(2.99, 2.99), SOFT).tone, 'ok');
  assert.equal(capUsage(cap(6 * CAP_NEAR_FRACTION, 1), SOFT).tone, 'crit');
  assert.equal(capUsage(cap(6 * CAP_NEAR_FRACTION - 0.01, 1), SOFT).tone, 'ok');
});

test('V3 an unreadable working set never raises the soft tone (we cannot tell) but the bill can still turn the bar red; no soft level ⇒ no tick and no warn', () => {
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

test('V4b the printed percent is FLOORED so « 90 % » always means red: 89.6 % reads 89 and is green; 90.0 % reads 90 and is red (review: it read 90 while still ok)', () => {
  const almost = capUsage(cap(5.376, 1), SOFT); // 89.6 % of 6 GB
  assert.equal(almost.billPct, 89);
  assert.equal(almost.tone, 'ok');
  const at = capUsage(cap(5.4, 1), SOFT);
  assert.equal(at.billPct, 90);
  assert.equal(at.tone, 'crit');
  for (let pct = 0; pct <= 110; pct++) {
    const u = capUsage(cap((6 * pct) / 100, 0.1), SOFT);
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

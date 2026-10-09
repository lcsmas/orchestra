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

test('V6 summary line: none capped ⇒ nothing; otherwise the count and the member closest to its cap', () => {
  const row = (name: string, c: MemberCapView | null) => ({ key: name, name, cap: c });
  assert.equal(capSummaryLine([row('a', null), row('b', null)]), null);
  assert.equal(capSummaryLine([]), null);
  assert.equal(capSummaryLine([row('feat-x', cap(2.1, 1.6)), row('feat-y', null)]), '1 capped member · closest: feat-x 35 % of 6.0 GB');
  assert.equal(capSummaryLine([row('feat-x', cap(2.1, 1.6)), row('big-job', cap(5.6, 4)), row('small', cap(0.6, 0.5, 3))]), '3 capped members · closest: big-job 93 % of 6.0 GB');
});

test('V7 the activation as the window may say it — read-only: live default + frozen copies on OPEN runs only; a closed run does not count', () => {
  const runs = [
    { closedAt: null, flags: { memoryCap: true } },
    { closedAt: null, flags: { memoryCap: false } },
    { closedAt: 123, flags: { memoryCap: true } },
  ];
  assert.deepEqual(capSwitchSummary({ memoryCap: false }, runs), { liveOn: false, runsOn: 1, runsOpen: 2, text: 'Cap is OFF for new runs · ON on 1 of 2 open runs' });
  assert.equal(capSwitchSummary({ memoryCap: true }, []).text, 'Cap is ON for new runs · ON on 0 of 0 open runs');
  assert.equal(capSwitchSummary({ memoryCap: false }, [{ closedAt: null, flags: { memoryCap: true } }]).text, 'Cap is OFF for new runs · ON on 1 of 1 open run');
});

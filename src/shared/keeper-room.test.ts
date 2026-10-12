import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keeperRoomOf, leastRoomClause, roomBytesText, roomChipOf, roomTooltipLine, type KeeperRoomInput } from './keeper-room.ts';

// #343 (D-pick B, LEAD 2026-10-12): a chip only from 70 % of the room (amber, then red from 100 %), one tooltip line always, one grey line under the table.
const GB = 1024 ** 3;
const room = (kGb: number, over: Partial<KeeperRoomInput> = {}) => keeperRoomOf({ backstopBytes: 7 * GB, hardBytes: 6 * GB, kWorkingSetBytes: kGb * GB, kCurrentBytes: kGb * GB, scopeCurrentBytes: 2 * GB, kOomKills: 0, scopeEpisodes: 0, ...over })!;

test('K1 the chip: HIDDEN below 70 % of the room, amber 70–99 %, red from 100 % — a healthy page shows no chip', () => {
  assert.equal(roomChipOf(null), null);
  assert.equal(roomChipOf(undefined), null);
  assert.equal(roomChipOf(room(0.41)), null, '41 %: nothing');
  assert.equal(roomChipOf(room(0.69)), null, '69 %: nothing');
  const warn = roomChipOf(room(0.9))!;
  assert.equal(warn.tone, 'warn');
  assert.equal(warn.text, 'k 0.9 GB / 1 GB room');
  assert.equal(roomChipOf(room(0.7))!.tone, 'warn', 'exactly at 70 % is amber');
  assert.equal(roomChipOf(room(1.0))!.tone, 'crit', 'exactly at 100 % is red');
  assert.equal(roomChipOf(room(1.4))!.text, 'k 1.4 GB / 1 GB room');
});

test('K2 the chip\'s title is the SAME sentence the MEM tooltip ends with, and says what red means', () => {
  const crit = room(1.2);
  assert.equal(roomChipOf(crit)!.title, roomTooltipLine(crit));
  assert.match(roomTooltipLine(crit), /keeper \+ CLI 1\.2 GB of the 1 GB room above the tool level \(120 %\) — above the room: a full tool leaf would open a scope-level OOM that can end the session/);
  assert.match(roomTooltipLine(room(0.41)), /^keeper \+ CLI 420 MB of the 1 GB room above the tool level \(41 %\)$/, 'a comfortable member: the figure, no alarm');
  assert.match(roomTooltipLine(room(0.8)), /\(80 %\) — close to the room$/);
  assert.match(roomTooltipLine(room(0.4, { kOomKills: 1, scopeEpisodes: 2 })), /the backstop has already acted on this scope \(2 events\)$/);
  assert.match(roomTooltipLine(room(0.4, { kOomKills: 1 })), /\(1 event\)$/);
  assert.match(roomTooltipLine(room(0.4, { kWorkingSetBytes: null, kCurrentBytes: 0.4 * GB })), /\(upper bound: cache not separable\)/);
});

test('K3 figures: 0.9 GB / 1 GB / 90 MB — one decimal from half a GB, whole numbers trimmed, MB below', () => {
  assert.equal(roomBytesText(0.9 * GB), '0.9 GB');
  assert.equal(roomBytesText(1 * GB), '1 GB');
  assert.equal(roomBytesText(1.04 * GB), '1 GB');
  assert.equal(roomBytesText(96 * 1024 ** 2), '96 MB');
  assert.equal(roomBytesText(0.45 * GB), '461 MB');
});

test('K4 the grey line\'s clause names the member with the LEAST room (highest k/room) and its room; nothing when no member has a margin', () => {
  assert.equal(leastRoomClause([]), null);
  assert.equal(leastRoomClause([{ name: 'a', room: null }, { name: 'b' }]), null);
  assert.equal(leastRoomClause([{ name: 'a', room: room(0.41) }, { name: 'feat-x', room: room(0.91) }, { name: 'c', room: room(0.2) }]), 'least room: feat-x 91 % of 1 GB');
  assert.equal(leastRoomClause([{ name: 'feat-x', room: room(0.91) }, { name: 'a', room: room(0.41) }]), 'least room: feat-x 91 % of 1 GB', 'order does not matter');
});

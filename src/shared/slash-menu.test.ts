import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_ALWAYS, PHONE_EXCLUDED, filterSlashItems, mergeSlashItems, slashQuery } from './slash-menu.ts';

const SK = (name: string, source: 'project' | 'user' | 'plugin' = 'user') => ({ name, description: `d-${name}`, source });

test('slashQuery: only a bare slash prefix opens the menu; a plugin name with « : » keeps it open', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/Shi'), 'shi');
  assert.equal(slashQuery('/slack:st'), 'slack:st', 'must-FAIL before: « : » closed the menu on plugin skills');
  assert.equal(slashQuery('/ship '), null, 'a space = the command is chosen');
  assert.equal(slashQuery('hello /ship'), null);
  assert.equal(slashQuery(''), null);
});

test('mergeSlashItems: skills win a clash, built-ins deduped case-insensitively, leading slash stripped, excluded names dropped', () => {
  const items = mergeSlashItems([SK('compact', 'project'), SK('ship')], ['/compact', 'usage', '/USAGE', 'clear', '/status'], DESKTOP_ALWAYS);
  assert.deepEqual(items.map((i) => `${i.name}:${i.source}`), ['compact:project', 'ship:user', 'clear:builtin', 'mcp:builtin', 'usage:builtin', 'status:builtin']);
  assert.equal(items.find((i) => i.name === 'usage')!.description, 'Show plan usage / rate-limit status');
  const phone = mergeSlashItems([SK('ship')], ['clear', 'mcp', 'status', 'usage'], ['compact'], PHONE_EXCLUDED);
  assert.deepEqual(phone.map((i) => i.name), ['ship', 'compact', 'usage'], 'the desktop-only intercepts are not offered on the phone');
  assert.deepEqual(mergeSlashItems([], undefined, []), [], 'no session yet: nothing but the skills');
});

test('filterSlashItems: substring match, prefix first then alphabetical, capped', () => {
  const items = ['mobile-db', 'db-tool', 'ship', 'adb', 'Dbx'].map((n) => SK(n));
  assert.deepEqual(filterSlashItems(items, 'db', 8).map((i) => i.name), ['db-tool', 'Dbx', 'adb', 'mobile-db']);
  assert.deepEqual(filterSlashItems(items, 'db', 2).map((i) => i.name), ['db-tool', 'Dbx']);
  assert.deepEqual(filterSlashItems(items, '', 8).length, 5, 'a bare « / » lists everything');
  assert.deepEqual(filterSlashItems(items, 'zzz', 8), []);
});

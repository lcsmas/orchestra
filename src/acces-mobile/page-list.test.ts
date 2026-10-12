// The phone page's LIST rendering and the conversation header (#372): the real APP_JS / CONVERSATION_JS against page-dom.ts's DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATION_JS } from './conversation.ts';
import { all, drawList, first, openConversation, row } from './page-dom.ts';

test('list (#372): a row is titled with displayName — the desktop name never reaches the phone list', async () => {
  const page = await drawList([
    row('a', { name: 'orchestra · fix-foo', displayName: 'fix-foo' }),
    row('b', { name: 'scratch · idea', displayName: 'idea', group: 'Orchestrators' }),
  ]);
  assert.equal(page.title(page.row('a')!), 'fix-foo');
  assert.equal(page.title(page.row('b')!), 'idea');
  assert.ok(!page.list.textContent.includes('orchestra · fix-foo') && !page.list.textContent.includes('scratch · idea'), 'no prefixed name anywhere in the list');
});

test('list (#372): an En attente row keeps its repo chip; a row under its repo section has none', async () => {
  const page = await drawList([
    row('w', { name: 'orchestra · ask-me', displayName: 'ask-me', status: 'waiting', preview: { kind: 'question', text: 'Quel choix ?' } }),
    row('n', { name: 'orchestra · plain', displayName: 'plain' }),
  ]);
  assert.deepEqual(page.headings(), ['En attente', 'orchestra']);
  assert.equal(page.title(page.row('w')!), 'ask-me');
  assert.equal(page.chip(page.row('w')!, 'repo'), 'orchestra', 'the waiting row names its repo (it left its repo section)');
  assert.equal(page.chip(page.row('n')!, 'repo'), undefined, 'a row inside its repo section does not repeat the repo');
});

test('list (#372): a row from a build without displayName still renders its name (never an empty title)', async () => {
  const page = await drawList([row('a', { name: 'orchestra · fix-foo', displayName: undefined })]);
  assert.equal(page.title(page.row('a')!), 'orchestra · fix-foo');
});

test('list (#372): a coordinator that is itself en attente keeps a header line in its repo group, titled with displayName', async () => {
  const page = await drawList([
    row('c', { name: 'orchestrator · vague-i', displayName: 'vague-i', status: 'waiting', group: 'Orchestrators', preview: { kind: 'question', text: 'Quoi ?' } }),
    row('k', { name: 'orchestrator · kid', displayName: 'kid', parentId: 'c', group: 'Orchestrators' }),
  ]);
  const owner = first(page.list, (e) => e.tag === 'li' && e.has('fold-owner'));
  assert.equal(owner?.textContent, 'vague-i (en attente, plus haut)');
});

test('conversation header (#372): the title is the row\'s displayName; the line under it keeps « repo · branch »', () => {
  const root = openConversation(CONVERSATION_JS, 'a', row('a', { name: 'orchestra · fix-foo', displayName: 'fix-foo', group: 'orchestra', branch: 'fix-foo' }));
  assert.equal(first(root, (e) => e.has('conv-title'))?.textContent, 'fix-foo');
  assert.ok(all(root, (e) => e.has('cs')).some((e) => e.textContent.includes('orchestra · fix-foo')), 'the repo and branch stay on the second line');
  assert.equal(first(openConversation(CONVERSATION_JS, 'b', undefined), (e) => e.has('conv-title'))?.textContent, 'b', 'opened by address with no list row ⇒ the id');
});

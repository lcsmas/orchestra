// The phone page's LIST rendering and the conversation header (#372): the real APP_JS / CONVERSATION_JS against page-dom.ts's DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATION_JS } from './conversation.ts';
import { all, drawList, first, openConversation, row, type Row } from './page-dom.ts';

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

// ───────────────────────── #373: the tree ─────────────────────────

const depthOf = (li: { dataset: Record<string, string>; style?: { props: Record<string, string> } }) => [li.dataset.depth, li.style?.props['--depth']];
/** a vague: root › sub › (w1, w2 › deep) and a top-level worker */
const vague = (): Row[] => [
  row('root', { group: 'Orchestrators' }),
  row('sub', { parentId: 'root', status: 'running' }),
  row('w1', { parentId: 'sub' }),
  row('w2', { parentId: 'sub', unread: true }),
  row('top', { parentId: 'root' }),
  row('deep', { parentId: 'w2', status: 'running' }),
];

test('tree (#373): a fold per coordinator, one indentation step per level, every row reachable by opening folds', async () => {
  const page = await drawList(vague());
  assert.deepEqual(page.rows().map((l) => l.dataset.id), ['root'], 'closed: only the root');
  assert.equal(page.fold('root')!.textContent, '▸5 agents2 en cours1 non lu', 'the root fold counts the WHOLE subtree: sub w1 w2 top deep · sub + deep running · w2 unread');
  page.fold('root')!.click();
  assert.deepEqual(page.rows().map((l) => l.dataset.id), ['root', 'sub', 'top'], 'root open: its direct kids, in order');
  assert.ok(page.fold('sub') && !page.row('w1'), 'sub has its OWN fold, closed');
  page.fold('sub')!.click();
  assert.deepEqual(page.rows().map((l) => l.dataset.id), ['root', 'sub', 'w1', 'w2', 'top']);
  page.fold('w2')!.click();
  assert.deepEqual(page.rows().map((l) => l.dataset.id), ['root', 'sub', 'w1', 'w2', 'deep', 'top'], 'three levels deep, in tree order');
  const depths = Object.fromEntries(page.rows().map((l) => [l.dataset.id, depthOf(l as never)]));
  assert.deepEqual(depths, { root: ['0', '0'], sub: ['1', '1'], w1: ['2', '2'], w2: ['2', '2'], deep: ['3', '3'], top: ['1', '1'] }, 'data-depth and --depth: one step per level');
  assert.ok(page.row('deep')!.has('child') && !page.row('root')!.has('child'));
  assert.deepEqual([page.fold('sub')!, page.fold('w2')!].map((f) => f.dataset.depth), ['1', '2'], 'a fold is indented like its coordinator');
  assert.equal(page.fold('sub')!.textContent, '▾3 agents1 en cours1 non lu', 'sub: w1 w2 deep · deep running · w2 unread');
  assert.equal(page.fold('w2')!.textContent, '▾1 agent1 en cours');
});

test('tree (#373): open / closed survives a list refresh (the live stream redraws the list), per fold', async () => {
  const page = await drawList(vague());
  page.fold('root')!.click(); page.fold('sub')!.click();
  const before = page.rows().map((l) => l.dataset.id);
  await page.refresh();
  assert.deepEqual(page.rows().map((l) => l.dataset.id), before, 'same fold state after a refresh');
  assert.ok(page.fold('sub')!.has('open') && !page.fold('w2')!.has('open'), 'sub stayed open, w2 stayed closed');
  await page.refresh(vague().map((w) => (w.id === 'w1' ? { ...w, status: 'running' } : w)));
  assert.deepEqual(page.rows().map((l) => l.dataset.id), before, 'a changed row does not collapse what was opened');
  assert.equal(page.fold('root')!.textContent, '▾5 agents3 en cours1 non lu', 'and the counts follow the new data');
});

test('tree (#373): an en attente row at depth 2 is lifted into « En attente »; its descendants stay reachable under a stand-in at its place', async () => {
  const rows: Row[] = [
    row('root', { group: 'Orchestrators' }),
    row('sub', { parentId: 'root' }),
    row('ask', { parentId: 'sub', status: 'waiting', group: 'orchestra', preview: { kind: 'question', text: 'Quoi ?' } }),
    row('g1', { parentId: 'ask' }),
    row('sib', { parentId: 'sub' }),
  ];
  const page = await drawList(rows);
  assert.deepEqual(page.headings(), ['En attente', 'Orchestrators']);
  assert.equal(page.chip(page.row('ask')!, 'repo'), 'orchestra', 'the waiting row is up in En attente with its repo chip');
  page.fold('root')!.click(); page.fold('sub')!.click();
  assert.deepEqual(page.rows().map((l) => l.dataset.id), ['ask', 'root', 'sub', 'sib'], 'ask appears ONCE (En attente), never inside the fold');
  const stand = first(page.list, (e) => e.has('stand'))!;
  assert.equal(stand.textContent, 'ask (en attente, plus haut)');
  assert.deepEqual(depthOf(stand as never), ['2', '2'], 'the stand-in holds ask\'s level');
  assert.equal(page.fold('ask')!.textContent, '▸1 agent', 'its descendants have their own fold');
  page.fold('ask')!.click();
  assert.deepEqual(page.rows().map((l) => l.dataset.id), ['ask', 'root', 'sub', 'g1', 'sib'], 'g1 is reachable, one level under the stand-in');
  assert.equal(page.fold('sub')!.textContent, '▾2 agents', 'sub folds sib + g1 — ask is counted in En attente only');
  assert.equal(page.headings().length, 2);
});

test('tree (#373): « À traiter » shows only what waits on the human, no folds', async () => {
  const page = await drawList([row('root', { group: 'O' }), row('k', { parentId: 'root' }), row('w', { parentId: 'k', status: 'waiting' })]);
  page.needsMe();
  assert.deepEqual(page.rows().map((l) => l.dataset.id), ['w']);
  assert.equal(page.fold('root'), undefined);
});

test('tree (#373): a cycle in the parent chain still shows every row', async () => {
  const page = await drawList([row('a', { parentId: 'b' }), row('b', { parentId: 'a' }), row('c', { parentId: 'b' })]);
  page.fold('a')!.click();
  page.fold('b')!.click();
  assert.deepEqual(page.rows().map((l) => l.dataset.id).sort(), ['a', 'b', 'c']);
});

test('tree (#373): a worker whose parent is in another repo section folds under its coordinator, in the coordinator\'s section (as before)', async () => {
  const page = await drawList([row('coord', { group: 'Orchestrators' }), row('w', { group: 'orchestra', parentId: 'coord' }), row('lone', { group: 'orchestra' })]);
  assert.deepEqual(page.headings(), ['Orchestrators', 'orchestra']);
  const sections = all(page.list, (e) => e.tag === 'h2').map((h) => h.textContent);
  assert.deepEqual(sections, ['Orchestrators2', 'orchestra1']);
});

test('tree (#373): a second tap closes a fold again, and only that fold', async () => {
  const page = await drawList(vague());
  page.fold('root')!.click(); page.fold('sub')!.click();
  page.fold('sub')!.click();
  assert.deepEqual(page.rows().map((l) => l.dataset.id), ['root', 'sub', 'top'], 'sub closed, root still open');
  page.fold('root')!.click();
  assert.deepEqual(page.rows().map((l) => l.dataset.id), ['root'], 'root closed');
});

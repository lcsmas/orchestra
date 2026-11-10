// #420 — each surface that summarises a reply shows a bloc HTML's TITLE (what the human/peer reads), never its markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStatusText } from './status-text.ts';
import { peerPreview, formatPeerMessage } from './peer-messages.ts';
import { deliveryPreview } from './bus-rows.ts';
import { projectMobileWorkspaces } from './acces-mobile.ts';
import { initPlatform, platform, type OrchestraPlatform, type UiNotification } from '../main/platform/index.ts';
import type { RepoEntry, Workspace } from './types.ts';

const closed = '```html-render title="Comparatif"\n<div>SRC-CLOSED</div>\n```\n';
const open = '```html-render title="Tableau"\n<div>SRC-OPEN';
const bareOnly = '```html-render\n<p>SRC-ONLY</p>\n```';
const noMarkup = (s: string) => assert.ok(!/SRC|```|<div|<p>/.test(s), `markup leaked: ${JSON.stringify(s)}`);

test('sidebar note (status text): closed, open, bloc-only, untouched prose', () => {
  assert.equal(sanitizeStatusText(`Voici\n${closed}fin`), 'Voici Comparatif fin');
  assert.equal(sanitizeStatusText(`Voici\n${open}`), 'Voici Tableau');
  assert.equal(sanitizeStatusText(bareOnly), 'Bloc HTML');
  assert.equal(sanitizeStatusText('  just   a note '), 'just a note');
});

test('notification toast: title and body show the title', () => {
  const seen: UiNotification[] = [];
  initPlatform({ notify: (n: UiNotification) => void seen.push(n) } as unknown as OrchestraPlatform);
  platform.notify({ wsId: 'w', kind: 'finished', title: 'Agent finished', body: `${closed}` });
  platform.notify({ wsId: 'w', kind: 'finished', title: bareOnly, body: open });
  assert.deepEqual(seen.map((n) => [n.title, n.body.trim()]), [['Agent finished', 'Comparatif'], ['Bloc HTML', 'Tableau']]);
  seen.forEach((n) => { noMarkup(n.title); noMarkup(n.body); });
});

test('peer message body: the receiving agent gets the title (closed and open), the envelope intact', () => {
  const m = formatPeerMessage('br', 'id1', `Résultat:\n${closed}Voilà`);
  assert.ok(m.startsWith("[message from agent 'br' (id1)]\nRésultat:\nComparatif\nVoilà\n\nReply with:"), m);
  noMarkup(m);
  const o = formatPeerMessage('br', 'id1', `Voici\n${open}`);
  assert.ok(o.includes('\nVoici\nTableau\n'), o);
  noMarkup(o);
  assert.ok(formatPeerMessage('br', 'id1', bareOnly).includes(']\nBloc HTML\n'));
});

test('peer-message and delivery previews (first line) show the title', () => {
  assert.equal(peerPreview(closed), 'Comparatif');
  assert.equal(peerPreview(open), 'Tableau');
  assert.equal(peerPreview(bareOnly), 'Bloc HTML');
  assert.equal(deliveryPreview(closed), 'Comparatif');
  assert.equal(deliveryPreview(open), 'Tableau');
  assert.equal(deliveryPreview(bareOnly), 'Bloc HTML');
});

const repos = [{ path: '/r/o', name: 'o', defaultBranch: 'master', accountId: 'mc' }] as RepoEntry[];
const ws = (over: Partial<Workspace>): Workspace =>
  ({ id: 'id', name: 'n', repoPath: '/r/o', branch: 'b', baseBranch: 'master', worktreePath: '/w', createdAt: 0, status: 'idle', agent: 'claude', ...over }) as Workspace;

test('phone workspace list: statusText and preview show the title', () => {
  const rows = projectMobileWorkspaces(
    [ws({ id: 'a', statusText: `Voici\n${closed}` }), ws({ id: 'b', statusText: open }), ws({ id: 'c', statusText: bareOnly })],
    repos,
    [{ id: 'mc', label: 'mc', configDir: '~/.claude-mc' }] as never,
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.a.statusText?.trim(), 'Voici\nComparatif');
  assert.equal(by.a.preview?.text.trim(), 'Voici\nComparatif');
  assert.equal(by.b.preview?.text.trim(), 'Tableau');
  assert.equal(by.c.preview?.text.trim(), 'Bloc HTML');
  rows.forEach((r) => { noMarkup(r.statusText ?? ''); noMarkup(r.preview?.text ?? ''); });
});

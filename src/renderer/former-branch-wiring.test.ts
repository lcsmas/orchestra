import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #384 source-wiring: BOTH sidebar row render paths (the pinned-tree row and the repo-section row) show `ex-<previous>`
// through the ONE shared helper, keep their "(locked)" / "double-click to rename" text, and `orchestra peers` carries
// the field end to end (PeerInfo → dispatchPeersRequest → CLI column). A planted inline copy / dropped call turns it red.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
// A constructed "ex-" label (template / concatenation), not a mention in a comment.
const INLINE_EX = /`ex-\$\{|['"]ex-['"] *\+/;
const sidebar = read('renderer/components/Sidebar.tsx');
const ws = read('main/workspaces.ts');
const cli = read('cli/index.ts');

test('Sidebar: both row title paths go through withExLabel(…, w.formerBranch)', () => {
  const calls = sidebar.match(/title=\{withExLabel\(/g) ?? [];
  assert.equal(calls.length, 2, 'exactly the two row render paths call the helper');
  const args = sidebar.match(/w\.formerBranch,\n\s*\)\}/g) ?? [];
  assert.equal(args.length, 2, 'each call passes w.formerBranch');
  assert.match(sidebar, /import \{ withExLabel \} from '\.\.\/\.\.\/shared\/former-branch';/);
  assert.doesNotMatch(sidebar, INLINE_EX, 'no inline copy of the "ex-" prefix: the shared module owns it');
});

test('Sidebar: the existing "(locked)" / "double-click to rename" tooltip text is kept on both paths', () => {
  assert.match(sidebar, /`\$\{w\.branch\} \(locked\)`/);
  assert.match(sidebar, /`\$\{w\.branch\} — double-click to rename`/);
  assert.match(sidebar, /— orchestrator · double-click to rename/);
  assert.match(sidebar, /— spawned by this \$\{rootNoun\} · double-click to rename/);
});

test('peers: the field rides PeerInfo → dispatchPeersRequest → CLI column (no inline "ex-" in the CLI)', () => {
  const info = ws.slice(ws.indexOf('export interface PeerInfo'), ws.indexOf('export interface PeersResult'));
  assert.match(info, /formerBranch\?: string;/);
  const dispatch = ws.slice(ws.indexOf('export async function dispatchPeersRequest('));
  assert.match(dispatch.slice(0, 1500), /\.\.\.\(w\.formerBranch \? \{ formerBranch: w\.formerBranch \} : \{\}\),/);
  const cliInfo = cli.slice(cli.indexOf('interface PeerInfo {'), cli.indexOf('\n}\n', cli.indexOf('interface PeerInfo {')));
  assert.match(cliInfo, /formerBranch\?: string;/);
  assert.match(cli, /const exCells = peersExColumn\(peers\);/);
  assert.match(cli, /import \{ peersExColumn \} from '\.\.\/shared\/former-branch\.ts';/);
  assert.doesNotMatch(cli, INLINE_EX, 'the prefix lives in shared/former-branch.ts only');
});

test('renameWorkspaceBranch: both write paths (relabel + real rename) spread formerBranchPatch; the no-op branches do not', () => {
  const start = ws.indexOf('export async function renameWorkspaceBranch(');
  const body = ws.slice(start, ws.indexOf('export interface RenameResult', start));
  assert.equal((body.match(/\.\.\.formerBranchPatch\(/g) ?? []).length, 2, 'exactly the two name-changing writes');
  assert.match(body, /formerBranchPatch\(ws, ws\.branch, newBranch,/, 'scratch relabel: the stored label is the previous name');
  assert.match(body, /formerBranchPatch\(ws, liveBranch, newBranch,/, 'git rename: the LIVE branch is the previous name, not the drifted stored one');
});

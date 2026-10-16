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
const activity = read('main/activity.ts');
const cli = read('cli/index.ts');

test('Sidebar: both row title paths go through withExLabel(…, w.formerBranch)', () => {
  const calls = sidebar.match(/title=\{withExLabel\(/g) ?? [];
  assert.equal(calls.length, 2, 'exactly the two row render paths call the helper');
  const args = sidebar.match(/w\.formerBranch,\n\s*\)\}/g) ?? [];
  assert.equal(args.length, 2, 'each call passes w.formerBranch');
  assert.match(sidebar, /import \{ withExLabel \} from '\.\.\/\.\.\/shared\/former-branch';/);
  assert.doesNotMatch(sidebar, INLINE_EX, 'no inline copy of the "ex-" prefix: the shared module owns it');
});

test('Sidebar: the ARCHIVED row (a third render path) shows it only for a renamed workspace — an unrenamed archived row keeps its DOM', () => {
  assert.match(sidebar, /<div className="ws-name" title=\{w\.formerBranch \? withExLabel\(w\.branch, w\.formerBranch\) : undefined\}>\{w\.branch\}<\/div>/);
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

test('renameWorkspaceBranch: the three name-changing writes spread formerBranchPatch; the no-op returns do not', () => {
  const start = ws.indexOf('export async function renameWorkspaceBranch(');
  const body = ws.slice(start, ws.indexOf('export interface RenameResult', start));
  assert.equal((body.match(/\.\.\.formerBranchPatch\(/g) ?? []).length, 3, 'the three name-changing writes: relabel, git rename, drift adoption');
  assert.match(body, /\.\.\.formerBranchPatch\(ws, ws\.branch, liveBranch, opts\.namedByParent\)/, 'drift adoption: stored → live is a name change of the record');
  assert.equal((body.match(/formerBranchPatch\(ws, ws\.branch, newBranch,/g) ?? []).length, 2, 'relabel AND git rename: the DISPLAYED (stored) name is the previous name — never a drifted live branch nobody saw');
  assert.doesNotMatch(body, /formerBranchPatch\(ws, liveBranch, newBranch/, 'm2: the live branch is not what is recorded');
});

test('activity.detectAndUpdateBranchName: an out-of-band `git branch -m` adoption records the replaced name too (D3: every ACTUAL name change)', () => {
  const start = activity.indexOf('export async function detectAndUpdateBranchName(');
  const body = activity.slice(start, activity.indexOf('\n}\n', start));
  // #383: the adoption's pin is `adoptedBranchPin(fresh)` (no human decision any more), so the replaced name is recorded with `pin.namedByParent`
  assert.match(body, /\.\.\.formerBranchPatch\(fresh, fresh\.branch, live, pin\.namedByParent\),/);
  assert.match(activity, /import \{ formerBranchPatch \} from '\.\.\/shared\/former-branch\.ts';/);
});

test('orchestra-comms skill (generated, shipped to every agent): the `peers` legend and prose name the `ex` column', () => {
  const a = ws.indexOf('const COMMS_SKILL = `');
  const skill = ws.slice(a, ws.indexOf('const WORKSPACE_ADMIN_SKILL', a)).replace(/\\`/g, '`');
  assert.ok(a !== -1 && skill.length > 3_000, 'COMMS_SKILL located');
  assert.match(skill, /orchestra peers {12}# id {2}branch {2}\[ex\] {2}repo {2}status/, 'the legend lists the optional ex column between branch and repo');
  assert.match(skill, /`ex` column \(`ex-<old name>`\)/, 'the prose says what ex-<old name> is for');
});

// #612 — liveness never escalates ABOUT a no-agent workspace: the liveness roster marks a member `hasTask` from `lastTask`, and a no-agent workspace is created with none (`createWorkspace` writes
// `lastTask` only from a spawn's task; `dispatchSpawnRequest` passes none for `--no-agent`). Pinned through the REAL roster builder so a future default task would turn this red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLivenessRoster, type LivenessRosterStore } from './bus-liveness-roster.ts';
import type { Workspace } from '../shared/types.ts';

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, name: id, repoPath: '/r', worktreePath: `/w/${id}`, branch: id, baseBranch: 'main', createdAt: 1, status: 'idle', agent: 'claude', ...over } as Workspace);

test('the liveness roster does not count a no-agent workspace as a dispatched member (hasTask=false) — it has no lastTask by construction', () => {
  const list = [ws('lead'), ws('na', { noAgent: true, runCommand: 'x', parentId: 'lead' }), ws('agent', { parentId: 'lead', lastTask: 'build it' })];
  const store: LivenessRosterStore = { workspaces: list, getWorkspace: (id) => list.find((w) => w.id === id) };
  const members = buildLivenessRoster(store, (w) => w.id)();
  assert.equal(members.find((m) => m.reader === 'na')!.hasTask, false);
  assert.equal(members.find((m) => m.reader === 'agent')!.hasTask, true, 'control: an agent member with a task IS tracked (the field is not a constant)');
});

test('wiring: nothing in the spawn path gives a no-agent workspace a task (lastTask stays unset)', () => {
  const src = fs.readFileSync('src/main/workspaces.ts', 'utf8');
  assert.match(src, /\.\.\.\(input\.noAgent \? \{\} : \{ task \}\), \/\/ #612/, 'createWorkspace is called WITHOUT a task for --no-agent');
});

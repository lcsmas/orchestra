// #332 — source-binding gate for the keeper's leaf layout (the keeper daemon cannot load under `node --test`): every hop of «keeper in k, CLI + tools in w, the cap and the watch on w» is wired.
// The leaf builder's order and failure handling are proven in member-leaves.test.ts; the real scope end to end in scripts/e2e-memory-cap.mjs (`session_survives_chain`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const keeper = readFileSync(path.join(here, 'index.ts'), 'utf8');
const setup = keeper.slice(keeper.indexOf('function setupMemoryCap('), keeper.indexOf('\n}\n', keeper.indexOf('function setupMemoryCap(')));
const startChild = keeper.slice(keeper.indexOf('function startChild('), keeper.indexOf('\n}\n', keeper.indexOf('function startChild(')));

test('CONTROL: the slices are the real functions', () => {
  assert.match(setup, /startMemoryWatch\(\{/);
  assert.match(startChild, /spawn\(command, args,/);
});

test('the scope\'s leaves are built by THIS keeper, from its own pid, after the scope was identified (leaf k maps back to the scope on a repeat call)', () => {
  assert.match(setup, /const inKeeperLeaf = !!cgPath && path\.basename\(cgPath\) === SCOPE_LEAF_KEEPER;/);
  assert.match(setup, /const scopePath = cgPath \? scopePathOfCgroup\(cgPath\) : null;/);
  assert.match(setup, /buildMemberLeaves\(\{ scopeDir: path\.join\(CGROUP_ROOT, scopePath\), hardBytes: cap\.hardBytes, pid: process\.pid, fs: realLeafFs, alreadyInKeeperLeaf: inKeeperLeaf \}\)/);
  const checkAt = setup.indexOf('path.basename(scopePath) !== cap.unit');
  assert.ok(checkAt > 0 && checkAt < setup.indexOf('buildMemberLeaves('), 'the scope is verified to be OURS before anything is created or moved');
});

test('fail closed: leaves that could not be built ⇒ state not-applied, said in the log, no wrapper, no watch (return before both)', () => {
  const failed = setup.slice(setup.indexOf('if (!leaves.ok) {'), setup.indexOf('workLeafDir = leaves.workDir;'));
  assert.match(failed, /state: 'not-applied'/);
  assert.match(failed, /klog\(`memory cap: scope \$\{cap\.unit\} is not delegated or its leaves could not be built/);
  assert.match(failed, /return env;/);
  assert.ok(setup.indexOf('if (!leaves.ok) {') < setup.indexOf('startMemoryWatch({'));
});

test('the cap, its read-back checks and the kill watch are on the WORK leaf (`dir`), never on the scope or the keeper leaf', () => {
  assert.match(setup, /workLeafDir = leaves\.workDir;\n  const dir = leaves\.workDir;/);
  assert.match(setup, /parseCgroupLimit\(fs\.readFileSync\(path\.join\(dir, 'memory\.max'\), 'utf8'\)\)/);
  assert.match(setup, /memWatch = startMemoryWatch\(\{\n    cgroupDir: dir,/);
});

test('the CLI starts INSIDE the work leaf (the keeper does not), through the self-moving sh; an uncapped keeper never does', () => {
  assert.match(startChild, /if \(workLeafDir\) \{[\s\S]*inWorkLeafArgv\(workLeafDir, command, args\)[\s\S]*command = w\.command;[\s\S]*args = w\.args;/);
  assert.ok(startChild.indexOf('inWorkLeafArgv(') < startChild.indexOf('spawn(command, args,'), 'the argv is rewritten BEFORE the spawn');
  assert.equal((keeper.match(/workLeafDir = /g) ?? []).length, 1, 'declared null; assigned in ONE place — once the leaves exist');
  assert.match(keeper, /let workLeafDir: string \| null = null;/);
});

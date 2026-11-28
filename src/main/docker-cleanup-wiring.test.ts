// #696 — wiring pins for the sources the unit tests cannot import (they pull in the whole main process). Behaviour is proven in docker-cleanup.test.ts on the fake dockerd;
// THESE pin that the delete path reaches it for EVERY kind of workspace (the scratch/sandbox early returns of teardownWorkspace used to skip anything placed after them),
// that the socket route + CLI carry the flag and the report, and that the sweep is started after the store loads. CODE only (comments stripped), top-level statements.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/[ \t]+$/gm, '');
const fn = (src: string, decl: string): string => {
  const a = src.indexOf(decl);
  assert.ok(a >= 0, `declaration not found: ${decl}`);
  const next = src.slice(a + decl.length).search(/\n(?:export )?(?:async )?function |\n\/\*\*/);
  return code(src.slice(a, next < 0 ? undefined : a + decl.length + next));
};
const ws = read('src', 'main', 'workspaces.ts');

test('teardownWorkspace removes the member\'s containers AFTER its session stops and BEFORE the scratch / sandbox early returns', () => {
  const body = fn(ws, 'async function teardownWorkspace(ws: Workspace');
  const stop = body.search(/^ {2}await stopStructuredSession\(id\);$/m);
  const rm = body.search(/^ {2}const docker = await removeWorkspaceContainers\(dockerApi, id, \{ removeNamedVolumes: opts\.removeNamedVolumes \}\);$/m);
  const early = body.search(/^ {2}if \(isScratchLike\(ws\)\) \{$/m);
  assert.ok(stop >= 0 && rm > stop && early > rm, `order stop(${stop}) < removeWorkspaceContainers(${rm}) < scratch early return(${early})`);
  assert.match(body, /^ {2}const dockerApi = dockerApiForMember\(keeperSocketPath\(id\), cleanupDockerApi\(\)\);$/m, 'the member\'s pinned daemon is resolved before its keeper dies');
  assert.ok(body.search(/dockerApiForMember/) < stop);
  assert.match(body, /^ {2}opts\.onDockerReport\?\.\(docker\);$/m);
});

test('deleteWorkspace / deleteWorkspaces / the socket route all reach teardownWorkspace; the route threads the flag and returns the report', () => {
  assert.match(fn(ws, 'export async function deleteWorkspace(id: string'), /^ {4}await teardownWorkspace\(ws, opts\);$/m);
  assert.match(fn(ws, 'export async function deleteWorkspaces('), /^ {6}await teardownWorkspace\(ws\);$/m);
  const route = fn(ws, 'export async function dispatchDeleteWorkspaceRequest(');
  assert.match(route, /removeNamedVolumes: input\.removeVolumes === true/);
  assert.match(route, /return \{ ok: true, id, branch, \.\.\.\(docker \? \{ docker \} : \{\}\) \};/);
  assert.match(code(read('src', 'main', 'hooks-server.ts')), /dispatchDeleteWorkspaceRequest\(\{ id: msg\.id, removeVolumes: msg\.removeVolumes === true \}\)/);
});

test('the CLI sends --volumes and prints the report', () => {
  const cli = code(read('src', 'cli', 'index.ts'));
  assert.match(cli, /request\('\/deleteWorkspace', \{ id, \.\.\.\(volumes \? \{ removeVolumes: true \} : \{\}\) \}\)/);
  assert.match(cli, /for \(const line of formatCleanupReport\(docker\)\) process\.stdout\.write/);
  assert.match(read('src', 'cli', 'help.ts'), /orchestra delete <id> \[--yes\] \[--volumes\]/);
});

test('the sweep starts after the store loads and stops at quit; it is only ever handed the store + bus predicates and the real store-ready gate', () => {
  const idx = code(read('src', 'main', 'index.ts'));
  assert.ok(idx.search(/^ {6}startResourceMonitor\(\);$/m) >= 0 && idx.search(/^ {6}startDockerSweep\(\);$/m) > idx.search(/^ {6}startResourceMonitor\(\);$/m));
  assert.match(idx, /^ {2}stopDockerSweep\(\);$/m);
  const host = code(read('src', 'main', 'docker-sweep-host.ts'));
  assert.match(host, /storeReady: \(\) => windowDeps\.storeReady\(\),/);
  assert.match(host, /workspaceExists: \(id\) => !!windowDeps\.getWorkspace\(id\),/);
  assert.match(host, /runKnown,/);
  assert.match(host, /const runKnown = runKnownIn\(windowDeps\);/);
});

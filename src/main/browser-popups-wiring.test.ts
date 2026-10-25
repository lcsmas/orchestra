// #396 — wiring pins for the popup windows' lifetime in source files the unit tests cannot import (they pull in the whole main process).
// Behaviour is proven in browser-panel-popups.test.ts (destroyPanel closes every child window) and by the rig's archive arm; THESE pin that every
// delete path reaches destroyPanel: the socket route used to skip it, leaking the workspace's tabs and now its popup windows too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');
const ws = read('src', 'main', 'workspaces.ts');
const fn = (src: string, decl: string): string => {
  const a = src.indexOf(decl);
  assert.ok(a >= 0, `declaration not found: ${decl}`);
  const next = src.slice(a + decl.length).search(/\n(?:export )?(?:async )?function |\n\/\*\*/);
  return src.slice(a, next < 0 ? undefined : a + decl.length + next);
};

test('teardownWorkspace destroys the browser panel: the socket `orchestra delete`, the bulk delete and repo removal all go through it', () => {
  const body = fn(ws, 'async function teardownWorkspace(ws: Workspace)');
  assert.match(body, /destroyBrowserPanel\(id\);/);
});

test('control: deleteWorkspace and deleteWorkspaces both tear down through teardownWorkspace; the socket route calls deleteWorkspace', () => {
  assert.match(fn(ws, 'export async function deleteWorkspace(id: string)'), /await teardownWorkspace\(ws\);/);
  assert.match(fn(ws, 'export async function deleteWorkspaces('), /await teardownWorkspace\(ws\);/);
  assert.match(fn(ws, 'export async function dispatchDeleteWorkspaceRequest('), /await deleteWorkspace\(id\);/);
});

test('control: archiveWorkspace still destroys the browser panel itself', () => {
  assert.match(fn(ws, 'export async function archiveWorkspace('), /destroyBrowserPanel\(ws\.id\);/);
});

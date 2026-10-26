// #396 — wiring pins for the popup windows' lifetime in source files the unit tests cannot import (they pull in the whole main process).
// Behaviour is proven in browser-panel-popups.test.ts (destroyPanel closes every child window) and by the rig's archive arm; THESE pin that every
// delete path reaches destroyPanel: the socket route used to skip it, leaking the workspace's tabs and now its popup windows too.
// The pins match CODE only (comments stripped) and the call as a top-level statement of the function: a commented-out or conditional call must fail them.

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
/** Source with `//` line comments and block comments removed (a string containing `//` is not a case here). */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/[ \t]+$/gm, '');

test('teardownWorkspace destroys the browser panel as an UNCONDITIONAL top-level statement: the socket `orchestra delete`, the bulk delete and repo removal all go through it', () => {
  const body = code(fn(ws, 'async function teardownWorkspace(ws: Workspace)'));
  assert.match(body, /^ {2}destroyBrowserPanel\(id\);$/m, 'a top-level statement (not commented out, not behind an if)');
  // controls for the matcher itself: the two shapes that used to slip through
  assert.doesNotMatch(code('  // destroyBrowserPanel(id);'), /^ {2}destroyBrowserPanel\(id\);$/m);
  assert.doesNotMatch(code('  if (id === "") destroyBrowserPanel(id);'), /^ {2}destroyBrowserPanel\(id\);$/m);
});

test('control: deleteWorkspace and deleteWorkspaces both tear down through teardownWorkspace; the socket route calls deleteWorkspace', () => {
  assert.match(code(fn(ws, 'export async function deleteWorkspace(id: string)')), /^ {2}await teardownWorkspace\(ws\);$/m);
  assert.match(code(fn(ws, 'export async function deleteWorkspaces(')), /^ {4}await teardownWorkspace\(ws\);$/m);
  assert.match(code(fn(ws, 'export async function dispatchDeleteWorkspaceRequest(')), /^ {4}await deleteWorkspace\(id\);$/m);
});

test('control: archiveWorkspace still destroys the browser panel itself', () => {
  assert.match(code(fn(ws, 'export async function archiveWorkspace(')), /^ {4}destroyBrowserPanel\(ws\.id\);$/m);
});

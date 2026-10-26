import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkHomeScratch } from '../shared/home-scratch.ts';

// #389 — scripts/lib/rig-paths.mjs: the physical views behind the driver's symlink checks (seat-1 F2/F3). A stand-in directory named like the
// runtime dir (`<scratch>/standin/run/user/1000`) plays the real one: nothing under /run is ever touched.
type Paths = { physicalPath: (p: string) => string; physicalForms: (p: string) => string[]; absolutePieces: (v: string) => string[] };
const { physicalPath, physicalForms, absolutePieces } = (await import(pathToFileURL(path.join(import.meta.dirname, '../../scripts/lib/rig-paths.mjs')).href)) as Paths;

const scratch = fs.realpathSync(mkHomeScratch('rig-paths-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const standin = path.join(scratch, 'standin/run/user/1000');
fs.mkdirSync(path.join(standin, 'real'), { recursive: true });

test('physicalPath: a path that does not exist yet resolves to where it WOULD land — through a symlinked parent', () => {
  const link = path.join(scratch, 'parent-link');
  fs.symlinkSync(path.join(standin, 'real'), link);
  assert.equal(physicalPath(path.join(link, 'k-unlocked/bus')), path.join(standin, 'real/k-unlocked/bus'), 'missing leaf + missing middle under a link');
  assert.equal(physicalPath(path.join(scratch, 'plain/not/yet')), path.join(scratch, 'plain/not/yet'), 'no link: unchanged');
  assert.equal(physicalPath(link), path.join(standin, 'real'), 'an existing link resolves');
  const chain = path.join(scratch, 'chain-b');
  fs.symlinkSync(link, chain);
  assert.equal(physicalPath(path.join(chain, 'x')), path.join(standin, 'real/x'), 'a chain of links');
  assert.equal(physicalPath('/'), '/');
});

test('physicalForms: realpath AND the literal target of a link — a dangling link into a directory is still read', () => {
  const l = path.join(scratch, 'to-real');
  fs.symlinkSync(path.join(standin, 'real'), l);
  assert.deepEqual([...new Set(physicalForms(l))], [path.join(standin, 'real')], 'real + target + physical landing place agree');
  assert.deepEqual([...new Set(physicalForms(path.join(l, 'sock')))], [path.join(standin, 'real/sock')], 'a MISSING leaf under a linked parent lands where the link points');
  const dangling = path.join(scratch, 'dangling');
  fs.symlinkSync(path.join(standin, 'nothing-here'), dangling);
  assert.ok(physicalForms(dangling).includes(path.join(standin, 'nothing-here')), 'dangling: its target is read');
  assert.deepEqual([...new Set(physicalForms(path.join(scratch, 'missing')))], [path.join(scratch, 'missing')], 'a plain missing path lands on itself');
  assert.deepEqual([...new Set(physicalForms(scratch))], [scratch], 'a plain dir: its realpath only');
});

test('absolutePieces: a plain path, a `:` list, `unix:path=…`, `KEY=/x` — only absolute pieces', () => {
  assert.deepEqual(absolutePieces('/a/b'), ['/a/b']);
  assert.deepEqual(absolutePieces('/usr/bin:/bin:rel/x'), ['/usr/bin', '/bin']);
  assert.deepEqual(absolutePieces('unix:path=/x/bus,guid=abc'), ['/x/bus']);
  assert.deepEqual(absolutePieces('wayland-rig'), []);
  // round-6 minor: the %hh-decoded form is carried into the physical pass
  assert.deepEqual(absolutePieces('unix:path=%2Fsrv%2Flink%2Fbus').sort(), ['/srv/link/bus'], 'an escaped address names its path');
  for (const want of ['/plain dir', '/plain%20dir', '/x']) assert.ok(absolutePieces('/plain%20dir:/x').includes(want), `both the literal and the decoded form (a literal % is legal in a path): ${want}`);
  assert.deepEqual(absolutePieces('unix:path=%2Fbad%zz%2Fbus'), [], 'malformed escape: nothing decoded, nothing guessed (refused lexically before this)');
});

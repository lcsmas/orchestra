// The real probes behind `resolveRelayUpstream` (docker-endpoint.ts): fs path kinds and the `docker context inspect` call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { dockerContextHostViaCli, pathKind } from './docker-endpoint.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-'));

test('pathKind: socket / missing / other', async () => {
  const sock = path.join(dir, 's.sock');
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(sock, r));
  try {
    assert.equal(pathKind(sock), 'socket');
  } finally {
    srv.close();
  }
  assert.equal(pathKind(path.join(dir, 'nothing.sock')), 'missing'); // may appear later (F4)
  fs.writeFileSync(path.join(dir, 'file'), '');
  assert.equal(pathKind(path.join(dir, 'file')), 'other'); // something in the way: refused
  assert.equal(pathKind(path.join(dir, 'file', 'child')), 'other'); // ENOTDIR is not "may appear later"
});

test('dockerContextHostViaCli: the CLI answer, trimmed; failure or silence → null; runs with the GIVEN env (PATH, HOME, no DOCKER_HOST)', async () => {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const fake = (body: string) => fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fake('echo "  unix:///fake/d.sock  "');
  assert.equal(await dockerContextHostViaCli({ PATH: `${bin}:${process.env.PATH}` }), 'unix:///fake/d.sock');
  fake('exit 3');
  assert.equal(await dockerContextHostViaCli({ PATH: `${bin}:${process.env.PATH}` }), null);
  fake('echo unix:///must/not/be/believed.sock; exit 3'); // prints a host but FAILED: the answer of a failing CLI is not an answer
  assert.equal(await dockerContextHostViaCli({ PATH: `${bin}:${process.env.PATH}` }), null);
  fake('true'); // exits 0 saying nothing
  assert.equal(await dockerContextHostViaCli({ PATH: `${bin}:${process.env.PATH}` }), null);
  fake('echo "h=$HOME dh=${DOCKER_HOST-unset}"');
  assert.equal(await dockerContextHostViaCli({ PATH: `${bin}:${process.env.PATH}`, HOME: '/scratch' }), 'h=/scratch dh=unset');
  assert.equal(await dockerContextHostViaCli({ PATH: '/nonexistent' }), null); // no docker CLI at all
  fs.rmSync(dir, { recursive: true, force: true });
});

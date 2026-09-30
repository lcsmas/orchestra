// #252 D1b round-2 F7 (D8 rig safety): the destructive inner rigs REFUSE to run outside their own pid namespace, and a direct run kills nothing.
// The refusal STRING is asserted (an rc alone cannot tell the guard from a crash). Canaries = the exact patterns the old cleanup killed host-wide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const REFUSAL = 'REFUSED: this rig must run in its OWN pid namespace';
const hostNs = process.platform === 'linux' ? fs.readlinkSync('/proc/self/ns/pid') : '';

function aliveArgv(pred: (argv: string[]) => boolean): number[] {
  const out: number[] = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0');
      if (pred(argv)) out.push(Number(n));
    } catch { /* gone */ }
  }
  return out;
}

function killTagged(tag: string): void {
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try {
      if (fs.readFileSync(`/proc/${n}/environ`, 'latin1').split('\0').includes(`PT_RIG_TAG=${tag}`)) process.kill(Number(n), 'SIGKILL');
    } catch { /* gone / not ours */ }
  }
}

test('F7 a DIRECT run of each destructive inner rig (host pid namespace, or missing tag / launcher namespace) is REFUSED by name, exits 3 and kills NOTHING (keeper.js / sleep canaries survive)', { timeout: 120_000 }, async () => {
  if (process.platform !== 'linux') return;
  const tag = `ptg-${process.pid}-${Date.now()}`;
  const canaries: ChildProcess[] = [];
  try {
    canaries.push(spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '/x/.orchestra/bin/keeper.js', 'canary'], { stdio: 'ignore' }));
    canaries.push(spawn('/bin/sleep', ['7811'], { stdio: 'ignore' }));
    await new Promise((r) => setTimeout(r, 300));
    const before = aliveArgv((a) => a.some((x) => x.endsWith('keeper.js') && x.includes('/x/.orchestra')) || (a[0]?.endsWith('sleep') && a[1] === '7811'));
    assert.ok(before.length >= 2, 'control: both canaries are up before the refused runs');
    for (const inner of ['provenance-inner.mjs', 'recycle-inner.mjs']) {
      for (const cfg of [
        { REPO, tag, hostPidNs: hostNs }, // same namespace as the launcher ⇒ refused
        { REPO, hostPidNs: hostNs }, // no tag
        { REPO, tag }, // no launcher namespace
      ]) {
        const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'pause-trap', inner)],
          { cwd: REPO, encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', PT_CONFIG: JSON.stringify(cfg) } });
        assert.equal(r.status, 3, `${inner} ${JSON.stringify(Object.keys(cfg))}: refused with rc 3 (got ${r.status}; ${(r.stderr ?? '').slice(0, 200)})`);
        assert.ok((r.stdout ?? '').includes(REFUSAL), `${inner}: the refusal names the guard (got: ${(r.stdout ?? '').slice(0, 200)})`);
      }
    }
    const after = aliveArgv((a) => a.some((x) => x.endsWith('keeper.js') && x.includes('/x/.orchestra')) || (a[0]?.endsWith('sleep') && a[1] === '7811'));
    assert.deepEqual(after.sort(), before.sort(), 'no canary was touched');
  } finally {
    killTagged(tag);
    for (const c of canaries) c.kill('SIGKILL');
  }
});

test('F7 the inner rigs kill only TAGGED processes (structural: no host-wide keeper.js / sleep-N sweep survives in their cleanup)', () => {
  for (const f of ['provenance-inner.mjs', 'recycle-inner.mjs']) {
    const code = fs.readFileSync(path.join(REPO, 'scripts', 'pause-trap', f), 'utf8');
    assert.ok(code.includes("from './pidns-guard.mjs'") && code.includes('requireOwnPidNs('), `${f} takes the guard`);
    assert.ok(!/endsWith\('keeper\.js'\)[^\n]*SIGKILL/.test(code), `${f}: no untagged keeper.js sweep`);
  }
  const prov = fs.readFileSync(path.join(REPO, 'scripts', 'pause-trap', 'provenance-inner.mjs'), 'utf8');
  assert.ok(prov.includes('isTagged(p.pid, TAG)'), 'provenance cleanup is keyed on the tag');
});

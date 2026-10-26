#!/usr/bin/env node
// #389 — must-FAIL preflight for every keyring / libsecret rig (LEAD ruling 2026-10-26 00:30). Rule set: src/shared/keyring-rig-preflight.ts; host
// accessors, phases and the self-test: src/main/keyring-rig-preflight-host.ts. It NEVER opens /run/user/<uid>/bus or the keyring control socket, and
// never even stats a path naming the per-user runtime dir: the only bus it asks is the rig's own PRIVATE one, a socket (not a link) inside the scratch dir.
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/keyring-rig-preflight.mjs selftest
//   node … scripts/keyring-rig-preflight.mjs check --spec <spec.json>     # selftest FIRST (proves the guard is armed), then the real world
//
// spec.json = { rigDir, phase: 'pre'|'bus'|'daemon', toolEnv: {…}, children: [{label, kind: 'tool'|'app', env: {…}}], expectOwner: bool }
// Exit 0 = every clause held (phase marker written); 2 = bad usage; 3 = ABORT (the verdict names each clause); 4 = the self-test failed (the guard is
// not armed — do not trust a green). A rig that imports the host module calls `await preflightOrDie(spec)` and `requirePhase(rigDir, phase)`.
// This file ALWAYS runs its CLI: there is no "am I the main module" guard to get wrong under a symlink or a path with a space.
import fs from 'node:fs';
import { preflightOrDie, selftest } from '../src/main/keyring-rig-preflight-host.ts';

const [cmd, flag, file] = process.argv.slice(2);
if (cmd === 'selftest' && flag === undefined) {
  const st = await selftest();
  for (const a of st.arms) console.log(`  ${a.ok ? 'PASS' : 'FAIL'}  ${a.name} — expected ${a.expect}, got ${JSON.stringify(a.got)}`);
  console.log(st.ok ? `SELFTEST OK: ${st.arms.length} arms` : 'SELFTEST FAILED');
  process.exit(st.ok ? 0 : 4);
} else if (cmd === 'check' && flag === '--spec' && file) {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`cannot read the spec ${file}: ${e.message}`);
    process.exit(2);
  }
  await preflightOrDie(spec);
} else {
  console.error('usage: keyring-rig-preflight.mjs selftest | check --spec <spec.json>');
  process.exit(2);
}

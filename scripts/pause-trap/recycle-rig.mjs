#!/usr/bin/env node
// Real pid-RECYCLE arm (#252 D1b, D4 identity re-read):  node scripts/pause-trap/recycle-rig.mjs [--json]
// Runs recycle-inner.mjs in `unshare --user --map-root-user --pid --fork --mount-proc` (the only place a pid can be forced to
// be reused: /proc/sys/kernel/ns_last_pid). must-PASS: the innocent process that inherited a planned tool's pid survives.
// must-FAIL: with the signal-time identity re-read REMOVED (load-time mutant) it is killed. Exit 0 / 1 / 3 (VOID: no unshare).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const probe = spawnSync('unshare', ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc', 'sh', '-c', 'echo 100 > /proc/sys/kernel/ns_last_pid && echo ok'], { encoding: 'utf8' });
if (probe.status !== 0 || !probe.stdout.includes('ok')) {
  console.log(`PAUSE-TRAP-RECYCLE: VOID — cannot create a pid namespace with a writable ns_last_pid here (${(probe.stderr || '').trim().slice(0, 160)}); nothing was measured`);
  process.exit(3);
}
function run(mutant) {
  const r = spawnSync('unshare', ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc', process.execPath, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'pause-trap', 'recycle-inner.mjs')],
    { cwd: REPO, encoding: 'utf8', timeout: 90_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', PT_CONFIG: JSON.stringify({ REPO, mutant }) } });
  const line = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{"recycle_rig"'));
  return line ? JSON.parse(line) : { checks: [], ok: false, error: `no result line (rc=${r.status}): ${(r.stderr ?? '').slice(-300)}` };
}
let bad = 0;
for (const [name, mutant, mustRedden] of [['recycle', null, null], ['mutant:identity-reread-removed', 'identity-reread-removed', 'innocent_inheritor_survives']]) {
  const res = run(mutant);
  let ok, why;
  if (mutant) {
    const ran = res.checks.some((c) => c.id === 'recycle_is_real_control' && c.ok);
    const named = res.checks.find((c) => c.id === mustRedden);
    ok = ran && !!named && !named.ok;
    why = ok ? `mutant caught: '${mustRedden}' RED (${named.detail})` : !ran ? `rig broke under the mutant: ${JSON.stringify(res).slice(0, 300)}` : `MUTANT SURVIVED (${named?.detail})`;
  } else { ok = res.ok; why = ok ? `${res.checks.length} checks green` : `RED: ${JSON.stringify(res.checks.filter((c) => !c.ok)).slice(0, 400)} ${res.error ?? ''}`; }
  if (!ok) bad++;
  console.log(`== ${name} (${mutant ? 'must-FAIL' : 'must-PASS'}): ${ok ? 'AS EXPECTED' : 'UNEXPECTED'} — ${why}`);
  for (const c of res.checks ?? []) console.log(`   ${c.ok ? 'ok ' : 'RED'} ${c.id} — ${c.detail}`);
}
console.log(`PAUSE-TRAP-RECYCLE: ${bad === 0 ? 'PASS' : 'FAIL'}`);
process.exit(bad === 0 ? 0 : 1);

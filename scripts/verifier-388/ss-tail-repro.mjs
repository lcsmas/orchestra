// pure repro of the marker-lookalike finding on a REAL-shaped ss row (incl. the `ino:… dev:…` tail ss -e prints). usage: node --experimental-strip-types ss-tail-repro.mjs <repo>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const W = await import(pathToFileURL(path.join(path.resolve(process.argv[2]), 'src/shared/keyring-rig-world.ts')).href);
const PNU = (rows) => 'Num       RefCount Protocol Flags    Type St Inode Path\n' + rows.map(([i, p]) => `0000000000000000: 00000002 00000000 00010000 0001 01 ${i}${p ? ' ' + p : ''}`).join('\n') + '\n';
const HUMAN = '/run/user/1000/bus';
let bad = 0;
const R = '/scratch/rig';
for (const [label, name] of [['CONTROL plain name', `${R}/hostile`], ['name with " --- " + shape tokens', `${R}/p 1 /q 2 --- zz`], ['name with " <-> "', `${R}/p 1 /q 2 <-> zz`], ['name with " --> " and trailing tokens', `${R}/q 1 /r 2 --> zz`], ['name with " <-- w 7 * 8"', `${R}/d 5 /e 6 <-- w 7 * 8`], ['name with " --- 11 * 12"', `${R}/m 9 /n 10 --- 11 * 12`], ['name with " --- " only (no shape)', `${R}/a --- b`]]) {
  const ss = `u_str ESTAB  0      0      ${name} 700 * 701 <-> ino:201225872 dev:0/36 sk:1\nu_str ESTAB  0      0      ${HUMAN} 701 * 700 <-> ino:5 dev:0/36 sk:2\n`;
  const { scan, unparsed } = W.buildSocketScan(PNU([[700, name], [701, HUMAN]]), ss);
  const got = W.socketPaths([700], scan); const sees = got.includes(HUMAN);
  const fabricated = [...scan.peerOf].filter(([k]) => k !== 700 && k !== 701);
  const verdict = sees ? 'SEES the human socket' : unparsed.length ? 'MISSED but REPORTED (fail closed)' : 'MISSED SILENTLY (fail OPEN)';
  if (!sees && !unparsed.length) bad++;
  console.log(`${verdict.padEnd(36)} ${label.padEnd(40)} socketPaths([700])=${JSON.stringify(got)} unparsed=${unparsed.length} fabricatedPairs=${JSON.stringify(fabricated)}`);
}
// the root cause, isolated: the same tail regex the module uses, applied to a path-bearing line
const SS_TAIL = /(?:\s+(?:<->|-->|<--|---)(?:\s.*)?)?$/;
console.log('stripped:', JSON.stringify(`u_str ESTAB 0 0 ${R}/p 1 /q 2 --- zz 700 * 701 <-> ino:1 dev:0/36`.replace(SS_TAIL, '').trim()));
process.exit(bad ? 1 : 0);

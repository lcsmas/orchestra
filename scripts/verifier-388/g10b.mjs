#!/usr/bin/env node
// G10b (seat 1, vague #388): READ-ONLY listing of the human's default (login) Secret Service collection — item paths + Label/Attributes/Created/Modified per item.
// NEVER a secret value, NEVER a write: every D-Bus call goes through `call()`, which refuses anything but org.freedesktop.DBus.Properties.Get/GetAll
// (GetSecret / Delete / SetSecret / CreateItem / Unlock are unreachable; the must-FAIL self-test below proves the refusal).
// usage: node g10b.mjs snap <out.json> | diff <a.json> <b.json> [rig-name] | selftest
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const BUS = `unix:path=/run/user/${process.getuid()}/bus`; // the human's session bus, addressed explicitly (env may hold nothing)
const ALLOWED = new Set(['org.freedesktop.DBus.Properties.Get', 'org.freedesktop.DBus.Properties.GetAll']);
function call(objectPath, method, ...args) {
  if (!ALLOWED.has(method)) throw new Error(`G10b REFUSED: ${method} is not a read-only property call`);
  const r = spawnSync('gdbus', ['call', '--address', BUS, '--timeout', '5', '--dest', 'org.freedesktop.secrets', '--object-path', objectPath, '--method', method, ...args], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  if (r.status !== 0) throw new Error(`gdbus ${method} ${objectPath} rc=${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`);
  return r.stdout.trim();
}
function snap() {
  const items = call('/org/freedesktop/secrets/aliases/default', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Items');
  const paths = [...items.matchAll(/'(\/org\/freedesktop\/secrets\/collection\/[^']+)'/g)].map((m) => m[1]).sort();
  const locked = call('/org/freedesktop/secrets/aliases/default', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Locked');
  const colLabel = call('/org/freedesktop/secrets/aliases/default', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Label');
  const out = { at: new Date().toISOString(), collectionLabel: colLabel, collectionLocked: locked, items: [] };
  for (const p of paths) {
    const all = call(p, 'org.freedesktop.DBus.Properties.GetAll', 'org.freedesktop.Secret.Item'); // Locked, Attributes, Label, Created, Modified — no secret
    const pick = (k) => (new RegExp(`'${k}':\\s*<(.*?)>(?:,\\s*'|\\}\\s*,?\\)?$)`, 's').exec(all) || [])[1] ?? null;
    out.items.push({ path: p, label: pick('Label'), attributes: pick('Attributes'), created: pick('Created'), modified: pick('Modified'), raw: all });
  }
  return out;
}
const [cmd, a, b, rig] = process.argv.slice(2);
if (cmd === 'snap') {
  const s = snap(); fs.writeFileSync(a, JSON.stringify(s, null, 1));
  console.log(`G10b snap: collection=${s.collectionLabel} locked=${s.collectionLocked} items=${s.items.length} ${s.items.map((i) => `[${i.label} created=${i.created} modified=${i.modified}]`).join(' ')}`);
} else if (cmd === 'diff') {
  const A = JSON.parse(fs.readFileSync(a, 'utf8')), B = JSON.parse(fs.readFileSync(b, 'utf8'));
  const key = (s) => JSON.stringify(s.items.map((i) => [i.path, i.raw]));
  const same = key(A) === key(B);
  const added = B.items.filter((i) => !A.items.some((j) => j.path === i.path)).map((i) => i.label);
  const removed = A.items.filter((i) => !B.items.some((j) => j.path === i.path)).map((i) => i.label);
  const modified = B.items.filter((i) => A.items.some((j) => j.path === i.path && j.raw !== i.raw)).map((i) => i.label);
  console.log(`G10b ${same ? 'CLEAN' : 'DIRTY'}${rig ? ` rig=${rig}` : ''} items ${A.items.length}->${B.items.length}${same ? '' : ` added=${JSON.stringify(added)} removed=${JSON.stringify(removed)} modified=${JSON.stringify(modified)}`}`);
  process.exit(same ? 0 : 1);
} else if (cmd === 'selftest') {
  // must-FAIL: a write/secret-reading method is refused BEFORE any D-Bus traffic.
  let refused = 0;
  for (const m of ['org.freedesktop.Secret.Item.GetSecret', 'org.freedesktop.Secret.Item.Delete', 'org.freedesktop.Secret.Service.Unlock', 'org.freedesktop.DBus.Properties.Set']) {
    try { call('/org/freedesktop/secrets/aliases/default', m); } catch (e) { if (/REFUSED/.test(e.message)) refused++; }
  }
  console.log(`G10b selftest: ${refused}/4 non-read-only methods refused`); process.exit(refused === 4 ? 0 : 1);
} else { console.error('usage: snap <out> | diff <a> <b> [rig] | selftest'); process.exit(2); }

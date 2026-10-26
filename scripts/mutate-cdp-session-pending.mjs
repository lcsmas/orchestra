// Must-FAIL proof for the child-session settlement (ledger #405, seat-1 `tchurn`): a command in flight on an auto-attached child that detaches is settled
// by the proxy. Mutates src/shared/cdp-session-pending.ts and src/shared/cdp-proxy-core.ts IN PLACE, one clause at a time; each mutant MUST redden its test
// files, and every file is restored from a byte-exact backup and compared after each mutant (and on any exit path).
// Run: node scripts/mutate-cdp-session-pending.mjs [--check]   (RC 0 = every mutant killed; --check: only prove every find-string still matches exactly once)
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PEND = 'src/shared/cdp-session-pending.ts', CORE = 'src/shared/cdp-proxy-core.ts';
const TESTS = { [PEND]: ['src/shared/cdp-session-pending.test.ts'], [CORE]: ['src/shared/cdp-proxy-core-detach.test.ts', 'src/shared/cdp-proxy-core.test.ts'] };
const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'pend-mut-'));
const backups = Object.fromEntries([PEND, CORE].map((f) => { const b = path.join(dir, path.basename(f) + '.orig'); copyFileSync(path.join(root, f), b); return [f, b]; }));
const origs = Object.fromEntries([PEND, CORE].map((f) => [f, readFileSync(path.join(root, f), 'utf8')]));

const FORWARD = "return childSessionId ? st.pending.track(childSessionId, forward, () => new CdpError('Session with given id not found.', ERR_SERVER)) : forward();";
const MUTANTS = [
  [CORE, 'a child\'s detach announcement settles nothing (the command stays pending until the whole debugger detaches)',
    'if (gone) st.pending.abort(gone);', ''],
  [CORE, 'child commands are forwarded untracked (nothing to settle)',
    FORWARD, 'return forward();'],
  [CORE, 'a child\'s detach settles the commands of EVERY child',
    'if (gone) st.pending.abort(gone);', 'if (gone) for (const ch of [...st.children, gone]) st.pending.abort(ch);'],
  [CORE, 'the settled command is answered with another error than the one a later command on that session gets',
    FORWARD, FORWARD.replace("'Session with given id not found.'", "'Target closed.'")],
  [PEND, 'abort rejects nothing',
    'if (finish()) reject(onAbort());', 'finish();'],
  [PEND, 'abort settles the commands of every session',
    'const set = this.bySession.get(sessionId);\n    if (!set) return 0;\n    const all = [...set];', 'const all = [...this.bySession.values()].flatMap((s) => [...s]);\n    if (all.length === 0) return 0;'],
  [PEND, 'abort reports no count',
    'return all.length;', 'return 0;'],
  [PEND, 'a command that settles normally stays tracked',
    'if (finish()) resolve(r);', 'resolve(r);'],
  [PEND, 'a send that throws synchronously stays tracked',
    'if (finish()) reject(e);\n        return;', 'reject(e);\n        return;'],
  [PEND, 'a retired session is tracked and forwarded again',
    'if (this.retired.has(sessionId)) return Promise.reject(onAbort());', ''],
  [PEND, 'abort does not retire the session (only what was in flight is settled)',
    '    this.retired.add(sessionId);\n', ''],
  [PEND, 'the retired set is never trimmed',
    'if (this.retired.size > this.retiredCap)', 'if (false)'],
  [CORE, 'a dropped debugger (replaced / destroyed / detached) leaves the commands in flight on its children pending',
    'st.pending.abortAll();', ''],
  [PEND, 'abortAll settles the first session only',
    'for (const sessionId of [...this.bySession.keys()]) n += this.abortPending(sessionId);', 'for (const sessionId of [...this.bySession.keys()].slice(0, 1)) n += this.abortPending(sessionId);'],
  [PEND, 'abortAll reports no count',
    '    return n;\n  }\n\n  /** Commands in flight on', '    return 0;\n  }\n\n  /** Commands in flight on'],
];

if (process.argv.includes('--check')) {
  let bad = 0;
  for (const [file, name, find] of MUTANTS) {
    const n = origs[file].split(find).length - 1;
    if (n !== 1) bad++;
    console.log(`${n === 1 ? 'OK ' : 'BAD'} (${n}x) ${name}`);
  }
  console.log(bad ? `${bad} anchor(s) stale` : `all ${MUTANTS.length} mutant anchors match exactly once`);
  process.exit(bad ? 1 : 0);
}

const run = (files) => spawnSync('node', ['--test', '--experimental-strip-types', ...files], { cwd: root, encoding: 'utf8' });
function restoreAll() {
  for (const f of Object.keys(backups)) copyFileSync(backups[f], path.join(root, f));
  return Object.keys(backups).every((f) => readFileSync(path.join(root, f)).equals(readFileSync(backups[f])));
}
process.on('exit', () => { try { restoreAll(); } catch {} });
for (const [sig, rc] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => process.exit(rc));

for (const f of Object.keys(TESTS)) {
  const base = run(TESTS[f]);
  if (base.status !== 0) { console.log(`BASELINE FAILS for ${f} — abort\n${base.stdout.slice(-1500)}`); process.exit(2); }
}
console.log('baseline PASS (pending + core tests)');

let killed = 0; const survivors = [];
for (const [file, name, find, replace] of MUTANTS) {
  const n = origs[file].split(find).length - 1;
  if (n !== 1) { console.log(`ABORT: mutant "${name}" find-string occurs ${n}x in ${file} (need exactly 1)`); restoreAll(); process.exit(2); }
  writeFileSync(path.join(root, file), origs[file].replace(find, () => replace));
  const r = run(TESTS[file]);
  restoreAll();
  const dead = r.status !== 0;
  if (dead) killed++; else survivors.push(name);
  console.log(`${dead ? 'KILLED  ' : 'SURVIVED'} ${name}${dead ? `  (${(r.stdout.match(/^not ok .*/gm) || []).length} arm(s) red)` : ''}`);
}
const same = restoreAll();
console.log(`\n${killed}/${MUTANTS.length} killed; restore byte-exact: ${same}`);
process.exit(survivors.length || !same ? 1 : 0);

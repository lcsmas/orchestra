// #240 — in-place mutants of every clause of the account-migration transcript move. Each mutant edits ONE clause (exact-string, must match
// exactly once), runs the suites that should notice, and must turn at least one RED; the file is restored byte-exact (Buffer compare) after each.
// A clean control (suites green, unmutated) runs first and last. Usage: node scripts/migrate-transcripts-mutants.mjs [m1 m2 …]
// Suites: `unit` = transcript-move.test.ts + migrate-account-wiring.test.ts (node --test); `rig:<arm>` = scripts/e2e-migrate-transcripts.mjs <arm>.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOVE = 'src/main/transcript-move.ts';
const WS = 'src/main/workspaces.ts';

/** [id, file, from, to, suites, what it breaks] */
const MUTANTS = [
  ['m01-no-identity-check', MOVE, 'if (sameDir(srcDir, dstDir)) return { warnings };', 'if (false) return { warnings };', ['unit'], 'the same dir is no longer recognized'],
  ['m02-string-compare', MOVE, 'if (sameDir(srcDir, dstDir)) return { warnings };', 'if (srcDir === dstDir) return { warnings };', ['unit'], 'identity replaced by the master string compare'],
  ['m03-overwrite-dest', MOVE, "    if (!(await exists(it.to))) moves.push(it);\n    else if (await exists(it.from)) keep(", "    moves.push(it);\n    if (false) keep(", ['unit'], 'a same-named destination entry is overwritten'],
  ['m04-no-rollback', MOVE, 'for (const it of moved.reverse()) {', 'for (const it of [] as Item[]) {', ['unit'], 'a failed rename leaves the move half done'],
  ['m05-rm-recursive-srcdir', MOVE, 'await rmdir(srcDir).catch(', 'await rm(srcDir, { recursive: true, force: true }).catch(', ['unit'], 'the source dir goes by rm -r (a late file is deleted)'],
  ['m06-no-copy-verify', MOVE, 'if (bad) throw new Error(`transcript copy not verified', 'if (false) throw new Error(`transcript copy not verified', ['unit'], 'a corrupt copy is accepted'],
  ['m07-no-changed-since', MOVE, 'if ((await statSig(it.from).catch(() => null)) !== it.pre) {', 'if (false) {', ['unit'], 'a source that grew after the copy is removed'],
  ['m08-no-distinct-object', MOVE, 'if (a === null || b === null || a === b) {', 'if (false) {', ['unit'], 'a source indistinguishable from its copy is removed'],
  ['m09-no-tmp-cleanup', MOVE, 'for (const p of ours) await rm(p, { recursive: true, force: true }).catch(() => undefined);', '/* mutant: no cleanup */', ['unit'], 'a failed copy leaves tmp/partial files at the destination'],
  ['m10-enoent-throws', MOVE, "if (errCode(err) === 'ENOENT' && !(await exists(it.from))) continue;", 'if (false) continue;', ['unit'], 'a concurrent mover taking an entry makes this one throw'],
  ['m11-vanished-src-throws', MOVE, "if (errCode(err) === 'ENOENT' && !(await exists(srcDir))) return { warnings };", 'if (false) return { warnings };', ['unit'], 'a source removed by a concurrent mover makes this one throw'],
  ['m12-unreadable-swallowed', MOVE, "if (errCode(err) !== 'ENOENT' && errCode(err) !== 'ENOTDIR') {", 'if (false) {', ['unit'], 'an unreadable source dir is silently skipped'],
  ['m13-copy-drops-mtime', MOVE, 'preserveTimestamps: true, verbatimSymlinks', 'preserveTimestamps: false, verbatimSymlinks', ['unit'], 'the copy path resets mtimes (claude --continue picks the newest)'],
  ['m15-stale-late-entries-lost', MOVE, 'const stranded = (await readdir(srcDir).catch(() => [] as string[])).filter((n) => !kept.has(n));\n      if (stranded.length)', 'const stranded: string[] = [];\n      if (stranded.length)', ['unit'], 'a late file in the source is not reported'],
  ['w01-no-lock-check', WS, 'if (migrationsInFlight.has(id)) return', 'if (false) return', ['rig:concurrent_same', 'unit'], 'a 2nd migration of one workspace is admitted'],
  ['w02-lock-never-released', WS, '    migrationsInFlight.delete(id);\n', '    /* mutant: never released */\n', ['rig:different', 'unit'], 'the lock outlives the call: the next migration is refused'],
  ['w03-lock-not-taken', WS, 'migrationsInFlight.add(id);', '/* mutant */', ['rig:concurrent_diff', 'unit'], 'the check passes but nothing is held'],
  ['w04-string-compare-config', WS, 'if (sameDir(srcConfigDir, dstConfigDir)) return { warnings: [] };', 'if (srcConfigDir === dstConfigDir) return { warnings: [] };', ['unit'], 'the config-dir belt reverts to the string compare (the project-dir identity still holds: pinned by source only)'],
  ['w05-warnings-dropped', WS, ', ...(moveReport.warnings.length ? { warnings: moveReport.warnings } : {}) }', ' }', ['unit'], 'the move warnings never reach the caller'],
];

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 300000 });
  return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
function suite(name) {
  if (name === 'unit') {
    const r = run('node', ['--test', '--experimental-strip-types', 'src/main/transcript-move.test.ts', 'src/main/migrate-account-wiring.test.ts']);
    const red = [...r.out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1].slice(0, 70));
    const skipped = Number(/^# skipped (\d+)/m.exec(r.out)?.[1] ?? NaN);
    return { name, green: r.rc === 0 && skipped === 0, red, note: `skipped=${skipped}` };
  }
  const arm = name.slice(4);
  const r = run('node', ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './scripts/.r2-register.mjs', 'scripts/e2e-migrate-transcripts.mjs', arm]);
  const red = [...r.out.matchAll(/^FAIL  (.{0,70})/gm)].map((m) => m[1]);
  return { name, green: r.rc === 0, red, note: `rc=${r.rc}` };
}
const control = (label, names) => {
  const rs = names.map(suite);
  const ok = rs.every((r) => r.green);
  console.log(`CONTROL ${label}: ${ok ? 'CLEAN' : 'DIRTY'} — ${rs.map((r) => `${r.name}:${r.green ? 'green' : 'RED'}(${r.note})`).join(' ')}`);
  return ok;
};

const only = process.argv.slice(2);
const todo = MUTANTS.filter(([id]) => only.length === 0 || only.some((o) => id.startsWith(o)));
const allSuites = [...new Set(MUTANTS.flatMap((m) => m[4]))];
const originals = new Map();
for (const f of new Set(MUTANTS.map((m) => m[1]))) originals.set(f, fs.readFileSync(path.join(REPO, f)));
const restore = () => { for (const [f, b] of originals) fs.writeFileSync(path.join(REPO, f), b); };
process.on('exit', restore);
process.on('SIGINT', () => process.exit(130));

if (!control('before', allSuites)) { console.log('RESULT: ABORT — the unmutated tree is not green'); process.exit(2); }
let survived = 0;
for (const [id, file, from, to, suites, what] of todo) {
  const orig = originals.get(file).toString('utf8');
  const n = orig.split(from).length - 1;
  if (n !== 1) { console.log(`${id}: BROKEN MUTANT — pattern matches ${n}× (need exactly 1)`); survived++; continue; }
  fs.writeFileSync(path.join(REPO, file), orig.replace(from, () => to));
  let killedBy = null;
  const seen = [];
  try {
    for (const s of suites) { const r = suite(s); seen.push(`${s}:${r.green ? 'green' : 'RED'}`); if (!r.green) { killedBy = { s, red: r.red }; break; } }
  } finally { fs.writeFileSync(path.join(REPO, file), originals.get(file)); }
  const restored = Buffer.compare(fs.readFileSync(path.join(REPO, file)), originals.get(file)) === 0;
  if (!restored) { console.log(`${id}: RESTORE FAILED`); process.exit(3); }
  if (killedBy) console.log(`${id}: KILLED by ${killedBy.s} [${killedBy.red.slice(0, 2).join(' | ') || 'non-zero exit'}] — ${what}`);
  else { survived++; console.log(`${id}: SURVIVED (${seen.join(' ')}) — ${what}`); }
}
restore();
const after = control('after', allSuites);
console.log(`RESULT: ${todo.length - survived}/${todo.length} killed, ${survived} survived/broken, control after ${after ? 'CLEAN' : 'DIRTY'}`);
process.exit(survived || !after ? 1 : 0);

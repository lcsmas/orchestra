#!/usr/bin/env node
// #564 rig — switch preNominationChecks + `orchestra fanout check`: every clause MUTATED in a scratch copy of src/ and the test file src/cli/fanout-check.test.ts
// (production paths: `fanout check`, `state set`, `state show`, the checks-file parser, the state reader, the skill render) must go RED.
// Light: no Electron, no network, no tokens; the scratch copy lives under $TMPDIR; the repo is never written.
//   node scripts/e2e-fanout-checks.mjs            control: the unpatched copy must be GREEN (24+ tests, 0 fail, 0 skipped)
//   node scripts/e2e-fanout-checks.mjs --mutants  each mutant (exact string, must occur ONCE in its file — else REFUSED as stale) must be KILLED (≥1 test FAILs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-chk-rig-'));
if (!path.resolve(scratch).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
fs.cpSync(path.join(ROOT, 'src'), path.join(scratch, 'src'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ type: 'module' })); // quiet the module-type reparse warning
const TEST = path.join(scratch, 'src/cli/fanout-check.test.ts');

function run() {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', TEST], { cwd: scratch, encoding: 'utf8', timeout: 240_000, env: { ...process.env, TMPDIR: tmpBase } });
  const out = `${r.stdout}\n${r.stderr}`;
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return { pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests'), out };
}

// [name, file, from, to] — `from` must occur exactly once in `file`.
const S = 'src/shared/fanout-state.ts';
const C = 'src/cli/fanout-check.ts';
const K = 'src/shared/fanout-checks.ts';
const V = 'src/shared/verified-fanout-skill.ts';
const F = 'false as boolean';
const mutants = [
  ['default preNominationChecks flipped on (v0.5.375 profile)', S, "minorPolicy: 'legacy', verifier: 'on', preNominationChecks: 'off' }; // #559", "minorPolicy: 'legacy', verifier: 'on', preNominationChecks: 'on' }; // #559"],
  ['default preNominationChecks flipped on (v0.5.378 profile)', S, "minorPolicy: 'spec', verifier: 'on', preNominationChecks: 'off' };", "minorPolicy: 'spec', verifier: 'on', preNominationChecks: 'on' };"],
  ['the switch is not in the table (unknown name)', S, "verifier: ['on', 'off'], preNominationChecks: ['on', 'off'] } as const;", "verifier: ['on', 'off'] } as const;"],
  ['state set never asks for a record', S, "if (switchesOf(state).preNominationChecks === 'on' && (next.status === 'nominated'", "if (false as boolean && (next.status === 'nominated'"],
  ['a direct gated status bypasses the record', S, "=== 'on' && (next.status === 'nominated' || next.status === 'gated' || next.verdict === 'pass'", "=== 'on' && (next.status === 'nominated' || next.verdict === 'pass'"],
  ['a failing record admits the nomination', K, "  if (rec.ok) return null;\n", "  return null;\n"],
  ['no record admits the nomination', K, "  if (!rec) return `${ticket}: no check record", `  if (${F}) return \`\${ticket}: no check record`],
  ['the record is looked up by sha, not by tree', K, "const rec = t.tree ? t.checks?.[t.tree] : undefined;", "const rec = t.head ? t.checks?.[t.head] : undefined;"],
  ['any tree\'s record admits the nomination', K, "const rec = t.tree ? t.checks?.[t.tree] : undefined;", "const rec = t.checks ? Object.values(t.checks)[0] : undefined;"],
  ['the refusal does not name the failing command', K, "${bad.map(failureLine).join('\\n')}", "failed"],
  ['the refusal drops the last lines', K, "${r.tail ? `\\n${r.tail}` : ''}", ""],
  ['the tail is not bounded to the last lines', K, "const TAIL_LINES = 20;", "const TAIL_LINES = 100000;"],
  ['a timeout is not a failure (record)', K, "ok: !nothingFound && results.every((r) => r.exit === 0 && !r.timedOut)", "ok: !nothingFound && results.every((r) => r.exit === 0 || r.timedOut)"],
  ['nothing found is a pass (NO SILENT GREEN)', K, "ok: !nothingFound && results.every", "ok: results.every"],
  ['nothing found is not flagged when files changed (never set)', C, "const nothingFound = source === 'discovered' && changed > 0 && specs.length === 0;", "const nothingFound = false;"],
  ['nothing found also with no changed file', C, "const nothingFound = source === 'discovered' && changed > 0 && specs.length === 0;", "const nothingFound = source === 'discovered' && specs.length === 0;"],
  ['the nothing-found refusal text is dropped', K, "  if (rec.nothingFound) return `${ticket}: the pre-nomination checks found NOTHING", "  if (false as boolean) return `${ticket}: the pre-nomination checks found NOTHING"],
  ['discovery adds a package no changed file belongs to', K, "  for (const f of changed) {\n    const dir", "  for (const f of changed.concat(changed.map(() => 'pkg-b/src/y.ts'))) {\n    const dir"],
  ['discovery takes the nearest package.json even without a lint script', K, "const dir = upDirs(f).find((d) => readPkg(d)?.lint);", "const dir = upDirs(f).find((d) => readPkg(d));"],
  ['discovery ignores the lockfile (always npm)', K, "run: lock ? lock[1] : 'npm run lint'", "run: 'npm run lint'"],
  ['the lockfile search starts at the root, not the nearest', K, "const lock = upDirs(`${dir}/x`).map(", "const lock = upDirs(`${dir}/x`).reverse().map("],
  ['the override does not win over discovery', C, "  if (override !== null) {", "  if (override !== null && false as boolean) {"],
  ['an explicit empty override is treated as nothing found', C, "const nothingFound = source === 'discovered' && changed > 0 && specs.length === 0;", "const nothingFound = changed >= 0 && specs.length === 0;"],
  ['an unreadable base is guessed as no change', C, "  throw new FanoutStateError(`cannot list the files the candidate changes", "  return []; throw new FanoutStateError(`cannot list the files the candidate changes"],
  ['the diff is against HEAD~ not the target', C, "git('diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`)", "git('diff', '--name-only', '--no-renames', '-z', 'HEAD~1', 'HEAD')"],
  ['config can hide untracked files from the clean check', C, "'-c', 'status.showUntrackedFiles=all', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'", "'status', '--porcelain'"],
  ['a changed override file is not flagged', C, "overrideChanged = changedFiles(git, state.target).includes(CHECKS_FILE);", "overrideChanged = false;"],
  ['the override is read from the working tree (an ignored file wins)', C, "const override = blob(CHECKS_FILE);", "const override = fs.existsSync(path.join(root, CHECKS_FILE)) ? fs.readFileSync(path.join(root, CHECKS_FILE), 'utf8') : null;"],
  ['a rename drops the old path', C, "'--name-only', '--no-renames', '-z'", "'--name-only', '-z'"],
  ['uncovered changed files are not recorded', K, "else uncovered.push(f);", "else { /* dropped */ }"],
  ['the override-changed flag is not persisted', K, "results, uncovered, overrideChanged };", "results, uncovered, overrideChanged: false };"],
  ['the time limit is not enforced', C, "timeout: timeoutMs,", "timeout: timeoutMs * 1000,"],
  ['the default time limit is 1 s', K, "export const CHECK_DEFAULT_TIMEOUT_SEC = 300;", "export const CHECK_DEFAULT_TIMEOUT_SEC = 1;"],
  ['a record of the same tree is not reused (the checks run again)', C, "if (have?.ok) return {", `if (${F}) return {`],
  ['a dirty worktree is accepted', C, "if (dirty.stdout.trim()) throw", `if (${F}) throw`],
  ['a HEAD that is not the candidate is accepted', C, "if (!head || !sameSha(head, want)) throw", "if (!head) throw"],
  ['`fanout check` runs with the switch off', C, "if (switchesOf(state).preNominationChecks !== 'on') throw", `if (${F}) throw`],
  ['a check that edits tracked files is recorded', C, "if (!sameSha(headOf(), head) || after.stdout.trim()) throw", `if (${F}) throw`],
  ['a cwd symlinked out of the repo is run', C, "(real === base || real.startsWith(base + path.sep))", "true"],
  ['an unknown key in the checks file is accepted', K, "if (k !== 'checks') throw new ChecksFileError", `if (${F}) throw new ChecksFileError`],
  ['an unknown key in an entry is accepted', K, "if (k !== 'run' && k !== 'cwd' && k !== 'timeoutSec') throw", `if (${F}) throw`],
  ['a cwd leaving the repo is accepted', K, "if (cwd.startsWith('/') || cwd.split(/[\\\\/]/).includes('..')) throw", `if (${F}) throw`],
  ['a bad timeoutSec is accepted', K, "if (t !== undefined && (typeof t !== 'number'", `if (${F} && (typeof t !== 'number'`],
  ['a hand-forged ok is accepted on read', S, "if (r.ok !== ok || r.vacuous !== (results.length === 0 && !r.nothingFound) || (r.nothingFound && results.length > 0)) throw", `if (${F}) throw`],
  ['the records are not part of the known ticket keys', S, "'tree', 'builtOnTree', 'checks', 'findings',", "'tree', 'builtOnTree', 'findings',"],
  ['`checks` becomes settable by --json', S, "'spec', 'implementer', 'verifier'] as const;", "'spec', 'implementer', 'verifier', 'checks'] as const;"],
  ['a verdict pass goes round the record rule', S, "|| next.verdict === 'pass' || next.verdict === 'approve') && next.head && ('status' in patch || 'head' in patch || 'verdict' in patch)) { // #564", "|| false as boolean) && next.head && ('status' in patch || 'head' in patch)) { // #564"],
  ['a verdict-only patch is not checked', S, "('status' in patch || 'head' in patch || 'verdict' in patch)) { // #564", "('status' in patch || 'head' in patch)) { // #564"],
  ['the resume write-back keeps a nominated ticket on a record-less tree', S, "const demote = switchesOf(state).preNominationChecks === 'on' && !(r.branchTree && t.checks?.[r.branchTree]?.ok);", "const demote = false;"],
  ['the resume write-back demotes even onto a tree with a passing record', S, "!(r.branchTree && t.checks?.[r.branchTree]?.ok);", "true;"],
  ['the nothing-found message drops the git add -f hint', K, "COMMIT it (the \\`.orchestra/\\` folder is gitignored in an Orchestra worktree: \\`git add -f ${CHECKS_FILE}\\`) and run", "and run"],
  ['--help drops the git add -f hint', C, "The override must be COMMITTED (read from HEAD): \\`git add -f .orchestra/pre-nomination-checks.json\\`, as \\`.orchestra/\\` is gitignored in an Orchestra worktree.", ""],
  ['a status-only patch is not checked', S, "&& next.head && ('status' in patch || 'head' in patch || 'verdict' in patch)) { // #564", "&& next.head && ('head' in patch || 'verdict' in patch)) { // #564"],
  ['a FAILED same-tree record is not re-run', C, "if (have?.ok) return {", "if (have) return {"],
  ['the time-limit kill is SIGTERM (ignorable)', C, "killSignal: 'SIGKILL'", "killSignal: 'SIGTERM'"],
  ['the skill says nothing when the switch is on', V, "<!--sw preNominationChecks=on-->", "<!--sw preNominationChecks=off-->"],
];

const base = run();
const baseOk = base.fail === 0 && base.skipped === 0 && base.pass >= 28 && base.pass === base.tests;
console.log(`control (unpatched copy): ${base.pass} pass / ${base.fail} fail / ${base.skipped} skipped → ${baseOk ? 'GREEN' : 'RED'}`);
if (!baseOk) { console.log(base.out.slice(-3000)); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(1); }
if (!process.argv.includes('--mutants')) { fs.rmSync(scratch, { recursive: true, force: true }); process.exit(0); }

let survived = 0, refused = 0;
for (const [i, [name, file, from, to]] of mutants.entries()) {
  const f = path.join(scratch, file);
  const orig = fs.readFileSync(f, 'utf8');
  const n = orig.split(from).length - 1;
  if (n !== 1) { console.log(`M${String(i + 1).padStart(2, '0')} REFUSED (stale: the string occurs ${n}×, need exactly 1) — ${name}`); refused++; continue; }
  fs.writeFileSync(f, orig.replace(from, () => to));
  const r = run();
  fs.writeFileSync(f, orig);
  const killed = r.fail > 0 || Number.isNaN(r.pass); // a mutant that breaks the module graph (no tests ran) is also dead
  if (!killed) survived++;
  console.log(`M${String(i + 1).padStart(2, '0')} ${killed ? 'KILLED' : 'SURVIVED'} (${r.pass} pass / ${r.fail} fail) — ${name}`);
}
const after = run(); // the restore is real: the copy is green again
const same = after.fail === 0 && after.pass === base.pass;
console.log(`\n${mutants.length - survived - refused}/${mutants.length} mutants killed, ${survived} survived, ${refused} refused; scratch restored → ${same ? 'GREEN' : 'RED'}`);

fs.rmSync(scratch, { recursive: true, force: true });
process.exit(survived || refused || !same ? 1 : 0);

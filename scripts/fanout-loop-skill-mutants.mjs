#!/usr/bin/env node
// #609 rig — the Boucle section of the coordinator skill + the help of the loop: every clause MUTATED in a scratch copy of src/ (the repo is never written); src/shared/fanout-loop-skill.test.ts (+ the #590 role-texts
// test, whose ON classification and byte-identity oracle must stay green) must go RED. Light: no Electron, no network, no tokens.
//   node scripts/fanout-loop-skill-mutants.mjs              control: the unpatched copy must be GREEN (0 fail, 0 skipped)
//   node scripts/fanout-loop-skill-mutants.mjs --mutants    each mutant (exact string, must occur ONCE in its file — else REFUSED as stale) must be KILLED
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-loop-skill-rig-'));
if (!path.resolve(scratch).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
fs.cpSync(path.join(ROOT, 'src'), path.join(scratch, 'src'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ type: 'module' }));
const TESTS = ['src/shared/fanout-loop-skill.test.ts', 'src/shared/fanout-role-texts.test.ts'].map((f) => path.join(scratch, f));

function run() {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...TESTS], { cwd: scratch, encoding: 'utf8', timeout: 240_000, env: { ...process.env, TMPDIR: tmpBase } });
  const out = `${r.stdout}\n${r.stderr}`;
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return { pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests'), out };
}

// [name, file, from, to] — `from` must occur exactly once in `file`. The skill's text is written with `¤` for a backtick.
const K = 'src/shared/verified-fanout-skill.ts';
const H = 'src/cli/fanout-loop-help.ts';
const C = 'src/cli/fanout-state.ts';
const HELP = 'src/cli/help.ts';
const mutants = [
  ['609 off: the Boucle section leaks into every render (switch widened to on|off)', K, '<!--sw seatRecords=on-->\n## The Boucle', '<!--sw seatRecords=on|off-->\n## The Boucle'],
  ['609 on: the section is never shown (switch inverted)', K, '<!--sw seatRecords=on-->\n## The Boucle', '<!--sw seatRecords=off-->\n## The Boucle'],
  ['609 on: a stray blank line outside the block changes the off render', K, 'parks.\n\n<!--/sw-->\n<!--sw verifier=on-->', 'parks.\n<!--/sw-->\n\n<!--sw verifier=on-->'],
  ['609 text: exit 3 is said to be exit 4', K, '**3** ≥1 parked', '**4** ≥1 parked'],
  ['609 text: the paused exit is dropped', K, ' · **4** paused: one check red on several PRs is the environment, fix it and run the same command again (it adopts every live agent, opens no second PR)', ''],
  ['609 text: a park cause is dropped', K, ' / ¤upstream¤', ''],
  ['609 text: plan-refused-twice is dropped', K, '(¤plan-refused-twice¤: exit 2, nothing starts)', ''],
  ['609 text: the run-decision refusal is dropped', K, '; a ¤--run-decision¤ after the plan is refused (¤decision-after-plan¤)', ''],
  ['609 text: the brief is said to wait (an order to wait comes back)', K, 'Write NO order about sequencing: the brief is rendered by code and says every implementer starts at once on frozen names', 'Wait for each upstream merge before you launch the dependent: write code only after every upstream is merged'],
  ['609 text: a flag the help does not have', K, '¤--start-check¤', '¤--start-chek¤'],
  ['609 text: the no-agent workspace spelling drifts from the ledger', K, '¤orchestra spawn --no-agent --name ops-<object> --run-command "<cmd>"¤', '¤orchestra spawn --noagent --name ops-<object> --run-command "<cmd>"¤'],
  ['609 text: the unpark verb is dropped', K, '¤orchestra fanout state set <ticket> --unpark¤', 'edit the state file'],
  ['609 text: the section is padded past the word budget', K, 'No model leads a run: you **prepare**', `${'padding '.repeat(120)}No model leads a run: you **prepare**`],
  ['609 help: exit 3 is said to be exit 2', H, 'Exit 0 every ticket merged · 3 the run ended', 'Exit 0 every ticket merged · 2 the run ended'],
  ['609 help: the plan submit verb is dropped', H, '  orchestra fanout plan submit <plan.json>', '  orchestra fanout plan send <plan.json>'],
  ['609 help: --unpark is dropped', H, '--unpark ', '--unpack '],
  ['609 help: loop-help prints nothing', C, "if (sub === 'loop-help') return { code: 0, stdout: `${LOOP_USAGE}\\n`, stderr: '' };", "if (sub === 'loop-help') return { code: 0, stdout: '', stderr: '' };"],
  ['609 help: the Boucle leaks into the main `help fanout` detail', HELP, '${DELIVER_HELP}`,', "${DELIVER_HELP}\\n\\nThe Boucle`,"],
];

const base = run();
const baseOk = base.fail === 0 && base.skipped === 0 && base.pass >= 25 && base.pass === base.tests;
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
  const killed = r.fail > 0 || Number.isNaN(r.pass);
  if (!killed) survived++;
  console.log(`M${String(i + 1).padStart(2, '0')} ${killed ? 'KILLED' : 'SURVIVED'} (${r.pass} pass / ${r.fail} fail) — ${name}`);
}
const after = run();
const same = after.fail === 0 && after.pass === base.pass;
console.log(`\n${mutants.length - survived - refused}/${mutants.length} mutants killed, ${survived} survived, ${refused} refused; scratch restored → ${same ? 'GREEN' : 'RED'}`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(survived || refused || !same ? 1 : 0);

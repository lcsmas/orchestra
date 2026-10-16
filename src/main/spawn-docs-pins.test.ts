// #382 follow-up (review m2, verifier F1/W09/W09b/W10b/W12/D01/D04) — the docs-promise half of AC5 ("every place that teaches `orchestra spawn`
// ships the flag and the convention"). Deleting the orchestrator-brief sentence, the skill's « --name is REQUIRED » paragraph, the rename-skill
// qualifier, the CLI usage line or a README line left the suite green. workspaces.ts cannot be imported under `node --test` (Electron), so each
// generated template is EXTRACTED and EVALUATED (not grepped): a comment, a stray occurrence elsewhere or a prose copy cannot satisfy a pin.
// Each pin has its in-place mutant in scripts/spawn-name-mutants.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../cli/help.ts';
import { checkSpawnName, NAME_CONVENTION } from '../shared/naming-policy.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const ws = read('src/main/workspaces.ts');

/** The value of `const <name> = \`…\`;` evaluated as a template literal (escapes + `${NAME_CONVENTION}` interpolation resolved). */
function template(name: string): string {
  const i = ws.indexOf(`const ${name} = \``);
  assert.notEqual(i, -1, `${name} not found`);
  const start = ws.indexOf('`', i) + 1;
  const end = ws.indexOf('\n`;\n', start);
  assert.ok(end > start, `end of ${name} not found`);
  return new Function('NAME_CONVENTION', `return \`${ws.slice(start, end)}\n\`;`)(NAME_CONVENTION) as string;
}
/** `const ORCHESTRATOR_BRIEF_HEAD = "…" + "…" + \`…\`;` evaluated. */
function briefHead(): string {
  const i = ws.indexOf('const ORCHESTRATOR_BRIEF_HEAD =');
  assert.notEqual(i, -1);
  const end = ws.indexOf(';\n\n', i);
  return new Function('NAME_CONVENTION', `return (${ws.slice(i + 'const ORCHESTRATOR_BRIEF_HEAD ='.length, end)});`)(NAME_CONVENTION) as string; // parenthesised: `return` + newline would be ASI → undefined
}

test('CONTROL: the extractor evaluates real templates (escapes resolved, NAME_CONVENTION interpolated)', () => {
  const skill = template('SPAWN_SKILL');
  assert.match(skill, /^---\nname: orchestra-spawn\n/);
  assert.ok(skill.includes('$ORCHESTRA_SOCK'), 'a `\\$` escape resolves to `$`');
  assert.ok(!skill.includes('${NAME_CONVENTION}') && skill.includes(NAME_CONVENTION), 'the interpolation is evaluated, not left as source');
  assert.ok(briefHead().startsWith('You are an orchestrator.'));
});

test('orchestrator brief: every spawn MUST carry --name, the convention, no wave codes (the sentence, not just any mention)', () => {
  const b = briefHead();
  assert.ok(b.includes('Every spawn MUST carry `--name`'), b.slice(0, 400));
  assert.ok(b.includes(`the child is named \`${NAME_CONVENTION}\``));
  assert.ok(b.includes('no wave codes in the name'));
});

test('orchestra-spawn skill: the « --name is REQUIRED » paragraph — required, convention, refusal, flat/≤79, collision suffix, final branch', () => {
  const s = template('SPAWN_SKILL');
  assert.ok(s.includes('**Name the child — `--name` is REQUIRED.**'));
  assert.ok(s.includes(`\`${NAME_CONVENTION}\``));
  assert.match(s, /is REFUSED and creates\nnothing/);
  assert.match(s, /Flat names only \(no `\/`\), 79 characters max\./);
  assert.match(s, /suffixed \(`-2`,\n`-3`…\) — the CLI prints the FINAL branch/);
  assert.match(s, /never nudged to rename itself: the name is YOURS to change/);
});

test('orchestra-spawn skill: every `orchestra spawn` example is valid shell with ONE --name value and a --task, and carries --name', () => {
  const s = template('SPAWN_SKILL');
  const lines = s.split('\n').filter((l) => l.startsWith('orchestra spawn'));
  assert.equal(lines.length, 3, `expected the 3 documented spawn examples, got: ${lines.join(' | ')}`);
  for (const line of lines) {
    // `orchestra` stubbed to print its argv one per line: an unquoted `<…>` / spaces breaks the shell (syntax error) or splits the value.
    const argv = execFileSync('bash', ['-c', `orchestra() { printf '%s\\n' "$@"; }\n${line}`], { encoding: 'utf8' }).trimEnd().split('\n');
    const i = argv.indexOf('--name');
    assert.ok(i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--'), `no --name value in: ${line}`);
    assert.equal(argv[argv.indexOf('--task') - 1], argv[i + 1], `the --name value is ONE word, directly before --task: ${line}`);
  }
  for (const line of lines.slice(0, 2)) {
    const name = /--name (\S+)/.exec(line)![1];
    assert.equal(checkSpawnName(name).ok, true, `the documented example name is itself accepted: ${name}`);
  }
  assert.ok(lines[2].includes('--name "ops-<milestone-in-human-words>"'), 'the sub-orchestrator example quotes its placeholder');
});

test('orchestra-rename skill: NOT for an agent spawned by another agent — in its description AND its body (the always-advertised skill must not steer a child)', () => {
  const r = template('RENAME_SKILL');
  const description = /^description: (.*)$/m.exec(r)?.[1] ?? '';
  assert.ok(description.includes('NOT for an agent spawned by another agent'), description);
  assert.ok(r.includes('If another agent spawned you, your branch was named by that agent'));
  assert.ok(r.includes('`ops-`, `impl-`, `verif-`, `review-` or `explo-`'));
});

test('CLI help: the spawn usage line and the --name entry carry the flag and the convention', () => {
  const spawn = COMMANDS.find((c) => c.name === 'spawn')!;
  const first = spawn.detail.split('\n')[0];
  assert.match(first, /^usage: orchestra spawn --name <name> --task <text>/);
  assert.ok(spawn.detail.includes(`--name <name>     the child's name (required): ${NAME_CONVENTION}.`));
});

test('README: the Spawn bullet and the CLI table line both show --name', () => {
  const readme = read('README.md');
  assert.match(readme, /^- \*\*Spawn\*\* — .*`orchestra spawn --name [^`]*--task/m);
  assert.match(readme, /^orchestra spawn --name <name> --task <text>/m);
});

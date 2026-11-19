// #470 — the bundled verified-fanout v2 skill: it installs (real installer, child process), it names only verbs and flags the CLI's own help has,
// and docs/evidence/470-v1-vs-v2.diff is a true v1→v2 diff (both sides rebuilt from it). Every check has a must-FAIL arm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../cli/help.ts';
import { VERIFIED_FANOUT_SKILL, VERIFIED_FANOUT_SKILL_NAME } from './verified-fanout-skill.ts';
import { FLEET_ROLES, roleSpec, type FleetRole } from './fleet-roles.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspacesSrc = fs.readFileSync(path.join(root, 'src', 'main', 'workspaces.ts'), 'utf8');

/** sha256 of the frozen v1 SKILL.md (ground-zero-prep/skills-v1/SHA256SUMS, tag verified-fanout-v1-prose). */
const V1_SHA256 = 'be6dfd360a1bb667c894bbd9fa53ad9248b96cd9e48b77b696ab1f326720513f';

// ---- verbs: every `orchestra <verb> …` the text names exists in the CLI's own help --------------------------------------------------

const helpOf = (name: string): string => { const c = COMMANDS.find((x) => x.name === name); return c ? `${c.summary}\n${c.detail}` : ''; };

/** Inline code spans of the text (fenced blocks dropped first: their 3-backtick runs would shift the pairing) that start with `orchestra `, whitespace collapsed. */
export function orchestraSpans(text: string): string[] {
  return [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\s+/g, ' ').trim()).filter((s) => /^orchestra( |$)/.test(s));
}

/** Problems of one span against the help: unknown verb, unknown sub-verb, unknown --flag of that verb. */
export function lintSpan(span: string): string[] {
  const tokens = span.split(' ').slice(1);
  const verb = tokens[0];
  if (!verb || verb.startsWith('-') || verb.startsWith('<') || verb === 'help') return []; // `help` is the CLI's own lookup, not a command
  if (!COMMANDS.some((c) => c.name === verb)) return [`unknown verb "orchestra ${verb}" (in: ${span})`];
  const help = helpOf(verb);
  const probs: string[] = [];
  let cmdPath = verb;
  for (const t of tokens.slice(1)) {
    if (!/^[a-z][a-z-]*$/.test(t)) break;
    if (!new RegExp(`orchestra ${cmdPath} ${t}\\b`).test(help)) { if (new RegExp(`orchestra ${cmdPath} [a-z]`).test(help)) probs.push(`unknown sub-verb "orchestra ${cmdPath} ${t}" (in: ${span})`); break; }
    cmdPath = `${cmdPath} ${t}`;
  }
  const allowed = flagsOf(help, cmdPath);
  for (const t of tokens) {
    const flag = /^(--[a-z][a-z-]*)/.exec(t)?.[1];
    if (flag && !allowed.has(flag)) probs.push(`flag ${flag} is not a flag of "orchestra ${cmdPath}" (in: ${span})`);
  }
  return probs;
}

/** The flags of ONE command path: the whole `--flag` tokens of its usage statement (the `orchestra <path>` line + its wrapped continuation
 *  lines); for a verb without sub-verbs also its `  --flag` option lines. A flag of a sibling sub-verb is NOT allowed (`fanout resume --into`). */
function flagsOf(help: string, cmdPath: string): Set<string> {
  const lines = help.split('\n');
  const out = new Set<string>();
  const grab = (l: string) => { for (const m of l.matchAll(/(?<![\w-])(--[a-z][a-z-]*)(?![\w-])/g)) out.add(m[1]); };
  const hasSubs = cmdPath.includes(' ') || new RegExp(`orchestra ${cmdPath} [a-z]`).test(help);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/^usage: /, '');
    if (!new RegExp(`^\\s*orchestra ${cmdPath}( |$)`).test(l)) continue;
    grab(l);
    for (let k = i + 1; k < lines.length && /^\s{8,}(\[|--|<|\()/.test(lines[k]); k++) grab(lines[k]);
  }
  if (!hasSubs) for (const l of lines) if (/^\s+--[a-z]/.test(l)) grab(l);
  return out;
}

const lint = (text: string): string[] => orchestraSpans(text).flatMap(lintSpan);

test('every `orchestra <verb> [sub] [--flag]` the skill names exists in the CLI help', () => {
  const spans = orchestraSpans(VERIFIED_FANOUT_SKILL);
  assert.ok(spans.length >= 30, `${spans.length} orchestra spans extracted — extractor broken?`);
  assert.deepEqual(lint(VERIFIED_FANOUT_SKILL), []);
  // positive controls: the verbs this v2 exists to point at ARE in the text, and were checked
  for (const needle of ['orchestra handoff', 'orchestra fanout deliver', 'orchestra fanout state init', 'orchestra fanout state set', 'orchestra fanout state show', 'orchestra fanout resume', 'orchestra send --type worker_done']) {
    assert.ok(spans.some((s) => s.startsWith(needle)), `the skill names ${needle}`);
  }
  assert.ok(COMMANDS.some((c) => c.name === 'fanout') && COMMANDS.some((c) => c.name === 'handoff'), 'the help has the new verbs');
});

test('must-FAIL: the lint reddens on a fake verb, a removed verb, a fake sub-verb and a fake flag', () => {
  const add = (s: string) => `${VERIFIED_FANOUT_SKILL}\n\`${s}\`\n`;
  assert.ok(lint(add('orchestra frobnicate --now')).some((p) => /unknown verb "orchestra frobnicate"/.test(p)));
  assert.ok(lint(add('orchestra link --pr 12')).some((p) => /unknown verb "orchestra link"/.test(p)), '`orchestra link --pr` was deleted from the CLI (v1 still cited it)');
  assert.ok(lint(add('orchestra fanout bogus --run 1')).some((p) => /unknown sub-verb "orchestra fanout bogus"/.test(p)));
  assert.ok(lint(add('orchestra fanout state frob x')).some((p) => /unknown sub-verb "orchestra fanout state frob"/.test(p)));
  assert.ok(lint(add('orchestra fanout deliver --no-such-flag x')).some((p) => /--no-such-flag/.test(p)));
  assert.ok(lint(add('orchestra handoff --summary-fiel x')).some((p) => /--summary-fiel/.test(p)));
  // the text itself, mutated in place: the real deliver flag renamed
  // flags of a SIBLING sub-verb or a near-miss spelling: the whole-help substring match let all of these through
  for (const bad of ['orchestra fanout deliver --depends-on x', 'orchestra fanout resume --review-verdict f', 'orchestra fanout deliver --review-verd f', 'orchestra fanout state set t --into main']) {
    assert.ok(lint(add(bad)).some((p) => /is not a flag of/.test(p)), bad);
  }
  const mutated = VERIFIED_FANOUT_SKILL.replace('--review-verdict <file>', '--review-verdit <file>');
  assert.notEqual(mutated, VERIFIED_FANOUT_SKILL, 'mutant anchor matches');
  assert.ok(lint(mutated).some((p) => /--review-verdit/.test(p)));
});

test('the deleted `orchestra link` is not cited, and the final report is worker_done --cap', () => {
  assert.doesNotMatch(VERIFIED_FANOUT_SKILL, /orchestra link/);
  assert.match(VERIFIED_FANOUT_SKILL, /worker_done --cap "\$\(orchestra token\)"/);
});

// ---- the text ---------------------------------------------------------------------------------------------------------------------

test('frontmatter: the name is verified-fanout and the description is v1\'s, verbatim', () => {
  assert.equal(VERIFIED_FANOUT_SKILL_NAME, 'verified-fanout');
  const fm = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(VERIFIED_FANOUT_SKILL);
  assert.ok(fm, 'frontmatter present');
  assert.equal(fm[1], 'verified-fanout');
  assert.match(fm[2], /^Mechanics of running a verified fan-out — N implementation agents in isolated worktrees plus one verifier that gates every branch on a real build before merge\./);
});

test('the rules that moved each carry their pointer, and the install/precedence note is there', () => {
  const need: Array<[string, RegExp]> = [
    ['merge rule → deliver', /orchestra fanout deliver[\s\S]*--review-verdict/], ['resume', /orchestra fanout resume/], ['state file', /orchestra fanout state set/],
    ['handoff', /orchestra handoff --summary-file/], ['role guard', /role guard/], ['scribe role', /`scribe-`/], ['the verbatim merge-rule sentence', /A review round with 0 BLOCKING and 0 MAJOR merges on its current gate; a\s+MINOR that touches correctness or a ticket promise goes to the candidate's ONE\s+follow-up branch, every other finding is `noted`\./],
    ['never chain check + destructive act', /TWO calls, never one/], ['reversible default', /REVERSIBLE default/], ['frozen interface', /--frozen-interface/],
    ['precedence: personal wins', /A personal-level copy shadows it/], ['VPS install note', /VPS install:/],
  ];
  for (const [what, re] of need) assert.match(VERIFIED_FANOUT_SKILL, re, what);
});

// ---- the role-guard summary in the text is the role table ---------------------------------------------------------------------------

/** The facts the "Roles are typed" section states, read from roleSpec() (the one table the guard is generated from). Empty = the text is true. */
export function roleClaimDrift(spec: (r: FleetRole) => ReturnType<typeof roleSpec>): string[] {
  const p: string[] = [];
  const noEdit = (r: FleetRole) => ['Edit', 'Write'].every((t) => spec(r).tools.denyTools.includes(t));
  const deniesPush = (r: FleetRole) => spec(r).tools.bashDeny.some((re) => new RegExp(re).test('git push origin x'));
  const deniesOther = (r: FleetRole) => ['git commit -m x', 'git merge x', 'git rebase x', 'git reset x'].every((c) => spec(r).tools.bashDeny.some((re) => new RegExp(re).test(c)));
  for (const r of FLEET_ROLES) if (!spec(r).tools.denyTools.includes('AskUserQuestion')) p.push(`${r}: AskUserQuestion not denied`);
  for (const r of ['coordinator', 'reviewer', 'explorer', 'scribe'] as FleetRole[]) if (!noEdit(r)) p.push(`${r}: Edit/Write not denied`);
  for (const r of ['implementer', 'verifier'] as FleetRole[]) if (noEdit(r)) p.push(`${r}: Edit/Write denied (the text says it edits)`);
  if (spec('verifier').tools.edit !== 'scratch') p.push('verifier: edit scope is not scratch');
  for (const r of ['verifier', 'reviewer', 'explorer', 'scribe'] as FleetRole[]) { if (!deniesPush(r)) p.push(`${r}: push not denied`); if (!deniesOther(r)) p.push(`${r}: commit/merge/rebase/reset not denied`); }
  if (!spec('implementer').tools.bashDeny.some((re) => new RegExp(re).test('git push origin master'))) p.push('implementer: push of master not denied');
  if (spec('implementer').tools.bashDeny.some((re) => new RegExp(re).test('git push origin impl-x'))) p.push('implementer: every push denied (the text says master/main only)');
  if (spec('scribe').model !== 'claude-haiku-5-5' || spec('scribe').effort !== 'low') p.push('scribe: not the cheap model at low effort');
  for (const r of ['coordinator', 'implementer', 'verifier', 'reviewer', 'explorer'] as FleetRole[]) if (spec(r).model !== undefined) p.push(`${r}: pins a model (the text says strong roles pin none)`);
  return p;
}

test('the "Roles are typed" claims match roleSpec(); a drifted table is seen', () => {
  assert.match(VERIFIED_FANOUT_SKILL, /Edit\/Write to the coordinator, reviewer, explorer and scribe/);
  assert.deepEqual(roleClaimDrift((r) => roleSpec(r)), []);
  // must-FAIL: the verifier gaining Write, the reviewer allowed to push, a strong role pinning a model, scribe on a strong model
  const mut = (f: (s: ReturnType<typeof roleSpec>) => void) => (r: FleetRole) => { const x = roleSpec(r); f(x); return x; };
  assert.ok(roleClaimDrift(mut((x) => { if (x.role === 'verifier') x.tools.denyTools.push('Edit', 'Write'); })).some((d) => /verifier: Edit\/Write denied/.test(d)));
  assert.ok(roleClaimDrift(mut((x) => { if (x.role === 'reviewer') x.tools.bashDeny = []; })).some((d) => /reviewer: push not denied/.test(d)));
  assert.ok(roleClaimDrift(mut((x) => { if (x.role === 'implementer') x.model = 'claude-opus-4-1'; })).some((d) => /implementer: pins a model/.test(d)));
  assert.ok(roleClaimDrift(mut((x) => { if (x.role === 'scribe') x.model = undefined; })).some((d) => /scribe: not the cheap model/.test(d)));
});

// ---- the diff artifact ------------------------------------------------------------------------------------------------------------

test('docs/evidence/470-v1-vs-v2.diff: its v2 side is this module\'s text and its v1 side is the frozen v1 (sha256)', () => {
  const diff = fs.readFileSync(path.join(root, 'docs', 'evidence', '470-v1-vs-v2.diff'), 'utf8').split('\n');
  const hunk = diff.findIndex((l) => l.startsWith('@@'));
  assert.ok(hunk > 0 && diff.slice(hunk + 1).every((l) => l === '' || /^[ +\\-]/.test(l)), 'a single full-context unified hunk');
  const body = diff.slice(hunk + 1);
  // a blank line of either file shows as a lone ' ' / '+' / '-': rebuild both sides line by line.
  const rebuild = (drop: string) => body.filter((l) => l.length > 0 && l[0] !== drop && l[0] !== '\\').map((l) => l.slice(1)).join('\n') + '\n';
  assert.equal(rebuild('-'), VERIFIED_FANOUT_SKILL, 'v2 side == the shipped text');
  assert.equal(createHash('sha256').update(rebuild('+')).digest('hex'), V1_SHA256, 'v1 side == the frozen v1 SKILL.md');
  // must-FAIL: one edited character on either side breaks the equality
  const bent = rebuild('-').replace('Verified fan-out', 'Verified fan-oot');
  assert.notEqual(bent, VERIFIED_FANOUT_SKILL);
  assert.notEqual(createHash('sha256').update(rebuild('+').replace('Verified fan-out', 'Verified fan-oot')).digest('hex'), V1_SHA256);
  // the movement is visible: pointers added, the dead `orchestra link --pr` sentence removed
  assert.ok(body.some((l) => l.startsWith('+') && l.includes('orchestra fanout deliver')));
  assert.ok(body.some((l) => l.startsWith('-') && l.includes('orchestra link --pr')));
});

// ---- the installer ----------------------------------------------------------------------------------------------------------------

test('wiring: workspaces.ts imports the module, writes the skill with writeSkill, and hashes the text into HOOKS_VERSION', () => {
  const check = (src: string): string[] => {
    const probs: string[] = [];
    if (!/import \{ VERIFIED_FANOUT_SKILL, VERIFIED_FANOUT_SKILL_NAME \} from '\.\.\/shared\/verified-fanout-skill\.ts';/.test(src)) probs.push('import missing');
    if (!/writeSkill\(VERIFIED_FANOUT_SKILL_NAME, VERIFIED_FANOUT_SKILL\)/.test(src)) probs.push('writeSkill line missing');
    const v = src.slice(src.indexOf('const HOOKS_VERSION = createHash'), src.indexOf('.digest(', src.indexOf('const HOOKS_VERSION = createHash')));
    if (!/\n\s+VERIFIED_FANOUT_SKILL,\n/.test(v)) probs.push('VERIFIED_FANOUT_SKILL not hashed into HOOKS_VERSION (an edited text would never reinstall)');
    if (!/RETIRED_SKILLS = \[[^\]]*\]/.test(src) || /RETIRED_SKILLS = \[[^\]]*verified-fanout/.test(src)) probs.push('verified-fanout must not be in RETIRED_SKILLS');
    return probs;
  };
  assert.deepEqual(check(workspacesSrc), []);
  // must-FAIL: each deletion is seen
  assert.ok(check(workspacesSrc.replace('writeSkill(VERIFIED_FANOUT_SKILL_NAME, VERIFIED_FANOUT_SKILL)', 'void 0')).includes('writeSkill line missing'));
  assert.ok(check(workspacesSrc.replace('      VERIFIED_FANOUT_SKILL,\n', '')).some((p) => /not hashed/.test(p)));
  assert.ok(check(workspacesSrc.replace("      'orchestra-link',\n", "      'orchestra-link',\n      'verified-fanout',\n")).some((p) => /RETIRED_SKILLS/.test(p)));
});

test('the REAL installOrchestraHooks lands the skill in a fresh worktree and rewrites it on a later spawn after an upgrade', () => {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './scripts/.r2-register.mjs', 'scripts/e2e-verified-fanout-skill-install.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 110_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
  });
  const r = JSON.parse(out.trim().split('\n').pop() ?? '{}');
  assert.deepEqual(r, { ok: true, nameIsVerifiedFanout: true, absentBefore: true, landed: true, siblingsKept: true, rewrittenOnUpgrade: true, stampedInstallIsNoop: true });
});

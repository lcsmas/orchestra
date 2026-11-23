// #470 — the bundled verified-fanout v2 skill: it installs (real installer, child process), it names only verbs and flags the CLI's own help has,
// and docs/evidence/470-v1-vs-v2.diff is a true v1→v2 diff (both sides rebuilt from it). Every check has a must-FAIL arm.
// #474 — the always-read SKILL.md stays under 4,000 words; its situational sections live in the v2 references (embedded from src/shared/verified-fanout-refs/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../cli/help.ts';
import { VERIFIED_FANOUT_MARKER, VERIFIED_FANOUT_SKILL, VERIFIED_FANOUT_SKILL_NAME } from './verified-fanout-skill.ts';
import { VERIFIED_FANOUT_FILES, VERIFIED_FANOUT_V2_REFERENCES } from './verified-fanout-files.ts';
import { renderSwitchBlocks } from './fanout-switch-render.ts';
import { installVerifiedFanoutSkill } from '../main/verified-fanout-install.ts';
import { mkHomeScratch } from './home-scratch.ts';
import { FLEET_ROLES, roleOfName, roleSpec, resolveSpawnRoleDefaults, type FleetRole } from './fleet-roles.ts';
import { isValidModelArg } from './model-defaults.ts';
import { MODEL_CHOICES } from '../renderer/components/agent/model-util.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspacesSrc = fs.readFileSync(path.join(root, 'src', 'main', 'workspaces.ts'), 'utf8');
const REFS_SRC_DIR = path.join(root, 'src', 'shared', 'verified-fanout-refs');
/** The v2-only references' text by shipped path (`references/<name>.md`). */
const refText = (name: string): string => VERIFIED_FANOUT_V2_REFERENCES.find((f) => f.path === `references/${name}`)?.content ?? '';
const ALL_V2_REFS = VERIFIED_FANOUT_V2_REFERENCES.map((f) => f.content).join('\n');

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
  assert.ok(spans.length >= 25, `${spans.length} orchestra spans extracted — extractor broken?`);
  assert.deepEqual(lint(VERIFIED_FANOUT_SKILL), []);
  // positive controls: the verbs this v2 exists to point at ARE in the text, and were checked
  for (const needle of ['orchestra handoff', 'orchestra fanout deliver', 'orchestra fanout state init', 'orchestra fanout state set', 'orchestra fanout state show', 'orchestra fanout resume', 'orchestra send --type worker_done']) {
    assert.ok(spans.some((s) => s.startsWith(needle)), `the skill names ${needle}`);
  }
  assert.ok(COMMANDS.some((c) => c.name === 'fanout') && COMMANDS.some((c) => c.name === 'handoff'), 'the help has the new verbs');
});

test('#474: every `orchestra <verb> [sub] [--flag]` the v2 references name exists in the CLI help too (all shipped text is linted)', () => {
  for (const f of VERIFIED_FANOUT_V2_REFERENCES) assert.deepEqual(lint(f.content), [], f.path);
  assert.ok(orchestraSpans(ALL_V2_REFS).length >= 15, 'the references name orchestra verbs — extractor broken?');
  // must-FAIL: a fake verb / removed sub-verb / fake flag planted in ONE reference is seen
  assert.ok(lint(`${refText('fleet-bus.md')}\n\`orchestra frobnicate --now\`\n`).some((p) => /unknown verb "orchestra frobnicate"/.test(p)));
  assert.ok(lint(`${refText('lead-ops-tiers.md')}\n\`orchestra fanout resume --no-such-flag\`\n`).some((p) => /--no-such-flag/.test(p)));
  const mutated = refText('fleet-bus.md').replace('orchestra gate resolve', 'orchestra gate resolv');
  assert.notEqual(mutated, refText('fleet-bus.md'), 'mutant anchor matches');
  assert.ok(lint(mutated).some((p) => /unknown sub-verb "orchestra gate resolv"/.test(p)));
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

/** #472: one pin per rule that a verb or guard enforces — the rule's ONE line must name its verb/guard (and the refusal to act on). `\s+` spans a wrapped line. */
export const RULE_PINS: ReadonlyArray<readonly [id: string, enforcedBy: string, re: RegExp]> = [
  ['role = name prefix', '#465 roleOfName / .orchestra/role', /The role is the `--name` prefix the spawner gave/],
  ['model + effort per role, scribe', '#465 roleSpec, spawn --model/--effort', /`scribe-` pins the cheap model at low\s+effort/],
  ['tool limits = a guard, BLOCKED is the answer', '#468 role-guard.sh exit 2', /PreToolUse role guard\*\* \(exit 2, `\[orchestra\] BLOCKED \(role: …\): <reason>`\)[\s\S]*never to be routed around/],
  ['AskUserQuestion denied, probe included', '#468 role guard', /denies `AskUserQuestion` to every role, even as a probe/],
  ['verifier edits scratch only, implementer its own worktree', '#468 edit scope', /the verifier edits scratch only, an implementer its own\s+worktree/],
  ['commit-class git acts outside a scratch clone', '#468 role guard + #465 bashDeny', /push to the verifier, reviewer, explorer and scribe, and commit, merge,\s+rebase and reset\s+outside a scratch clone/],
  ['gh pr merge / delete / archive: coordinator only', '#468 role guard', /`gh pr merge` and workspace delete\/archive to every role but the coordinator/],
  ['never chain a check and a destructive act', '#468 role guard chain rule', /Check and act are TWO\s+calls, never one: the role guard denies a check/],
  ['handoff', '#466 orchestra handoff', /`orchestra handoff --summary-file <path>`[\s\S]*`handoff-unvouched`/],
  ['state file, unknown field refused', '#469 fanout state', /`orchestra fanout state init --target <branch>` once \(own run\)[\s\S]*unknown field is\s+refused/],
  ['resume a dead ops', '#469 fanout resume', /first act `orchestra fanout resume`/],
  ['dependent track: frozen interface, then gated on the upstream candidate', '#469/#506 fanout state set --depends-on / --built-on', /--depends-on\s+<upstream> --frozen-interface <ref>` lets it go `--status started`\. Once the upstream has a verified candidate[\s\S]*`--built-on <upstream>=<head>`[\s\S]*`fanout gate --ticket <id>`[\s\S]*`deliver` enforces order and content/],
  ['merge on 0 BLOCKING/0 MAJOR, head-pinned, CI steps>0', '#467 fanout deliver', /`orchestra fanout deliver --branch <b>[\s\S]*--run <id>`[\s\S]*`review-blocking`, `head-moved`[\s\S]*`zero-steps`/],
  ['deliver: always pass --review-verdict (else refused no-verdict)', '#473 no-verdict', /ALWAYS pass `--review-verdict`: without it `deliver` refuses \(`no-verdict`\); `--no-review-gate`\s+is the explicit ungated merge/],
  ['deliver exit 1 = could not check, not a refusal', '#467 exit codes', /Exit 1 \(`timeout`,\s+`gh-failed`, `merge-failed`, `bad-verdict`, `no-verified-head`\) is "could not check"/],
  ['deliver + state init|set: coordinator only (guarded)', '#473 role guard', /`orchestra fanout deliver\|open` and `fanout state init\|set` to every role but the\s+coordinator \(`state show` and `resume` stay open\)/],
  ['verifier skips the full suite when the target has PR CI (derived, head-bound)', '#495 fanout gate', /`orchestra fanout gate --branch <b> --into <target> --head <sha>` derives it \(`fullSuite: ci`[\s\S]*a moved head's CI is never accepted/],
  ['implementer self-gate + every fix round: no full suite', '#497 skill rule', /An implementer's self-gate — and every fix round — is the typecheck, its diff's test files and its own rig arms; never the full suite/],
  ['a coordinator waits for a verdict with orchestra check on its run id, never ledger comment counts', '#496 review B (bus check/ack)', /A coordinator waits for a verdict with `orchestra check --run <your run id>`, never by counting ledger comments/],
  ['one PR per ticket', '#467 fanout deliver', /one PR per\s+ticket: it opens or reuses/],
  ['combined suite after N merges', '#467 deliver combinedSuite', /`deliver` prints `combinedSuite`/],
  ['final report = worker_done --cap', 'host capability (#160)', /ONLY on its `worker_done` \(#160\)/],
  ['no common ancestry: status/ask only; message refused', '#436/#441 CLI', /`orchestra message` is refused for every target/],
  ['acceptance: code forces it — register the spec, Orchestra spawns the accept- writer (Opus 5.5 in the role table)', '#515 fanout state set --spec + the accept- role', /Code forces it; you do not spawn the writer\.[\s\S]*`orchestra fanout state set <ticket> --spec <file\|url\|ledger section> --implementer <ws id> --verifier <ws id>`\. Orchestra spawns its `accept-` writer itself \(Opus 5\.5; brief = spec \+ ticket, never an implementer branch\)/],
  ['acceptance: the writer freezes its own ticket to the shared branch; show --brief prints path + command; implementers copy unchanged', '#515 acceptance/<run>', /The writer freezes\*\* \(own ticket only\) to `acceptance\/<run>`; Orchestra tells implementer and verifier the path \+ command \(`orchestra fanout acceptance show <ticket> --brief`\)\. Implementers copy them UNCHANGED/],
  ['acceptance: gate runs them (waits when unfrozen, pending exit 3), deliver re-reads the bytes (acceptance-pending)', '#515 fanout gate --cwd / deliver --acceptance', /`orchestra fanout gate … --ticket <id> --cwd <checkout>` runs them \(unfrozen it WAITS, then `pending` exit 3: no round consumed\); `orchestra fanout deliver … --acceptance <receipt\.json>` re-reads them \(`acceptance-pending` while unfrozen\)\. `frozen-test-changed` \/ `frozen-test-failed` go to the implementer; `acceptance-unproven` \/ `acceptance-stale` \/ `acceptance-stale-checkout` mean the verifier re-gates/],
  ['acceptance: a wrong test is amended / a ticket that cannot have tests is waived — the coordinator\'s, with a ledger decision', '#510 amend + #515 waive', /`orchestra fanout acceptance amend <ticket> --decision <url> --spec-sentence "<text>" --files <p1,p2>`, `orchestra fanout acceptance waive <ticket> --decision <url> --reason "<why>"`/],
  ['reversible default instead of asking (judgement line)', 'none — ledger decision', /take the REVERSIBLE default, apply it and write it in your ledger\s+comment/],
];

/** #472 review m2: the JUDGEMENT rules no code carries — one phrase each, so cutting one reds a test (the diff-rebuild test alone is silenced by regenerating the diff). */
export const JUDGEMENT_PINS: ReadonlyArray<readonly [id: string, re: RegExp]> = [
  ['pull the ledger first', /Pull the ledger before acting on any instruction; a message that pins a\s+sha or contradicts the ledger is stale/],
  ['relay refs, re-resolve with ls-remote', /Relay branch REFS and re-resolve with `ls-remote` at action time/],
  ['sent != received', /\*\*Sent ≠ received\.\*\*/],
  ['state-only acks', /\*\*State-only acks\*\* from message one/],
  ['write the gate checklist first', /\*\*Write the full gate checklist into the ledger before the first gate\*\*/],
  ['self-gate + pre-review before nominating', /\*\*Self-gate BEFORE nominating[\s\S]*fresh-context PRE-REVIEW/],
  ['carry verdicts by tree identity', /\*\*Carry verdicts by TREE IDENTITY across clean rebases\*\*/],
  ['LEAD reports to the human as a team lead\'s synthesis', /TEAM LEAD'S SYNTHESIS/],
  ['coverage gap: drive the module, not more cases', /do NOT add cases at the layer you already test/],
  ['mutation runs: full at first nomination and final gate', /\*\*Mutation runs: FULL set at the first nomination and at the final merge/],
  ['serialize merges that touch a shared seam', /\*\*Serialize merges that touch a shared seam\.\*\*/],
  ['composed features need a composed gate', /\*\*Composed features need a composed gate\.\*\*/],
  ['ledger lifecycle: the `ledger` label + ONE writer per section', /The ledger carries the `ledger` label[\s\S]*ONE writer per section/],
  ['wave close: LEAD deletes the OPS itself, peers greps zero + a positive control, then close the ledger', /A wave is closed only when the LEAD has itself gated and deleted the OPS workspace[\s\S]*plus one grep for a workspace that must still exist\); then close the ledger/],
  ['verify-landed names --into <integration> (default target is YOUR branch)', /`orchestra verify-landed <ws> --into <integration>` \(the default target is YOUR branch\)/],
  ['traps.md pointer carries its four rung triggers + line ranges', /L23–117\) when[\s\S]*L118–394\) when[\s\S]*L395–559\) when[\s\S]*L560–723\) when/],
  ['close-out: reported done != landed', /"Agent reported done" and "work \*\*landed\*\*" are two different events/],
  ['delete only a FINISHED agent, re-take the sweep', /\*\*Deleting a workspace requires the agent to be FINISHED, not merely landed\.\*\*/],
  ['scribe only for steps that need turns between them (poll/retry/read-then-act), no judgement', /A scribe only for steps that need turns BETWEEN them \(poll, retry, read-then-act\) with NO judgement/],
  ['a single call or a one-Bash-call batch is run by the coordinator (spawn + worker_done + delete cost more)', /A batch one Bash call can run \(for \/ &&\) or a single call you run yourself:\s+spawn \+ `worker_done` \+ delete cost more turns than they save/],
  ['scribe lever: scribe-able turns are a ceiling, the static prefix dominates, handoff late', /scribe-able turns are a\s+~6\.4% ceiling, ≥49% is the static prefix: keep this file small, `orchestra handoff` late/],
  ['scribe spawn shape: body text or absolute path + run id; the coordinator deletes it', /scribe-<object> --task "<body text or absolute path, run id, fixed commands, ledger #N>"`; it ends with `worker_done --cap`, then\s+you delete it/],
  ['a scribe\'s state set never carries --accept-merged / --json / mergedAccepted', /A scribe's `state set` never carries `--accept-merged`, `--json` or `mergedAccepted` \(guard-denied\)/],
  ['routing rule: an upstream gap is fixed ON the upstream, never by changing the dependent\'s interface', /a gap found in an upstream is fixed by a follow-up ON the upstream, never by changing the dependent's spec interface \(the one it was specified and tested against\); a follow-up that must change the frozen interface goes through a ledger decision first/],
  ['deliverable file exists on the integration branch', /Then confirm each deliverable \*\*file\*\* exists on the integration branch/],
];

/** #474: the SKILL.md-RESIDENT rules = every RULE_PIN and JUDGEMENT_PIN above (the one-line enforced rules and the judgement rules needed on EVERY turn).
 *  The pin test reads SKILL.md ALONE for these: moving one into a reference — even with its sentence intact there — reddens `droppedRules(skill)`. */
export const SKILL_RESIDENT: readonly string[] = [...RULE_PINS.map(([id]) => id), ...JUDGEMENT_PINS.map(([id]) => id)];

/** #474: sentences that MOVED to a reference with their section (situational — read only in one situation): [id, shipped file, pin]. Read from the embedded reference, NOT from SKILL.md. */
export const REFERENCE_PINS: ReadonlyArray<readonly [id: string, file: string, re: RegExp]> = [
  ['LEAD report = a team lead\'s synthesis', 'lead-ops-tiers.md', /TEAM LEAD'S SYNTHESIS/],
  ['dead-ops detector (lead pulls peers + app log)', 'lead-ops-tiers.md', /live delivery timeout — parked in inbox/],
  ['closed ledger ⇒ zero wave workspaces (positive terminator)', 'lead-ops-tiers.md', /plus one grep for a workspace\s+that must still exist/],
  ['patch-id is unavailable across a resolution', 'budget-and-gates.md', /patch-id\s+equality is UNAVAILABLE across a resolution/],
  ['coverage gap: drive the module, not more cases', 'budget-and-gates.md', /STRUCTURALLY CAPABLE/],
  ['bus: legacy =OFF runs read the old channel', 'fleet-bus.md', /A notice line `=OFF` means a legacy run/],
  ['bus: a hung session keeps running (liveness blind spot)', 'fleet-bus.md', /a session hung mid-tool-call keeps `running`/],
  ['verifier pins an account derived from its own login', 'verifier-and-review.md', /The rig PINS AN ACCOUNT before any live drive/],
  ['verifier: second seat numbers', 'verifier-and-review.md', /nomination→verdict from 79–265 min to 17–46 min/],
  ['review needs freshness (the verifier must not review)', 'verifier-and-review.md', /Review lives on freshness/],
  ['delete-gate trap 0: a rebase reads a false not-landed', 'closeout-and-gates.md', /after a REBASE, `verify-landed` reads a FALSE not-landed/],
  ['delete-gate trap 2: filter generated porcelain noise', 'closeout-and-gates.md', /porcelain is never literally empty — filter the known generated noise/],
  ['delete-gate trap 1: an older build exits 0 on NOT LANDED', 'closeout-and-gates.md', /Older \*installed\*\s+builds exit 0 on NOT LANDED/],
  ['acceptance: Orchestra spawns the writer from the role table (accept-, Opus 5.5); no spawn line of the coordinator', 'acceptance-tests.md', /Orchestra spawns it \(role `accept-` in the fleet role table, Opus 5\.5 pinned there; every other role is unchanged\)/],
  ['acceptance: amend reads the decision through gh and fails closed', 'acceptance-tests.md', /reads the decision through `gh` and fails closed/],
  ['acceptance: deliver\'s acceptance-stale is a re-gate (receipt for another head or set)', 'acceptance-tests.md', /`acceptance-stale` \(deliver: a receipt for another head or frozen set[^)]*\)[^\n]*re-gate/],
  ['acceptance: the writer\'s brief names the repo\'s integration harness (declared / found), boots the full app module, one execution context per test (#538)', 'acceptance-tests.md', /boot the FULL app module through it and open its OWN execution context per test[^\n]*`orchestra fanout state set --harness/],
  ['acceptance: the freeze does not cover runner config / helpers — pointed at help, reviewed', 'acceptance-tests.md', /runner config file or a non-frozen helper the tests import is still the candidate's and is NOT hashed/],
  ['acceptance: the writer is told to keep tests self-contained (its brief is generated)', 'acceptance-tests.md', /the tests self-contained\)/],
  ['acceptance: --run-cmd is a direct runner call naming a frozen file, no shell', 'acceptance-tests.md', /`--run-cmd`: a direct runner call naming a frozen file, no shell/],
  ['acceptance: the routing rule, with its reason', 'acceptance-tests.md', /a test amended to fit an upstream's bug freezes the bug\)\. A follow-up that must change that frozen interface is a ledger decision first/],
  ['gate example: wrap-not-touch', 'closeout-and-gates.md', /\*wrap-not-touch\*/],
  ['visual claims need a triptych', 'closeout-and-gates.md', /before\/after\/reference triptych/],
];
const referencePinProblems = (refs: (file: string) => string): string[] => REFERENCE_PINS.filter(([, file, re]) => !re.test(refs(file))).map(([id, file]) => `${id}: not in ${file}`);

/** The ids of the rules whose pin no longer matches `text` (empty = every enforced rule is still named). */
export const droppedRules = (text: string): string[] => [...RULE_PINS.map(([id, , re]) => [id, re] as const), ...JUDGEMENT_PINS].filter(([, re]) => !re.test(text)).map(([id]) => id);

/** `text` with every line the pin's match touches deleted (a rule dropped from the skill). */
function withoutRule(text: string, re: RegExp): string {
  const m = re.exec(text)!;
  const from = text.lastIndexOf('\n', m.index) + 1;
  const to = text.indexOf('\n', m.index + m[0].length);
  return text.slice(0, from) + text.slice(to === -1 ? text.length : to + 1);
}

test('each rule a verb or guard enforces keeps ONE line naming it (#472); the prose duplicates are gone', () => {
  assert.deepEqual(droppedRules(VERIFIED_FANOUT_SKILL), []);
  // the v2 pointer paragraphs of #470 are gone: no "In code (v2)" block, no "(v2: …)" aside restating a guard
  assert.doesNotMatch(VERIFIED_FANOUT_SKILL, /In code \(v2\)|\(v2:/);
  // the v1 prose of the AskUserQuestion bullet, the wave-C probe story and the simulated-cache numbers were replaced, not kept beside the line
  assert.doesNotMatch(VERIFIED_FANOUT_SKILL, /placeholder question|SIMULATED cache|Why the count comes first/);
  // the judgement rules stay as prose
  for (const re of [/A review round with 0 BLOCKING, 0 MAJOR and no unsettled spec-sentence MINOR merges on its\s+current gate; every other MINOR is `noted` — no follow-up PR\./, /A personal-level copy shadows it/, /VPS install:/, /Specify gates that can fail/]) assert.match(VERIFIED_FANOUT_SKILL, re);
});

test('must-FAIL: deleting the line of any one enforced rule reddens exactly that rule\'s pin', () => {
  for (const [id, , re] of RULE_PINS) {
    const cut = withoutRule(VERIFIED_FANOUT_SKILL, re);
    assert.notEqual(cut, VERIFIED_FANOUT_SKILL, `${id}: mutant anchor matches`);
    assert.ok(droppedRules(cut).includes(id), `${id}: dropping its line is seen`);
  }
  for (const [id, re] of JUDGEMENT_PINS) {
    const cut = withoutRule(VERIFIED_FANOUT_SKILL, re);
    assert.notEqual(cut, VERIFIED_FANOUT_SKILL, `${id}: mutant anchor matches`);
    assert.ok(droppedRules(cut).includes(id), `${id}: dropping its line is seen`);
  }
  // a verb renamed in place (the line stays, its enforcer is gone) is seen too
  assert.ok(droppedRules(VERIFIED_FANOUT_SKILL.replace('orchestra handoff --summary-file', 'orchestra hand-off --summary-file')).includes('handoff'));
});

test('#474: the SKILL.md-resident rules are listed, read from SKILL.md alone; the moved sentences are read from their reference', () => {
  assert.ok(SKILL_RESIDENT.length >= 34 && new Set(SKILL_RESIDENT).size === SKILL_RESIDENT.length, `${SKILL_RESIDENT.length} resident rules, ids unique`);
  for (const id of ['merge on 0 BLOCKING/0 MAJOR, head-pinned, CI steps>0', 'final report = worker_done --cap', 'pull the ledger first', 'self-gate + pre-review before nominating', 'close-out: reported done != landed', 'handoff', 'resume a dead ops']) assert.ok(SKILL_RESIDENT.includes(id), `${id} is SKILL.md-resident`);
  assert.deepEqual(referencePinProblems(refText), []);
  // must-FAIL (a): a resident rule MOVED into a reference — its sentence intact in the long form — is still dropped from SKILL.md
  const [, , rePre] = RULE_PINS.find(([id]) => id === 'handoff')!;
  const cut = withoutRule(VERIFIED_FANOUT_SKILL, rePre);
  assert.ok(droppedRules(cut).includes('handoff'));
  assert.equal(droppedRules(VERIFIED_FANOUT_SKILL).length, 0);
  const [, reSelf] = JUDGEMENT_PINS.find(([id]) => id === 'self-gate + pre-review before nominating')!;
  assert.match(refText('budget-and-gates.md'), reSelf, 'the long form in the reference carries the sentence too…');
  assert.ok(droppedRules(withoutRule(VERIFIED_FANOUT_SKILL, reSelf)).includes('self-gate + pre-review before nominating'), '…and that does not keep it resident');
  // must-FAIL (b): a reference stripped of a moved sentence, or a pin aimed at the wrong file, is seen
  for (const [id, file, re] of REFERENCE_PINS) {
    const stripped = (f: string) => (f === file ? withoutRule(refText(f), re) : refText(f));
    assert.notEqual(stripped(file), refText(file), `${id}: mutant anchor matches`);
    assert.ok(referencePinProblems(stripped).some((p) => p.startsWith(id)), `${id}: stripping it from ${file} is seen`);
  }
  assert.ok(referencePinProblems(() => '').length === REFERENCE_PINS.length, 'an empty reference set fails every pin');
  // the moved sentences are NOT required in SKILL.md (they moved): the TEAM LEAD synthesis rules are not always-read
  assert.doesNotMatch(VERIFIED_FANOUT_SKILL, /live delivery timeout|patch-id\s+equality/);
});

// ---- #474: the always-read text is under 4,000 words -------------------------------------------------------------------------------

/** Words the way `wc -w` counts the rendered text (whitespace-separated tokens). */
export const wordCount = (t: string): number => t.split(/\s+/).filter(Boolean).length;
const WORD_BUDGET = 4000;
/** v1's SKILL.md is 40,690 bytes / 6,358 words; #470's text was 6,943 words / 48,213 B; this budget keeps the always-read text well inside v1 on both axes. */
const SIZE_BUDGET = 32_000;
test('#474 word budget: the rendered SKILL.md has < 4,000 words (was 6,962) and a padded text breaks it', () => {
  const w = wordCount(VERIFIED_FANOUT_SKILL);
  assert.ok(w < WORD_BUDGET, `${w} words >= ${WORD_BUDGET}`);
  assert.ok(w > 2500, `${w} words: suspiciously small — a section was dropped wholesale, not moved`);
  // must-FAIL: a moved section pasted back into SKILL.md puts the text over budget (the real regression this guards)
  const back = wordCount(VERIFIED_FANOUT_SKILL + '\n' + refText('lead-ops-tiers.md'));
  assert.ok(back >= WORD_BUDGET, `${back} words with lead-ops-tiers.md pasted back — the budget would not catch it`);
  assert.ok(!(wordCount(VERIFIED_FANOUT_SKILL + ' word'.repeat(WORD_BUDGET - w - 1)) >= WORD_BUDGET) && wordCount(VERIFIED_FANOUT_SKILL + ' word'.repeat(WORD_BUDGET - w)) >= WORD_BUDGET, 'the boundary is exact: one word under passes, at 4,000 fails');
  assert.equal(wordCount('a  b\nc\t d '), 4, 'the counter splits on any whitespace, like wc -w');
});

test('size budget (#472): the rendered text stays within 32,000 B (v1 40,690 B), and a padded text breaks it', () => {
  const bytes = (t: string) => Buffer.byteLength(t, 'utf8');
  assert.ok(bytes(VERIFIED_FANOUT_SKILL) <= SIZE_BUDGET, `${bytes(VERIFIED_FANOUT_SKILL)} B > ${SIZE_BUDGET} B`);
  assert.ok(bytes(VERIFIED_FANOUT_SKILL + 'x'.repeat(SIZE_BUDGET)) > SIZE_BUDGET);
});

// ---- #510 B: the acceptance-tests section ---------------------------------------------------------------------------------------------

test('#515: the skill has NO manual writer spawn line any more — Orchestra spawns the `accept-` writer, Opus 5.5 pinned in the ROLE TABLE (the superseded D4 line is gone)', () => {
  assert.equal(orchestraSpans(VERIFIED_FANOUT_SKILL).some((x) => /^orchestra spawn --name impl-tests-/.test(x)), false, 'no `orchestra spawn --name impl-tests-…` line in SKILL.md');
  assert.equal(orchestraSpans(refText('acceptance-tests.md')).some((x) => /^orchestra spawn /.test(x)), false, 'nor in the reference');
  assert.doesNotMatch(VERIFIED_FANOUT_SKILL, /--model claude-opus-5-5/);
  assert.equal(roleOfName('accept-510'), 'acceptor');
  assert.equal(resolveSpawnRoleDefaults('accept-510', {}).model, 'claude-opus-5-5');
  assert.ok(isValidModelArg(resolveSpawnRoleDefaults('accept-510', {}).model!));
  assert.ok(MODEL_CHOICES.some((c) => c.value === 'claude-opus-5-5'), 'the pin is a wire id the repo knows');
  // must-FAIL: the old line brought back, or the section dropping the "code forces it" statement, is seen
  const old = VERIFIED_FANOUT_SKILL.replace('Code forces it; you do not spawn the writer.', 'Spawn the writer: `orchestra spawn --name impl-tests-<ticket> --model claude-opus-5-5 --task "<brief>"`.');
  assert.notEqual(old, VERIFIED_FANOUT_SKILL);
  assert.ok(droppedRules(old).includes('acceptance: code forces it — register the spec, Orchestra spawns the accept- writer (Opus 5.5 in the role table)'));
});

/** The `orchestra fanout …` spans of `text` that belong to the acceptance feature (gate/deliver spans only when they carry its flags). */
const acceptanceSpans = (text: string): string[] => orchestraSpans(text).filter((s) => /^orchestra fanout acceptance /.test(s) || (/^orchestra fanout (gate|deliver) /.test(s) && /--(cwd|acceptance)\b/.test(s)));

test('#510 B: every acceptance verb the skill and its reference name is in the CLI help (A\'s help text); a fake one is seen', () => {
  const spans = [...acceptanceSpans(VERIFIED_FANOUT_SKILL), ...acceptanceSpans(refText('acceptance-tests.md'))];
  for (const need of [/^orchestra fanout acceptance freeze /, /^orchestra fanout acceptance amend /, /^orchestra fanout acceptance show /, /^orchestra fanout gate .*--cwd/, /^orchestra fanout deliver .*--acceptance/]) assert.ok(spans.some((x) => need.test(x)), `the skill or its reference names ${need}`);
  assert.deepEqual(spans.flatMap(lintSpan), [], 'every named acceptance verb and flag exists in `orchestra fanout --help` (needs track A\'s help text)');
  // must-FAIL: a renamed sub-verb, a renamed flag on gate and on deliver, and a verb that does not exist
  for (const bad of ['orchestra fanout acceptance frize t --files a', 'orchestra fanout acceptance amend t --desicion u', 'orchestra fanout gate --ticket 1 --cwdd x', 'orchestra fanout deliver --acceptence r.json', 'orchestra fanout acceptence freeze t']) assert.ok(lintSpan(bad).length > 0, bad);
  // the real text, mutated in place: each of the four acceptance verbs renamed is seen by the existing lint
  for (const [from, to] of [['acceptance show', 'acceptance shw'], ['acceptance amend', 'acceptance amnd'], ['acceptance waive', 'acceptance waiv'], ['--cwd <checkout>', '--cwdd <checkout>'], ['--acceptance <receipt.json>', '--acceptence <receipt.json>']] as const) {
    const m = VERIFIED_FANOUT_SKILL.replace(from, to);
    assert.notEqual(m, VERIFIED_FANOUT_SKILL, `${from}: mutant anchor matches`);
    assert.ok(lint(m).length > 0, `${from} → ${to} is seen`);
  }
});

test('#510 B: §1b exists, points at its reference with a trigger, and the routing rule sits in the dependent-track paragraph', () => {
  const from = VERIFIED_FANOUT_SKILL.indexOf('## 1b. Acceptance tests'); const to = VERIFIED_FANOUT_SKILL.indexOf('\n## ', from + 4);
  assert.ok(from > 0 && to > from, '§1b present');
  assert.match(VERIFIED_FANOUT_SKILL.slice(from, to), /Read[^\n]*references\/acceptance-tests\.md[^\n]*\bwhen\b/);
  assert.ok(VERIFIED_FANOUT_V2_REFERENCES.some((f) => f.path === 'references/acceptance-tests.md'), 'the reference ships');
  // the routing rule lives in §1 (dependent tracks), not only in §1b
  const s1 = VERIFIED_FANOUT_SKILL.slice(VERIFIED_FANOUT_SKILL.indexOf('## 1. Split and brief'), from);
  assert.match(s1, /\*\*Routing rule: a gap found in an upstream is fixed by a follow-up ON the upstream, never by changing the dependent's spec interface \(the one it was specified and tested against\); a follow-up that must change the frozen interface goes through a ledger decision first\.\*\*/);
  // the section points at commands, it does not restate what code enforces: no sha/hash algorithm, no exit-code table, no state-field list
  assert.doesNotMatch(VERIFIED_FANOUT_SKILL.slice(from, to), /sha256|exit 2|\bfrozenAt\b|\bamendments\b/);
});

// ---- #474: every pointer reaches a shipped file, with its trigger -------------------------------------------------------------------

const SHIPPED_PATHS: readonly string[] = [...VERIFIED_FANOUT_FILES, ...VERIFIED_FANOUT_V2_REFERENCES].map((f) => f.path);
/** Problems of the pointers in `skill`: a `references/x.md` / `scripts/ledger-set` mention with no shipped file behind it, a v2 reference nobody points at, or one pointed at with no "read when/before" trigger on a line naming it. */
function pointerProblems(skill: string, shipped: readonly string[], v2: readonly string[]): string[] {
  const probs: string[] = [];
  for (const m of skill.matchAll(/(?<![\w/-])((?:references\/[a-z][a-z-]*\.md)|scripts\/ledger-set[\w-]*)/g)) if (!shipped.includes(m[1])) probs.push(`pointer to ${m[1]}: not in the shipped file set`);
  const lines = skill.split('\n');
  for (const f of v2) {
    const at = lines.map((l, i) => (l.includes(f) ? i : -1)).filter((i) => i >= 0);
    if (at.length === 0) probs.push(`${f}: no pointer to it in SKILL.md`);
    // the trigger sits ON a line that names the file (no neighbour window: a neighbour's "read before" must not vouch for it, #474 review M1)
    else if (!at.some((i) => /\bread\b[^\n]*?\b(when|before)\b/i.test(lines[i]))) probs.push(`${f}: pointed at without a "read when/before" trigger`);
  }
  return probs;
}
test('#474 pointers: every references/ / scripts/ pointer in SKILL.md and in the references reaches a shipped file; every new reference has a "read when" trigger', () => {
  const v2 = VERIFIED_FANOUT_V2_REFERENCES.map((f) => f.path);
  assert.ok(v2.length >= 5, `${v2.length} v2 references`);
  assert.deepEqual(pointerProblems(VERIFIED_FANOUT_SKILL, SHIPPED_PATHS, v2), []);
  // no shipped reference is orphaned from SKILL.md — v1's four included (#474 review: prose.md lost its only pointer)
  const allRefs = SHIPPED_PATHS.filter((x) => x.startsWith('references/'));
  assert.deepEqual(pointerProblems(VERIFIED_FANOUT_SKILL, SHIPPED_PATHS, allRefs), []);
  assert.ok(pointerProblems(VERIFIED_FANOUT_SKILL.replaceAll('references/prose.md', 'references/traps.md'), SHIPPED_PATHS, allRefs).some((p) => /prose\.md: no pointer/.test(p)), 'must-FAIL: an orphaned v1 reference is seen');
  for (const f of VERIFIED_FANOUT_V2_REFERENCES) assert.deepEqual(pointerProblems(f.content, SHIPPED_PATHS, []), [], f.path);
  // every section that MOVED left a pointer: its heading's pointer line names its reference
  for (const [heading, ref] of [['## 0a.', 'lead-ops-tiers.md'], ['## 0b.', 'budget-and-gates.md'], ['## 0c.', 'fleet-bus.md'], ['## 3. Spawn the verifier', 'verifier-and-review.md'], ['## 5. Close-out', 'closeout-and-gates.md']] as const) {
    const from = VERIFIED_FANOUT_SKILL.indexOf(heading); const to = VERIFIED_FANOUT_SKILL.indexOf('\n## ', from + 4);
    const sec = VERIFIED_FANOUT_SKILL.slice(from, to);
    assert.match(sec, new RegExp(`[Rr]ead[^\\n]*references/${ref.replace('.', '\\.')}|references/${ref.replace('.', '\\.')}[^\\n]*\\b(when|before)\\b`), `${heading} points at ${ref} with a trigger`);
  }
  // must-FAIL: a pointer to a file that does not ship, a pointer removed, a trigger removed
  assert.ok(pointerProblems(`${VERIFIED_FANOUT_SKILL}\nRead when x: \`references/no-such.md\``, SHIPPED_PATHS, v2).some((p) => /references\/no-such\.md: not in the shipped/.test(p)));
  assert.ok(pointerProblems(VERIFIED_FANOUT_SKILL, SHIPPED_PATHS.filter((x) => x !== 'references/fleet-bus.md'), v2).some((p) => /fleet-bus\.md: not in the shipped/.test(p)), 'a reference dropped from the shipped set');
  assert.ok(pointerProblems(VERIFIED_FANOUT_SKILL.replaceAll('references/closeout-and-gates.md', 'references/traps.md'), SHIPPED_PATHS, v2).some((p) => /closeout-and-gates\.md: no pointer/.test(p)));
  const noTrigger = VERIFIED_FANOUT_SKILL.replace(/\b(when|before)\b/gi, 'if');
  assert.ok(pointerProblems(noTrigger, SHIPPED_PATHS, v2).some((p) => /without a "read when\/before" trigger/.test(p)));
  // #474 review M1: a pointer line whose trigger was replaced is seen even though its NEIGHBOURS say "read before"
  const trapsLine = VERIFIED_FANOUT_SKILL.split('\n').find((l) => l.includes('references/traps.md') && /^- /.test(l))!;
  assert.ok(trapsLine && /\bread\b[^\n]*\b(when|before)\b/i.test(trapsLine), 'the traps pointer line carries its own trigger');
  const noTrapsTrigger = VERIFIED_FANOUT_SKILL.replace(trapsLine, trapsLine.replace(/\bread\b/gi, 'use').replace(/\b(when|before)\b/gi, 'if'));
  assert.notEqual(noTrapsTrigger, VERIFIED_FANOUT_SKILL);
  assert.ok(pointerProblems(noTrapsTrigger, SHIPPED_PATHS, allRefs).some((p) => /traps\.md: pointed at without/.test(p)), 'must-FAIL: traps pointer without its own trigger');
  assert.ok(pointerProblems(VERIFIED_FANOUT_SKILL.replace('scripts/ledger-set', 'scripts/ledger-sett'), SHIPPED_PATHS, v2).some((p) => /ledger-sett/.test(p)));
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
  assert.match(VERIFIED_FANOUT_SKILL, /Edit\/Write to the coordinator,\s+reviewer, explorer and scribe/);
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

test('wiring: workspaces.ts calls the guarded installer and hashes the text AND the bundled files into HOOKS_VERSION', () => {
  const check = (src: string): string[] => {
    const probs: string[] = [];
    if (!/import \{ installVerifiedFanoutSkill \} from '\.\/verified-fanout-install\.ts';/.test(src)) probs.push('import missing');
    if (!/\n\s+installVerifiedFanoutSkill\(skillsDir, /.test(src)) probs.push('installVerifiedFanoutSkill(skillsDir) call missing');
    const v = src.slice(src.indexOf('const HOOKS_VERSION = createHash'), src.indexOf('.digest(', src.indexOf('const HOOKS_VERSION = createHash')));
    if (!/\n\s+VERIFIED_FANOUT_SKILL,\n/.test(v)) probs.push('VERIFIED_FANOUT_SKILL not hashed into HOOKS_VERSION (an edited text would never reinstall)');
    if (!/\n\s+JSON\.stringify\(VERIFIED_FANOUT_FILES\),\n/.test(v)) probs.push('VERIFIED_FANOUT_FILES not hashed into HOOKS_VERSION');
    if (!/\n\s+JSON\.stringify\(VERIFIED_FANOUT_V2_REFERENCES\),\n/.test(v)) probs.push('VERIFIED_FANOUT_V2_REFERENCES not hashed into HOOKS_VERSION (an edited reference would never reinstall)');
    if (!/RETIRED_SKILLS = \[[^\]]*\]/.test(src) || /RETIRED_SKILLS = \[[^\]]*verified-fanout/.test(src)) probs.push('verified-fanout must not be in RETIRED_SKILLS');
    return probs;
  };
  assert.deepEqual(check(workspacesSrc), []);
  // must-FAIL: each deletion is seen
  assert.ok(check(workspacesSrc.replace('      installVerifiedFanoutSkill(skillsDir, (e) => log.warn(`verified-fanout skill install skipped for ${worktreePath}`, e), fanoutSwitches),\n', '')).includes('installVerifiedFanoutSkill(skillsDir) call missing'));
  assert.ok(check(workspacesSrc.replace('      VERIFIED_FANOUT_SKILL,\n', '')).some((p) => /VERIFIED_FANOUT_SKILL not hashed/.test(p)));
  assert.ok(check(workspacesSrc.replace('      JSON.stringify(VERIFIED_FANOUT_FILES),\n', '')).some((p) => /VERIFIED_FANOUT_FILES not hashed/.test(p)));
  assert.ok(check(workspacesSrc.replace('      JSON.stringify(VERIFIED_FANOUT_V2_REFERENCES),\n', '')).some((p) => /VERIFIED_FANOUT_V2_REFERENCES not hashed/.test(p)));
  assert.ok(check(workspacesSrc.replace("      'orchestra-link',\n", "      'orchestra-link',\n      'verified-fanout',\n")).some((p) => /RETIRED_SKILLS/.test(p)));
});

// ---- D8: v1's references/ + scripts/ledger-set ship byte-identical -----------------------------------------------------------------

/** sha256 of the frozen v1 files (ground-zero-prep/skills-v1/SHA256SUMS). */
const V1_FILE_SHA256: Record<string, string> = {
  'references/meta-rules.md': 'a203d4a735e79e7339c7ed88617e4f403cc80d4fd547d8e943f7cd7956aa5bcd',
  'references/prose.md': '68ce78da7a108a475c211afe24b8cdb661e7d6391b69f5134f34126b6499c3ed',
  'references/traps.md': '2da64c32010533252c26e8ffe069a8a8c86d374e96cf20849963c49ac4187560',
  'references/working-with-agents.md': '8fc47556e2ee1f7f4542660484cbb6fd3b99780b38fed8f4013a3f6d106bf1f7',
  'scripts/ledger-set': 'c6e24d3a56a9d6498f2d191f11979fa6f0a5e5370187d23ba8a1ca89af9ad0f6',
};
const sha = (t: string) => createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex');
const filesDrift = (files: ReadonlyArray<{ path: string; content: string }>): string[] =>
  Object.entries(V1_FILE_SHA256).flatMap(([rel, want]) => { const f = files.find((x) => x.path === rel); return !f ? [`${rel}: not shipped`] : sha(f.content) !== want ? [`${rel}: sha256 differs from frozen v1`] : []; })
    .concat(files.filter((f) => !(f.path in V1_FILE_SHA256)).map((f) => `${f.path}: not a v1 file`));

test('D8: every shipped reference file is byte-identical to the frozen v1 (sha256), ledger-set is executable', () => {
  assert.deepEqual(filesDrift(VERIFIED_FANOUT_FILES), []);
  assert.equal(VERIFIED_FANOUT_FILES.find((f) => f.path === 'scripts/ledger-set')?.mode, 0o755);
  // must-FAIL: one changed byte, a dropped file, a stray file
  const bent = VERIFIED_FANOUT_FILES.map((f) => (f.path === 'references/traps.md' ? { ...f, content: f.content.replace('a', 'b') } : f));
  assert.ok(filesDrift(bent).some((d) => /traps\.md: sha256 differs/.test(d)));
  assert.ok(filesDrift(VERIFIED_FANOUT_FILES.slice(1)).some((d) => /meta-rules\.md: not shipped/.test(d)));
  assert.ok(filesDrift([...VERIFIED_FANOUT_FILES, { path: 'references/extra.md', content: 'x' }]).some((d) => /extra\.md: not a v1 file/.test(d)));
});

// ---- #474: the v2 references ship, from ONE source (src/shared/verified-fanout-refs/*.md) -------------------------------------------

/** Problems of the embedded v2 references against their source dir: a stale embedding (edit not regenerated), a missing/extra file, a v1 name, a wrong mode, an empty file. */
function v2Drift(files: ReadonlyArray<{ path: string; mode: number; content: string }>, srcDir: string): string[] {
  const disk = fs.readdirSync(srcDir).filter((n) => n.endsWith('.md')).sort();
  const probs: string[] = [];
  for (const n of disk) {
    const f = files.find((x) => x.path === `references/${n}`);
    if (!f) probs.push(`references/${n}: in the source dir, not embedded (run scripts/gen-verified-fanout-files.mjs)`);
    else if (f.content !== fs.readFileSync(path.join(srcDir, n), 'utf8')) probs.push(`references/${n}: embedded text differs from its source (run scripts/gen-verified-fanout-files.mjs)`);
    if (f && f.mode !== 0o644) probs.push(`references/${n}: mode ${f.mode.toString(8)}`);
    if (f && f.content.trim() === '') probs.push(`references/${n}: empty`);
  }
  for (const f of files) {
    if (!disk.includes(f.path.replace(/^references\//, ''))) probs.push(`${f.path}: embedded, no source file`);
    if (f.path in V1_FILE_SHA256) probs.push(`${f.path}: collides with a v1 file`);
  }
  return probs;
}
test('#474: the v2 references are embedded byte-for-byte from their one source dir, none is a v1 file, and v1\'s five are untouched', () => {
  assert.deepEqual(v2Drift(VERIFIED_FANOUT_V2_REFERENCES, REFS_SRC_DIR), []);
  assert.ok(VERIFIED_FANOUT_V2_REFERENCES.length >= 5 && VERIFIED_FANOUT_V2_REFERENCES.every((f) => /^references\/[a-z-]+\.md$/.test(f.path)));
  assert.deepEqual(filesDrift(VERIFIED_FANOUT_FILES), [], 'v1 files stay sha256-identical to the frozen v1');
  // must-FAIL: one changed byte, a dropped file, a stray embedded file, a v1 collision, an unembedded source file
  const bent = VERIFIED_FANOUT_V2_REFERENCES.map((f) => (f.path === 'references/fleet-bus.md' ? { ...f, content: f.content + ' ' } : f));
  assert.ok(v2Drift(bent, REFS_SRC_DIR).some((d) => /fleet-bus\.md: embedded text differs/.test(d)));
  assert.ok(v2Drift(VERIFIED_FANOUT_V2_REFERENCES.slice(1), REFS_SRC_DIR).some((d) => /in the source dir, not embedded/.test(d)));
  assert.ok(v2Drift([...VERIFIED_FANOUT_V2_REFERENCES, { path: 'references/extra.md', mode: 0o644, content: 'x' }], REFS_SRC_DIR).some((d) => /extra\.md: embedded, no source file/.test(d)));
  assert.ok(v2Drift([...VERIFIED_FANOUT_V2_REFERENCES, { path: 'references/traps.md', mode: 0o644, content: 'x' }], REFS_SRC_DIR).some((d) => /traps\.md: collides with a v1 file/.test(d)));
  assert.ok(v2Drift(VERIFIED_FANOUT_V2_REFERENCES.map((f) => ({ ...f, mode: 0o755 })), REFS_SRC_DIR).some((d) => /mode 755/.test(d)));
  // the generator is deterministic: its output for the current sources is the committed module
  const gen = fs.readFileSync(path.join(root, 'src', 'shared', 'verified-fanout-files.ts'), 'utf8');
  for (const f of VERIFIED_FANOUT_V2_REFERENCES) assert.ok(gen.includes(JSON.stringify(f.content)), `${f.path}: the committed module embeds the source literally`);
});

test('#474: roleClaimDrift covers every role-guard claim the references make (the verifier edits scratch only)', () => {
  const claims = [...ALL_V2_REFS.matchAll(/[^.\n]*role guard[^.\n]*/gi)].map((m) => m[0].trim());
  assert.ok(claims.length >= 1 && claims.every((c) => /scratch only/.test(c)), `unexpected role-guard claim(s) in the references: ${claims.join(' | ')}`);
  assert.deepEqual(roleClaimDrift((r) => roleSpec(r)), []);
  const verifierEdits = (r: FleetRole) => { const x = roleSpec(r); if (r === 'verifier') x.tools.edit = 'own-worktree'; return x; };
  assert.ok(roleClaimDrift(verifierEdits).some((d) => /verifier: edit scope is not scratch/.test(d)), 'must-FAIL: the verifier gaining the worktree breaks the references\' claim');
  // a NEW role-guard claim planted in a reference is not in the covered set
  assert.ok([...`${ALL_V2_REFS}\nThe role guard lets a reviewer push.`.matchAll(/[^.\n]*role guard[^.\n]*/gi)].some((m) => !/scratch only/.test(m[0])));
});

test('the text no longer claims the references are absent or conditional', () => {
  assert.match(VERIFIED_FANOUT_SKILL, /[Tt]hese files ship WITH this skill/);
  assert.doesNotMatch(VERIFIED_FANOUT_SKILL, /present only where that copy is|carries every rule v2 needs|skip them/);
  assert.ok(VERIFIED_FANOUT_SKILL.includes(VERIFIED_FANOUT_MARKER), 'the generated marker is in the text (the installer keys on it)');
  assert.doesNotMatch(VERIFIED_FANOUT_SKILL, /instead of restating/);
});

// ---- the guarded installer (pure fs) -----------------------------------------------------------------------------------------------

test('installVerifiedFanoutSkill: fresh dir gets SKILL.md + the files; a marked older copy is rewritten; a repo\'s OWN unmarked SKILL.md is never touched', async () => {
  const skills = mkHomeScratch('vf-install-');
  try {
    const dir = path.join(skills, 'verified-fanout');
    assert.equal(await installVerifiedFanoutSkill(skills), 'written');
    assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), VERIFIED_FANOUT_SKILL);
    assert.equal(fs.readFileSync(path.join(dir, 'references', 'traps.md'), 'utf8'), VERIFIED_FANOUT_FILES.find((f) => f.path === 'references/traps.md')!.content);
    // #474: the v2 references land too (every pointer of SKILL.md resolves in the installed dir)
    for (const f of VERIFIED_FANOUT_V2_REFERENCES) assert.equal(fs.readFileSync(path.join(dir, f.path), 'utf8'), renderSwitchBlocks(f.content, {}), f.path); // #554: the default-switch render
    for (const m of VERIFIED_FANOUT_SKILL.matchAll(/(?<![\w/-])(references\/[a-z][a-z-]*\.md|scripts\/ledger-set)(?![\w-])/g)) assert.ok(fs.existsSync(path.join(dir, m[1])), `${m[1]} (pointed at by SKILL.md) exists on disk after the install`);
    assert.ok((fs.statSync(path.join(dir, 'scripts', 'ledger-set')).mode & 0o111) !== 0);
    // a previous generated copy + a corrupted reference + a lost exec bit → all restored
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `<!-- ${VERIFIED_FANOUT_MARKER} -->\nold`);
    fs.writeFileSync(path.join(dir, 'references', 'prose.md'), 'corrupt');
    fs.writeFileSync(path.join(dir, 'references', 'fleet-bus.md'), 'corrupt');
    fs.chmodSync(path.join(dir, 'scripts', 'ledger-set'), 0o644);
    assert.equal(await installVerifiedFanoutSkill(skills), 'written');
    assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), VERIFIED_FANOUT_SKILL);
    assert.deepEqual(filesDrift(VERIFIED_FANOUT_FILES.map((f) => ({ path: f.path, content: fs.readFileSync(path.join(dir, f.path), 'utf8') }))), []);
    assert.ok((fs.statSync(path.join(dir, 'scripts', 'ledger-set')).mode & 0o111) !== 0, 'exec bit restored on a rewrite');
    assert.equal(fs.readFileSync(path.join(dir, 'references', 'fleet-bus.md'), 'utf8'), refText('fleet-bus.md'), 'a corrupted v2 reference is restored');
  } finally { fs.rmSync(skills, { recursive: true, force: true }); }
  // never throws: each fs-error shape returns skipped-error (reported), never an exception; a symlinked dir is the repo's own and is not written through
  const errs = mkHomeScratch('vf-install-err-');
  try {
    const seen: unknown[] = [];
    const shape = (name: string, make: (d: string) => void) => { const sk = path.join(errs, name); make(path.join(sk, 'verified-fanout')); return sk; };
    assert.equal(await installVerifiedFanoutSkill(shape('dangling', (d) => { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.symlinkSync(path.join(errs, 'absent'), d); }), (e) => seen.push(e)), 'skipped-foreign');
    assert.equal(await installVerifiedFanoutSkill(shape('md-dir', (d) => fs.mkdirSync(path.join(d, 'SKILL.md'), { recursive: true })), (e) => seen.push(e)), 'skipped-error');
    assert.equal(await installVerifiedFanoutSkill(shape('file', (d) => { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, 'x'); }), (e) => seen.push(e)), 'skipped-error');
    assert.equal(seen.length, 2, 'both fs errors reached the reporter');
    // a symlink to a real dir without SKILL.md: nothing written THROUGH it
    const target = path.join(errs, 'personal'); fs.mkdirSync(target);
    assert.equal(await installVerifiedFanoutSkill(shape('linked', (d) => { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.symlinkSync(target, d); })), 'skipped-foreign');
    assert.deepEqual(fs.readdirSync(target), []);
    // a foreign SKILL.md that merely QUOTES the marker is not ours; an empty (truncated) one is
    const quote = shape('quote', (d) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), `own skill that mentions ${VERIFIED_FANOUT_MARKER} in prose\n`); });
    assert.equal(await installVerifiedFanoutSkill(quote), 'skipped-foreign');
    const empty = shape('empty', (d) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), ''); });
    assert.equal(await installVerifiedFanoutSkill(empty), 'written');
    // #474: SKILL.md is written LAST — a failing reference write leaves NO new SKILL.md pointing at references that did not land
    const partial = shape('partial', (d) => fs.mkdirSync(path.join(d, 'references', 'fleet-bus.md'), { recursive: true }));
    assert.equal(await installVerifiedFanoutSkill(partial), 'skipped-error');
    assert.ok(!fs.existsSync(path.join(partial, 'verified-fanout', 'SKILL.md')), 'no SKILL.md after a failed reference write');
    // a throwing reporter cannot make it throw
    assert.equal(await installVerifiedFanoutSkill(shape('throwing', (d) => fs.mkdirSync(path.join(d, 'SKILL.md'), { recursive: true })), () => { throw new Error('reporter'); }), 'skipped-error');
  } finally { fs.rmSync(errs, { recursive: true, force: true }); }
  // a repo's own tracked skill: untouched, no file added, sibling kept
  const own = mkHomeScratch('vf-install-own-');
  try {
    const dir = path.join(own, 'verified-fanout');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'THE REPO OWN SKILL\n');
    fs.writeFileSync(path.join(dir, 'extra.md'), 'EXTRA\n');
    assert.equal(await installVerifiedFanoutSkill(own), 'skipped-foreign');
    assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), 'THE REPO OWN SKILL\n');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['SKILL.md', 'extra.md']);
  } finally { fs.rmSync(own, { recursive: true, force: true }); }
});

test('the REAL installOrchestraHooks lands the skill + files in a fresh worktree, rewrites them on a later spawn after an upgrade, and leaves a repo\'s own skill alone', () => {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './scripts/.r2-register.mjs', 'scripts/e2e-verified-fanout-skill-install.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 110_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
  });
  const r = JSON.parse(out.trim().split('\n').pop() ?? '{}');
  assert.deepEqual(r, { ok: true, nameIsVerifiedFanout: true, absentBefore: true, landed: true, filesLanded: true, ledgerSetExecutable: true, siblingsKept: true, rewrittenOnUpgrade: true, stampedInstallIsNoop: true, ownSkillKept: true, errorShapes: { dangling_symlink: true, skill_md_is_dir: true, file_at_skill_dir: true }, errorShapesKeepHooks: true });
});

// ---- #495/#497: the §0b full-suite rules conflict with nothing -------------------------------------------------------------------------
/** The text of one `## ` section (heading line included) up to the next `## ` heading. */
const sectionOf = (text: string, heading: RegExp): string => {
  const m = heading.exec(text);
  assert.ok(m, `section ${heading} exists`);
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/\n## /);
  return m[0] + (next === -1 ? rest : rest.slice(0, next));
};
/** Every bullet of §0b that mentions "the full suite" / "full suite" — each must be one of the two rules (a bullet that says the verifier runs it must carry the CI exception; one about the implementer must say never). */
export const fullSuiteConflicts = (text: string): string[] => {
  const b = sectionOf(text, /\n## 0b\. Budget: messages and gates\n/);
  const bullets = b.split(/\n(?=- )/).filter((x) => /full suite/i.test(x));
  const probs: string[] = [];
  if (bullets.length !== 2) probs.push(`expected exactly 2 bullets naming the full suite in §0b, found ${bullets.length}`);
  for (const x of bullets) {
    const verifier = /verifier's seat/.test(x);
    const implementer = /implementer's self-gate/.test(x);
    if (verifier && !/fanout gate/.test(x)) probs.push('a bullet puts the full suite on the verifier without the `fanout gate` exception');
    if (implementer && !/never the full suite/.test(x)) probs.push('a bullet about the implementer self-gate does not forbid the full suite');
    if (verifier && implementer) probs.push('one bullet mixes the verifier and implementer suite rules');
  }
  return probs;
};

test('#495/#497: §0b has exactly the two full-suite rules and they do not contradict (verifier: per fanout gate; implementer: never)', () => {
  assert.deepEqual(fullSuiteConflicts(VERIFIED_FANOUT_SKILL), []);
  // must-FAIL: the pre-#495 bullet (verifier always runs it) and an implementer bullet allowing it are both seen
  const old = VERIFIED_FANOUT_SKILL.replace(/- \*\*The full suite and the build run on the verifier's seat[\s\S]*?\n- \*\*An implementer/, "- **The full suite and the build run on the verifier's seat, once per candidate**; an implementer's self-gate is the typecheck.\n- **An implementer");
  assert.ok(fullSuiteConflicts(old).length > 0, 'the old unconditional verifier rule is seen');
  const allowed = VERIFIED_FANOUT_SKILL.replace('; never the full suite (CI runs the rest)', ' and the full suite');
  assert.ok(fullSuiteConflicts(allowed).some((p) => /does not forbid/.test(p)), 'an implementer bullet that allows the suite is seen');
});

test('#495: the verifier brief (§3) and the references point at `fanout gate` rather than restating the derivation', () => {
  assert.match(sectionOf(VERIFIED_FANOUT_SKILL, /\n## 3\. Spawn the verifier\n/), /tests \(§0b\)/);
  assert.match(refText('verifier-and-review.md'), /fullSuite: ci/);
  assert.match(refText('budget-and-gates.md'), /unless the target has PR CI/);
});

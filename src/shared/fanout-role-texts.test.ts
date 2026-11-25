// #590 (vague #585, ledger #591 I5) — one skill text per role under `seatRecords`. The ticket's four criteria, each with must-fail arms:
//   (1) `off`: every render (the whole switch matrix, SKILL.md + references) is byte-identical to master's — sha256 oracle `fixtures/seat-records-off-snapshot.json`, taken BEFORE #590's edits (`scripts/gen-seat-records-off-snapshot.mjs`).
//   (2) `on`: a LIST (RULES below: marker → role) classifies every rule of today's text; the coordinator's ON text holds coordinator rules only, the role files theirs only, moved text is byte-equal to master's.
//   (3) the ON coordinator text names the new verbs and none of the refused ones.   (4) the installer writes the role files under ON only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { renderVerifiedFanoutSkill, verifiedFanoutReferenceWanted } from './verified-fanout-skill.ts';
import { renderFanoutReviewerSkill, FANOUT_REVIEWER_SKILL_PATH } from './fanout-reviewer-skill.ts';
import { renderFanoutImplementerSkill, FANOUT_IMPLEMENTER_SKILL_PATH } from './fanout-implementer-skill.ts';
import { FANOUT_ROLE_FILES, fanoutRoleFilesWanted } from './fanout-role-files.ts';
import { renderSwitchBlocks } from './fanout-switch-render.ts';
import { VERIFIED_FANOUT_FILES, VERIFIED_FANOUT_V2_REFERENCES } from './verified-fanout-files.ts';
import { installFanoutRoleFiles, installVerifiedFanoutSkill } from '../main/verified-fanout-install.ts';
import { REVIEWER_RULES, renderReviewerBrief } from './fanout-review-brief.ts';
import { COMMANDS } from '../cli/help.ts';
import { SEAT_USAGE } from '../cli/fanout-state.ts';
import { REVIEW_USAGE } from '../cli/fanout-review.ts';
import { RECORD_USAGE } from '../cli/fanout-record.ts';
import { briefInputOf } from './fanout-review.ts';
import { switchesOf, type Switches } from './fanout-state.ts';

const helpOf = (name: string): string => { const c = COMMANDS.find((x) => x.name === name); return c ? `${c.summary}\n${c.detail}` : ''; };
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const AXES: Record<string, string[]> = { earlyGate: ['on', 'off'], acceptance: ['on', 'off'], minorPolicy: ['legacy', 'refuse', 'spec', 'demonstrated'], verifier: ['on', 'off'], preNominationChecks: ['on', 'off'] };
const COMBOS: Array<Record<string, string>> = [{}];
for (const [k, vs] of Object.entries(AXES)) { const next: Array<Record<string, string>> = []; for (const c of COMBOS) for (const v of vs) next.push({ ...c, [k]: v }); COMBOS.length = 0; COMBOS.push(...next); }
const asSw = (c: Record<string, string>, seat: 'on' | 'off'): Partial<Switches> => ({ ...c, seatRecords: seat }) as Partial<Switches>;
const comboKey = (c: Record<string, string>) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ');

// ---------------------------------------------------------------- (1) OFF is byte-identical to master -------------------------------------------------------------------------
const SNAP = JSON.parse(readFileSync(new URL('./fixtures/seat-records-off-snapshot.json', import.meta.url), 'utf8')) as Record<string, { skill: string; refs: string | null }>;
const refsHash = (sw: Partial<Switches>): string => sha([...VERIFIED_FANOUT_FILES, ...VERIFIED_FANOUT_V2_REFERENCES].filter((f) => verifiedFanoutReferenceWanted(f.path, sw)).map((f) => `${f.path}\n${f.path.endsWith('.md') ? renderSwitchBlocks(f.content, sw) : f.content}`).join('\n\0\n'));

test('#590 off: SKILL.md and every reference are byte-identical to master over the whole switch matrix (seatRecords absent AND explicit off)', () => {
  assert.equal(Object.keys(SNAP).length, COMBOS.length + 1, 'the snapshot covers the 64-point matrix + the bare default');
  for (const c of COMBOS) {
    const want = SNAP[comboKey(c)];
    assert.ok(want, `snapshot has ${comboKey(c)}`);
    for (const sw of [c as Partial<Switches>, asSw(c, 'off')]) {
      assert.equal(sha(renderVerifiedFanoutSkill(sw)), want.skill, `SKILL.md differs from master at ${comboKey(c)} (${JSON.stringify(sw)})`);
      assert.equal(refsHash(sw), want.refs, `a reference differs from master at ${comboKey(c)}`);
    }
  }
  assert.equal(sha(renderVerifiedFanoutSkill()), SNAP['(default)'].skill, 'the bare default render');
});

test('#590 off: the oracle can fail — a one-byte change to the rendered text breaks the comparison', () => {
  const want = SNAP[comboKey(COMBOS[0])].skill;
  assert.notEqual(sha(renderVerifiedFanoutSkill(COMBOS[0] as Partial<Switches>) + ' '), want);
  assert.notEqual(sha(renderVerifiedFanoutSkill(asSw(COMBOS[0], 'on'))), want, 'seatRecords=on is not the master text (the switch does something)');
});

// ---------------------------------------------------------------- (2) the list ----------------------------------------------------------------------------------------------
type Role = 'C' | 'R' | 'I';
/** [marker = the first 44 chars of the unit (bullet / emphasis / backticks stripped, whitespace collapsed), roles (C coordinator · R reviewer · I implementer — every role whose text holds the rule), how?]
 *  how: 'o' = a master line only the OFF coordinator text has (a pointer); its ON home is a role file under another marker · 'n' = text NEW under seatRecords=on (no master line behind it) · 'r' = master's rule REWORDED because it names a verb the switch refuses (the record replaces the typed finding) · absent = MOVED byte for byte (ledger D4).
 *  The longest marker that prefixes a unit wins. A rule with no entry fails the test: classify it. */
const RULES: ReadonlyArray<readonly [string, string, string?]> = [
  ["--- name: verified-fanout description: Mecha", 'C'],
  ["# Verified fan-out", 'C'],
  ["Decide before you spawn. This skill is the m", 'C'],
  ["Three roles. N implementers work in fresh wo", 'C'],
  ["## Roles are typed — the name is the role (v", 'C'],
  ["The role is the --name prefix the spawner ga", 'C'],
  ["Model and effort per role — roleSpec(); stro", 'C'],
  ["A scribe only for steps that need turns BETW", 'C'],
  ["Tool limits — the PreToolUse role guard (exi", 'C'],
  ["## 0a. Two tiers when a human sits on the or", 'C'],
  ["Run orchestra whoami first (role and run). A", 'C'],
  ["A LEAD never coordinates a vague directly (A", 'C'],
  ["LEAD: quiet, freezes specs with the human be", 'C'],
  ["A decision you cannot make yourself: take th", 'C'],
  ["Ops dies mid-wave → respawn ops pointed at t", 'C'],
  ["No incoming message = no next turn, EVER. An", 'C'],
  ["A long-lived member re-reads its whole conte", 'C'],
  ["WALL-CLOCK IS A GOAL: pipeline, never batch ", 'C'],
  ["Read references/lead-ops-tiers.md when you a", 'C'],
  ["## 0. Open the ledger before spawning", 'C'],
  ["The ledger — one durable tracking issue — is", 'C'],
  ["Two rules ride in every brief, verbatim:", 'C'],
  ["Pull the ledger before acting on any instruc", 'CRI'],
  ["Relay branch REFS and re-resolve with ls-rem", 'CRI'],
  ["Coordinator-side rules:", 'C'],
  ["Freeze contested spec axes before dispatchin", 'C'],
  ["Sent ≠ received. Act on a counterparty's fin", 'C'],
  ["State-only acks from message one; evaluative", 'C'],
  ["Execution state lives in the state file, dec", 'C'],
  ["Edit a ledger table row with scripts/ledger-", 'C'],
  ["The ledger carries the ledger label (open le", 'C'],
  ["## 0b. Budget: messages and gates", 'CRI'],
  ["Churn burns a fleet's tokens and wall-clock.", 'C', 'r'],
  ["Every report, verdict and blocking question ", 'RI'],
  ["Fixed report format, ≤15 lines: STATE: <tip ", 'RI'],
  ["One ping per event — checkpoint, gate verdic", 'RI'],
  ["Gate rhythm:", 'CI'],
  ["Write the full gate checklist into the ledge", 'C'],
  ["The full suite and the build run on the veri", 'C'],
  ["An implementer's self-gate — and every fix r", 'I'],
  ["Self-gate BEFORE nominating — the implemente", 'I'],
  ["Gate merge candidates, not pushes. The verif", 'C'],
  ["Run the repo's fast checks before nominating", 'I'],
  ["Carry verdicts by TREE IDENTITY across clean", 'C'],
  ["Scope re-gates to the delta; a docs/comment-", 'C'],
  ["A review that exposes a coverage gap: do NOT", 'I'],
  ["Mutation runs: FULL set at the first nominat", 'I'],
  ["Read references/budget-and-gates.md before t", 'C'],
  ["## 0c. The fleet bus (every live run is all-", 'C'],
  ["Every run is all-ON (six switches; mail cann", 'C'],
  ["Read references/fleet-bus.md when a message ", 'C'],
  ["## 1. Split and brief", 'C'],
  ["Break the feature into 2–4 self-contained su", 'C'],
  ["A dependent track starts at dispatch and is ", 'C'],
  ["Routing rule: a gap found in an upstream is ", 'C'],
  ["The spawner names the child at spawn — orche", 'C'],
  ["Done when: every brief names your literal wo", 'C'],
  ["## 1b. Acceptance tests: written blind, froz", 'C'],
  ["Code forces it; you do not spawn the writer.", 'C'],
  ["Register the spec: orchestra fanout state se", 'C'],
  ["The writer freezes (own ticket only) to acce", 'C'],
  ["Bytes decide: orchestra fanout gate … --tick", 'C'],
  ["Read references/acceptance-tests.md when you", 'C'],
  ["## 2. Spawn the implementers", 'C'],
  ["One orchestra spawn --name <rôle>-<object>-<", 'C'],
  ["## 3. Spawn the verifier", 'C'],
  ["One agent whose only job is verification. It", 'C'],
  ["pnpm install (or the repo's equivalent) once", 'C'],
  ["Per branch named by the coordinator: git fet", 'C'],
  ["Run the real gate: typecheck, tests (§0b), a", 'C'],
  ["Run the FULL gate checklist from the ledger ", 'C'],
  ["Prove the rig before trusting it: one mutati", 'C'],
  ["Audit the rig before filing any defect; prob", 'C'],
  ["Read references/verifier-and-review.md when ", 'C'],
  ["## 3b. Adversarial review: one fresh spawn p", 'C'],
  ["Gates verify BEHAVIOUR; review attacks the C", 'CR'],
  ["Severity scale (BLOCKING / MAJOR / MINOR / N", 'R', 'o'],
  ["No spawned reviewer when the candidate's dif", 'C'],
  ["## 4. Coordinate and gate", 'C'],
  ["Implementer reports done → send the verifier", 'C'],
  ["At nomination, parallel with the gate: orche", 'C'],
  ["PASS → apply the merge rule below, through o", 'C'],
  ["The merge rule — apply it the moment a revie", 'C'],
  ["A review round with 0 BLOCKING and 0 MAJOR m", 'C'],
  ["The count, the head and the CI are code: wri", 'C'],
  ["BLOCKING/MAJOR → ONE fix round: the implemen", 'C'],
  ["At most ONE follow-up branch per candidate; ", 'C'],
  ["MERGE-ELIGIBLE = a DISPOSITION in the ledger", 'C'],
  ["Serialize merges that touch a shared seam. S", 'C'],
  ["Composed features need a composed gate. When", 'C'],
  ["## 5. Close-out sweep", 'C'],
  ["\"Agent reported done\" and \"work landed\" are ", 'C'],
  ["bash git log <integration-branch>..<agent-br", 'C'],
  ["The first catches stranded commits (run it a", 'C'],
  ["Deleting a workspace requires the agent to b", 'C'],
  ["Gate a delete on BOTH checks, not on verify-", 'C'],
  ["Then confirm each deliverable file exists on", 'C'],
  ["A wave is closed only when the LEAD has itse", 'C'],
  ["Done when: both commands print nothing, ever", 'C'],
  ["Read references/closeout-and-gates.md before", 'C'],
  ["## 6. Report", 'C'],
  ["One consolidated status: per branch, verdict", 'C'],
  ["## Specify gates that can fail", 'C'],
  ["Name the property, the observation that woul", 'C'],
  ["## Deep references — pull on demand", 'C'],
  ["These files ship WITH this skill (references", 'C'],
  ["references/lead-ops-tiers.md — read when you", 'C'],
  ["references/budget-and-gates.md — read before", 'C'],
  ["references/fleet-bus.md — read when a messag", 'C'],
  ["references/verifier-and-review.md — read whe", 'C'],
  ["references/closeout-and-gates.md — read befo", 'C'],
  ["references/traps.md — the confident-wrong-an", 'C'],
  ["references/prose.md — read before writing an", 'C'],
  ["references/working-with-agents.md — read bef", 'C'],
  ["references/meta-rules.md — read when adding ", 'C'],
  ["## Which copy is this? Install and precedenc", 'C'],
  ["This is the bundled v2, rewritten into each ", 'C'],
  ["A personal-level copy shadows it (measured o", 'C'],
  ["VPS install: an AppImage release carries thi", 'C'],
  ["Declare the plan before the first spawn (§0 ", 'C', 'n'],
  ["Every implementer's brief names its rules fi", 'C', 'n'],
  ["The count, the head and the CI are code, and", 'C', 'n'],
  ["At most ONE follow-up branch per candidate, ", 'C', 'n'],
  ["<!-- orchestra-generated: fan-out role text ", 'RI', 'n'],
  ["# Fan-out reviewer — your rules", 'R', 'n'],
  ["You are the reviewer of ONE merge candidate ", 'R', 'n'],
  ["Two rules ride in your brief, verbatim:", 'I', 'n'],
  ["Two rules ride in every fleet message that na", 'R', 'n'],
  ["## Adversarial review: what you do", 'R', 'n'],
  ["It: it reads the diff, the ledger spec, and ", 'R'],
  ["The traps file, when the repo has Orchestra's", 'R', 'n'],
  ["Your brief names no ledger: your verdict goes", 'R', 'n'],
  ["Severity scale (the §4 merge rule keys on it", 'R'],
  ["(§4 is the coordinator's merge rule: 0 BLOCK", 'R', 'n'],
  ["BLOCKING — must not merge as is (red CI/buil", 'R'],
  ["MAJOR — wrong behaviour on a real input, or ", 'R'],
  ["MINOR — a real defect with limited reach (ra", 'R'],
  ["NIT — cosmetic (comment, doc, naming) — not ", 'R'],
  ["## Record your verdict — the only way your r", 'R', 'n'],
  ["orchestra fanout record <ticket> --head <sha", 'R', 'n'],
  ["A worker sends gate failures, decision asks ", 'RI'],
  ["Done when: the reviewer's comment is on the ", 'R'],
  ["# Fan-out implementer — your rules", 'I', 'n'],
  ["You are an implementer (impl- name, set by y", 'I', 'n'],
  ["Rebase onto current master BEFORE nominating", 'I'],
  ["Two standing roles. N implementers work in f", 'C'],
  ["The PR's CI is the build and the full suite;", 'C'],
  ["Review merge candidates, not pushes. The rev", 'C'],
  ["## 3. No gating seat: the CI and the reviewe", 'CI'],
  ["No agent runs a gate for you: the build and ", 'C'],
  ["The implementer's self-gate (§0b) and its pr", 'I'],
  ["What neither the CI nor the reviewer covers ", 'I'],
  ["Implementer reports done → spawn the reviewe", 'C'],
  ["At nomination, parallel with the review: orc", 'C'],
  ["Review verdict in and CI green → apply the m", 'C'],
  ["A review round with 0 BLOCKING, 0 MAJOR and ", 'C'],
  ["A MINOR that breaks a sentence of the ticket", 'R', 'r'],
  ["A finding with a demonstration (#572, minorP", 'R', 'r'],
  ["A dependent track waits for its upstream's M", 'C'],
];

const unitsOf = (text: string): string[] => {
  const out: string[] = []; let cur: string[] = [];
  const flush = () => { if (cur.length) out.push(cur.join('\n')); cur = []; };
  for (const line of text.split('\n')) { if (line.trim() === '') { flush(); continue; } if (/^(- |→ |#+ )/.test(line)) flush(); cur.push(line); }
  flush(); return out;
};
const norm = (u: string): string => u.replace(/^(- |→ |> )/, '').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
const classify = (unit: string): { marker: string; roles: string; how?: string } | null => {
  const n = norm(unit); let best: (typeof RULES)[number] | null = null;
  for (const r of RULES) if (n.startsWith(r[0]) && (!best || r[0].length > best[0].length)) best = r;
  return best ? { marker: best[0], roles: best[1], how: best[2] } : null;
};
const union = (renders: string[]): Set<string> => new Set(renders.flatMap(unitsOf));

interface Texts { coordinator: string[]; reviewer: string[]; implementer: string[]; masterOff: string[]; refsOff: string }
const realTexts = (): Texts => ({
  coordinator: COMBOS.map((c) => renderVerifiedFanoutSkill(asSw(c, 'on'))),
  reviewer: COMBOS.map((c) => renderFanoutReviewerSkill(asSw(c, 'on'))),
  implementer: COMBOS.map((c) => renderFanoutImplementerSkill(asSw(c, 'on'))),
  masterOff: COMBOS.map((c) => renderVerifiedFanoutSkill(asSw(c, 'off'))),
  refsOff: VERIFIED_FANOUT_V2_REFERENCES.map((f) => COMBOS.map((c) => renderSwitchBlocks(f.content, asSw(c, 'off'))).join('\n')).join('\n'),
});

/** The whole check, pure: every violation as one line. [] = the three texts hold their own rules and nothing else. */
function checkRoleTexts(t: Texts): string[] {
  const bad: string[] = [];
  const roleOf: Record<Role, string[]> = { C: t.coordinator, R: t.reviewer, I: t.implementer };
  const used = new Set<string>();
  const masterNorm = norm([...union(t.masterOff)].join('\n\n') + '\n\n' + t.refsOff);
  for (const role of ['C', 'R', 'I'] as Role[]) {
    for (const u of union(roleOf[role])) {
      const c = classify(u);
      if (!c) { bad.push(`${role}: unclassified rule — add it to RULES: ${JSON.stringify(norm(u).slice(0, 60))}`); continue; }
      used.add(c.marker);
      if (!c.roles.includes(role)) bad.push(`${role}: a rule of ${c.roles} sits in the ${({ C: 'coordinator', R: 'reviewer', I: 'implementer' })[role]} text: ${JSON.stringify(c.marker)}`);
      if (role !== 'C' && !c.how && !masterNorm.includes(norm(u))) bad.push(`${role}: "${c.marker}" is listed as moved but is not byte-equal to master's text`);
    }
  }
  for (const u of union(t.masterOff)) { // every rule of today's text is classified (the first job of the ticket)
    const c = classify(u);
    if (!c) bad.push(`master: unclassified rule of today's text: ${JSON.stringify(norm(u).slice(0, 60))}`); else used.add(c.marker);
  }
  for (const r of RULES) if (!used.has(r[0])) bad.push(`stale entry (matches no unit of any text): ${JSON.stringify(r[0])}`);
  // a moved rule left behind: the ON coordinator text must not contain the text of a rule that is not the coordinator's, nor a role file the coordinator's
  const coordNorm = norm(t.coordinator.join('\n'));
  const reviewerNorm = norm(t.reviewer.join('\n')); const implNorm = norm(t.implementer.join('\n'));
  for (const role of ['R', 'I'] as Role[]) for (const u of union(roleOf[role])) {
    const c = classify(u); if (!c || c.how || c.roles.includes('C') || /^#/.test(u)) continue; // a heading is not a rule
    if (coordNorm.includes(norm(u))) bad.push(`C: a ${role === 'R' ? 'reviewer' : 'implementer'}-only rule stays in the coordinator text: ${JSON.stringify(c.marker)}`);
  }
  for (const u of union(t.coordinator)) {
    const c = classify(u); if (!c || c.how || c.roles.includes('R') || u.length < 40) continue;
    if (reviewerNorm.includes(norm(u))) bad.push(`R: a coordinator rule is in the reviewer text: ${JSON.stringify(c.marker)}`);
    if (!c.roles.includes('I') && implNorm.includes(norm(u))) bad.push(`I: a coordinator rule is in the implementer text: ${JSON.stringify(c.marker)}`);
  }
  // each role file has its rules: every non-coordinator entry that is not 'n' appears in its roles' texts
  for (const r of RULES) for (const role of ['R', 'I'] as Role[]) {
    if (!r[1].includes(role) || r[2] === 'n' || r[2] === 'o') continue;
    if (!([...union(roleOf[role])].some((u) => classify(u)?.marker === r[0]))) bad.push(`${role}: the rule ${JSON.stringify(r[0])} is missing from its role text`);
  }
  return bad;
}

test('#590 on: the list classifies every rule — the coordinator text holds coordinator rules only, each role file its own, moved text byte-equal to master', () => {
  assert.deepEqual(checkRoleTexts(realTexts()), []);
});

test('#590 on: the list is a list of the rules, not of the texts — it has the three roles and the moved rules', () => {
  const by = (role: string) => RULES.filter((r) => r[1] === role).length;
  assert.ok(by('C') > 80, `coordinator entries: ${by('C')}`);
  assert.ok(RULES.filter((r) => r[1] === 'R').length >= 8 && by('I') >= 6 && by('RI') >= 4, 'reviewer / implementer / shared entries are present');
  assert.ok(RULES.filter((r) => !r[2] && !r[1].includes('C')).length >= 15, 'at least 15 rules were MOVED (not new, not coordinator) — the ticket moves text, it does not rewrite it');
});

// must-fail arms: each mutation of the real texts must be caught, by the clause it targets
const arm = (name: string, mutate: (t: Texts) => void, expect: RegExp) => test(`#590 must-fail arm — ${name}`, () => {
  const t = realTexts(); mutate(t);
  const bad = checkRoleTexts(t);
  assert.ok(bad.some((b) => expect.test(b)), `no violation matched ${expect}; got ${JSON.stringify(bad.slice(0, 4))}`);
});
const IMPL_RULE = "- **Mutation runs: FULL set at the first nomination and at the final merge gate; intermediate rounds mutate only the clauses the delta changed.**";
const REVIEWER_RULE = "- **MAJOR** — wrong behaviour on a real input, or a ticket promise not kept.";
const COORD_RULE = "- **Sent ≠ received.** Act on a counterparty's final state only after their\n  explicit echo; their stale status line tells you your answer never arrived.";
arm('an implementer-only rule left in the coordinator text', (t) => { t.coordinator = t.coordinator.map((x) => x + '\n\n' + IMPL_RULE); }, /implementer-only rule stays in the coordinator/);
arm('a reviewer-only rule left in the coordinator text', (t) => { t.coordinator = t.coordinator.map((x) => x + '\n\n' + REVIEWER_RULE); }, /reviewer-only rule stays in the coordinator/);
arm('the OFF coordinator text (nothing moved) used as the ON text', (t) => { t.coordinator = t.masterOff; }, /of (RI|R|I) sits in the coordinator text|stays in the coordinator/);
arm('a coordinator rule pasted into the reviewer text', (t) => { t.reviewer = t.reviewer.map((x) => x + '\n\n' + COORD_RULE); }, /R: a rule of C sits in the reviewer text/);
arm('a coordinator rule pasted into the implementer text', (t) => { t.implementer = t.implementer.map((x) => x + '\n\n' + COORD_RULE); }, /I: a rule of C sits in the implementer text/);
arm('an unclassified new rule added to the coordinator text', (t) => { t.coordinator = t.coordinator.map((x) => x + '\n\n- **A brand new rule nobody classified** — it must fail until it has a role.'); }, /unclassified rule/);
arm('a moved rule reworded in the reviewer text (not byte-equal to master)', (t) => { t.reviewer = t.reviewer.map((x) => x.replace('or a ticket promise not kept.', 'or a ticket promise kept.')); }, /not byte-equal to master/);
arm('a moved rule missing from the implementer text', (t) => { t.implementer = t.implementer.map((x) => x.replace(IMPL_RULE, '')); }, /missing from its role text|stale entry/);
arm('a stale list entry (its rule no longer exists anywhere)', (t) => { t.reviewer = t.reviewer.map((x) => x.replace(REVIEWER_RULE, '')); t.masterOff = t.masterOff.map((x) => x.replaceAll(REVIEWER_RULE, '')); t.refsOff = t.refsOff.replaceAll(REVIEWER_RULE, ''); }, /missing from its role text|stale entry/);

// ---------------------------------------------------------------- (3) the verbs ----------------------------------------------------------------------------------------------
const NEW_VERBS = ['--plan', '--plan-add', '--depends-on', '--interface', '--interface-reason', '--follows', '--run-decision', 'orchestra fanout review', 'orchestra fanout record'];
const REFUSED = [/--review-verdict/, /--no-review-gate/, /--finding-json/, /--settle/, /--finding(?![-\w])/];

test('#590 on: the coordinator text names the new verbs (plan / interface / follows / review / record / run-decision) and none of the refused ones — SKILL.md and every reference', () => {
  for (const c of COMBOS) {
    const skill = renderVerifiedFanoutSkill(asSw(c, 'on'));
    for (const v of NEW_VERBS) assert.ok(skill.includes(v), `SKILL.md (${comboKey(c)}) does not name ${v}`);
    for (const re of REFUSED) assert.ok(!re.test(skill), `SKILL.md (${comboKey(c)}) names the refused ${re}`);
    for (const f of VERIFIED_FANOUT_V2_REFERENCES) {
      const text = renderSwitchBlocks(f.content, asSw(c, 'on'));
      for (const re of REFUSED) assert.ok(!re.test(text), `${f.path} (${comboKey(c)}) names the refused ${re}`);
    }
  }
});

test('#590 on: the role files name no refused verb either, and the reviewer\'s names its record verb + path, the implementer\'s its self-gate', () => {
  for (const c of COMBOS) for (const text of [renderFanoutReviewerSkill(asSw(c, 'on')), renderFanoutImplementerSkill(asSw(c, 'on'))]) for (const re of REFUSED) assert.ok(!re.test(text), `a role file names the refused ${re} (${comboKey(c)})`);
  assert.match(renderFanoutReviewerSkill(), /orchestra fanout record <ticket> --head <sha> --verdict approve\|changes-requested --json/);
  assert.match(renderFanoutImplementerSkill(), /self-gate/);
});

test('#590 on: the must-fail check of the verbs — the OFF text (which names --review-verdict) fails the refused-verb clause, a text without the new verbs fails the named-verb clause', () => {
  const off = renderVerifiedFanoutSkill(asSw({}, 'off'));
  assert.ok(REFUSED.some((re) => re.test(off)), 'the OFF text names refused verbs, so the clause can fail');
  assert.ok(NEW_VERBS.some((v) => !off.includes(v)), 'the OFF text lacks the new verbs, so the clause can fail');
});

test('#590 on: the coordinator\'s spawn rule names the implementer file, §3b names the reviewer file, and both paths are the ones the installer writes', () => {
  const on = renderVerifiedFanoutSkill(asSw({}, 'on'));
  assert.ok(on.includes(FANOUT_IMPLEMENTER_SKILL_PATH) && on.includes(FANOUT_REVIEWER_SKILL_PATH));
  assert.deepEqual(FANOUT_ROLE_FILES.map((r) => r.worktreePath).sort(), [FANOUT_IMPLEMENTER_SKILL_PATH, FANOUT_REVIEWER_SKILL_PATH].sort());
  assert.ok(!renderVerifiedFanoutSkill(asSw({}, 'off')).includes('roles/implementer.md'), 'OFF names no role file');
});

// ---------------------------------------------------------------- (4) the installer + the brief -----------------------------------------------------------------------------
test('#590 installer: seatRecords=on writes .orchestra/roles/reviewer.md + implementer.md (rendered by the run\'s switches); off writes none and removes an earlier install\'s copies', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fanout-roles-'));
  try {
    const sw = { minorPolicy: 'demonstrated', verifier: 'off', seatRecords: 'on' } as Partial<Switches>;
    assert.equal(await installFanoutRoleFiles(dir, undefined, sw), 'written');
    for (const r of FANOUT_ROLE_FILES) assert.equal(await readFile(path.join(dir, r.worktreePath), 'utf8'), r.render(sw), `${r.worktreePath} is the rendered role text`);
    assert.match(await readFile(path.join(dir, FANOUT_REVIEWER_SKILL_PATH), 'utf8'), /A finding with a demonstration/, 'the reviewer file follows minorPolicy');
    assert.equal(await installFanoutRoleFiles(dir, undefined, { ...sw, seatRecords: 'off' }), 'removed');
    for (const r of FANOUT_ROLE_FILES) await assert.rejects(stat(path.join(dir, r.worktreePath)), /ENOENT/, `${r.worktreePath} removed under off`);
    assert.equal(await installFanoutRoleFiles(dir, undefined, {}), 'removed');
    for (const r of FANOUT_ROLE_FILES) await assert.rejects(stat(path.join(dir, r.worktreePath)), /ENOENT/, `${r.worktreePath} never written by the default`);
    assert.equal(fanoutRoleFilesWanted({}), false); assert.equal(fanoutRoleFilesWanted({ seatRecords: 'on' }), true);
    assert.match(FANOUT_REVIEWER_SKILL_PATH, /^\.orchestra\//, 'in Orchestra\'s own dir');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#590 installer: a repo\'s OWN verified-fanout skill is kept AND the role files still land (they live in .orchestra/, not in the skill dir)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fanout-roles-foreign-'));
  try {
    const skills = path.join(dir, '.claude', 'skills');
    await mkdir(path.join(skills, 'verified-fanout'), { recursive: true });
    await writeFile(path.join(skills, 'verified-fanout', 'SKILL.md'), '# the repo\'s own skill\n');
    const sw = { seatRecords: 'on' } as Partial<Switches>;
    assert.equal(await installVerifiedFanoutSkill(skills, undefined, sw), 'skipped-foreign');
    assert.equal(await installFanoutRoleFiles(dir, undefined, sw), 'written');
    assert.equal(await readFile(path.join(skills, 'verified-fanout', 'SKILL.md'), 'utf8'), '# the repo\'s own skill\n', 'the repo\'s skill is untouched');
    for (const r of FANOUT_ROLE_FILES) assert.ok((await stat(path.join(dir, r.worktreePath))).isFile());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#590 installer: an fs error is reported, never thrown (the hook install it sits in must go on)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fanout-roles-err-'));
  try {
    await writeFile(path.join(dir, '.orchestra'), 'a file where the dir should be');
    const seen: unknown[] = [];
    assert.equal(await installFanoutRoleFiles(dir, (e) => seen.push(e), { seatRecords: 'on' } as Partial<Switches>), 'skipped-error');
    assert.equal(seen.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#590 the reviewer\'s brief carries the role file path (I5) — by default, and the path is one the installer writes; the pointer replaced the inline rules', () => {
  const state = { run: 'r1', target: 'master', switches: { seatRecords: 'on' }, tickets: { T1: { id: 'T1', dependsOn: [], builtOn: {}, builtOnTree: {}, follows: {}, findings: {}, spec: null, specText: 't', branch: 'b1', pr: null, head: 'a'.repeat(40) } }, decisions: [] } as unknown as Parameters<typeof briefInputOf>[0];
  const input = briefInputOf(state, 'T1', { kind: 'spawn', head: 'a'.repeat(40), base: 'b'.repeat(40) });
  const withPath = renderReviewerBrief(input);
  assert.ok(withPath.includes(`Your role file: ${FANOUT_REVIEWER_SKILL_PATH}`) && withPath.includes(REVIEWER_RULES));
  assert.ok(FANOUT_ROLE_FILES.some((r) => r.worktreePath === FANOUT_REVIEWER_SKILL_PATH), 'the named path is a written file');
  assert.ok(!renderReviewerBrief({ ...input, reviewerSkillPath: null }).includes('Your role file'), 'no path ⇒ no pointer line (the field is optional in the pure renderer)');
  assert.ok(!REVIEWER_RULES.includes('BLOCKING = must not merge'), 'the severity scale is no longer duplicated in the brief — one text per role');
  assert.equal(briefInputOf(state, 'T1', { kind: 'spawn', head: 'a'.repeat(40), base: null }).reviewerSkillPath, FANOUT_REVIEWER_SKILL_PATH, 'the production input names the file without the host passing it');
});

test('#590 installer wiring: the role templates are in the HOOKS_VERSION hash (an edit reinstalls) — and the check fails on a hash without them', () => {
  const w = readFileSync(new URL('../main/workspaces.ts', import.meta.url), 'utf8');
  const hash = w.slice(w.indexOf('const HOOKS_VERSION'), w.indexOf('.digest('));
  assert.ok(hash.length > 500, 'the hash source was found');
  assert.match(w, /installFanoutRoleFiles\(worktreePath, \(e\) => log\.warn\([^)]*\), fanoutSwitches\)/, 'installOrchestraHooks installs the role files for the run\'s switches');
  for (const name of ['FANOUT_REVIEWER_SKILL_TEMPLATE', 'FANOUT_IMPLEMENTER_SKILL_TEMPLATE']) {
    assert.ok(hash.includes(name), `${name} is hashed`);
    assert.ok(!hash.replaceAll(name, 'X').includes(name), 'the mutated hash source (name removed) fails the same check');
  }
});

// every `orchestra fanout …` span of the ON text names a verb and flags the CLI knows: the main usage + the seatRecords usage (#587) + the review usage (#588) + `fanout record` once #589 lands
test('#590 on: every `orchestra fanout state set …` / `fanout review` flag of the ON coordinator text is a flag of the CLI (main usage ∪ seat usage ∪ review usage); a made-up flag is caught', () => {
  const known = new Set([...[helpOf('fanout'), SEAT_USAGE, REVIEW_USAGE, RECORD_USAGE].join('\n').matchAll(/(?<![\w-])(--[a-z][a-z-]*)(?![\w-])/g)].map((m) => m[1]));
  const spans = (text: string): string[] => [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\s+/g, ' ').trim()).filter((x) => /^orchestra fanout (state set|review|record|deliver)\b/.test(x));
  const lint = (text: string): string[] => spans(text).flatMap((sp) => sp.split(' ').flatMap((tk) => { const f = /^(--[a-z][a-z-]*)/.exec(tk)?.[1]; return f && !known.has(f) ? [`${f} in: ${sp}`] : []; }));
  for (const c of COMBOS) assert.deepEqual(lint(renderVerifiedFanoutSkill(asSw(c, 'on'))), [], `ON text at ${comboKey(c)}`);
  assert.ok(spans(renderVerifiedFanoutSkill(asSw({}, 'on'))).length >= 4, 'the extractor found the spans');
  assert.deepEqual(lint('`orchestra fanout state set --made-up-flag x`'), ['--made-up-flag in: orchestra fanout state set --made-up-flag x'], 'a made-up flag is caught');
});

// F1 (review r1): the references the coordinator reads are coordinator text too — no implementer-only / reviewer-only rule of them stays under ON
const REF_ROLE_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['Every report, verdict and blocking question lands as a LEDGER COMMENT', 'implementer+reviewer'], ['Fixed report format, ≤15 lines', 'implementer+reviewer'], ['One ping per event', 'implementer+reviewer'],
  ['in the first round AND every fix round, is the typecheck', 'implementer'], ['Self-gate BEFORE nominating', 'implementer'], ['Then a fresh-context PRE-REVIEW', 'implementer'],
  ['**Rebase onto current master BEFORE nominating**', 'implementer'], ['Mutation runs: FULL set', 'implementer'], ['do NOT add cases at the layer you already test', 'implementer'],
  ['**Severity scale (the §4 merge rule keys on it):**', 'reviewer'], ['It: it reads the diff, the ledger spec, and', 'reviewer'], ['A MINOR that breaks a sentence of the ticket', 'reviewer'],
  ['A finding with a demonstration (#572', 'reviewer'], ["**Done when:** the reviewer's comment is on the ledger", 'reviewer'],
];
const refViolations = (renderRef: (c: Record<string, string>) => string): string[] => {
  const bad: string[] = [];
  for (const c of COMBOS) { const t = renderRef(c).replace(/\s+/g, ' '); for (const [m, who] of REF_ROLE_MARKERS) if (t.includes(m.replace(/\s+/g, ' '))) bad.push(`a ${who}-only rule stays in a coordinator reference at ${comboKey(c)}: ${m}`); }
  return bad;
};
const allRefs = (sw: (c: Record<string, string>) => Partial<Switches>) => (c: Record<string, string>): string => VERIFIED_FANOUT_V2_REFERENCES.map((f) => (f.path.endsWith('.md') ? renderSwitchBlocks(f.content, sw(c)) : '')).join('\n');

test('#590 on (review F1): no implementer-only or reviewer-only rule stays in the references the coordinator reads — and the check fails on the OFF render, where they all are', () => {
  assert.deepEqual(refViolations(allRefs((c) => asSw(c, 'on'))), []);
  const off = new Set(COMBOS.flatMap((c) => refViolations(allRefs((x) => asSw(x, 'off'))).filter((v) => v.includes(comboKey(c)))).map((v) => v.split(': ').slice(1).join(': ')));
  for (const [m] of REF_ROLE_MARKERS) assert.ok(off.has(m), `the marker ${JSON.stringify(m)} is present in some OFF render (a stale marker would pass vacuously)`);
});

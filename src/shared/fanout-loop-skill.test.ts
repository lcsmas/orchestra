// #609 (vague #601, ledger #613) — the skill's Boucle section. Criteria, each with a must-FAIL arm:
//   (1) the section lives under `seatRecords=on` ONLY: every render of the switch matrix with the switch off/absent is byte-identical to master's (sha256 oracle, the #590 snapshot) — and the pin catches a leak;
//   (2) the ON text names the frozen verbs, flags, exit codes and park causes of ledger #613 (FROZEN NAMES v1), and every `orchestra …` it names is in the help (`fanout loop-help` ∪ the CLI help);
//   (3) it carries no order to wait, and stays inside the word budget; (4) `orchestra fanout loop-help` prints the usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderVerifiedFanoutSkill, VERIFIED_FANOUT_SKILL_TEMPLATE } from './verified-fanout-skill.ts';
import { renderSwitchBlocks } from './fanout-switch-render.ts';
import type { Switches } from './fanout-state.ts';
import { LOOP_USAGE } from '../cli/fanout-loop-help.ts';
import { runFanout, SEAT_USAGE } from '../cli/fanout-state.ts';
import { COMMANDS } from '../cli/help.ts';

/** FROZEN NAMES v1 (ledger #613, #603's `PARK_CAUSES`): kept here so this test builds before #603 merges; import it from fanout-state.ts once it exports it. */
const PARK_CAUSES = ['question', 'situation', 'ci', 'upstream'] as const;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const SNAP = JSON.parse(readFileSync(new URL('./fixtures/seat-records-off-snapshot.json', import.meta.url), 'utf8')) as Record<string, { skill: string }>;
const AXES: Record<string, string[]> = { earlyGate: ['on', 'off'], acceptance: ['on', 'off'], minorPolicy: ['legacy', 'refuse', 'spec', 'demonstrated'], verifier: ['on', 'off'], preNominationChecks: ['on', 'off'] };
const COMBOS: Array<Record<string, string>> = [{}];
for (const [k, vs] of Object.entries(AXES)) { const next: Array<Record<string, string>> = []; for (const c of COMBOS) for (const v of vs) next.push({ ...c, [k]: v }); COMBOS.length = 0; COMBOS.push(...next); }
const key = (c: Record<string, string>) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ');
const sw = (c: Record<string, string>, seat?: 'on' | 'off'): Partial<Switches> => (seat ? { ...c, seatRecords: seat } : c) as Partial<Switches>;
const SECTION_START = '## The Boucle: `orchestra fanout run` leads the vague (#601)';
/** The Boucle section of a render: from its heading to the next `## ` heading. */
const sectionOf = (text: string): string => { const i = text.indexOf(SECTION_START); if (i < 0) return ''; const j = text.indexOf('\n## ', i + 5); return text.slice(i, j < 0 ? undefined : j); };

// ---- (1) off is byte-identical; the pin can fail ---------------------------------------------------------------------------------
test('#609 off: with seatRecords absent or off, every render of the 64-point matrix is byte-identical to master and holds no word of the Boucle section', () => {
  for (const c of COMBOS) for (const seat of [undefined, 'off'] as const) {
    const text = renderVerifiedFanoutSkill(sw(c, seat));
    assert.equal(sha(text), SNAP[key(c)].skill, `render differs from master at ${key(c)} seatRecords=${seat ?? 'absent'}`);
    assert.ok(!text.includes('fanout run') && !text.includes('Boucle'), `Boucle text leaked into the off render at ${key(c)}`);
  }
  assert.equal(sha(renderVerifiedFanoutSkill()), SNAP['(default)'].skill, 'the bare default render');
});

test('#609 off (must-FAIL arm): a section whose switch is widened to on|off, or dropped, breaks the pin', () => {
  const leaky = VERIFIED_FANOUT_SKILL_TEMPLATE.replace('<!--sw seatRecords=on-->\n## The Boucle', '<!--sw seatRecords=on|off-->\n## The Boucle');
  assert.notEqual(leaky, VERIFIED_FANOUT_SKILL_TEMPLATE, 'the mutation applied');
  assert.notEqual(sha(renderSwitchBlocks(leaky, sw(COMBOS[0], 'off'))), SNAP[key(COMBOS[0])].skill, 'a section shown with the switch off is caught by the oracle');
  assert.notEqual(sha(renderSwitchBlocks(leaky, sw(COMBOS[0], 'off'))), sha(renderVerifiedFanoutSkill(sw(COMBOS[0], 'off'))));
  // and the off render of the real template is NOT what the ON render is (the switch does something)
  assert.notEqual(sha(renderVerifiedFanoutSkill(sw(COMBOS[0], 'on'))), SNAP[key(COMBOS[0])].skill);
});

// ---- (2) the ON text: frozen names, help --------------------------------------------------------------------------------------------
const ON = (c: Record<string, string> = {}) => sectionOf(renderVerifiedFanoutSkill(sw(c, 'on')));

test('#609 on: every switch combination renders the section, with the three steps and the frozen names of ledger #613', () => {
  for (const c of COMBOS) {
    const s = ON(c);
    assert.ok(s.length > 800, `section present at ${key(c)}`);
    for (const frozen of ['orchestra fanout run --tickets', '--plan <plan.json>', '--start-check', 'plan-refused-twice', 'decision-after-plan', 'explo-plan-<run8>', 'orchestra spawn --no-agent --name ops-<object> --run-command "orchestra fanout run …"', 'orchestra fanout state set <ticket> --unpark', 'irreversible: <what>']) {
      assert.ok(s.includes(frozen), `${frozen} missing at ${key(c)}`);
    }
    for (const cause of PARK_CAUSES) assert.ok(s.includes(`\`${cause}\``), `park cause ${cause} named`);
    for (const step of ['**Prepare**', '**Launch**', '**Read the report**']) assert.ok(s.includes(step), step);
  }
});

test('#609 on: the exit codes of the text are the frozen ones and the help says the same (0 merged · 3 parked · 4 paused · 2 refused · 1 could not run)', () => {
  const s = ON().replace(/\*\*/g, '');
  for (const [code, word] of [['0', 'every ticket merged'], ['3', 'parked'], ['4', 'paused'], ['2', 'refused'], ['1', 'could not run']] as const) {
    assert.match(s, new RegExp(`exit ${code}[^·]*?${word}|· ${code} [^·]*?${word}`), `exit ${code} (${word}) in the skill`);
  }
  assert.match(LOOP_USAGE, /Exit 0 every ticket merged · 3 the run ended with ≥1 parked ticket · 4 paused \(lift it with `orchestra fanout state set --run <id> --resume-run`, then run again\) · 2 refused \(\[run-…\]\) · 1 could not run/);
  // must-fail: swapping two codes in the text breaks the match
  const swapped = s.replace('3 ≥1 parked', '4 ≥1 parked');
  assert.doesNotMatch(swapped, /· 3 [^·]*?parked/);
});

/** Spans `orchestra …` of the section (inline code), whitespace collapsed. */
const spans = (text: string): string[] => [...text.matchAll(/`((?:orchestra|--)[^`]+)`/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
const HELP = [LOOP_USAGE, SEAT_USAGE, ...COMMANDS.filter((c) => c.name === 'fanout').map((c) => `${c.summary}\n${c.detail}`)].join('\n');
const KNOWN_FLAGS = new Set([...HELP.matchAll(/(?<![\w-])(--[a-z][a-z-]*)(?![\w-])/g)].map((m) => m[1]));
/** #612's verb (not in this branch's CLI yet): its frozen spelling, kept here so the skill cannot drift from the ledger while the help is elsewhere. */
const FROZEN_612 = 'orchestra spawn --no-agent --name ops-<object> --run-command "orchestra fanout run …"';
const lint = (text: string): string[] => spans(text).flatMap((sp) => {
  if (sp === FROZEN_612) return [];
  const p: string[] = [];
  if (sp.startsWith('--')) { const f = /^--[a-z][a-z-]*/.exec(sp)![0]; return KNOWN_FLAGS.has(f) ? [] : [`${f} is not a flag of the help (in: ${sp})`]; } // a bare flag span (`--plan <plan.json>`)
  const m = /^orchestra fanout (run|plan|loop-help|state set)\b/.exec(sp);
  if (!m) { p.push(`not a frozen Boucle verb: ${sp}`); return p; }
  if (!HELP.includes(`orchestra fanout ${m[1]}`)) p.push(`verb absent from the help: ${sp}`);
  for (const tk of sp.split(' ')) { const f = /^(--[a-z][a-z-]*)/.exec(tk)?.[1]; if (f && !KNOWN_FLAGS.has(f)) p.push(`${f} is not a flag of the help (in: ${sp})`); }
  return p;
});

test('#609 on: every `orchestra …` the section names is in the help (loop-help ∪ fanout help), flags included — and a made-up flag / verb is caught', () => {
  for (const c of COMBOS) assert.deepEqual(lint(ON(c)), [], `section at ${key(c)}`);
  assert.ok(spans(ON()).length >= 8, 'the extractor found the spans');
  assert.deepEqual(lint('`orchestra fanout run --no-such-flag`'), ['--no-such-flag is not a flag of the help (in: orchestra fanout run --no-such-flag)']);
  assert.deepEqual(lint('`--no-such-flag x`'), ['--no-such-flag is not a flag of the help (in: --no-such-flag x)'], 'a bare made-up flag span is caught');
  assert.deepEqual(lint('`orchestra fanout frobnicate`'), ['not a frozen Boucle verb: orchestra fanout frobnicate']);
  assert.ok(lint(`\`${FROZEN_612.replace('--no-agent', '--no-agnt')}\``).length > 0, 'a misspelt #612 verb is caught');
});

test('#609 help: `orchestra fanout loop-help` prints the usage (exit 0), names the frozen verbs, and the main fanout usage is untouched', () => {
  const r = runFanout(['loop-help'], { env: {}, cwd: '/', runner: (() => ({ code: 1, stdout: '', stderr: '' })) as never, now: () => '', readStdin: () => '' } as never);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${LOOP_USAGE}\n`);
  for (const name of ['orchestra fanout run', 'orchestra fanout plan --tickets', 'orchestra fanout plan submit', '--park <cause> --park-reason', '--unpark', '--pause <reason> [--pause-check <name>]', '--run <id> --resume-run', 'plan-refused-twice', 'irreversible']) assert.ok(LOOP_USAGE.includes(name), name);
  for (const cause of PARK_CAUSES) assert.ok(LOOP_USAGE.includes(cause), `cause ${cause}`);
  assert.ok(ON().includes('--resume-run'), 'the skill says how a pause is lifted (the real `fanout run` help: state set --run <id> --resume-run)');
  const main = COMMANDS.find((c) => c.name === 'fanout')!;
  assert.ok(!main.detail.includes('The Boucle'), 'the main `help fanout` detail is byte-identical (the Boucle has its own help, like seat-help)');
});

// ---- (3) no order to wait; the budget -------------------------------------------------------------------------------------------
test('#609 on: the section carries no order to wait, and names a decision only to say it is refused', () => {
  const s = ON();
  assert.doesNotMatch(s, /wait (for|until|on) (the |its |every )?(upstream|merge|candidate)/i);
  assert.doesNotMatch(s, /write code only after/i);
  assert.match(s, /`--run-decision` after the plan is refused/);
  assert.match(s, /every implementer starts at once on frozen names/);
});

test('#609 on: the loop-profile render (seatRecords=on verifier=off minorPolicy=demonstrated) stays under the 4,000-word always-read budget', () => {
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  // master's own ON text was already 4,021 words with every feature on (the #474 budget is pinned on the off render): the loop's profile — the one `fanout run` inits — must stay under it WITH the section
  const loop = renderVerifiedFanoutSkill({ seatRecords: 'on', verifier: 'off', minorPolicy: 'demonstrated' });
  assert.ok(words(loop) < 4000, `${words(loop)} words in the loop profile`);
  assert.ok(words(sectionOf(loop)) < 360, `the section alone is ${words(sectionOf(loop))} words`);
});

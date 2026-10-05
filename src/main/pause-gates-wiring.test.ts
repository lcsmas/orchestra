import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// #252 fleet PAUSE — the sites the rig (pause-gates.test.ts) cannot LOAD (Electron-bound api-handlers.ts / index.ts), pinned by source
// position, plus the ENUMERATION guard for HUMAN origins. Each arm is what an in-place mutant of that clause reddens (ledger #261).
// Source-shape guards are weaker than the rig: the behavioural proof for every other row is in pause-gates.test.ts.

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', 'main', f), 'utf8');
const API = read('api-handlers.ts');
const INDEX = read('index.ts');
const ROSTER = read('wake-roster.ts');
const body = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `anchor missing: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b > a, `end anchor missing: ${end}`);
  return src.slice(a, b);
};

test('row 11 pty:start: the handler hands the brief to the REAL scheduler (gated at fire time, driven by the `pty_brief` rig arm) and the scheduler gates before it writes', () => {
  const b = body(API, 'ptyStart: async (id, cols, rows) =>', 'ptyWrite: async');
  assert.match(body(b, 'if (!resuming && ws.lastTask)', '\n  },'), /scheduleOpeningBrief\(id, ws\.lastTask, writePty\)/);
  assert.doesNotMatch(b, /writePty\(/, 'the handler never calls the pty writer itself — `writePty` appears ONLY as the scheduler\'s argument (an extra ungated write must redden this)');
  assert.doesNotMatch(body(b, 'const resuming', 'if (!resuming && ws.lastTask)'), /pauseRefusal/, 'opening the terminal itself (HUMAN) is not gated');
  const sched = read('opening-brief-pty.ts');
  assert.match(sched, /delayMs: number = OPENING_BRIEF_DELAY_MS,/, 'the default parameter IS the constant (it cannot drift from the pinned 1200)');
  assert.match(sched, /export const OPENING_BRIEF_DELAY_MS = 1200;/, 'the TUI-init delay is pinned (the rig\'s default-delay check measures it)');
  assert.ok(sched.indexOf("pauseRefusalById(id, 'auto')") >= 0 && sched.indexOf("pauseRefusalById(id, 'auto')") < sched.indexOf("write(id, task + '\\n')"), 'gate precedes the write');
});

test('row 1 composer: the human prompt carries origin human to the sdkSend gate', () => {
  assert.match(body(API, 'agentSdkSend: async', 'agentSdkRunBash'), /sdkSend\(wsId, text, images, undefined, undefined, false, false, 'human'\)/);
});

test('rows 22/28: inbox tray release, Fix checks and Send review are HUMAN clicks (origin human reaches the gates)', () => {
  assert.match(API, /releaseInboxMessage: \(id, text\) => releaseInboxBlock\(id, text, 'human'\)/);
  assert.match(API, /releaseAllInboxBlocks\(id, 'human'\)/);
  assert.equal([...API.matchAll(/wakeAgentWithPrompt\(id, prompt, \{ origin: 'human' \}\)/g)].length, 2, 'fixChecks + sendReviewToAgent');
});

test('row 14 wiring: the boot roster is the REAL wakeRosterEntry, whose wakeable clause carries the pause refusal', () => {
  assert.match(INDEX, /setWakeRoster\(\(\) => store\.workspaces\.map\(wakeRosterEntry\)\);/);
  assert.match(ROSTER, /pauseRefusal\(ws, 'auto'\) === null &&/);
});

test('ENUMERATION: the ONLY sites that pass origin `human` are the composer, tray, Send now, Fix checks, Send review and the toolbar Restart — a new one is a new pause bypass', () => {
  const dir = path.join(process.cwd(), 'src', 'main');
  const found: Record<string, number> = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    // strip comments so prose about 'human' cannot count
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
    const n = [...src.matchAll(/'human'/g)].length;
    if (n > 0) found[f] = n;
  }
  assert.deepEqual(found, {
    'agent-sdk.ts': 1,          // the `origin === 'human'` tag that feeds the drain gate
    'api-handlers.ts': 5,       // composer + tray release + release-all + Fix checks + Send review
    'bus-pause.ts': 1,          // pauseRefusalWith: a human origin is never refused
    'prompt-queue.ts': 1,       // "Send now" (force)
    'restart-workspace.ts': 1,  // trigger 'toolbar' → human
  });
});

/** Every place a source file PASSES, READS or DECLARES a property named `human` — by AST (so `{human:true}`, `{ human }`, `{ "human": true }`, `opts.human`, `opts['human']`, `const { human } = opts` all count, and a `*\/` inside a string cannot swallow code). */
function humanOptionSites(source: string): { passes: number; reads: number; declares: number } {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const out = { passes: 0, reads: 0, declares: 0 };
  const named = (n: ts.PropertyName | undefined): boolean => !!n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === 'human';
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && named(n.name)) out.passes++;
    else if (ts.isShorthandPropertyAssignment(n) && n.name.text === 'human') out.passes++;
    else if (ts.isPropertyAccessExpression(n) && n.name.text === 'human') out.reads++;
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'human') out.reads++;
    else if (ts.isBindingElement(n) && ((n.propertyName && named(n.propertyName)) || (!n.propertyName && ts.isIdentifier(n.name) && n.name.text === 'human'))) out.reads++;
    else if (ts.isPropertySignature(n) && named(n.name)) out.declares++;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('ENUMERATION (extends the guard above to the human ACTOR, D-pick Q1): the ONLY site that PASSES the writers\' `human` option is src/main/pause-ui.ts; only the four coordinator-rule writers READ it — by AST, spelling-proof; the CLI deps are TYPED without it', () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
  const passes: Record<string, number> = {};
  const reads: Record<string, number> = {};
  const declares: Record<string, number> = {};
  for (const f of walk(path.join(process.cwd(), 'src'))) {
    const s = humanOptionSites(fs.readFileSync(f, 'utf8'));
    const rel = path.relative(process.cwd(), f);
    if (s.passes) passes[rel] = s.passes;
    if (s.reads) reads[rel] = s.reads;
    if (s.declares) declares[rel] = s.declares;
  }
  assert.deepEqual(passes, { 'src/main/pause-ui.ts': 4 }, 'setRunPause, beginReprise, setRunHold, releaseMembers — all in uiPause / uiResume / uiRelease');
  assert.deepEqual(reads, { 'src/main/bus-pause.ts': 1, 'src/main/bus-runs.ts': 1, 'src/main/pause-reprise.ts': 3 }, 'setRunPause, setRunHold, beginRepriseCore (+ who releases the coordinators), releaseMembers');
  assert.deepEqual(declares, { 'src/main/bus-pause.ts': 1, 'src/main/bus-runs.ts': 1, 'src/main/pause-reprise.ts': 2, 'src/shared/pause-lifecycle.ts': 1 }, 'where the option is DECLARED (the writers\' opts types + RepriseEntry)');
  // the CLI verbs take the Reprise seam WITHOUT `human`: a verb that tried to pass it would not typecheck
  const cli = fs.readFileSync(path.join(process.cwd(), 'src', 'cli', 'bus-verbs.ts'), 'utf8');
  assert.ok(/export type CliRepriseEntry = [^;]*Omit<NonNullable<Parameters<RepriseEntry>\[3\]>, 'human'>/.test(cli) && /beginReprise\?: CliRepriseEntry;/.test(cli), 'RunPauseDeps.beginReprise is CliRepriseEntry (RepriseEntry minus `human`)');
  assert.ok(!/beginReprise\?: RepriseEntry/.test(cli));
  // the scanner itself: every spelling an evasion could use is seen (and prose / strings are not)
  const probe = (code: string) => humanOptionSites(code);
  assert.equal(probe('f({human:true})').passes, 1);
  assert.equal(probe('const human = go(); f({ human })').passes, 1);
  assert.equal(probe('f({ "human": true })').passes, 1);
  assert.equal(probe('f({ [`x`]: 1, human: flag })').passes, 1);
  assert.equal(probe('o?.human').reads, 1);
  assert.equal(probe('o.human').reads, 1);
  assert.equal(probe("o['human']").reads, 1);
  assert.equal(probe('const { human } = o;').reads, 1);
  assert.equal(probe('const { human: h } = o;').reads, 1);
  assert.equal(probe('type T = { human?: boolean }').declares, 1);
  assert.deepEqual(probe("const s = '/* human: true */'; // human: true\nconst t = \"*/\"; f({ human: true })"), { passes: 1, reads: 0, declares: 0 }, 'a comment / string mentioning it is not a site; a `*/` inside a string does not hide the real one');
});

test('docs: the orchestra-comms skill SOURCE (COMMS_SKILL) documents the verbs, the refusal text and the human-prompt policy', () => {
  const src = read('workspaces.ts');
  const skill = body(src, 'const COMMS_SKILL = `', 'const WORKSPACE_ADMIN_SKILL').replace(/\\`/g, '`'); // un-escape the template literal's \\`
  assert.match(skill, /orchestra run pause \[--hard\] \[--run <id>\]/);
  assert.match(skill, /orchestra run confirm pause \[--run <id>\]/);
  assert.match(skill, /\*\*Pause douce\*\*/);
  assert.match(skill, /orchestra run resume \[--run <id>\]/);
  assert.match(skill, /run en pause — orchestra run resume --run <id>/);
  assert.match(skill, /A prompt a HUMAN types in a member's composer is still allowed and does NOT\s*\nlift the pause/);
  assert.match(skill, /`pause`\s*\nswitch ON at wave start \(frozen; default OFF\)/);
});

test('docs: `orchestra --help` lists run as hold / pause / resume', () => {
  const help = fs.readFileSync(path.join(process.cwd(), 'src', 'cli', 'help.ts'), 'utf8');
  assert.match(help, /summary: "Admin: re-freeze a mission run's switches; hold \/ pause \/ resume a run"/);
});

test('F5 → #255 (wave E): the texts describe the SHIPPED behaviour — `resume` starts a STRUCTURED Reprise (coordinators first, workers blocked until released); the plain lift of a stale pause still says only what really resumes', () => {
  const src = read('workspaces.ts');
  const skill = body(src, 'const COMMS_SKILL = `', 'const WORKSPACE_ADMIN_SKILL').replace(/\\`/g, '`');
  const sect = skill.slice(skill.indexOf('## 7. Pause a run'));
  const help = fs.readFileSync(path.join(process.cwd(), 'src', 'cli', 'help.ts'), 'utf8');
  const runHelp = body(help, "name: 'run',", "name: 'message'");
  const verbs = fs.readFileSync(path.join(process.cwd(), 'src', 'cli', 'bus-verbs.ts'), 'utf8');
  // The PLAIN lift (the legacy path: a stale pause column on a switch-OFF run, or deps without beginReprise) promises none of the host-trap behaviour.
  const plain = [...verbs.matchAll(/pause LIFTED — réveils, turns and spawns are allowed again\./g)].map((m) => verbs.slice(m.index, m.index! + 220));
  assert.ok(plain.length >= 2, 'both plain-lift texts exist');
  for (const t of plain) {
    assert.doesNotMatch(t, /Bilan|snapshot|interrupts the turn|kills tool|Nothing restarts on its own/i, 'plain lift output promises behaviour it does not have');
    assert.match(t, /Queued turns and pending bus mail resume now/);
  }
  // Skill §7 and run --help describe the Pause trap AND the structured Reprise (#255 ships them in this tree).
  assert.match(sect, /refs\/orchestra\/pause\/<run>\/<ws>\/<ts>/, 'skill §7 names the pause ref D1b ships');
  assert.match(sect, /orchestra run status/, 'skill §7 documents the Bilan reader');
  assert.match(runHelp, /Bilan de pause/, 'run --help documents the Bilan');
  assert.match(sect, /releases ONLY the coordinators/, 'skill §7 says who resume wakes');
  assert.match(sect, /orchestra run release <ws>/);
  assert.match(runHelp, /Nothing restarts on its own: the host releases ONLY the coordinators/, 'run --help says the same');
  assert.match(runHelp, /Every worker stays BLOCKED/);
});

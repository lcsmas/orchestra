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
function humanOptionSites(source: string, fileName = 'x.ts'): { passes: number; reads: number; declares: number } {
  // parsed AS WHAT THE FILE IS: a `.ts` as TSX would read `<any>{ human: true }` / a generic arrow as JSX and miss the site (review m1)
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
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

test('ENUMERATION (extends the guard above to the human ACTOR, D-pick Q1): no `human` property is PASSED anywhere but src/main/pause-ui.ts (by AST — every LITERAL spelling, each file parsed as its own kind); a RELAYED object (spread / variable) is stopped by the two pins below (every call site of the four writers by arity + argument kinds, and the single importer of the UI entry points) and, for `bus-verbs.ts`, by its deps being TYPED without the option', () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
  const passes: Record<string, number> = {};
  const reads: Record<string, number> = {};
  const declares: Record<string, number> = {};
  for (const f of walk(path.join(process.cwd(), 'src'))) {
    const s = humanOptionSites(fs.readFileSync(f, 'utf8'), f);
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
  // …and the other three `bus-verbs.ts` writer deps take NO options parameter at all: a relayed `{ ...opts }` is a type error THERE (only there — the pins below cover every other file)
  assert.ok(cli.includes('setRunPause: (db: BusDb, runId: string, pause: boolean, actor: string | null, mode?: PauseMode) => RunPauseOutcome;'), 'RunPauseDeps.setRunPause has no options parameter');
  assert.ok(cli.includes('setRunHold: (db: BusDb, runId: string, hold: boolean, actor: string | null) => RunHoldOutcome;'), 'RunHoldDeps.setRunHold has no options parameter');
  assert.ok(cli.includes("releaseMembers?: (db: BusDb, carrierRunId: string, actor: string, targets: readonly string[] | 'all') => ReleaseResult;"), 'RunPauseDeps.releaseMembers has no options parameter');
  // the scanner itself: every spelling an evasion could use is seen (and prose / strings are not)
  const probe = (code: string) => humanOptionSites(code);
  assert.equal(probe('f({human:true})').passes, 1);
  assert.equal(probe('const human = go(); f({ human })').passes, 1);
  assert.equal(probe('f({ "human": true })').passes, 1);
  assert.equal(probe('f({ [`x`]: 1, human: flag })').passes, 1);
  assert.equal(humanOptionSites('const o = <any>{ human: true };', 'x.ts').passes, 1, 'a type assertion in a .ts file (parsed as TS, not as JSX)');
  assert.equal(humanOptionSites('const f = <T,>(x: T) => ({ human: true });', 'x.tsx').passes, 1);
  assert.equal(probe('o?.human').reads, 1);
  assert.equal(probe('o.human').reads, 1);
  assert.equal(probe("o['human']").reads, 1);
  assert.equal(probe('const { human } = o;').reads, 1);
  assert.equal(probe('const { human: h } = o;').reads, 1);
  assert.equal(probe('type T = { human?: boolean }').declares, 1);
  assert.deepEqual(probe("const s = '/* human: true */'; // human: true\nconst t = \"*/\"; f({ human: true })"), { passes: 1, reads: 0, declares: 0 }, 'a comment / string mentioning it is not a site; a `*/` inside a string does not hide the real one');
});

/** Every non-test source file of src/ (ts / tsx / mts / cts / js / mjs / cjs), parsed as its own kind. */
function sourceFiles(): Array<{ rel: string; sf: ts.SourceFile }> {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name) && !/\.test\.[a-z]+$/.test(e.name) ? [path.join(d, e.name)] : []));
  const kindOf = (f: string): ts.ScriptKind => (f.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  return walk(path.join(process.cwd(), 'src')).map((f) => ({ rel: path.relative(process.cwd(), f), sf: ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.ES2022, true, kindOf(f)) }));
}

/** Files that import / re-export / `import()` / `require()` the module `target` (a path relative to the repo root, extension-less) — type-only imports included — by AST. */
function importersOf(target: string, files = sourceFiles()): string[] {
  const hits: string[] = [];
  for (const { rel, sf } of files) {
    const resolves = (spec: string): boolean => spec.startsWith('.') && path.normalize(path.join(path.dirname(rel), spec)).replace(/\.(ts|tsx|mts|cts|js|mjs|cjs)$/, '') === target;
    let hit = false;
    const visit = (n: ts.Node): void => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier) && resolves(n.moduleSpecifier.text)) hit = true;
      else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteralLike(n.argument.literal) && resolves(n.argument.literal.text)) hit = true;
      else if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteralLike(n.arguments[0]) && ((n.expression.kind === ts.SyntaxKind.ImportKeyword) || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && resolves(n.arguments[0].text)) hit = true;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (hit) hits.push(rel);
  }
  return hits.sort();
}

const WRITERS = new Set(['setRunPause', 'setRunHold', 'beginReprise', 'beginRepriseCore', 'releaseMembers']);
/** Object-literal arguments of a writer call may carry ONLY these properties (a spread / computed key / another name could relay an authority bypass): the CLI verbs pass `reason`; the host auto-Reprises (usage-limit #256, memory #290) `host` + `reason`; the UI layer its own. */
const ALLOWED_PROPS: Record<string, string[]> = { 'src/main/pause-ui.ts': ['human', 'ownRuns', 'reason'], 'src/main/pause-auto.ts': ['host', 'reason'], 'src/main/pause-memory.ts': ['host', 'reason'] };

const unwrapCallee = (e: ts.Expression): ts.Expression => {
  while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
};
/** The name a call is made through: `f(…)`, `x.f(…)`, `x['f'](…)`, with any `!` / parentheses / `as` / `<T>` / `satisfies` wrapped around the callee. */
const calleeName = (e0: ts.Expression): string | null => {
  const e = unwrapCallee(e0);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return null;
};

/** Every CALL of a writer — including through `.call` / `.apply` / `.bind` — as `name/argc:kinds`, plus any object-literal argument whose properties are not plain allowed ones. */
function writerCalls(files = sourceFiles()): { sites: Record<string, string[]>; badObjects: string[] } {
  const sites: Record<string, string[]> = {};
  const badObjects: string[] = [];
  for (const { rel, sf } of files) {
    const allowed = ALLOWED_PROPS[rel] ?? ['reason'];
    const okProp = (p: ts.ObjectLiteralElementLike): boolean => {
      const nm = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null) : null;
      return nm !== null && allowed.includes(nm);
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        let name = calleeName(n.expression);
        let via = '';
        if (name === 'call' || name === 'apply' || name === 'bind') {
          const c = unwrapCallee(n.expression);
          const inner = ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c) ? calleeName(c.expression) : null;
          if (inner && WRITERS.has(inner)) { via = `.${name}`; name = inner; }
        }
        if (name && WRITERS.has(name)) {
          (sites[rel] ??= []).push(`${name}${via}/${n.arguments.length}:${n.arguments.map((a) => ts.SyntaxKind[a.kind]).join(',')}`);
          for (const a of n.arguments) {
            if (ts.isObjectLiteralExpression(a) && !a.properties.every(okProp)) badObjects.push(`${rel}: ${a.getText().slice(0, 60)}`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const k of Object.keys(sites)) sites[k].sort();
  return { sites, badObjects };
}

test('ENUMERATION (importers + call sites): the UI entry points uiPause / uiResume / uiRelease have ONE importer (pause-ui-host.ts, the file that registers them on ipcMain); EVERY call of the five Pause writers is pinned by arity + argument kinds (casts, element access, .call / .apply / .bind seen through), their object arguments are plain `reason` (`host` only in the host auto-Reprise, the UI layer\'s own keys only in pause-ui.ts) — a route that imports pause-ui or calls a writer by name, a relayed object or an extra argument is a NEW site and fails here (review m-A). An ALIASED call (`const f = w.setRunPause; f(…)`) is outside what a static scan follows', () => {
  assert.deepEqual(importersOf('src/main/pause-ui'), ['src/main/pause-ui-host.ts'], 'who imports / re-exports / dynamically loads src/main/pause-ui.ts (the module that holds the human authority)');
  const { sites, badObjects } = writerCalls();
  assert.deepEqual(badObjects, [], 'a writer call whose object argument is not plain (allowed keys only, no spread / computed key)');
  assert.deepEqual(sites, {
    'src/cli/bus-verbs.ts': ['beginReprise/4:PropertyAccessExpression,Identifier,Identifier,ObjectLiteralExpression', 'releaseMembers/4:PropertyAccessExpression,Identifier,Identifier,Identifier', 'setRunHold/4:PropertyAccessExpression,Identifier,Identifier,Identifier', 'setRunPause/4:PropertyAccessExpression,Identifier,FalseKeyword,Identifier', 'setRunPause/5:PropertyAccessExpression,Identifier,TrueKeyword,Identifier,Identifier'],
    'src/main/bus-pause.ts': ['beginRepriseCore/5:Identifier,Identifier,Identifier,Identifier,CallExpression'], // the RepriseEntry wrapper `beginReprise` relays its (typed) opts to the core — the ONE place a relayed opts object legitimately flows
    'src/main/pause-auto.ts': ['beginReprise/4:Identifier,PropertyAccessExpression,StringLiteral,ObjectLiteralExpression'],
    'src/main/pause-memory.ts': ['beginReprise/4:Identifier,PropertyAccessExpression,StringLiteral,ObjectLiteralExpression'], // #290: the memory guard's automatic Reprise — the second (and last) host caller
    'src/main/pause-ui.ts': ['beginReprise/4:Identifier,PropertyAccessExpression,Identifier,ObjectLiteralExpression', 'releaseMembers/6:Identifier,BinaryExpression,Identifier,PropertyAccessExpression,CallExpression,ObjectLiteralExpression', 'setRunHold/5:Identifier,PropertyAccessExpression,FalseKeyword,Identifier,ObjectLiteralExpression', 'setRunPause/6:Identifier,PropertyAccessExpression,TrueKeyword,Identifier,PropertyAccessExpression,ObjectLiteralExpression'],
  }, 'the CLI verbs (typed deps), the host auto-Reprise and the human\'s UI layer — no other file calls a writer');
  // the pin sees what it claims to see: planted evasions, each in a fresh file set
  const plant = (rel: string, code: string, kind = ts.ScriptKind.TS) => ({ rel, sf: ts.createSourceFile(rel, code, ts.ScriptTarget.ES2022, true, kind) });
  const callsIn = (code: string, rel = 'src/x.ts') => writerCalls([plant(rel, code)]);
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/main/api-handlers.ts', "import { uiPause } from './pause-ui';")]), ['src/main/api-handlers.ts']);
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/main/x.ts', "import * as ui from './pause-ui.ts';")]), ['src/main/x.ts']);
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/main/x.ts', "export { uiResume } from './pause-ui';")]), ['src/main/x.ts']);
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/main/x.ts', "const m = await import('./pause-ui');")]), ['src/main/x.ts']);
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/main/x.ts', "const m = require('./pause-ui');", ts.ScriptKind.JS)]), ['src/main/x.ts'], 'a require() in a JS file');
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/main/x.ts', "import type { PauseUiDeps } from './pause-ui';")]), ['src/main/x.ts'], 'a type-only import is an importer too (nothing but the host may even name it)');
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/main/x.ts', "type T = import('./pause-ui').PauseUiDeps;")]), ['src/main/x.ts'], 'an import() TYPE');
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/main/x.ts', "import { uiPause } from './pause-ui.js';")]), ['src/main/x.ts'], 'a .js specifier (bundler resolution)');
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/cli/x.ts', "import { uiPause } from '../main/pause-ui';")]), ['src/cli/x.ts']);
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/main/x.ts', "import { x } from './pause-ui-host';")]), [], 'a sibling module is not the target');
  assert.deepEqual(importersOf('src/main/pause-ui', [plant('src/main/x.ts', "import type { PauseUiOverview } from '../shared/pause-ui';")]), [], 'the SHARED pause-ui module is not the target');
  assert.deepEqual(callsIn("busPause.setRunPause(db, id, true, a, 'hard', JSON.parse(s));", 'src/cli/index.ts').sites['src/cli/index.ts'], ['setRunPause/6:Identifier,Identifier,TrueKeyword,Identifier,StringLiteral,CallExpression']);
  assert.equal(callsIn('deps.releaseMembers!(db, c, a, t, 1, o);').sites['src/x.ts'].length, 1, 'a non-null-asserted call is seen');
  assert.equal(callsIn('deps.setRunHold?.(db, r, false, a, o);').sites['src/x.ts'].length, 1, 'an optional call is seen');
  assert.equal(callsIn('(deps.setRunPause as any)(db, id, true, a, m, opts);').sites['src/x.ts'].length, 1, 'a CAST callee is seen (review: the standard way to defeat the typed deps)');
  assert.equal(callsIn('(<any>deps.setRunPause)(db, id, true, a, m, opts);').sites['src/x.ts'].length, 1, 'a type-assertion callee');
  assert.equal(callsIn('(deps.setRunPause satisfies F)(db, id, true, a, m, opts);').sites['src/x.ts'].length, 1, 'a satisfies callee');
  assert.equal(callsIn("deps['setRunPause'](db, id, true, a, m, opts);").sites['src/x.ts'].length, 1, 'an element-access call');
  assert.deepEqual(callsIn('deps.setRunPause.call(deps, db, id, true, a, m, opts);').sites['src/x.ts'], ['setRunPause.call/7:Identifier,Identifier,Identifier,TrueKeyword,Identifier,Identifier,Identifier'], '.call is seen through');
  assert.equal(callsIn('deps.setRunHold.apply(deps, [db, r, false, a, o]);').sites['src/x.ts'].length, 1, '.apply is seen through');
  assert.equal(callsIn('const f = deps.releaseMembers.bind(deps);').sites['src/x.ts'].length, 1, '.bind is seen through');
  assert.equal(callsIn('beginRepriseCore(db, c, a, relayed, ids);').sites['src/x.ts'].length, 1, 'beginRepriseCore is a writer too (it reads host AND human)');
  assert.equal(callsIn('beginReprise(db, c, a, { ...opts });').badObjects.length, 1, 'a relayed spread');
  assert.equal(callsIn("beginReprise(db, c, a, { reason: 'manual' });").badObjects.length, 0, 'plain reason is fine');
  assert.equal(callsIn('beginReprise(db, c, a, { reason });').badObjects.length, 0, 'shorthand reason is fine');
  assert.equal(callsIn("beginReprise(db, c, a, { 'reason': x });").badObjects.length, 0, 'a string-literal key is fine');
  assert.equal(callsIn('beginReprise(db, c, a, { host: true, reason: x });').badObjects.length, 1, '`host` skips the coordinator rule too: only the host auto-Reprise may pass it');
  assert.equal(callsIn('beginReprise(db, c, a, { host: true, reason: x });', 'src/main/pause-auto.ts').badObjects.length, 0, '…and that file may');
  assert.equal(callsIn('beginReprise(db, c, a, { host: true, reason: x });', 'src/main/pause-memory.ts').badObjects.length, 0, '…and the memory Pause\'s (#290)');
  assert.equal(callsIn('beginReprise(db, c, a, { human: true });', 'src/main/pause-memory.ts').badObjects.length, 1, 'but the memory Pause never passes `human`');
  assert.equal(callsIn('beginReprise(db, c, a, { ["hu" + "man"]: true });').badObjects.length, 1, 'a computed key');
  assert.equal(callsIn('setRunHold(db, r, false, a, { human: true });').badObjects.length, 1, 'the human key outside pause-ui.ts');
  assert.equal(callsIn('setRunHold(db, r, false, a, { human: true });', 'src/main/pause-ui.ts').badObjects.length, 0, '…and inside it');
  assert.equal(callsIn('setRunHold(db, r, false, a, { ...x, human: true });', 'src/main/pause-ui.ts').badObjects.length, 1, 'a spread even in the UI layer');
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

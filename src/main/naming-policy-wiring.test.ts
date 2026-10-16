// #381 — SOURCE-LEVEL wiring pin for the naming policy (src/shared/naming-policy.ts). workspaces.ts / agent-sdk.ts /
// api-handlers.ts / activity.ts import Electron and cannot be loaded under `node --test`, so this asserts against
// source text (same stance as wave-run-anchor-wiring.test.ts): the decisions are executed in
// src/shared/naming-policy.test.ts; this file pins that spawn, `/rename`, the nudge gate and the human rename paths
// CALL the module and that no inline copy of the rule survives in src/main. A source pin proves placement, never effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const workspacesSrc = code(read('src/main/workspaces.ts'));
const agentSdkSrc = code(read('src/main/agent-sdk.ts'));
const apiHandlersSrc = code(read('src/main/api-handlers.ts'));
const activitySrc = code(read('src/main/activity.ts'));
const hooksSrc = code(read('src/main/hooks-server.ts'));
const sandboxMgrSrc = code(read('src/main/transport/sandbox-manager.ts'));
const policySrc = read('src/shared/naming-policy.ts');

/** Body of a top-level function: from its signature to the next column-0 `}`. */
function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `signature not found: ${signature}`);
  const end = src.indexOf('\n}\n', at);
  assert.ok(end > at, `no closing brace after: ${signature}`);
  return src.slice(at, end);
}

/** Source with every comment blanked to spaces (layout kept), found through the TS AST/trivia — a regex stripper swallows code
 *  after a `/*` inside a `//` comment or a shell template string, and a commented-out wiring line must not satisfy a positive assertion. */
function code(src: string): string {
  const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const ranges = new Map<number, number>();
  const visit = (n: ts.Node): void => {
    for (const r of ts.getLeadingCommentRanges(src, n.pos) ?? []) ranges.set(r.pos, r.end);
    for (const r of ts.getTrailingCommentRanges(src, n.end) ?? []) ranges.set(r.pos, r.end);
    for (const c of n.getChildren(sf)) visit(c);
  };
  visit(sf);
  const out = src.split('');
  for (const [p, e] of ranges) for (let i = p; i < e; i++) if (out[i] !== '\n') out[i] = ' ';
  return out.join('');
}

/** Every non-test file under src/main, relative path → comment-free code. */
function mainSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.set(rel, code(read(rel)));
    }
  };
  walk('src/main');
  return out;
}

/** The inline-copy detectors. Each pattern is one clause of the rule living OUTSIDE the policy module. */
const INLINE_COPIES: Array<[string, RegExp]> = [
  ['an inline human-pin literal (`branchManuallySet: true|false`)', /\bbranchManuallySet\s*:\s*(true|false)\b/],
  ['an inline budget comparison (`< MAX_AUTO_RENAMES`)', /<\s*MAX_AUTO_RENAMES\b/],
  ['an inline counter comparison (`autoRenameCount ?? 0) <`)', /autoRenameCount\s*\?\?\s*0\s*\)\s*[<>]/],
  ['the retired gate `autoRenameActive`', /\bautoRenameActive\b/],
  ['a literal rename pin (`manual: true|false`)', /\bmanual\s*:\s*(true|false)\b/],
  ['a locally derived counter bump (`bumpAutoCount =|:`)', /\bbumpAutoCount\s*[:=]/],
  ['a re-derived pin predicate (`opts.manual`)', /\bopts\.manual\b/],
  ['a local definition of a moved symbol', /\b(?:const|function)\s+(?:MAX_AUTO_RENAMES|sanitizeBranchName)\b/],
];
const inlineCopiesIn = (src: string): string[] => INLINE_COPIES.filter(([, re]) => re.test(code(src))).map(([d]) => d);

test('CONTROL: sources are readable and non-trivial', () => {
  for (const [name, src] of Object.entries({ workspacesSrc, agentSdkSrc, apiHandlersSrc, activitySrc, hooksSrc, sandboxMgrSrc, policySrc }))
    assert.ok(src.length > 1000, `${name} short: ${src.length}`);
  assert.ok(mainSources().size > 50, 'src/main walk found the main-process sources');
  assert.doesNotMatch(workspacesSrc, /zzzNoSuchPatternZzz/);
});

test('DETECTOR CONTROL: each inline-copy pattern fires on a planted copy and stays quiet on clean code', () => {
  const planted: Array<[string, string]> = [
    [INLINE_COPIES[0][0], 'const ws = { id, branchManuallySet: false };'],
    [INLINE_COPIES[0][0], 'updated = { ...ws, branchManuallySet: true };'],
    [INLINE_COPIES[0][0], '// glob /tmp/*.jsonl  (a block-comment opener inside a line comment)\nconst a = { branchManuallySet: false };'],
    [INLINE_COPIES[0][0], 'const t = `ls /*)`;\nconst a = { branchManuallySet: false };\n/* real comment */'],
    [INLINE_COPIES[1][0], 'return (ws.autoRenameCount ?? 0) < MAX_AUTO_RENAMES;'],
    [INLINE_COPIES[2][0], 'if ((ws.autoRenameCount ?? 0) < 2) nudge();'],
    [INLINE_COPIES[3][0], 'env.ORCHESTRA_BRANCH_AUTO = autoRenameActive(ws) ? "1" : "0";'],
    [INLINE_COPIES[4][0], 'renameWorkspaceBranch(id, b, { manual: true });'],
    [INLINE_COPIES[5][0], 'const bumpAutoCount = !ws.branchManuallySet;'],
    [INLINE_COPIES[6][0], 'if ((opts.manual && !ws.branchManuallySet) || opts.bumpAutoCount) { persist(); }'],
    [INLINE_COPIES[7][0], 'export const MAX_AUTO_RENAMES = 2;'],
    [INLINE_COPIES[7][0], 'function sanitizeBranchName(raw: string) { return raw; }'],
  ];
  for (const [detector, src] of planted)
    assert.ok(inlineCopiesIn(src).includes(detector), `detector "${detector}" missed: ${src}`);
  const clean = [
    '...initialNaming(),',
    'const decision = decideRename(ws, { kind: "agent" });',
    '// the rule: branchManuallySet: false and autoRenameCount < MAX_AUTO_RENAMES live in naming-policy',
    '/** `manual: true` is the human pin */',
    'const gateFields = pinFields(ws, opts);',
    'if (pinAdvancesGate(ws, opts)) {',
    '// if ((opts.manual && !ws.branchManuallySet) || opts.bumpAutoCount) {  (prose)',
    'const ok = 1; // branchManuallySet: false (trailing prose)',
    'const re = /\\/\\*[\\s\\S]*?\\*\\//g; const y = 1; // regex with a comment opener inside',
    'env.ORCHESTRA_BRANCH_AUTO = nudgeActive(ws) ? "1" : "0";',
  ];
  for (const src of clean) assert.deepEqual(inlineCopiesIn(src), [], `false positive on: ${src}`);
});

test('no inline copy of the naming rule anywhere in src/main (every non-test file)', () => {
  const offenders: string[] = [];
  for (const [file, src] of mainSources())
    for (const [desc, re] of INLINE_COPIES) if (re.test(src)) offenders.push(`${file}: ${desc}`);
  assert.deepEqual(offenders, [], 'the rule lives in src/shared/naming-policy.ts only');
});

test('the policy module is pure: it imports only the Workspace type, nothing from Electron or node:*', () => {
  const imports = [...code(policySrc).matchAll(/^\s*import\s[^;]*from\s+'([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./types.ts']);
  assert.match(policySrc, /^import type \{ Workspace \} from '\.\/types\.ts';/m);
});

test('workspaces.ts takes MAX_AUTO_RENAMES / sanitizeBranchName / the decisions from the module', () => {
  const m = workspacesSrc.match(/import \{([^}]*)\} from '\.\.\/shared\/naming-policy\.ts';/);
  assert.ok(m, 'workspaces.ts imports ../shared/naming-policy.ts');
  const names = m![1].split(',').map((s) => s.trim().replace(/^type\s+/, '')).filter(Boolean).sort();
  assert.deepEqual(names, ['MAX_AUTO_RENAMES', 'RenamePin', 'decideRename', 'initialNaming', 'pinAdvancesGate', 'pinFields', 'sanitizeBranchName']);
});

test('spawn: createWorkspace (the one git-workspace creation path, spawn included) takes its naming fields from initialNaming()', () => {
  const b = body(workspacesSrc, 'export async function createWorkspace(');
  assert.match(b, /\.\.\.initialNaming\(\),/);
  // dispatchSpawnRequest has no creation site of its own: it reaches the policy through createWorkspace.
  assert.match(body(workspacesSrc, 'export async function dispatchSpawnRequest('), /await createWorkspace\(\{/);
  assert.equal([...code(workspacesSrc).matchAll(/createdAt: Date\.now\(\)/g)].length, 2, 'exactly two Workspace-record creation sites (git + scratch-like)');
});

test('scratch / orchestrator creation takes its naming fields from initialNaming() too', () => {
  const b = body(workspacesSrc, 'async function createScratchLikeWorkspace(');
  assert.match(b, /\.\.\.initialNaming\(\),/);
});

test('/rename: dispatchRenameRequest asks the policy (agent caller) and hands the PIN to renameWorkspaceBranch', () => {
  const b = body(workspacesSrc, 'export async function dispatchRenameRequest(');
  assert.match(b, /const decision = decideRename\(ws, \{ kind: 'agent' \}\);/);
  assert.match(b, /if \(!decision\.allow\) return \{ ok: false, error: decision\.error \};/);
  assert.equal([...b.matchAll(/renameWorkspaceBranch\(id, target, pin\)/g)].length, 2, 'scratch-like AND git branch both pass the decided pin');
  assert.match(b, /if \(pin\.bumpAutoCount\) await writeRenameProgress\(/);
});

test('/rename: the socket route and the sandbox transport both reach dispatchRenameRequest (one function, one rule)', () => {
  assert.match(hooksSrc, /dispatchRenameRequest\(msg\.id, msg\.branch\)/);
  assert.match(sandboxMgrSrc, /dispatchRenameRequest\(p\.id, p\.branch\)/);
  // callers of the executor: the dispatcher and the human sidebar handler, nobody else
  const callers = [...mainSources()].filter(([f, s]) => /\brenameWorkspaceBranch\(/.test(s) && f !== 'src/main/workspaces.ts').map(([f]) => f);
  assert.deepEqual(callers, ['src/main/api-handlers.ts']);
});

test('renameWorkspaceBranch: the written gate fields come from the decided pin (pinFields), not from opts re-derived', () => {
  const b = body(workspacesSrc, 'export async function renameWorkspaceBranch(');
  assert.match(b, /opts: RenamePin,/);
  assert.match(b, /const gateFields = pinFields\(ws, opts\);/);
  assert.equal([...b.matchAll(/if \(pinAdvancesGate\(ws, opts\)\) \{/g)].length, 2, 'both same-name short-circuits (scratch-like + git) ask the policy whether the pin changes anything');
});

test('nudge gate: ORCHESTRA_BRANCH_AUTO reads nudgeActive from the module', () => {
  assert.match(agentSdkSrc, /import \{ nudgeActive \} from '\.\.\/shared\/naming-policy\.ts';/);
  assert.match(agentSdkSrc, /env\.ORCHESTRA_BRANCH_AUTO = nudgeActive\(ws\) \? '1' : '0';/);
  assert.equal([...code(agentSdkSrc).matchAll(/ORCHESTRA_BRANCH_AUTO\s*=/g)].length, 1, 'one writer of the gate');
});

test('nudge hook script: the budget baked into the script is the module\'s MAX_AUTO_RENAMES', () => {
  assert.match(workspacesSrc, /\[ "\\\$count" -ge \$\{MAX_AUTO_RENAMES\} \] 2>\/dev\/null && exit 0/);
});

test('human rename (sidebar): renameBranch asks the policy for a HUMAN caller and passes its pin', () => {
  const at = apiHandlersSrc.indexOf('renameBranch: async (id, newBranch) => {');
  assert.ok(at >= 0, 'renameBranch handler found');
  const b = apiHandlersSrc.slice(at, apiHandlersSrc.indexOf('\n  },\n', at));
  assert.match(b, /const decision = decideRename\(ws, \{ kind: 'human' \}\);/);
  assert.match(b, /renameWorkspaceBranch\(id, newBranch, decision\.pin\)/);
  assert.match(apiHandlersSrc, /import \{ decideRename \} from '\.\.\/shared\/naming-policy\.ts';/);
});

test('human pin sites: an explicit branch switch and an out-of-band `git branch -m` adoption pin through the policy', () => {
  const sw = body(workspacesSrc, 'export async function switchWorkspaceBranch(');
  assert.match(sw, /decideRename\(ws, \{ kind: 'human' \}\)/);
  assert.match(sw, /\.\.\.pinFields\(ws, decision\.pin\),/);
  const adopt = body(activitySrc, 'export async function detectAndUpdateBranchName(');
  assert.match(adopt, /decideRename\(fresh, \{ kind: 'human' \}\)/);
  assert.match(adopt, /\.\.\.pinFields\(fresh, decision\.pin\),/);
  assert.match(activitySrc, /import \{ decideRename, pinFields \} from '\.\.\/shared\/naming-policy\.ts';/);
});

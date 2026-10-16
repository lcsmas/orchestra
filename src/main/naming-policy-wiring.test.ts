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
const POLICY_FILE = 'src/shared/naming-policy.ts';
const policySrc = read(POLICY_FILE);

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

/** Every non-test file under src/main AND src/shared (the policy module itself excepted), relative path → comment-free code. */
function mainSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && rel !== POLICY_FILE) out.set(rel, code(read(rel)));
    }
  };
  walk('src/main');
  walk('src/shared');
  return out;
}

/** The inline-copy detectors. Each pattern is one clause of the rule living OUTSIDE the policy module (src/main + src/shared). */
const INLINE_COPIES: Array<[string, RegExp]> = [
  // ANY value: `branchManuallySet: false`, `branchManuallySet: !!x`, `autoRenameCount: n` (a typed declaration `branchManuallySet?: boolean` has a `?` and is not a write)
  ['an inline human-pin / counter property write (`branchManuallySet: <expr>` / `autoRenameCount: <expr>`)', /\b(?:branchManuallySet|autoRenameCount)\s*:/],
  ['an inline budget comparison (`< MAX_AUTO_RENAMES`)', /<\s*MAX_AUTO_RENAMES\b/],
  ['an inline counter comparison (`autoRenameCount ?? 0) <`)', /autoRenameCount\s*\?\?\s*0\s*\)\s*[<>]/],
  ['the retired gate `autoRenameActive`', /\bautoRenameActive\b/],
  ['a literal rename pin (`manual: true|false`)', /\bmanual\s*:\s*(true|false)\b/],
  ['a locally derived counter bump (`bumpAutoCount =|:`)', /\bbumpAutoCount\s*[:=]/],
  ['a re-derived pin predicate (`opts.manual`)', /\bopts\.manual\b/],
  ['a local definition of a moved symbol', /\b(?:const|function)\s+(?:MAX_AUTO_RENAMES|sanitizeBranchName)\b/],
  // reviewer #381 (measured): a bare read is how a REALISTIC copy looks — `!ws.branchManuallySet && (ws.autoRenameCount || 0) < 2`, `store.getWorkspace(id)?.branchManuallySet`
  ['a bare read of `.branchManuallySet` / `.autoRenameCount` (member, optional-chain or bracket access) outside the sanctioned sites', /\.\s*(?:branchManuallySet|autoRenameCount)\b|\[\s*['"`](?:branchManuallySet|autoRenameCount)['"`]\s*\]/],
  ['a shorthand / destructured `branchManuallySet` or `autoRenameCount`', /\b(?:branchManuallySet|autoRenameCount)\s*[,}]/],
  // verifier #381 F1: the sanitizer copied inline (its allow-list literal, or its `.trim().replace(/\s+/g, '-')` head) — INLINE_COPIES used to catch only a local DEFINITION
  ['the sanitizer allow-list literal (`[^a-zA-Z0-9._/-]`) outside the module', /\[\^a-zA-Z0-9\._\/-\]/],
  ['the sanitizer body (`.trim().replace(/\\s+/g, "-")`) outside the module', /\.trim\(\)\s*\.replace\(\s*\/\\s\+\/g\s*,\s*['"]-['"]\s*\)/],
  // reviewer #383 m1: the AUTHORITY fields. `.namedByParent` is read in a handful of sanctioned places (SANCTIONED_READS + former-branch.ts); `.parentId` is read all
  // over the app (trees, buses, pause) so it is NOT banned as a bare read — it is banned compared with the caller's identity anywhere, and inside the rename surfaces below.
  ['a bare read of `.namedByParent` (member, optional-chain or bracket access) outside the sanctioned sites', /\.\s*namedByParent\b|\[\s*['"`]namedByParent['"`]\s*\]/],
  ['the caller\'s identity compared with a workspace `parentId` (`… === from` / `from !== ….parentId` / `[….parentId].includes(from)`; caller-ish names: from*, caller*, requester*, actor*, sender*)', /\bparentId\b[^;]{0,120}?(?:[!=]==?|\.includes\(|\.indexOf\()[^;]{0,120}?\b(?:from|caller|requester|actor|sender)\w*\b|\b(?:from|caller|requester|actor|sender)\w*\b[^;]{0,120}?(?:[!=]==?|\.includes\(|\.indexOf\()[^;]{0,120}?\bparentId\b/],
  ['a shorthand / destructured / property-written `namedByParent` (`{ namedByParent }`, `namedByParent: <expr>`) outside the module (a typed declaration `namedByParent?:` has a `?`)', /\bnamedByParent\s*[:,}]/],
];

/** The ONLY sanctioned bare reads of the two counters outside the policy module: DATA exports, never a decision. Statement-exact and per file —
 *  a second read in the same file is still flagged — and each entry must still exist (a rotted entry fails the test below). */
const SANCTIONED_READS: Array<[file: string, statement: string, why: string, occurrences?: number]> = [
  ['src/main/workspaces.ts', 'writeRenameProgress(ws.worktreePath, updated.autoRenameCount ?? 0)', 'the .branch-renamed sentinel value written after a counted rename'],
  ['src/main/agent-sdk.ts', 'env.ORCHESTRA_AUTO_RENAME_COUNT = String(ws.autoRenameCount ?? 0);', 'the ORCHESTRA_AUTO_RENAME_COUNT env export the nudge hook reads'],
  // the pin's namer FORWARDED (never compared) — #384's former-name record and the live-nudge sentinel; the namer's DISPLAY NAME is resolved by the policy's `namerName`
  ['src/main/activity.ts', 'formerBranchPatch(fresh, fresh.branch, live, pin.namedByParent)', '#384: the replaced name of an adopted out-of-band rename'],
  ['src/main/workspaces.ts', 'formerBranchPatch(ws, ws.branch, newBranch, opts.namedByParent)', '#384: scratch relabel AND git rename (the displayed name is the previous one at both)', 2],
  ['src/main/workspaces.ts', 'formerBranchPatch(ws, ws.branch, liveBranch, opts.namedByParent)', '#384: drift adoption'],
  ['src/main/workspaces.ts', 'else if (pin.namedByParent) await writeRenameProgress(ws.worktreePath, MAX_AUTO_RENAMES)', '#383: a parent pin retires a live child\'s nudge sentinel'],
];
/** Files that may read `.namedByParent` as a whole: the former-name rule (#384) keys on the pin by design. */
const NAMER_READ_FILES = new Set(['src/shared/former-branch.ts']);

/** Descriptions of every detector that fires on `src` as if it lived in `file` (sanctioned statements of THAT file removed first). */
function inlineCopiesIn(src: string, file = 'src/main/planted.ts'): string[] {
  let c = code(src);
  for (const [f, statement] of SANCTIONED_READS) if (f === file) c = c.split(statement).join(' ');
  return INLINE_COPIES.filter(([d, re]) => re.test(c) && !((d === NAMER_READ || d === NAMER_SHORTHAND) && NAMER_READ_FILES.has(file))).map(([d]) => d);
}
const NAMER_READ = INLINE_COPIES[12][0];
const CALLER_VS_PARENT = INLINE_COPIES[13][0];
const NAMER_SHORTHAND = INLINE_COPIES[14][0];
const BARE_READ = INLINE_COPIES[8][0];
const PROPERTY_WRITE = INLINE_COPIES[0][0];
const SANITIZER_LITERAL = INLINE_COPIES[10][0];
const SANITIZER_BODY = INLINE_COPIES[11][0];

test('CONTROL: sources are readable and non-trivial', () => {
  for (const [name, src] of Object.entries({ workspacesSrc, agentSdkSrc, apiHandlersSrc, activitySrc, hooksSrc, sandboxMgrSrc, policySrc }))
    assert.ok(src.length > 1000, `${name} short: ${src.length}`);
  assert.ok(mainSources().size > 50, 'src/main walk found the main-process sources');
  const scanned = [...mainSources().keys()];
  assert.ok(scanned.some((k) => k.startsWith('src/shared/') && k !== POLICY_FILE), 'src/shared is scanned too (a literal copy there is a copy)');
  assert.ok(scanned.some((k) => k.startsWith('src/main/transport/')), 'subdirectories are walked');
  assert.equal(scanned.includes(POLICY_FILE), false, 'the policy module is the one file allowed to hold the rule');
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
  // the reviewer's five measured blind spots (#381 review) + the verifier's F1, each as a PLANTED copy that must now turn the scan RED
  const realistic: Array<[string, string, string, string]> = [
    ['(a) a new file re-deriving the nudge gate', BARE_READ, 'src/main/new-feature.ts', 'const on = !ws.branchManuallySet && (ws.autoRenameCount || 0) < 2;'],
    ['(b) a pin written with a computed value', PROPERTY_WRITE, 'src/main/workspaces.ts', 'const u = { ...ws, branchManuallySet: !!x };'],
    ['(c) createWorkspace spreading initialNaming() then overriding the pin', PROPERTY_WRITE, 'src/main/workspaces.ts', '...initialNaming(), branchManuallySet: !!input.branch,'],
    ['(d) the /rename route refusing on the human pin itself (the shape #383 adds)', BARE_READ, 'src/main/hooks-server.ts', 'if (store.getWorkspace(msg.id)?.branchManuallySet) { send(200, { ok: false }); return; }'],
    ['(e) a literal copy in src/shared', BARE_READ, 'src/shared/rename-rule.ts', 'export const locked = (w: Workspace) => w.branchManuallySet === true;'],
    ['(f) bracket access', BARE_READ, 'src/main/x.ts', "const n = ws['autoRenameCount'];"],
    ['(g) destructuring', INLINE_COPIES[9][0], 'src/main/x.ts', 'const { branchManuallySet } = ws;'],
    ['(m1-a) an inline refuse in the /rename route on the namer', NAMER_READ, 'src/main/hooks-server.ts', 'const w = store.getWorkspace(msg.id); if (w?.namedByParent && msg.from !== w.namedByParent) { send(200, { ok: false }); return; }'],
    ['(m1-b) a from-vs-parentId check in sandbox-manager\'s rename case', CALLER_VS_PARENT, 'src/main/transport/sandbox-manager.ts', "if (p.from !== store.getWorkspace(p.id)?.parentId) return { ok: false, error: 'no' };"],
    ['(m1-b2) the same with the operands swapped', CALLER_VS_PARENT, 'src/main/transport/sandbox-manager.ts', 'if (ws.parentId === p.from) return reply(await dispatchRenameRequest(p.id, p.branch));'],
    ['(m1-c) an adoption gate on the namer', NAMER_READ, 'src/main/activity.ts', 'if (fresh.namedByParent) return;'],
    ['(m1-d) a new file copying the whole rule', NAMER_READ, 'src/main/rename-guard.ts', 'export const mayRename = (ws: Workspace, from?: string) => !!from && (ws.parentId === from || ws.namedByParent === from);'],
    ['(m1-d2) …and its parentId comparison', CALLER_VS_PARENT, 'src/main/rename-guard.ts', 'export const mayRename = (ws: Workspace, from?: string) => !!from && (ws.parentId === from || ws.namedByParent === from);'],
    ['(r-a) a destructured namer in the /rename route (reviewer of the follow-up)', NAMER_SHORTHAND, 'src/main/hooks-server.ts', 'const { namedByParent } = store.getWorkspace(msg.id)!; if (namedByParent && msg.from !== namedByParent) { send(200, { ok: false }); return; }'],
    ['(r-b) a parameter destructure in a new helper', NAMER_SHORTHAND, 'src/main/rename-guard.ts', 'export const mayRename = ({ namedByParent }: Workspace, from?: string) => namedByParent === from;'],
    ['(r-c) an inline pin write handed to the apply step', NAMER_SHORTHAND, 'src/main/hooks-server.ts', 'await renameWorkspaceBranch(id, target, { ...pin, namedByParent: from });'],
    ['(r-d) a parentId membership test against the caller', CALLER_VS_PARENT, 'src/main/rename-guard.ts', 'export const mayRename = (ws: Workspace, from?: string) => [ws.parentId].includes(from);'],
    ['(r-e) another caller-ish name (requester / fromId / callerWsId)', CALLER_VS_PARENT, 'src/main/rename-guard.ts', 'export const mayRename = (ws: Workspace, requester: string) => ws.parentId === requester;'],
    ['(r-f) the operator wrapped onto the next line', CALLER_VS_PARENT, 'src/main/rename-guard.ts', 'const ok = ws.parentId\n    === fromId;'],
    ['(m1-e) bracket access to the namer', NAMER_READ, 'src/shared/x.ts', "const n = ws['namedByParent'];"],
    ['F1 the sanitizer allow-list literal inlined in renameWorkspaceBranch', SANITIZER_LITERAL, 'src/main/workspaces.ts', "const nb = raw.replace(/[^a-zA-Z0-9._/-]/g, '');"],
    ['F1 the sanitizer BODY inlined (verifier\'s exact plant)', SANITIZER_BODY, 'src/main/workspaces.ts', "const nb = rawNewBranch.trim().replace(/\\s+/g,'-').replace(/[^a-zA-Z0-9._/-]/g,'').slice(0,80);"],
  ];
  for (const [what, detector, file, src] of realistic)
    assert.ok(inlineCopiesIn(src, file).includes(detector), `${what}: detector "${detector}" missed: ${src}`);
  // the allow-list is statement-exact and PER FILE: the sanctioned statement passes in its own file, a second read beside it or the same text elsewhere does not
  for (const [f, statement] of SANCTIONED_READS) {
    const detector = /namedByParent/.test(statement) ? NAMER_READ : BARE_READ; // the detector that owns this statement's field
    assert.equal(inlineCopiesIn(statement, f).includes(detector), false, `sanctioned in ${f}: ${statement}`);
    assert.equal(inlineCopiesIn(statement, 'src/main/elsewhere.ts').includes(detector), true, `the same text in another file must be flagged: ${statement}`);
    assert.equal(inlineCopiesIn(`${statement}\nif (ws.branchManuallySet) go();`, f).includes(BARE_READ), true, `a second read next to the sanctioned one in ${f} must be flagged`);
    assert.equal(inlineCopiesIn(`${statement}\nconst c = ws.autoRenameCount;`, f).includes(BARE_READ), true, `a second counter read in ${f} must be flagged`);
    assert.equal(inlineCopiesIn(`${statement}\nconst n = ws.namedByParent;`, f).includes(NAMER_READ), true, `a second namer read next to the sanctioned one in ${f} must be flagged`);
  }
  // the former-name rule (#384) reads the pin by design: whole-file allowance, and ONLY that file
  assert.equal(inlineCopiesIn('if (!ws.namedByParent && !namedByParentAfter) return {};', 'src/shared/former-branch.ts').includes(NAMER_READ), false);
  assert.equal(inlineCopiesIn('if (!ws.namedByParent && !namedByParentAfter) return {};', 'src/shared/other.ts').includes(NAMER_READ), true);
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
    '  branchManuallySet?: boolean;', // the typed field declaration in types.ts
    "export type NamingFields = Pick<Workspace, 'branchManuallySet' | 'autoRenameCount' | 'namedByParent' | 'parentId'>;",
    'const oneLine = s.replace(/\\s+/g, " ").trim();', // an unrelated whitespace collapse (space, not '-')
    'const bump = pin.bumpAutoCount;',
    '  namedByParent?: string;', // the typed field declaration
    'const parentName = namerName(ws, (pid) => store.getWorkspace(pid)?.branch);', // the policy resolves the namer's name
    'const kids = all.filter((w) => w.parentId === ws.id);', // an unrelated tree walk: parentId vs a WORKSPACE id, not the caller
    'const r = { ...base, namedByParentLabel: "x" };', // a longer identifier is not the field
    'function formerBranchPatch(ws: Pick<Workspace, "namedByParent">, before: string, namedByParentAfter?: string) {}', // types / a longer parameter name
    'const kids = all.filter((w) => w.parentId === parentId);', // tree walk against a parentId PARAMETER (broadcast-targets.ts shape)
    'const reply = dispatchPeersRequest({ from: p.from });',
  ];
  for (const src of clean) assert.deepEqual(inlineCopiesIn(src), [], `false positive on: ${src}`);
});

test('no inline copy of the naming rule anywhere in src/main or src/shared (every non-test file, the policy module excepted)', () => {
  const offenders: string[] = [];
  for (const [file, src] of mainSources()) for (const d of inlineCopiesIn(src, file)) offenders.push(`${file}: ${d}`);
  assert.deepEqual(offenders, [], 'the rule lives in src/shared/naming-policy.ts only');
});

test('the sanctioned-reads allow-list has not rotted: every entry still occurs exactly once in its file; the human pin is never read', () => {
  for (const [file, statement, , occurrences = 1] of SANCTIONED_READS) {
    const src = mainSources().get(file);
    assert.ok(src, `${file} is scanned`);
    assert.equal(src!.split(statement).length - 1, occurrences, `${file}: sanctioned statement not found exactly ${occurrences}×: ${statement}`);
    assert.doesNotMatch(statement, /branchManuallySet/, 'only the counter DATA exports are sanctioned; the human pin is never read outside the module');
  }
  assert.equal(SANCTIONED_READS.length, 6);
});

/** The rename SURFACES — where a rename request is decided or applied. No authority field (`.parentId`, `.namedByParent`, `.branchManuallySet`,
 *  `.autoRenameCount`) may be read inside them (the sanctioned statements aside): the policy decides, they forward. This catches what the global
 *  detectors cannot — a `.parentId` copied into a local then compared later (`.parentId` is read all over the app, so it is only banned HERE). */
const AUTHORITY_FIELD_READ = /\.\s*(?:parentId|namedByParent|branchManuallySet|autoRenameCount)\b|\[\s*['"`](?:parentId|namedByParent|branchManuallySet|autoRenameCount)['"`]\s*\]|\b(?:parentId|namedByParent)\s*[:,}]/;
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `not found after it: ${to}`);
  return src.slice(a, b);
};
const RENAME_SURFACES: Array<[name: string, file: string, src: string, slice: (src: string) => string, mustContain: RegExp]> = [
  ['hooks-server /rename route', 'src/main/hooks-server.ts', hooksSrc, (x) => between(x, "if (route === '/rename') {", "} else if (route === '"), /dispatchRenameRequest\(/],
  ['sandbox-manager rename rpc', 'src/main/transport/sandbox-manager.ts', sandboxMgrSrc, (x) => between(x, "case 'rename': {", "case 'spawn': {"), /dispatchRenameRequest\(/],
  ['activity adoption (detectAndUpdateBranchName)', 'src/main/activity.ts', activitySrc, (x) => body(x, 'export async function detectAndUpdateBranchName('), /adoptedBranchPin\(/],
  ['api-handlers renameBranch (the sidebar)', 'src/main/api-handlers.ts', apiHandlersSrc, (x) => between(x, 'renameBranch: async (id, newBranch) => {', 'reorderWorkspaces:'), /decideRename\(/],
  ['workspaces.ts dispatchRenameRequest', 'src/main/workspaces.ts', workspacesSrc, (x) => body(x, 'export async function dispatchRenameRequest('), /decideRename\(/],
  ['workspaces.ts renameWorkspaceBranch', 'src/main/workspaces.ts', workspacesSrc, (x) => body(x, 'export async function renameWorkspaceBranch('), /pinFields\(/],
];
const surfaceReads = (file: string, slice: string): boolean => {
  let c = code(slice);
  for (const [f, statement] of SANCTIONED_READS) if (f === file) c = c.split(statement).join(' ');
  return AUTHORITY_FIELD_READ.test(c);
};

test('the rename surfaces read no authority field: they forward to the policy (hooks-server /rename, sandbox rpc, adoption, sidebar, dispatch, apply)', () => {
  assert.equal(RENAME_SURFACES.length, 6);
  for (const [name, file, src, slice, mustContain] of RENAME_SURFACES) {
    const s = slice(src);
    assert.ok(s.length > 60, `${name}: surface slice found (${s.length} chars)`);
    assert.match(s, mustContain, `${name}: the slice no longer holds the forwarding call it is the surface OF (the extractor drifted)`);
    assert.equal(surfaceReads(file, s), false, `${name} reads an authority field — a re-implementation of the rule`);
  }
});

test('DETECTOR CONTROL: the surface ban fires on a planted read in every surface and stays quiet on the forwarding shape', () => {
  const plants: Array<[string, string, string]> = [
    ['a .parentId copied to a local in the /rename route (compared later)', 'src/main/hooks-server.ts', 'const par = store.getWorkspace(msg.id)?.parentId; if (par !== msg.from) refuse();'],
    ['a .namedByParent refuse in the sandbox rpc', 'src/main/transport/sandbox-manager.ts', 'if (ws.namedByParent) return { ok: false };'],
    ['a human-pin read in the adoption', 'src/main/activity.ts', 'if (fresh.branchManuallySet) return;'],
    ['a .parentId read in dispatchRenameRequest beside the sanctioned lookups', 'src/main/workspaces.ts', 'const isMine = ws.parentId === from; // second authority read'],
    ['a counter read in renameWorkspaceBranch', 'src/main/workspaces.ts', 'if ((ws.autoRenameCount ?? 0) > 1) return ws;'],
    ['a bracket read in the sidebar handler', 'src/main/api-handlers.ts', "if (ws['branchManuallySet']) throw new Error('x');"],
    ['a destructured namer in the /rename route', 'src/main/hooks-server.ts', 'const { namedByParent } = store.getWorkspace(msg.id)!;'],
    ['an inline pin write in the apply step', 'src/main/workspaces.ts', 'const pin2 = { ...pin, namedByParent: from };'],
  ];
  for (const [what, file, src] of plants) assert.equal(surfaceReads(file, src), true, `missed: ${what}`);
  for (const clean of ['send(200, await dispatchRenameRequest(msg.id, msg.branch, typeof msg.from === "string" ? msg.from : undefined));', 'const decision = decideRename(ws, { kind: "human" });', 'const parentName = namerName(ws, (pid) => store.getWorkspace(pid)?.branch);'])
    assert.equal(surfaceReads('src/main/workspaces.ts', clean), false, `false positive: ${clean}`);
  // the sanctioned statements pass in their own file only
  assert.equal(surfaceReads('src/main/workspaces.ts', 'else if (pin.namedByParent) await writeRenameProgress(ws.worktreePath, MAX_AUTO_RENAMES)'), false);
  assert.equal(surfaceReads('src/main/hooks-server.ts', 'else if (pin.namedByParent) await writeRenameProgress(ws.worktreePath, MAX_AUTO_RENAMES)'), true);
});

test('the pin is main-process / policy only: no renderer, preload, CLI, keeper or phone file reads or writes `.namedByParent`', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (rel !== 'src/main' && rel !== 'src/shared') walk(rel); }
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        const c = code(read(rel));
        if (INLINE_COPIES[12][1].test(c) || INLINE_COPIES[14][1].test(c)) offenders.push(rel);
      }
    }
  };
  walk('src');
  assert.deepEqual(offenders, [], 'a renderer/CLI read of the pin could disable the human path — keep the decision in the policy');
  // negative control: the same detectors DO fire on such a read
  assert.ok(INLINE_COPIES[12][1].test('const locked = ws.namedByParent;') && INLINE_COPIES[14][1].test('const { namedByParent } = ws;'));
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
  // #382 adds checkSpawnName (dispatchAgentSpawnRequest) and NAME_CONVENTION (the generated spawn skill + orchestrator brief).
  assert.deepEqual(names, ['MAX_AUTO_RENAMES', 'NAME_CONVENTION', 'RenamePin', 'checkSpawnName', 'decideRename', 'initialNaming', 'namerName', 'pinAdvancesGate', 'pinFields', 'sanitizeBranchName']);
});

test('spawn: createWorkspace (the one git-workspace creation path, spawn included) takes its naming fields from initialNaming()', () => {
  const b = body(workspacesSrc, 'export async function createWorkspace(');
  assert.match(b, /\.\.\.initialNaming\(\{ namedBy: naming\?\.namedBy \}\),/); // #382: the namer rides in; absent = today's `initialNaming()` record
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
  assert.match(b, /const decision = decideRename\(ws, \{ kind: 'agent', id: from \}, \{ parentName \}\);/);
  assert.match(b, /if \(!decision\.allow\) return \{ ok: false, error: decision\.error \};/);
  assert.equal([...b.matchAll(/renameWorkspaceBranch\(id, target, pin\)/g)].length, 2, 'scratch-like AND git branch both pass the decided pin');
  assert.match(b, /if \(pin\.bumpAutoCount\) await writeRenameProgress\(/);
});

test('/rename: the socket route and the sandbox transport both reach dispatchRenameRequest (one function, one rule)', () => {
  assert.match(hooksSrc, /dispatchRenameRequest\(\s*msg\.id,\s*msg\.branch,/);
  assert.match(sandboxMgrSrc, /dispatchRenameRequest\(\s*p\.id,\s*p\.branch,/);
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
  // #383: the adoption's pin is the policy's call (adoptedBranchPin) — a child's own `git branch -m` must not mint a human pin
  assert.match(adopt, /const pin = adoptedBranchPin\(fresh\);/);
  assert.match(adopt, /\.\.\.pinFields\(fresh, pin\),/);
  assert.match(activitySrc, /import \{ adoptedBranchPin, pinFields \} from '\.\.\/shared\/naming-policy\.ts';/);
});

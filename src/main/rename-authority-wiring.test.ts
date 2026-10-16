// #383 — SOURCE-LEVEL wiring guard for rename authority (human > parent > child). workspaces.ts / hooks-server.ts /
// sandbox-manager.ts import Electron and cannot be loaded under `node --test`, so the PRESENCE of the wiring is asserted
// against source text (same limitation and style as wave-run-anchor-wiring.test.ts); the decision itself is driven for
// real in src/shared/rename-authority.test.ts and the CLI wire in src/cli/rename-from.test.ts. Every assertion has a
// negative control (a planted regression the same matcher must flag) so it cannot pass against an empty/wrong file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const workspacesSrc = read('src/main/workspaces.ts');
const hooksSrc = read('src/main/hooks-server.ts');
const sandboxSrc = read('src/main/transport/sandbox-manager.ts');
const protocolSrc = read('src/shared/sandbox-protocol.ts');
const apiSrc = read('src/main/api-handlers.ts');
const cliSrc = read('src/cli/index.ts');

function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.ok(start > 0, `${decl} not found`);
  const after = src.slice(start + decl.length);
  const rel = after.search(/\n(export (async )?function|async function|function) /);
  return after.slice(0, rel > 0 ? rel : 4000);
}
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${from} not found`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `${to} not found after ${from}`);
  return src.slice(a, b);
};

// The route passes the caller's id through; a bare `(msg.id, msg.branch)` is the pre-#383 shape.
const PASSES_FROM_HOOKS = /dispatchRenameRequest\(\s*msg\.id,\s*msg\.branch,\s*typeof msg\.from === 'string' \? msg\.from : undefined\s*\)/;
const PASSES_FROM_SANDBOX = /dispatchRenameRequest\(\s*p\.id,\s*p\.branch,\s*typeof p\.from === 'string' \? p\.from : undefined\s*\)/;
// An inline authority copy: a comparison of the target's/caller's identity or pin fields, or a re-read of the nudge rule.
const INLINE_AUTHORITY = /(parentId|namedByParent|branchManuallySet|caller\.id|\bfrom)\s*[!=]==|[!=]==\s*[\w.]*(parentId|namedByParent|\bfrom\b)|autoRenameActive\(|nudgeActive\(|ws\.branchManuallySet|ws\.autoRenameCount/;

test('CONTROL: the sources are readable and non-trivial', () => {
  assert.ok(workspacesSrc.length > 10_000);
  assert.ok(hooksSrc.length > 5_000);
  assert.ok(sandboxSrc.length > 2_000);
  assert.ok(cliSrc.length > 10_000);
  assert.doesNotMatch(workspacesSrc, /zzzNoSuchPatternZzz/);
});

test('/rename (hooks-server) passes the caller identity `from` to dispatchRenameRequest', () => {
  const block = between(hooksSrc, "if (route === '/rename') {", "} else if (route === '/setBase')");
  assert.match(block, PASSES_FROM_HOOKS);
  // negative control: the pre-#383 call shape must NOT satisfy the matcher
  assert.doesNotMatch("send(200, await dispatchRenameRequest(msg.id, msg.branch));", PASSES_FROM_HOOKS);
  assert.doesNotMatch("dispatchRenameRequest(msg.id, msg.branch, undefined)", PASSES_FROM_HOOKS);
});

test('the sandbox transport route passes the caller identity too (a remote agent is a caller like any other)', () => {
  const block = between(sandboxSrc, "case 'rename': {", "case 'spawn': {");
  assert.match(block, PASSES_FROM_SANDBOX);
  assert.doesNotMatch("return reply(await dispatchRenameRequest(p.id, p.branch));", PASSES_FROM_SANDBOX);
  // the wire type carries it, so the shim's forward is typed
  assert.match(protocolSrc, /rename: \{ id: string; branch: string; from\?: string \};/);
});

test('the CLI sends `from` on rename (the built-CLI test pins the wire; this pins the source)', () => {
  const block = between(cliSrc, "case 'rename': {", "case 'set-base': {");
  assert.match(block, /request\('\/rename', \{ id, branch, from: selfWorkspaceId\(\) \}\)/);
  assert.doesNotMatch("request('/rename', { id, branch })", /from: selfWorkspaceId\(\)/);
});

test('dispatchRenameRequest builds an AGENT caller from `from` and asks the policy BEFORE touching git or the store', () => {
  const body = fnBody(workspacesSrc, 'export async function dispatchRenameRequest(');
  const decide = body.indexOf("decideRename(ws, { kind: 'agent', id: from }");
  assert.ok(decide > 0, "decideRename(ws, { kind: 'agent', id: from }, …) missing");
  const refuse = body.indexOf('if (!decision.allow) return { ok: false, error: decision.error };');
  assert.ok(refuse > decide, 'a refusal must return {ok:false, error} straight from the decision');
  // nothing that writes (git branch -m, the store, the sentinel) may precede the refusal
  for (const writer of ['renameWorkspaceBranch(', 'freeBranchName(', 'writeRenameProgress(', 'getCurrentBranch(']) {
    const at = body.indexOf(writer);
    assert.ok(at > refuse, `${writer} runs before the refusal returns`);
  }
  // the decision's pin (not a re-derivation) is what gets applied, at BOTH call sites (scratch relabel + git branch)
  assert.equal(body.split('renameWorkspaceBranch(id, target, pin)').length - 1, 2);
  // the policy gets the namer's name for the message, looked up from parentId then namedByParent
  assert.match(body, /\[ws\.parentId, ws\.namedByParent\]/);
  assert.match(body, /\{ parentName \}/);
});

test('NO inline authority copy in dispatchRenameRequest (the policy module is the only place)', () => {
  const dispatch = fnBody(workspacesSrc, 'export async function dispatchRenameRequest(');
  assert.doesNotMatch(dispatch, INLINE_AUTHORITY, 'dispatchRenameRequest re-implements the authority matrix');
  // negative controls: planted copies must be flagged by the same matcher
  assert.match("if (ws.parentId === from) return { ok: true };", INLINE_AUTHORITY);
  assert.match("if (from !== ws.parentId) return { ok: false };", INLINE_AUTHORITY);
  assert.match("const bump = autoRenameActive(ws);", INLINE_AUTHORITY);
  assert.match("if (ws.branchManuallySet) return refuse();", INLINE_AUTHORITY);
  assert.match("if (ws.namedByParent && ws.namedByParent !== from) return refuse();", INLINE_AUTHORITY);
});

test('a parent pin retires the LIVE session\'s rename nudge (sentinel budget spent), without counting a rename', () => {
  const body = fnBody(workspacesSrc, 'export async function dispatchRenameRequest(');
  assert.match(body, /else if \(pin\.namedByParent\) await writeRenameProgress\(ws\.worktreePath, MAX_AUTO_RENAMES\)/);
  assert.match(body, /if \(pin\.bumpAutoCount\) await writeRenameProgress\(ws\.worktreePath, updated\.autoRenameCount \?\? 0\)/);
});

test('the sidebar rename is the HUMAN caller of the same policy and still renames anything', () => {
  const handler = between(apiSrc, 'renameBranch: async (id, newBranch) => {', 'reorderWorkspaces:');
  assert.match(handler, /decideRename\(ws, \{ kind: 'human' \}\)/);
  assert.match(handler, /renameWorkspaceBranch\(id, newBranch, decision\.pin\)/);
  // negative control: the pre-#381 sidebar line bypassed the policy
  assert.doesNotMatch("renameBranch: (id, newBranch) => renameWorkspaceBranch(id, newBranch, { manual: true }),", /decideRename/);
  assert.doesNotMatch(handler, /\{ manual: true \}/);
  // a human is never refused: the handler only throws on the pin's own refusal branch, which decideRename never takes for `human`
  assert.doesNotMatch(handler, /parentId|namedByParent|branchManuallySet/, 'the sidebar handler re-implements authority');
});

test('renameWorkspaceBranch applies the decision\'s pin via pinFields; the same-name short-circuit asks pinAdvancesGate (a same-name parent rename still persists the namer)', () => {
  const body = fnBody(workspacesSrc, 'export async function renameWorkspaceBranch(');
  assert.match(body, /const gateFields = pinFields\(ws, opts\);/);
  assert.equal(body.split('if (pinAdvancesGate(ws, opts)) {').length - 1, 2, 'both same-name early returns (scratch relabel + live branch) go through the gate');
  assert.doesNotMatch(body, /opts\.manual && !ws\.branchManuallySet\) \|\| opts\.bumpAutoCount\) \{/, 'an inline copy of the gate');
  const policy = read('src/shared/naming-policy.ts');
  assert.match(policy, /pin\.namedByParent && pin\.namedByParent !== ws\.namedByParent/);
});

test('the generated orchestra-rename skill and the CLI help state the authority (human > parent > child)', () => {
  assert.match(workspacesSrc, /## Who may rename \(human > parent > child\)/);
  const help = read('src/cli/help.ts');
  assert.match(help, /Who may rename \(human > parent > child\)/);
  assert.match(help, /ORCHESTRA_WS_ID/);
});

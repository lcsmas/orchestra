// #382 — SOURCE-LEVEL guard for the spawn-name seam in un-importable modules (workspaces.ts, hooks-server.ts,
// sandbox-manager.ts import Electron/store and cannot load under `node --test`; same limitation as
// wave-run-anchor-wiring.test.ts). The pure rule is driven for real in shared/naming-policy-spawn-name.test.ts and the
// built CLI in cli/spawn-name.test.ts; this file pins WHERE the rule is consulted and WHERE it must NOT be (#380 D4).
// Every clause has a must-PASS (control) and a must-FAIL arm so it cannot pass against an empty or wrong file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialNaming, MAX_AUTO_RENAMES, NAME_CONVENTION, nudgeActive } from '../shared/naming-policy.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const workspacesSrc = read('src/main/workspaces.ts');
const hooksSrc = read('src/main/hooks-server.ts');
const sandboxSrc = read('src/main/transport/sandbox-manager.ts');
const linearSrc = read('src/main/linear-tickets.ts');
const mobileSrc = read('src/main/acces-mobile-routes.ts');
const cliSrc = read('src/cli/index.ts');

/** The text of `fn`'s body, from its declaration to the next top-level `\n}\n`. */
function bodyOf(src: string, decl: string): string {
  const i = src.indexOf(decl);
  assert.notEqual(i, -1, `declaration not found: ${decl}`);
  const j = src.indexOf('\n}\n', i);
  assert.notEqual(j, -1, `end of ${decl} not found`);
  return src.slice(i, j);
}

test('CONTROL: sources are readable and non-trivial; the extractor finds real bodies', () => {
  for (const [n, s] of Object.entries({ workspacesSrc, hooksSrc, sandboxSrc, linearSrc, mobileSrc, cliSrc })) assert.ok(s.length > 1_000, n);
  assert.match(bodyOf(workspacesSrc, 'export async function dispatchSpawnRequest('), /createWorkspace\(/);
});

test('the AGENT route requires the name: dispatchAgentSpawnRequest checks it FIRST, then maps it onto branch + namer', () => {
  const body = bodyOf(workspacesSrc, 'export async function dispatchAgentSpawnRequest(');
  const check = body.indexOf('checkSpawnName(input.name)');
  const dispatch = body.indexOf('dispatchSpawnRequest(');
  assert.ok(check !== -1 && dispatch !== -1 && check < dispatch, 'the check must precede the dispatch');
  assert.match(body, /if \(!checked\.ok\) return \{ ok: false,/); // refused → nothing created
  assert.match(body, /defaultKind: 'spawned'/);
  assert.match(body, /branch: checked\.name/); // the SANITISED name, onto the existing explicit-branch input
  assert.match(body, /namedBy: input\.from/); // the spawner is the namer — also for --detached (no parentId)
  assert.ok(workspacesSrc.includes("import { checkSpawnName, initialNaming,"), 'imported from the policy module');
});

test('hooks-server /spawn and the sandbox wire both go through dispatchAgentSpawnRequest, with the wire `name`', () => {
  const route = hooksSrc.slice(hooksSrc.indexOf("route === '/spawn'"), hooksSrc.indexOf("route === '/peers'"));
  assert.match(route, /dispatchAgentSpawnRequest\(/);
  assert.match(route, /name: typeof msg\.name === 'string' \? msg\.name : undefined/);
  assert.doesNotMatch(route, /dispatchSpawnRequest\(/);
  assert.doesNotMatch(route, /defaultKind/); // the kind is the wrapper's business, not the route's
  const rpc = sandboxSrc.slice(sandboxSrc.indexOf("case 'spawn':"), sandboxSrc.indexOf("case 'peers':"));
  assert.match(rpc, /dispatchAgentSpawnRequest\(/);
  assert.match(rpc, /name: typeof p\.name === 'string' \? p\.name : undefined/);
  assert.doesNotMatch(rpc, /dispatchSpawnRequest\(/);
});

test('D4 — the HUMAN paths reusing dispatchSpawnRequest pass NO name and NO namedBy, even when `from` is set', () => {
  // pinned-Linear `--spawn`: `from` set ⇒ defaultKind 'spawned' (an agent's `orchestra linear add --spawn`), still unnamed-by-parent.
  const linear = linearSrc.slice(linearSrc.indexOf('await dispatchSpawnRequest({'));
  const linearCall = linear.slice(0, linear.indexOf('});'));
  assert.match(linearCall, /defaultKind: from \? 'spawned' : 'workspace'/); // control: the shape the trap is about
  assert.match(linearCall, /branch,/); // its explicit key-first branch is untouched
  assert.doesNotMatch(linearCall, /namedBy|\bname\b/);
  assert.doesNotMatch(linearSrc, /dispatchAgentSpawnRequest|checkSpawnName/);
  // accès mobile launch
  const mobileCall = mobileSrc.slice(mobileSrc.indexOf('dispatchSpawnRequest({'), mobileSrc.indexOf('}),', mobileSrc.indexOf('dispatchSpawnRequest({')));
  assert.match(mobileCall, /defaultKind: 'workspace'/);
  assert.doesNotMatch(mobileCall, /namedBy|\bname\b/);
  assert.doesNotMatch(mobileSrc, /dispatchAgentSpawnRequest|checkSpawnName/);
});

test('D4 — dispatchSpawnRequest itself never demands a name: the requirement is NOT keyed on defaultKind', () => {
  const body = bodyOf(workspacesSrc, 'export async function dispatchSpawnRequest(');
  assert.doesNotMatch(body, /checkSpawnName/);
  assert.match(body, /\{ namedBy: input\.namedBy \}/); // forwarded only when the agent route set it
  assert.doesNotMatch(body, /namedBy: input\.from/); // dispatchSpawnRequest never invents a namer from `from`
});

test('createWorkspace records the namer through the policy module, not an inline field', () => {
  const body = bodyOf(workspacesSrc, 'export async function createWorkspace(');
  assert.match(body, /\.\.\.initialNaming\(\{ namedBy: naming\?\.namedBy \}\)/);
  assert.doesNotMatch(body, /branchManuallySet: false/);
  assert.doesNotMatch(body, /namedByParent:/); // no inline copy of the field
});

test('the CLI checks the name BEFORE the first socket call of the spawn case', () => {
  const spawnCase = cliSrc.slice(cliSrc.indexOf("case 'spawn': {"), cliSrc.indexOf("case 'rename': {"));
  const check = spawnCase.indexOf('checkSpawnName(rawName)');
  const sock = spawnCase.indexOf("request('/spawn'");
  assert.ok(check !== -1 && sock !== -1 && check < sock, 'checkSpawnName must precede request(/spawn)');
  assert.match(spawnCase, /name: named\.name/); // the SANITISED name is what is sent
  assert.doesNotMatch(spawnCase, /ROLES|startsWith\(/); // no inline copy of the rôle rule
});

test('no inline copy of the rôle rule outside the policy module', () => {
  for (const [n, s] of Object.entries({ workspacesSrc, hooksSrc, sandboxSrc, cliSrc })) {
    assert.doesNotMatch(s, /\['ops', 'impl'/, n);
    assert.doesNotMatch(s, /ops \| impl \| verif/, `${n} restates the list instead of NAME_CONVENTION`);
  }
});

// ── (c) the child receives no rename instruction: policy ⇒ env ⇒ the REAL installed hook script ──────────────────────
// The hook is a bash template in workspaces.ts. Evaluate that template and RUN it under the env the app would give.
function renameHookOutput(branchAuto: string): string {
  const i = workspacesSrc.indexOf('const RENAME_INSTRUCTION_SCRIPT = `');
  assert.notEqual(i, -1);
  const start = workspacesSrc.indexOf('`', i) + 1;
  const end = workspacesSrc.indexOf('\n`;\n', start);
  const script = new Function('MAX_AUTO_RENAMES', `return \`${workspacesSrc.slice(start, end)}\n\`;`)(MAX_AUTO_RENAMES) as string;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'orch-hook-'));
  try {
    const file = path.join(dir, 'rename-instruction.sh');
    fs.writeFileSync(file, script);
    const env = { PATH: process.env.PATH ?? '', ORCHESTRA_BRANCH_AUTO: branchAuto, ORCHESTRA_SOCK: path.join(dir, 's.sock'), ORCHESTRA_WORKTREE: dir, ORCHESTRA_AUTO_RENAME_COUNT: '0' };
    return execFileSync('bash', [file], { env, encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('agent-sdk derives ORCHESTRA_BRANCH_AUTO from the policy (single source), never from a field of its own', () => {
  const agentSdkSrc = read('src/main/agent-sdk.ts');
  assert.match(agentSdkSrc, /env\.ORCHESTRA_BRANCH_AUTO = (nudgeActive|autoRenameActive)\(ws\) \? '1' : '0'/);
});

test('end to end — a child born named-by-parent: policy off ⇒ env 0 ⇒ the installed hook prints NOTHING; a human-created one is nudged', () => {
  const named = initialNaming({ namedBy: 'parent-ws' });
  const human = initialNaming();
  assert.equal(nudgeActive(named), false);
  assert.equal(nudgeActive(human), true); // must-FAIL arm of the clause: without !namedByParent this would also be true for `named`
  // control: the hook DOES speak when the gate is open (the template evaluated and ran)
  assert.match(renameHookOutput(nudgeActive(human) ? '1' : '0'), /Rename it NOW/);
  // the child's gate: closed ⇒ silent, on SessionStart and on every later UserPromptSubmit alike (same script, same gate)
  assert.equal(renameHookOutput(nudgeActive(named) ? '1' : '0'), '');
});

test('the spawn skill and the orchestrator brief carry --name and the convention verbatim (single-sourced)', () => {
  assert.match(workspacesSrc, /orchestra spawn --name impl-politique-nommage-381 --task/);
  assert.match(workspacesSrc, /orchestra spawn --detached --name explo-/);
  assert.ok(workspacesSrc.includes('${NAME_CONVENTION}'), 'the skill/brief interpolate NAME_CONVENTION');
  assert.ok(NAME_CONVENTION.length > 40);
});

test('G10 — every doc that teaches `orchestra spawn` shows --name (and the guides the convention verbatim)', () => {
  for (const f of ['docs/guide/cli.md', 'docs/guide/multi-agent.md']) {
    const s = read(f);
    assert.ok(s.includes('--name'), `${f} lacks --name`);
    assert.ok(s.includes(NAME_CONVENTION), `${f} lacks the convention verbatim`);
  }
  assert.match(read('README.md'), /orchestra spawn --name /);
  assert.match(read('src/renderer/components/Help.tsx'), /orchestra spawn --name /);
  const help = read('src/cli/help.ts');
  assert.ok(help.includes('${NAME_CONVENTION}') && help.includes('--name <name>'));
  for (const f of ['docs/codebase-map/workspaces.md', 'docs/codebase-map/hooks-cli-socket.md']) assert.ok(read(f).includes('dispatchAgentSpawnRequest') || read(f).includes('#382'), f);
});

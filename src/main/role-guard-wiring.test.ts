// #468 — the WIRING of the role guard + the role sentinel, pinned structurally (workspaces.ts imports Electron seams and cannot run
// under `node --test`); the deny BEHAVIOUR of the installed string is src/shared/role-guard.matrix.ts, the real CLI is
// `pnpm run test:role-guard-cli`. The sentinel writer itself is driven for real below.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRoleSentinel } from './role-sentinel.ts';

function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
  return raw.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
}

test('the guard is written, wired on PreToolUse, and part of the hook-bundle hash', () => {
  const w = codeOf('src/main/workspaces.ts');
  assert.ok(/w\('role-guard\.sh', ROLE_GUARD_SCRIPT\)/.test(w), 'script written');
  assert.ok(/upsertMatcherHookCommand\(preToolList, ROLE_GUARD_MATCHER, HOOK_ROLE_GUARD_CMD\)/.test(w), 'wired');
  const hash = w.slice(w.indexOf('const HOOKS_VERSION'), w.indexOf('.digest('));
  for (const k of ['ROLE_GUARD_SCRIPT', 'HOOK_ROLE_GUARD_CMD', 'ROLE_GUARD_MATCHER']) assert.ok(hash.includes(k), `${k} in the hash`);
});

test('#446: no deny-guard command swallows exit 2 with `|| true`', () => {
  const w = codeOf('src/main/workspaces.ts');
  for (const name of ['HOOK_ORCHESTRATOR_GUARD_CMD', 'HOOK_HOME_ROOT_GUARD_CMD', 'HOOK_TMP_GUARD_CMD']) {
    const at = w.indexOf(`const ${name} =`);
    assert.ok(at > 0, name);
    const decl = w.slice(at, w.indexOf("';\n", at));
    assert.ok(!/\|\|\s*true/.test(decl), `${name} must not end in || true: ${decl}`);
    assert.ok(/\[ -f "\$f" \] \|\| exit 0; bash "\$f"/.test(decl), `${name} uses the exit-preserving form`);
  }
});

test('#446: an install evicts a legacy `|| true` orchestrator-guard entry from an existing settings.local.json', () => {
  const w = codeOf('src/main/workspaces.ts');
  const at = w.indexOf('let preToolList');
  assert.ok(at > 0 && w.indexOf("cmd.includes('.orchestra/orchestrator-guard.sh')", at) > at, 'evicts by script + `|| true`');
  assert.ok(w.indexOf('removeHookCommand(preToolList', at) < w.indexOf('upsertMatcherHookCommand(preToolList, ORCHESTRATOR_GUARD_MATCHER', at), 'before the upsert');
});

test('the sentinel is refreshed on a rename (3 sites) and on every real install (outside the hash gate) and at creation', () => {
  const w = codeOf('src/main/workspaces.ts');
  const inst = w.slice(w.indexOf('export async function installOrchestraHooks('));
  assert.ok(inst.indexOf('writeRoleSentinel(worktreePath') > 0 && inst.indexOf('writeRoleSentinel(worktreePath') < inst.indexOf("const stamp = path.join(dir, '.hooks-version')"), 'before the stamp short-circuit');
  assert.equal((w.match(/writeRoleSentinel\(updated\.worktreePath, updated\.branch, updated\.spawnRole\)/g) ?? []).length, 3, 'rename re-writes the role (#489: from the record\'s frozen spawnRole first)');
  assert.ok(/writeRoleSentinel\(worktreePath, roleWs\.branch, roleWs\.spawnRole\)/.test(w), 'every session start: same anchor');
  assert.ok(/initialNaming\(\{ namedBy: naming\?\.namedBy, \.\.\.\(naming\?\.exactName \? \{ spawnName: branch \} : \{\}\) \}\)/.test(w), '#489: only the agent spawn route freezes a role');
  assert.ok(!/writeRoleSentinel\([^)]*\.name\)/.test(w), 'never from ws.name');
  assert.ok(/writeRoleSentinel\(ws\.worktreePath, ws\.branch, ws\.spawnRole\)/.test(w), 'at creation (startBusRunAndWriteNotice), from the BRANCH — ws.name is "<repo> · <branch>" and maps to no role');
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'role-sentinel-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('writeRoleSentinel: role word from the --name prefix, removed when the name has none, idempotent', async () => {
  const wt = path.join(root, 'wt');
  const file = path.join(wt, '.orchestra', 'role');
  assert.equal(await writeRoleSentinel(wt, 'impl-role-guard-468'), 'implementer');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'implementer');
  const ino = fs.statSync(file).ino;
  assert.equal(await writeRoleSentinel(wt, 'impl-other'), 'implementer');
  assert.equal(fs.statSync(file).ino, ino, 'unchanged role: no rewrite');
  assert.equal(await writeRoleSentinel(wt, 'ops-verified-fanout-v2'), 'coordinator');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'coordinator');
  assert.equal(await writeRoleSentinel(wt, 'scribe-x'), 'scribe');
  // a name WITHOUT a role prefix (human session, LEAD, plain agent) removes the file ⇒ the guard is inert again
  assert.equal(await writeRoleSentinel(wt, 'fix-the-thing'), null);
  assert.ok(!fs.existsSync(file));
  assert.equal(await writeRoleSentinel(wt, undefined), null);
  assert.equal(await writeRoleSentinel(wt, 'implementer-lookalike'), null, 'prefix is `impl-`, not a substring');
});

// #446 BEHAVIOUR: the orchestrator guard's INSTALLED command (read from workspaces.ts, not copied) now lets its exit 2 through.
test('#446: the installed orchestrator-guard command denies with exit 2; the old `|| true` form swallowed it', async () => {
  const { spawnSync } = await import('node:child_process');
  const { COORDINATOR_HOOK_GATE } = await import('../shared/run-position.ts');
  const src = fs.readFileSync(path.join(process.cwd(), 'src/main/workspaces.ts'), 'utf8');
  const lit = src.slice(src.indexOf('const ORCHESTRATOR_GUARD_SCRIPT = `') + 'const ORCHESTRATOR_GUARD_SCRIPT = '.length);
  const tpl = lit.slice(0, lit.indexOf('`;\n') + 1);
  const script = new Function('COORDINATOR_HOOK_GATE', `return ${tpl};`)(COORDINATOR_HOOK_GATE) as string;
  const cmdDecl = src.slice(src.indexOf('const HOOK_ORCHESTRATOR_GUARD_CMD =') + 'const HOOK_ORCHESTRATOR_GUARD_CMD ='.length);
  const cmd = new Function(`return ${cmdDecl.slice(0, cmdDecl.indexOf("';\n") + 1).trim()};`)() as string;
  const wt = path.join(root, 'home', '.orchestra', 'worktrees', 'ops-own');
  fs.mkdirSync(path.join(wt, '.orchestra'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.orchestra', 'orchestrator-guard.sh'), script, { mode: 0o755 });
  fs.writeFileSync(path.join(wt, '.orchestra', '.orchestrator'), '1');
  const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(root, 'home', '.orchestra', 'worktrees', 'impl-child', 'a.ts') } });
  const go = (c: string) => spawnSync('bash', ['-c', c], { input: payload, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), ORCHESTRA_WORKTREE: wt } });
  const real = go(cmd);
  assert.equal(real.status, 2, `${real.stderr}\n--script--\n${script.slice(0, 400)}`);
  assert.match(real.stderr, /BLOCKED: you are an ORCHESTRATOR/);
  assert.equal(go(`${cmd} || true`).status, 0, 'the broken form swallows the deny — the must-FAIL arm');
});

test('#489: the role frozen at spawn survives any rename — sentinel keeps it; a record without one still follows its name', async () => {
  const wt = path.join(root, 'wt489');
  const file = path.join(wt, '.orchestra', 'role');
  assert.equal(await writeRoleSentinel(wt, 'impl-manual-return-button-4454', 'implementer'), 'implementer');
  // a self-rename / parent rename / out-of-band `git branch -m` to an unprefixed name, then the session-start refresh:
  assert.equal(await writeRoleSentinel(wt, 'nmc-4455-carrier-return-state', 'implementer'), 'implementer');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'implementer', 'guard still armed');
  // even a rename to ANOTHER role's prefix cannot change it
  assert.equal(await writeRoleSentinel(wt, 'ops-whatever', 'implementer'), 'implementer');
  // control (the other direction): no frozen role ⇒ today's name-derived rule (human-created / pre-#489 record)
  assert.equal(await writeRoleSentinel(wt, 'nmc-4455-carrier-return-state'), null);
  assert.ok(!fs.existsSync(file), 'no anchor + no prefix ⇒ guard inert');
  assert.equal(await writeRoleSentinel(wt, 'impl-x'), 'implementer');
});

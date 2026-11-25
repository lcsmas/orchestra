// #587 PR B — the production half of `fanout start` + the hand-spawn refusal, pinned by source (workspaces.ts / the wiring import the store / Electron seam and cannot run under node --test).
// The decisions are pure and driven in src/cli/fanout-start.test.ts: this pins that the main process USES them, and that nothing from the socket can reach the bypass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
const bodyOf = (src: string, head: string): string => { const i = src.indexOf(head); assert.ok(i >= 0, `control: found ${head}`); return src.slice(i, i + 3500); };

test('dispatchAgentSpawnRequest asks handSpawnRefusalFor right after the name check, before anything is created; the bypass is a second, in-process argument', () => {
  const src = read('workspaces.ts');
  const head = src.slice(src.indexOf('export async function dispatchAgentSpawnRequest('), src.indexOf('): Promise<SpawnResult> {', src.indexOf('export async function dispatchAgentSpawnRequest(')));
  assert.match(head, /opts: \{ viaFanoutStart\?: boolean \} = \{\}/);
  const body = bodyOf(src, 'export async function dispatchAgentSpawnRequest(');
  const iName = body.indexOf('checkSpawnName(input.name)');
  const iHand = body.indexOf('handSpawnRefusalFor(orchestraHome(), fromWs ? resolveWaveRunId(fromWs) : input.from, checked.name, opts.viaFanoutStart === true)');
  const iDispatch = body.indexOf('return dispatchSpawnRequest(');
  assert.ok(iName >= 0 && iHand > iName && iDispatch > iHand, 'name check → hand-spawn refusal → dispatch');
  assert.match(body, /if \(handSpawn\) return \{ ok: false, error: handSpawn \}/);
});

test('the socket cannot set the bypass: /spawn and the sandbox wire call dispatchAgentSpawnRequest with ONE argument', () => {
  for (const f of ['hooks-server.ts', 'transport/sandbox-manager.ts']) assert.doesNotMatch(read(f), /viaFanoutStart/, f);
});

test('only the implementer door of `fanout start` passes viaFanoutStart; the acceptor spawn does not; liveness = exists and not archived', () => {
  const src = read('fanout-acceptance-wiring.ts');
  assert.equal((src.match(/viaFanoutStart: true/g) ?? []).length, 1);
  const impl = src.slice(src.indexOf('spawnImplementer:'), src.indexOf('childrenOf:'));
  assert.match(impl, /\{ viaFanoutStart: true \}\)/);
  assert.match(impl, /baseBranch/);
  assert.match(impl, /\.\.\.\(i\.reuseBranch \? \{ reuseBranch: true \} : \{\}\)/);
  const acc = src.slice(src.indexOf('spawn: async (i)'), src.indexOf('implementerLive'));
  assert.doesNotMatch(acc, /viaFanoutStart/);
  assert.match(src, /vouches: \(id, key\) => !!key && sessionKeys\(\)\.verify\(id, key\) === 'ok'/);
  assert.match(src, /orphanImplementer: \(\{ run, name, recorded, others \}\) =>/);
  assert.match(src, /store\.workspaces\.find\(\(x\) => x\.parentId === run && !x\.archived && !recorded\.includes\(x\.id\) && named\(x\.branch\) && !others\.includes\(x\.branch\)\)/);
  assert.match(src, /implementerLive: \(id\) => \{ const w = store\.getWorkspace\(id\); return !!w && !w\.archived; \}/);
});

test('the CLI routes `fanout start` through runStart, vouched by the host like a freeze', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../cli/index.ts'), 'utf8');
  const i = src.indexOf("if (args[0] === 'start') {");
  assert.ok(i > 0);
  const blk = src.slice(i, i + 900);
  assert.match(blk, /const helpOnly = args\.includes\('--help'\) \|\| args\.includes\('-h'\);/, 'a --help start is not a start: no host question');
  assert.match(blk, /if \(!helpOnly\) await settleHostIdentity\(\);/);
  assert.match(blk, /if \(!helpOnly && hostIdentity\?\.source !== 'host'\) fail\('refusing to start:/, 'fail closed: no key is not a vouch either');
  assert.match(blk, /fanoutDeps\.vouchedCaller = /);
  assert.match(blk, /runStart\(args\.slice\(1\), fanoutDeps, \(body\) => request\('\/fanoutAcceptance', body/);
});

test('reuseBranch rides createWorkspace\'s naming (no suffix pick, git reuse) and cannot come from the socket', () => {
  const w = read('workspaces.ts');
  assert.match(w, /const free = requested && naming\?\.reuseBranch \? requested : requested \? await freeBranchName\(/);
  assert.match(w, /createWorktree\(input\.repoPath, branch, baseBranch, worktreePath, naming\?\.reuseBranch \? \{ reuse: true \} : undefined\)/);
  assert.match(w, /\.\.\.\(input\.reuseBranch \? \{ reuseBranch: true \} : \{\}\) \}, input\.profile/);
  for (const f of ['hooks-server.ts', 'transport/sandbox-manager.ts', 'acces-mobile.ts']) { try { assert.doesNotMatch(read(f), /reuseBranch/, f); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
});

test('#599 the production wiring answers the worktree repo (the coordinator\'s repo: remote + default branch) and the ref check; a spawn without a base is cut from the repo default', () => {
  const src = read('fanout-acceptance-wiring.ts');
  assert.match(src, /worktreeRepo: async \(\{ run, repoPath \}\) => \{\n\s+const p = repoPath \?\? store\.getWorkspace\(run\)\?\.repoPath;\n\s+const r = store\.repos\.find\(\(x\) => x\.path === p\);\n\s+return \{ remote: r\?\.remoteUrl \?\? \(p \? \(await detectRemoteUrl\(p\)\) \?\? null : null\), defaultBranch: r\?\.defaultBranch \?\? null \};/);
  assert.match(src, /refExists: \(\{ run, repoPath, ref \}\) => \{ const p = repoPath \?\? store\.getWorkspace\(run\)\?\.repoPath; return p \? refResolves\(p, ref\) : Promise\.resolve\(true\); \}/);
  assert.match(read('workspaces.ts'), /const baseBranch = input\.baseBranch \|\| repo\?\.defaultBranch \|\| 'main';/, 'createWorkspace: no base = the repo default (what a cross-repo start relies on)');
  assert.match(read('git.ts'), /export async function refResolves\(repoPath: string, ref: string\)/);
});

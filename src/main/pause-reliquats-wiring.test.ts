// #325 — the production WIRING of the Reliquat kill, pinned structurally (the host imports Electron-coupled modules; the behaviour is proven by pause-reliquats.test.ts, pause-trap-reliquats.test.ts
// and the rig scripts/pause-trap/reliquat-rig.mjs over a real keeper in a real scope). Each assertion is a STRUCTURAL relationship over comment-stripped source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = raw.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
  assert.ok(code.length > 400, `comment-stripping ${rel} returned too little`);
  return code;
}
const at = (code: string, needle: string): number => {
  const i = code.indexOf(needle);
  assert.notEqual(i, -1, `not found: ${needle}`);
  return i;
};

test('the host binds the Reliquat kill to the member scope ADAPTER and the SAME process-kill deps as the tool trees — one place meets memberScopes/listScopeProcs', () => {
  const host = codeOf('src/main/pause-trap-host.ts');
  assert.ok(host.includes('killReliquats: (m, opts) => killReliquats(m.wsId, memberScopeDeps(m.wsId), kill, opts),'), 'bound per member, over the adapter, with the app\'s one `kill` deps');
  assert.ok(host.includes("import { killReliquats } from './pause-reliquats';") && host.includes("import { memberScopeDeps } from './pause-reliquats-scope';"));
  // FI-1 v1.3: no consumer resolves a scope any other way
  for (const rel of ['src/main/pause-reliquats.ts', 'src/main/pause-trap.ts', 'src/main/pause-trap-host.ts', 'src/shared/pause-reliquats.ts']) {
    const code = codeOf(rel);
    assert.ok(!/memberScopes|listScopeProcs|classifyScopeMembers|memory-scope/.test(code.replace("import type { ClassifiedMember, ScopeRole } from './memory-scope.ts';", '')), `${rel} must not touch the scope readers (only the adapter does)`);
    assert.ok(!/\/sys\/fs\/cgroup|app\.slice|user@|cgroup\.kill|systemctl|systemd-run/.test(code), `${rel} must not hard-code a cgroup path or drive systemd`);
  }
  const adapter = codeOf('src/main/pause-reliquats-scope.ts');
  assert.ok(/from '\.\/memory-scope\.ts'/.test(adapter));
  assert.ok(!/\/sys\/fs\/cgroup|systemctl|systemd-run|cgroup\.kill/.test(adapter));
});

test('trapMember: the Reliquat step runs AFTER the tool-tree kill and BEFORE the container stop, only under a proven session (or none), and a lift returns before the containers', () => {
  const code = codeOf('src/main/pause-trap.ts');
  const body = code.slice(at(code, 'export async function trapMember('));
  const trees = at(body, 'const rep = await deps.killTrees(');
  const step = at(body, "if (deps.killReliquats && (target === null || !('error' in target))) {");
  const call = at(body, 'const rep = await deps.killReliquats(m, {');
  const docker = at(body, 'const res = await stopAttributedContainers(');
  assert.ok(trees < step && step < call && call < docker, 'order: tool trees → Reliquats → containers');
  const stepSrc = body.slice(step, docker);
  assert.ok(stepSrc.includes('keeperPid: proven ? proven.keeperPid : null,') && stepSrc.includes('cliPid: proven ? proven.cli.pid : null,'), 'the PROVEN keeper/CLI are handed over (never signalled)');
  assert.ok(stepSrc.includes('stillPaused: () => stillPaused(db, carrier),') && stepSrc.includes('humanWindows: humanWindowsNow,'), 'the lift check and the human windows are the tool kill\'s own');
  assert.ok(stepSrc.includes('...(pauseCallPids.length ? { protectPids: pauseCallPids } : {}),'), 'the pauser\'s process chain is protected');
  assert.ok(stepSrc.includes("if (rep.aborted === 'lifted') {") && stepSrc.indexOf("return 'lifted'") > stepSrc.indexOf("if (rep.aborted === 'lifted') {"));
});

test('the killer signals through ONE call site, preceded by the signal-time judgement (fresh scope listing + identity + role + ancestry) — no other way to deliver a signal', () => {
  const code = codeOf('src/main/pause-reliquats.ts');
  assert.equal((code.match(/kill\.signal\(/g) ?? []).length, 1, 'exactly one signal call');
  assert.ok(!/process\.kill\(|child_process|execFile|spawn\(/.test(code), 'no other way to signal or shell out');
  const fn = code.slice(at(code, 'const signalOne = (t: Target, sig:'));
  assert.ok(at(fn, 'judgeReliquat(t.pid, t.startTicks, t.scope, scopeDeps.list(t.scope), protect, kill.read)') < at(fn, 'kill.signal(t.pid, sig)'), 'judged against a listing read NOW, then signalled');
  const loop = code.slice(at(code, 'for (let round = 1; round <= maxRounds; round++) {'));
  assert.ok(loop.includes("signalOne(t, 'SIGTERM')") && loop.includes("signalOne(t, 'SIGKILL')"), 'both signals go through it');
  assert.ok(at(loop, "signalOne(t, 'SIGKILL')") > at(loop, 'if (!alive(t)) continue;'), 'SIGKILL only for a same-identity survivor');
});

test('the scope adapter reads cgroup.procs BEFORE listScopeProcs (gone/unreadable ≠ empty) and re-resolves the scope (fresh keeper) at every listing', () => {
  const code = codeOf('src/main/pause-reliquats-scope.ts');
  const fn = code.slice(at(code, 'list: (scope): ScopeListing => {'));
  assert.ok(at(fn, "e.readFile(path.join(scope.cgroupDir, 'cgroup.procs'))") < at(fn, 'memberScopes(wsId, e).find((s) => s.unit === scope.unit)'));
  assert.ok(at(fn, 'memberScopes(wsId, e).find((s) => s.unit === scope.unit)') < at(fn, 'listScopeProcs(fresh, null, e)'));
  assert.ok(fn.includes("? 'gone' : 'unreadable'"));
});

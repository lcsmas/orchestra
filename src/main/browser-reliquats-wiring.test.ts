// #331 — the production WIRING of the browser-Reliquat bridge, pinned structurally (the monitor / host import Electron-coupled modules; behaviour is proven by browser-reliquats.test.ts,
// the driven real tick (browser-reliquats-monitor.test.ts) and the rig with real headless Chromium). Each assertion is a STRUCTURAL relationship over comment-stripped source.

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

test('the 60 s tick runs the browser pass AFTER the reap and ONLY when the bridge is installed; only the production deps install it (defaultDeps never touches a browser)', () => {
  const code = codeOf('src/main/resource-monitor.ts');
  const tick = code.slice(at(code, 'export async function sampleTick('));
  assert.ok(at(tick, 'await reapPass(d, table, keeperRoots, liveWorkspaceIds)') < at(tick, 'if (d.browser) {'), 'reap first, browsers after');
  assert.ok(at(tick, 'if (d.browser) {') < at(tick, 'if (d.refreshContainers)'), 'before the (slow, Docker) container pass');
  assert.ok(tick.includes('await browserPass(d.browser.deps, d.browser.tracker, table)'));
  assert.ok(tick.includes('d.browser.notifyOwner(ws, browserStatusText(list))'), 'one status per member per pass');
  const def = code.slice(at(code, 'const defaultDeps: ResourceMonitorDeps = {'), at(code, 'let prevTicks = new Map<number, number>();'));
  assert.ok(!def.includes('browser'), 'defaultDeps does not carry the bridge');
  const prod = code.slice(at(code, 'export function productionDeps()'));
  assert.ok(prod.slice(0, 700).includes('browser: productionBrowserBridge(),'));
});

test('the production bridge: agent-tmp under the home, a workspace the LOADED store knows, the real /proc client reader, the bus for the owner\'s status; the Pause dure goes through the SAME tracker', () => {
  const code = codeOf('src/main/resource-monitor.ts');
  const b = code.slice(at(code, 'export function productionBrowserBridge()'), at(code, 'export function getBrowserReliquatView()'));
  assert.ok(b.includes("agentTmpRoot: () => path.join(os.homedir(), AGENT_TMP_REL),"));
  assert.ok(b.includes('workspaceKnown: (id) => store.loadedFromDisk && !!store.getWorkspace(id),'), 'an unloaded store attributes nothing');
  assert.ok(b.includes('clientState: (pid) => realClientState(pid),'));
  assert.ok(b.includes("sender: 'host', kind: 'status', recipient: wsId"));
  assert.ok(b.includes('if (bridge) return bridge;') && b.includes('tracker: new BrowserTracker(),'), 'one tracker for the process');
  const pause = code.slice(at(code, 'export async function stopBrowserReliquatsOf('));
  assert.ok(pause.includes('productionBrowserBridge()') && pause.includes('onlyWs: wsId, ignoreWindow: true'), 'a Pause dure: one member, no idle window');
  const host = codeOf('src/main/pause-trap-host.ts');
  assert.ok(host.includes('killBrowserReliquats: (m, opts) => stopBrowserReliquatsOf(m.wsId, {'), 'the host binds the Pause dure to the monitor\'s bridge');
  const res = codeOf('src/main/resources.ts');
  assert.ok(res.includes('browserReliquats: getBrowserReliquatView(),'), 'the Resources snapshot carries the per-workspace counter');
});

test('trapMember: the browser step runs after the scope step and before the containers, independent of the session proof, never for a remote member', () => {
  const code = codeOf('src/main/pause-trap.ts');
  const body = code.slice(at(code, 'export async function trapMember('));
  const scope = at(body, 'const rep = await deps.killReliquats(m, {');
  const step = at(body, 'if (deps.killBrowserReliquats) {');
  const docker = at(body, 'const res = await stopAttributedContainers(');
  assert.ok(scope < step && step < docker, 'scope Reliquats → browsers → containers');
  const stepSrc = body.slice(step, docker);
  assert.ok(!/\berror\b' in target|target === null/.test(stepSrc), 'not gated on the session proof');
  assert.ok(stepSrc.includes('stillPaused: () => stillPaused(db, carrier),') && stepSrc.includes("combineReliquats(activity.reliquats, b, { replaceSource: 'browser' })"));
  assert.ok(stepSrc.includes('humanWindows: humanWindowsNow,') && stepSrc.includes('ignoreWindow: !(pauser || carriedPauser),'), 'D9 windows + the pauser keeps its idle window');
  assert.ok(stepSrc.includes('persistLifted();'), 'a lift persists the whole row');
  assert.ok(at(body, 'if (m.remote) {') < step, 'the remote member returned long before');
});

test('the browser module only READS the profile and /proc: no way to remove, rewrite or rename a file; every signal is preceded by a fresh identity read', () => {
  for (const rel of ['src/main/browser-reliquats.ts', 'src/shared/browser-reliquats.ts']) {
    const code = codeOf(rel);
    assert.ok(!/rmSync|\.rm\(|unlink|rmdir|writeFile|appendFile|rename\(|truncate|child_process|execFile|spawn\(/.test(code), `${rel} must not modify the filesystem or shell out`);
  }
  const code = codeOf('src/main/browser-reliquats.ts');
  const term = at(code, "d.signal(m.pid, 'SIGTERM')");
  assert.ok(at(code, 'const fresh = d.readProcStat(t.main.pid);') < term && at(code, 'sameArgv(d.readCmdline(t.main.pid), t.argv)') < term, 'identity + argv re-read before the first signal');
  assert.ok(at(code, 'if (!f || f.startTicks !== m.startTicks) continue;') < at(code, "d.signal(m.pid, 'SIGKILL')"), 'SIGKILL only for a same-identity survivor');
  assert.equal((code.match(/d\.signal\(/g) ?? []).length, 2, 'exactly the SIGTERM and the SIGKILL call sites');
});

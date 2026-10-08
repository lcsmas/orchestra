// #330 — the production WIRING of the resilient watchers, pinned structurally (the sites import Electron / the store, so they cannot run under `node --test`; the behaviour is proven by src/shared/resilient-watch.test.ts,
// src/main/watchers.test.ts and the composition rig scripts/e2e-resilient-watchers.mjs). Each assertion is a relationship over comment-stripped source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function strip(rel: string): string {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return raw.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
}
function codeOf(rel: string): string {
  const code = strip(rel);
  assert.ok(code.length > 300, `comment-stripping ${rel} returned too little`);
  return code;
}
const at = (code: string, needle: string): number => {
  const i = code.indexOf(needle);
  assert.notEqual(i, -1, `not found: ${needle}`);
  return i;
};

/** The seven sites: file, watcher name, the catch-up pass its recovery runs, the call that stops it. */
const SITES: Array<{ file: string; name: string; recover: RegExp; stop: RegExp }> = [
  { file: 'src/main/bus-wake.ts', name: 'bus-wake', recover: /onRecover: \(\) => void sweepBusWake\(\)/, stop: /watcher\?\.stop\(\)/ },
  { file: 'src/main/pause-ui-host.ts', name: 'pause-ui', recover: /onRecover: reconcilePauseUi/, stop: /watcher\?\.stop\(\)/ },
  { file: 'src/main/pause-trap.ts', name: 'pause-trap', recover: /onRecover: \(\) => \{\s*if \(activeDeps\) void sweepPauseTrap\(activeDeps\)/, stop: /watcher\?\.stop\(\)/ },
  { file: 'src/main/human-gates.ts', name: 'human-gates', recover: /onRecover: reconcileHumanGates/, stop: /watcher\?\.stop\(\)/ },
  { file: 'src/main/inbox-tray.ts', name: 'inbox-tray', recover: /onRecover: \(\) => \{[^}]*broadcastInbox\(ws\.id\)/, stop: /watcher\?\.stop\(\)/ },
  { file: 'src/main/events-spool.ts', name: 'events-spool', recover: /onRecover: drainAll/, stop: /watcher\.stop\(\)/ },
  { file: 'src/main/account-usage.ts', name: 'login-watch', recover: /onRecover: check/, stop: /fsWatcher\.stop\(\)/ },
];

test('NO HAND-ROLLED DIRECTORY WATCH in the main process: `fs.watch(` appears only in src/main/watchers.ts (the shared primitive)', () => {
  const offenders: string[] = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'src/main'))) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const code = strip(`src/main/${f}`);
    if (/\bfs\.watch\(|\bwatchFile\(/.test(code) && f !== 'watchers.ts') offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'every directory watch goes through createWatcher()');
  assert.ok(/fs\.watch\(/.test(codeOf('src/main/watchers.ts')), 'the shared primitive is the one fs.watch');
});

for (const site of SITES) {
  test(`SITE ${site.name} (${site.file}): created through createWatcher with its fallback, runs ONE catch-up on recovery, stop() cancels the retries`, () => {
    const code = codeOf(site.file);
    assert.ok(/import \{ createWatcher \} from '\.\/watchers(\.ts)?';/.test(code), 'imports the shared factory');
    const i = at(code, `name: '${site.name}'`);
    const spec = code.slice(i - 80, i + 1500);
    assert.ok(/fallback:/.test(spec), 'the spec names the fallback that keeps the subsystem working meanwhile');
    assert.ok(site.recover.test(code.slice(i)), `the catch-up pass: ${site.recover}`);
    assert.ok(site.stop.test(code), `the owner's stop() stops the watcher: ${site.stop}`);
    assert.ok(/\.start\(\);/.test(code.slice(i)), 'the watcher is started');
  });
}

test('the sites that used to mkdir before watching still create their directory on every arm (ensureDir); the bus-dir sites for the engine / trap do not', () => {
  for (const [file, name] of [['src/main/pause-ui-host.ts', 'pause-ui'], ['src/main/human-gates.ts', 'human-gates'], ['src/main/inbox-tray.ts', 'inbox-tray']] as const) {
    const code = codeOf(file);
    assert.ok(/ensureDir: true/.test(code.slice(at(code, `name: '${name}'`))), `${name}: ensureDir`);
  }
  for (const [file, name] of [['src/main/bus-wake.ts', 'bus-wake'], ['src/main/pause-trap.ts', 'pause-trap']] as const) {
    const code = codeOf(file);
    assert.ok(!/ensureDir/.test(code.slice(at(code, `name: '${name}'`), at(code, `name: '${name}'`) + 900)), `${name}: never creates the bus directory`);
  }
});

test('the transient login watch stays non-persistent (it must never keep the process alive)', () => {
  const code = codeOf('src/main/account-usage.ts');
  assert.ok(/persistent: false/.test(code.slice(at(code, "name: 'login-watch'"))), 'persistent:false is forwarded');
});

test('index.ts: the push is subscribed BEFORE the first watch is armed; the pull is registered ONCE at module scope; shutdown stops every watcher', () => {
  const s = codeOf('src/main/index.ts');
  assert.equal(s.split('registerWatchersIpc();').length - 1, 1, 'registered exactly once');
  assert.ok(/^registerWatchersIpc\(\);/m.test(fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8')), 'column 0 — module scope');
  assert.equal(s.split('pushWatchersToRenderer();').length - 1, 1, 'subscribed exactly once');
  const push = at(s, 'pushWatchersToRenderer();');
  for (const start of ['startEventsSpool();', 'startInboxWatcher();', 'startHumanGatesWatcher();', 'startPauseUiWatcher();', 'startBusWake();', 'startPauseTrap(']) {
    assert.ok(push < at(s, start), `subscribed before ${start}`);
  }
  const shut = s.slice(at(s, 'function shutdownSubsystems(): void {'));
  const body = shut.slice(0, shut.indexOf('\n}\n'));
  assert.ok(body.includes('stopAllWatchers();'), 'shutdown cancels every pending retry');
});

test('bus-status: the /busStatus payload carries `watchers` and the CLI prints the block (absent from an older app → no line)', () => {
  const hs = codeOf('src/main/hooks-server.ts');
  assert.ok(/watchers: watchersStatus\(\),/.test(hs), 'the payload key');
  const cli = codeOf('src/cli/index.ts');
  const i = at(cli, 'formatWatchersLines(res.watchers as WatchersStatus');
  assert.ok(/res\.watchers && typeof res\.watchers === 'object'/.test(cli.slice(i - 250, i)), 'guarded: an older app prints nothing');
});

test('the renderer push is the whole status on `watchers:update`; the pull is `watchers:status`; both exposed by the preload', () => {
  const w = codeOf('src/main/watchers.ts');
  assert.ok(/WATCHERS_UPDATE_CHANNEL = 'watchers:update'/.test(w));
  assert.ok(/platform\.broadcast\(WATCHERS_UPDATE_CHANNEL, s\)/.test(w));
  assert.ok(/WATCHERS_PULL_CHANNEL = 'watchers:status'/.test(codeOf('src/main/watchers-host.ts')));
  const pre = codeOf('src/preload/index.ts');
  assert.ok(/ipcRenderer\.invoke\('watchers:status'\)/.test(pre) && /ipcRenderer\.on\('watchers:update', listener\)/.test(pre) && /ipcRenderer\.off\('watchers:update', listener\)/.test(pre));
});

test('the fault-injection env is the ONLY way to force a failed arm in a built app, and it throws EMFILE', () => {
  const w = codeOf('src/main/watchers.ts');
  assert.ok(/ORCHESTRA_WATCH_FAULT_FILE/.test(w) && /code: 'EMFILE'/.test(w));
  assert.ok(!/ORCHESTRA_WATCH_FAULT_FILE/.test(codeOf('src/main/index.ts')), 'read at each arm inside the primitive, never cached at boot');
});

test('the production retry timer is unref’d: a pending retry never keeps the process (or a quitting app) alive', () => {
  const w = codeOf('src/main/watchers.ts');
  const i = at(w, 'setTimer: (fn, ms) => {');
  assert.ok(/t\.unref\?\.\(\)/.test(w.slice(i, i + 200)), 'setTimeout(...).unref()');
});

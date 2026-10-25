import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_COMMANDS, absolutizeBrowserArgs, browserChildEnv, mapBrowserFailure, planBrowserCommand, staleRefMessage } from './browser-cli.ts';

test('every allowed command plans through unchanged, with its refs listed', () => {
  for (const c of BROWSER_COMMANDS) assert.deepEqual(planBrowserCommand([c]), { ok: true, args: [c], refs: [] }, c);
  assert.deepEqual(planBrowserCommand(['click', '@e2']), { ok: true, args: ['click', '@e2'], refs: ['@e2'] });
  assert.deepEqual(planBrowserCommand(['--json', 'snapshot', '-i']), { ok: true, args: ['--json', 'snapshot', '-i'], refs: [] });
  assert.deepEqual(planBrowserCommand(['fill', '@e6', '@e9 is text']).ok && (planBrowserCommand(['fill', '@e6', '@e9 is text']) as any).refs, ['@e6']);
});

test('no command → usage; an unknown command → named refusal', () => {
  assert.match((planBrowserCommand([]) as any).error, /usage: orchestra browser/);
  assert.match((planBrowserCommand(['--json']) as any).error, /usage:/);
  assert.match((planBrowserCommand(['frobnicate']) as any).error, /unknown command 'frobnicate'/);
});

test('commands that escape the panel are refused with their reason', () => {
  for (const c of ['connect', 'close', 'session', 'install', 'plugin', 'auth', 'dashboard', 'stream', 'batch', 'read', 'inspect']) {
    const r = planBrowserCommand([c, 'x']);
    assert.equal(r.ok, false, c);
    assert.match((r as any).error, new RegExp(`'${c}' is not available`), c);
  }
});

test('flags that re-point the client are refused ANYWHERE in argv, incl. --flag=value and after the command', () => {
  for (const f of ['--cdp', '--session', '--namespace', '--profile', '--auto-connect', '--executable-path', '--headed', '--config', '--provider', '-p', '--state', '--extension', '--proxy', '--engine']) {
    for (const argv of [['snapshot', f, 'x'], ['snapshot', `${f}=x`]]) {
      const r = planBrowserCommand(argv);
      assert.equal(r.ok, false, argv.join(' '));
      assert.match((r as any).error, /is not allowed/);
    }
    assert.equal(planBrowserCommand([f, 'x', 'snapshot']).ok, false, 'leading: refused (command-first rule or the flag list)');
  }
});

test('`--` is NOT a way out: agent-browser honours flags after it, so a refused flag is refused there too (pre-review B2, verified on v0.39.2)', () => {
  for (const argv of [['session', '--', '--session', 'x'], ['type', '@e1', '--', '--cdp'], ['get', 'url', '--', '--profile=Default']]) {
    assert.equal(planBrowserCommand(argv).ok, false, argv.join(' '));
  }
  assert.equal(planBrowserCommand(['screenshot', '--full', 'x.png']).ok, true);
  assert.equal(planBrowserCommand(['snapshot', '-i', '-c', '-d', '3']).ok, true);
  assert.equal(planBrowserCommand(['fill', '@e1', '--', 'plain text']).ok, true, 'a plain `--` separator itself is fine');
});

test('the command must come first: a leading value-taking option would shift which token is the command (pre-review B2)', () => {
  for (const argv of [['--screenshot-dir', 'open', 'session', 'info'], ['--max-output', '5', 'connect', 'ws://x'], ['--headers', '{}', 'plugin', 'add', 'x'], ['--color-scheme', 'dark', 'dashboard']]) {
    const r = planBrowserCommand(argv);
    assert.equal(r.ok, false, argv.join(' '));
    assert.match((r as any).error, /put the command first/);
  }
  assert.equal(planBrowserCommand(['--json', 'snapshot']).ok, true, '--json is valueless and may lead');
  assert.equal(planBrowserCommand(['snapshot', '--json']).ok, true);
});

test('absolutizeBrowserArgs makes every file argument absolute and leaves everything else alone', () => {
  const cwd = '/work/tree';
  assert.deepEqual(absolutizeBrowserArgs(['screenshot', 'out.png'], cwd), ['screenshot', '/work/tree/out.png']);
  assert.deepEqual(absolutizeBrowserArgs(['screenshot', '--full', 'sub/out.png'], cwd), ['screenshot', '--full', '/work/tree/sub/out.png']);
  assert.deepEqual(absolutizeBrowserArgs(['--json', 'pdf', './p.pdf'], cwd), ['--json', 'pdf', '/work/tree/p.pdf']);
  assert.deepEqual(absolutizeBrowserArgs(['upload', '@e3', 'a.bin', '/abs/b.bin'], cwd), ['upload', '@e3', '/work/tree/a.bin', '/abs/b.bin']);
  assert.deepEqual(absolutizeBrowserArgs(['network', 'har', 'stop', 'net.har'], cwd), ['network', 'har', 'stop', '/work/tree/net.har']);
  assert.deepEqual(absolutizeBrowserArgs(['cookies', 'set', '--curl', 'c.txt'], cwd), ['cookies', 'set', '--curl', '/work/tree/c.txt']);
  // untouched: no path argument, an absolute path, a url, selectors and text
  assert.deepEqual(absolutizeBrowserArgs(['screenshot'], cwd), ['screenshot']);
  assert.deepEqual(absolutizeBrowserArgs(['screenshot', '/abs/x.png'], cwd), ['screenshot', '/abs/x.png']);
  assert.deepEqual(absolutizeBrowserArgs(['open', 'page.html'], cwd), ['open', 'page.html'], 'open is a url, not a file argument');
  assert.deepEqual(absolutizeBrowserArgs(['fill', '@e6', 'a.bin'], cwd), ['fill', '@e6', 'a.bin']);
  assert.deepEqual(absolutizeBrowserArgs(['click', '@e1'], cwd), ['click', '@e1']);
});

test('browserChildEnv: only the allowlist of the caller\'s env + the host values; the caller\'s AGENT_BROWSER_* and secrets never pass', () => {
  const env = browserChildEnv(
    { PATH: '/bin', LANG: 'C', AGENT_BROWSER_SESSION: 'other-ws', AGENT_BROWSER_CDP: 'ws://evil', ANTHROPIC_API_KEY: 'sk', HOME: '/home/u', ORCHESTRA_SESSION_KEY: 'k' },
    { AGENT_BROWSER_SESSION: 'mine', HOME: '/scratch' },
  );
  assert.deepEqual(env, { PATH: '/bin', LANG: 'C', AGENT_BROWSER_SESSION: 'mine', HOME: '/scratch' });
});

test('mapBrowserFailure: a ref command that fails with the measured agent-browser text becomes browser_stale_ref', () => {
  const run = { code: 1, stdout: '', stderr: '✗ Could not locate element with role=button name=Go\n' };
  const m = mapBrowserFailure(run, ['@e8'], false);
  assert.equal(m.code, 1);
  assert.match(m.stderr, /^browser_stale_ref: @e8 no longer resolves/);
  assert.match(m.stderr, /Could not locate element with role=button name=Go/);
  const j = mapBrowserFailure({ code: 1, stdout: '{"success":false,"data":null,"error":"Unknown ref: e4"}\n', stderr: '' }, ['@e4'], true);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.code, 'browser_stale_ref');
  assert.equal(parsed.detail, 'Unknown ref: e4');
  assert.equal(parsed.success, false);
});

test('mapBrowserFailure leaves success, ref-less failures and unrelated errors untouched', () => {
  const ok = { code: 0, stdout: 'ok', stderr: '' };
  assert.equal(mapBrowserFailure(ok, ['@e1'], false), ok);
  const noref = { code: 1, stdout: '', stderr: 'Could not locate element with role=button name=Go' };
  assert.equal(mapBrowserFailure(noref, [], false), noref);
  const other = { code: 1, stdout: '', stderr: 'CDP error (Page.navigate): net::ERR_NAME_NOT_RESOLVED' };
  assert.equal(mapBrowserFailure(other, ['@e1'], false), other);
  assert.match(staleRefMessage([]), /the element ref no longer resolves/);
});

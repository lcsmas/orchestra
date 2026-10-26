import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_COMMANDS, absolutizeBrowserArgs, browserChildEnv, prepareBrowserCommand, redactEndpoint, splitEqualsFlags, mapBrowserFailure, planBrowserCommand, staleRefMessage } from './browser-cli.ts';

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

test('a value-taking flag before the path does not steal it, and --flag=value is split (#399 parity rig: G1)', () => {
  const cwd = '/work/tree';
  // `jpeg` is the VALUE of --screenshot-format, not the path; out.jpg is
  assert.deepEqual(absolutizeBrowserArgs(['screenshot', '--screenshot-format', 'jpeg', 'out.jpg'], cwd), ['screenshot', '--screenshot-format', 'jpeg', '/work/tree/out.jpg']);
  assert.deepEqual(absolutizeBrowserArgs(['screenshot', '--screenshot-format', 'jpeg', '--screenshot-quality', '20', 'out.jpg'], cwd), ['screenshot', '--screenshot-format', 'jpeg', '--screenshot-quality', '20', '/work/tree/out.jpg']);
  // path-first keeps working
  assert.deepEqual(absolutizeBrowserArgs(['screenshot', 'out.jpg', '--screenshot-format', 'jpeg'], cwd), ['screenshot', '/work/tree/out.jpg', '--screenshot-format', 'jpeg']);
  // the = form becomes the spaced form (the client treated `--screenshot-quality=30` as the PATH and wrote a file of that name into the host's cwd)
  assert.deepEqual(absolutizeBrowserArgs(['screenshot', '--screenshot-format=jpeg', '--screenshot-quality=30', 'out.jpg'], cwd), ['screenshot', '--screenshot-format', 'jpeg', '--screenshot-quality', '30', '/work/tree/out.jpg']);
  // a path-valued flag is made absolute too
  assert.deepEqual(absolutizeBrowserArgs(['screenshot', '--screenshot-dir', 'shots'], cwd), ['screenshot', '--screenshot-dir', '/work/tree/shots']);
  assert.deepEqual(absolutizeBrowserArgs(['screenshot', '--screenshot-dir=shots', 'a.png'], cwd), ['screenshot', '--screenshot-dir', '/work/tree/shots', '/work/tree/a.png']);
  assert.deepEqual(splitEqualsFlags(['click', '@e1', '--depth=3', 'plain=text', '-d=2']), ['click', '@e1', '--depth', '3', 'plain=text', '-d=2'], 'only long KNOWN value flags; data with = is untouched');
  // reviewer m1: data that merely looks like a flag stays ONE token
  assert.deepEqual(splitEqualsFlags(['type', '@e2', '--api-key=sk-123']), ['type', '@e2', '--api-key=sk-123']);
  assert.deepEqual(absolutizeBrowserArgs(['fill', '@e1', '--foo=bar'], cwd), ['fill', '@e1', '--foo=bar']);
});

// ── pre-review M3: the allowlist judges the FINAL argv ──────────────────────────────────────────────────────────────────
const REFUSED_SAMPLE = [
  '--cdp', '--session', '--namespace', '--profile', '--auto-connect', '--executable-path', '--engine', '--provider', '-p', '--headed',
  '--config', '--state', '--extension', '--args', '--proxy', '--user-agent', '--init-script', '--enable', '--allow-file-access', '--device',
  '--idle-timeout', '--session-name', '--restore', '--allowed-domains',
];
const VALUE_CARRIERS = ['--screenshot-format', '--screenshot-quality', '--depth', '--selector', '--max-output', '--timeout', '--filter', '--headers', '--color-scheme', '--curl', '--baseline', '--output', '--screenshot-dir'];

test('M3: `--json=--cdp 9222` and every other way to land a refused flag in the FINAL argv is refused; an ok plan never contains one', () => {
  const smuggles: string[][] = [];
  for (const f of REFUSED_SAMPLE) {
    smuggles.push(['snapshot', f], ['snapshot', `${f}=x`], ['snapshot', '--', f], ['snapshot', '--json', f, 'x']);
    smuggles.push(['snapshot', `--json=${f}`, '9222'], ['snapshot', `--full=${f}`], ['snapshot', `--annotate=${f}`, 'x'], ['snapshot', `--pin-tab=${f}`]);
    for (const c of VALUE_CARRIERS) smuggles.push(['snapshot', c, f, 'x'], ['snapshot', `${c}=${f}`, 'x'], ['screenshot', `${c}=${f}`, 'out.png']);
  }
  let refused = 0, ok = 0;
  for (const argv of smuggles) {
    const plan = prepareBrowserCommand(argv, '/work/tree');
    if (!plan.ok) { refused++; continue; }
    ok++;
    // the exact tokens the client would receive: no refused flag, bare or `=`-joined, anywhere
    for (const t of plan.args) assert.equal(REFUSED_SAMPLE.some((f) => t === f || t.startsWith(`${f}=`)), false, `${argv.join(' ')} → ${plan.args.join(' ')} carries ${t}`);
  }
  assert.ok(refused > 400, `most forms are refused outright (${refused}/${smuggles.length}); the rest stay inert single tokens (${ok})`);
  // the exact reproduction from the review
  const r = prepareBrowserCommand(['snapshot', '--json=--cdp', '9222'], '/w');
  assert.deepEqual(r.ok && r.args, ['snapshot', '--json=--cdp', '9222'], 'not split: one inert token, no standalone --cdp');
  assert.equal(prepareBrowserCommand(['snapshot', '--screenshot-format=--cdp', '9222'], '/w').ok, false, 'a KNOWN value flag IS split, and the value is then judged');
  assert.equal(prepareBrowserCommand(['snapshot', '--cdp=9222'], '/w').ok, false);
});

test('seam review m2: `get cdp-url` (any case/spelling, with flags around it) is refused; ordinary `get` subcommands and data that mentions it pass', () => {
  for (const argv of [['get', 'cdp-url'], ['get', 'CDP-URL'], ['get', 'cdp_url'], ['get', 'cdpurl'], ['--json', 'get', 'cdp-url'], ['get', '--json', 'cdp-url'], ['get', 'cdp-url', '--json'],
    // final-tip review m5: a value-taking global flag shifts the sub-command position; quotes around it
    ['get', '--max-output', '100', 'cdp-url'], ['get', '--color-scheme', 'dark', 'cdp-url'], ['get', '--input-mode', 'instant', 'cdp-url'], ['get', 'cdp-url', '--json'], ['get', '"cdp-url"'], ["get", "'cdp_URL'"], ['--json', 'get', '--max-output', '5', '`cdp-url`']]) {
    const r = prepareBrowserCommand(argv, '/w');
    assert.equal(r.ok, false, argv.join(' '));
    assert.match((r as any).error, /get cdp-url/);
  }
  for (const argv of [['get', 'url'], ['get', 'title'], ['get', 'text', '#out'], ['fill', '@e1', 'cdp-url'], ['eval', 'document.title // cdp-url']]) {
    assert.equal(prepareBrowserCommand(argv, '/w').ok, true, argv.join(' '));
  }
});

test('redactEndpoint hides the ws URL and the bare token from anything the client prints', () => {
  const url = 'ws://127.0.0.1:41955/AbCdEf0123456789xyZ_-q/devtools/browser/4FB8D36BB1CFD6C33D679159CDA7D8D4';
  assert.equal(redactEndpoint(`${url}\n`, url), '<proxy-endpoint>\n');
  assert.equal(redactEndpoint('connect to ws://127.0.0.1:41955/AbCdEf0123456789xyZ_-q/json failed', url), 'connect to ws://127.0.0.1:41955/<redacted>/json failed');
  assert.equal(redactEndpoint(JSON.stringify({ cdpUrl: url }), url), '{"cdpUrl":"<proxy-endpoint>"}');
  assert.equal(redactEndpoint('nothing to hide', url), 'nothing to hide');
  assert.equal(redactEndpoint('', url), '');
  assert.equal(redactEndpoint('abc', 'not a url'), 'abc');
});

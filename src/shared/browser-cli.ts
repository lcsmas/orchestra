/**
 * Pure half of `orchestra browser <cmd>` (#395, ADR 0009): which `agent-browser` commands/flags an
 * agent may pass through, the scrubbed child env, and the stale-ref error mapping. The CLI
 * (`src/cli/index.ts`) and the host (`src/main/browser-cli-host.ts`) are thin around it.
 *
 * `agent-browser` can launch its own browser, connect to ANY CDP endpoint, install plugins and
 * start servers. `orchestra browser` exists to drive THIS workspace's panel only, so the command
 * set is an allowlist and every flag that re-points the client is refused (ADR 0009 story 41).
 */

/** Commands passed to `agent-browser` as-is. Everything else is refused with a reason. */
export const BROWSER_COMMANDS: ReadonlySet<string> = new Set([
  'open', 'back', 'forward', 'reload',
  'click', 'dblclick', 'type', 'fill', 'press', 'keyboard', 'hover', 'focus',
  'check', 'uncheck', 'select', 'drag', 'upload', 'scroll', 'scrollintoview',
  'wait', 'screenshot', 'pdf', 'snapshot', 'eval',
  'get', 'is', 'find', 'mouse', 'set', 'network', 'cookies', 'storage', 'tab', 'diff',
  'console', 'errors', 'highlight', 'dialog',
]);

/** Why a known-dangerous / out-of-scope command is refused (shown to the agent). */
const REFUSED_COMMANDS: Record<string, string> = {
  connect: 'the host connects it to this workspace\'s panel; you cannot point it elsewhere',
  close: 'the host owns the browser connection; nothing to close (use `tab close` for a tab you opened)',
  session: 'the host owns the session',
  install: 'it would install a browser; this drives the Orchestra panel',
  upgrade: 'the client is pinned by the app',
  doctor: 'not available',
  plugin: 'plugins run arbitrary commands',
  auth: 'the auth vault is not available here',
  profiles: 'Chrome profiles are not available here',
  dashboard: 'it starts a server',
  stream: 'it opens a streaming port',
  chat: 'not available',
  mcp: 'use the CLI',
  skills: 'not available',
  batch: 'run several commands from your shell instead',
  confirm: 'not available',
  deny: 'not available',
  read: 'it fetches pages outside the panel; use open + snapshot',
  download: 'not available yet',
  trace: 'not available yet',
  profiler: 'not available yet',
  record: 'not available yet',
  inspect: 'DevTools would take the panel\'s debugger',
  clipboard: 'not available yet',
  webmcp: 'not available yet',
  react: 'not available yet',
  vitals: 'not available yet',
  a11y: 'not available yet',
  pushstate: 'not available yet',
  removeinitscript: 'not available',
};

/** Global flags that re-point the client, change its identity or load code: refused anywhere in argv. */
const REFUSED_FLAGS: ReadonlySet<string> = new Set([
  '--cdp', '--auto-connect', '--session', '--namespace', '--session-name', '--profile',
  '--restore', '--restore-save', '--restore-check-url', '--restore-check-text', '--restore-check-fn', '--state',
  '--executable-path', '--engine', '--provider', '-p', '--headed', '--extension', '--args', '--config',
  '--proxy', '--proxy-bypass', '--ca-cert', '--no-ca-cert', '--use-system-ca', '--ignore-https-errors',
  '--allow-file-access', '--init-script', '--enable', '--device', '--action-policy', '--confirm-actions',
  '--confirm-interactive', '--allowed-domains', '--idle-timeout', '--webgpu', '--user-agent',
]);

export type BrowserPlan = { ok: true; args: string[]; refs: string[] } | { ok: false; error: string };

const REF = /^@e\d+$/;

/** Options that may precede the command: valueless ones only (a value-taking option would shift which token is the command). */
const LEADING_OPTIONS: ReadonlySet<string> = new Set(['--json']);

/**
 * Validate `orchestra browser <argv>`; returns the args to hand to `agent-browser` (after `--cdp <url>`).
 * The command MUST be the first token (after `--json`): agent-browser parses global options wherever they stand, so a
 * leading value-taking option (`--screenshot-dir open session …`) or a flag after `--` (`session -- --session x`)
 * would change which command runs / which daemon is addressed (found by pre-review, verified on v0.39.2). Refused
 * flags are therefore refused EVERYWHERE, `--` included; a data token that looks like one (`fill @e1 -p`) is refused too.
 */
export function planBrowserCommand(argv: readonly string[]): BrowserPlan {
  const usage = 'usage: orchestra browser <command> [args]   (e.g. snapshot, click @e2, fill @e6 "text", screenshot out.png)';
  let idx = 0;
  while (idx < argv.length && LEADING_OPTIONS.has(argv[idx]!)) idx++;
  const command = argv[idx];
  if (command === undefined) return { ok: false, error: usage };
  if (command.startsWith('-')) {
    return { ok: false, error: `orchestra browser: put the command first and options after it (got ${command} before the command).\n${usage}` };
  }
  if (command in REFUSED_COMMANDS) {
    return { ok: false, error: `orchestra browser: '${command}' is not available — ${REFUSED_COMMANDS[command]}.` };
  }
  if (!BROWSER_COMMANDS.has(command)) {
    return { ok: false, error: `orchestra browser: unknown command '${command}'.\n${usage}` };
  }
  // `get cdp-url` prints the full token-bearing websocket URL: any shell step could then speak raw CDP, past this allowlist (seam review m2)
  if (command === 'get') {
    const sub = argv.slice(idx + 1).find((a) => !a.startsWith('-'));
    if (sub !== undefined && sub.toLowerCase().replace(/[-_]/g, '') === 'cdpurl') {
      return { ok: false, error: "orchestra browser: 'get cdp-url' is not available — it would print the proxy endpoint, and the proxy is not meant to be reached except through this CLI." };
    }
  }
  for (const a of argv) {
    const name = a.startsWith('--') || a.startsWith('-p=') ? a.split('=')[0]! : a;
    if (REFUSED_FLAGS.has(name)) {
      return { ok: false, error: `orchestra browser: ${name} is not allowed — this CLI drives only your workspace's own browser panel.` };
    }
  }
  return { ok: true, args: [...argv], refs: argv.filter((a) => REF.test(a)) };
}

/** Flags whose NEXT token is a file/dir path the client reads or writes (made absolute). */
const PATH_VALUE_FLAGS: ReadonlySet<string> = new Set(['--curl', '--baseline', '--output', '--screenshot-dir', '--download-path']);
/** Other flags that take a value: that value is never a positional argument (`screenshot --screenshot-format jpeg out.jpg`). */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--screenshot-format', '--screenshot-quality', '--depth', '-d', '--selector', '-s', '--max-output', '--timeout', '--filter',
  '--headers', '--color-scheme', '--input-mode', '--url', '--domain', '--path', '--expires', '--sameSite',
]);

const KNOWN_EQUALS_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, ...PATH_VALUE_FLAGS].filter((f) => f.startsWith('--')));

/**
 * agent-browser documents `--flag value`; its `--flag=value` form is not parsed as one flag (it became a positional and a file
 * literally named `--screenshot-quality=30` appeared in the host's cwd — found by #399's parity rig). Split `--name=value` into
 * `--name value` ONLY for the value flags we know: anything else is data (`fill @e1 --api-key=sk-123`) or an unknown flag the client
 * treats as an inert positional, and splitting it would manufacture tokens the agent never typed (`--json=--cdp` → `--json --cdp`).
 */
export function splitEqualsFlags(args: readonly string[]): string[] {
  return args.flatMap((a) => {
    const m = /^(--[A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/.exec(a);
    return m && KNOWN_EQUALS_FLAGS.has(m[1]!) ? [m[1]!, m[2]!] : [a];
  });
}

/**
 * THE entry point of the CLI: rewrite first (split known `--flag=value`, make file arguments absolute), validate LAST. The allowlist
 * must judge the argv the client will actually receive — validating a pre-transform copy let `--screenshot-format=--cdp` become
 * `--screenshot-format --cdp` after the check (pre-review M3). Invariant (unit-tested over every refused flag in every position/form):
 * a plan that is ok contains no refused flag token.
 */
export function prepareBrowserCommand(argv: readonly string[], cwd: string): BrowserPlan {
  return planBrowserCommand(absolutizeBrowserArgs(argv, cwd));
}

/**
 * The agent-browser daemon is owned by the HOST, so a relative path would resolve against the Electron process's cwd
 * (verified: `screenshot rel.png` landed there). The CLI knows the agent's cwd: make every file argument absolute.
 * Covers screenshot [path], pdf <path>, upload <sel> <files…>, network har start|stop [path], and --curl/--baseline/--output <file>.
 */
export function absolutizeBrowserArgs(args: readonly string[], cwd: string): string[] {
  const abs = (p: string): string => (p.startsWith('/') || p.includes('://') ? p : `${cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`);
  const out = splitEqualsFlags(args);
  let ci = 0;
  while (ci < out.length && LEADING_OPTIONS.has(out[ci]!)) ci++;
  const command = out[ci];
  const positionals: number[] = [];
  for (let i = ci + 1; i < out.length; i++) {
    const t = out[i]!;
    if (PATH_VALUE_FLAGS.has(t) && i + 1 < out.length) {
      out[i + 1] = abs(out[i + 1]!);
      i++;
    } else if (VALUE_FLAGS.has(t) && i + 1 < out.length) {
      i++; // its value is not a positional (and not a path)
    } else if (!t.startsWith('-')) positionals.push(i);
  }
  if (command === 'screenshot' || command === 'pdf') {
    const i = positionals[0];
    if (i !== undefined) out[i] = abs(out[i]!);
  } else if (command === 'upload') {
    for (const i of positionals.slice(1)) out[i] = abs(out[i]!);
  } else if (command === 'network' && out[positionals[0] ?? -1] === 'har') {
    const i = positionals[2]; // har <start|stop> [path]
    if (i !== undefined) out[i] = abs(out[i]!);
  }
  return out;
}

/** Env the `agent-browser` child may inherit from the agent's shell (nothing of `AGENT_BROWSER_*`, no secrets). */
const PASS_ENV = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR', 'TZ', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL'];

/** The child's env: an allowlist of the caller's, then the host's `AGENT_BROWSER_*` + `HOME` (never the caller's own). */
export function browserChildEnv(
  parent: Record<string, string | undefined>,
  fromHost: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASS_ENV) {
    const v = parent[k];
    if (typeof v === 'string') out[k] = v;
  }
  for (const [k, v] of Object.entries(fromHost)) out[k] = v;
  return out;
}

/** What `agent-browser` v0.39.2 prints when a ref no longer resolves (measured, not documented). */
const STALE_PATTERNS = [/Could not locate element with role=/i, /Unknown ref:/i, /stale ref/i, /no longer (?:attached|exists)/i];

export const STALE_REF_CODE = 'browser_stale_ref';

export function staleRefMessage(refs: readonly string[]): string {
  const which = refs.length ? refs.join(', ') : 'the element ref';
  return `${STALE_REF_CODE}: ${which} no longer resolves — the page changed since the snapshot that issued it. Run \`orchestra browser snapshot\` again and use the new refs.`;
}

export interface BrowserRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Rewrite a failed run whose command used `@eN` refs and whose output says the ref did not resolve
 * into the clear `browser_stale_ref` error (the original line is kept after it). Anything else is
 * returned untouched — including a failure without refs, which is not a stale-ref case.
 */
export function mapBrowserFailure(run: BrowserRun, refs: readonly string[], json: boolean): BrowserRun {
  if (run.code === 0 || refs.length === 0) return run;
  const text = `${run.stdout}\n${run.stderr}`;
  if (!STALE_PATTERNS.some((p) => p.test(text))) return run;
  const msg = staleRefMessage(refs);
  if (json) {
    let original: unknown = null;
    try {
      original = (JSON.parse(run.stdout.trim()) as { error?: unknown }).error ?? null;
    } catch {
      /* not JSON: keep null */
    }
    return { code: run.code, stdout: JSON.stringify({ success: false, data: null, error: msg, code: STALE_REF_CODE, detail: original }) + '\n', stderr: '' };
  }
  const detail = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' | ');
  return { code: run.code, stdout: '', stderr: `${msg}\n  (agent-browser: ${detail})\n` };
}

/**
 * Defence in depth: whatever the client prints (an error quoting its connection, a command we did not think of), the proxy endpoint
 * and its token never reach the agent's stdout/stderr. Replaces the full ws URL, then the bare token path segment.
 */
export function redactEndpoint(text: string, wsUrl: string): string {
  if (!text) return text;
  let out = text.split(wsUrl).join('<proxy-endpoint>');
  let token = '';
  try {
    token = new URL(wsUrl).pathname.split('/')[1] ?? '';
  } catch {
    /* not a URL: nothing more to redact */
  }
  if (token.length >= 8) out = out.split(token).join('<redacted>');
  return out;
}

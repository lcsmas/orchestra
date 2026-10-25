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

/** Validate `orchestra browser <argv>`; returns the args to hand to `agent-browser` (after `--cdp <url>`). */
export function planBrowserCommand(argv: readonly string[]): BrowserPlan {
  const usage = 'usage: orchestra browser <command> [args]   (e.g. snapshot, click @e2, fill @e6 "text", screenshot out.png)';
  // Flags first: a flag's VALUE can precede the command (`--cdp x snapshot`), so the refusal must not depend on parsing it.
  for (const a of argv) {
    if (a === '--') break; // after a separator everything is data
    const name = a.startsWith('--') || a.startsWith('-p=') ? a.split('=')[0]! : a;
    if (REFUSED_FLAGS.has(name)) {
      return { ok: false, error: `orchestra browser: ${name} is not allowed — this CLI drives only your workspace's own browser panel.` };
    }
  }
  // The command is the first token that is not a flag.
  const idx = argv.findIndex((a) => !a.startsWith('-'));
  if (idx === -1) return { ok: false, error: usage };
  const command = argv[idx]!;
  if (command in REFUSED_COMMANDS) {
    return { ok: false, error: `orchestra browser: '${command}' is not available — ${REFUSED_COMMANDS[command]}.` };
  }
  if (!BROWSER_COMMANDS.has(command)) {
    return { ok: false, error: `orchestra browser: unknown command '${command}'.\n${usage}` };
  }
  return { ok: true, args: [...argv], refs: argv.filter((a) => REF.test(a)) };
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

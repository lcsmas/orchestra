// Load-time MUTANTS of the shipped source for the session-budget must-FAIL arms (#208).
// Registered by session-runner.mjs (`module.register`) BEFORE src/ is imported: the source text is
// rewritten as node loads it, so the mutant is a real edit of the shipped file inside its own
// resolution tree — with NOTHING written to disk (no restore step, no dirty release tree).
// Every mutant asserts its anchor matches EXACTLY ONCE, else the run throws PATTERN-GONE: a mutant
// that silently matched nothing would make its must-FAIL arm pass vacuously.

import { fileURLToPath } from 'node:url';

const FAKE_MCP_SERVER = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));

/** name -> { file suffix, regex (global), replace } */
export const MUTANTS = {
  // #428 (vague-endormie rig): each must turn the named clause of scripts/session-budget/vague-endormie.mjs RED.
  'vague-no-episode': {
    file: '/src/main/vague-endormie.ts',
    find: /if \(verdict\.nudge === 'done' \|\| \(retryAt\.get\(f\.runId\) \?\? 0\) > now\) continue;/g,
    replace: 'if ((retryAt.get(f.runId) ?? 0) > now) continue;',
  },
  'vague-ignore-process': {
    file: '/src/shared/vague-endormie.ts',
    find: /  if \(procs\.length > 0\) \{\n/g,
    replace: '  if (false) {\n',
  },
  'vague-ignore-active': {
    file: '/src/main/vague-roster.ts',
    find: /active: ws\.status === 'running' \|\| \(ws\.sdkPendingPrompts\?\.length \?\? 0\) > 0,/g,
    replace: 'active: false,',
  },
  'vague-coordinator-resume-ends': {
    file: '/src/shared/vague-endormie.ts',
    find: /if \(f\.members\.some\(\(m\) => m\.active \|\| m\.waiting \|\| m\.heldStart \|\| m\.lastActivityAt > ep\.declaredAt\)\) return 'resumed';/g,
    replace: "if ([f.coordinator, ...f.members].some((m) => m.active || m.waiting || m.heldStart || m.lastActivityAt > ep.declaredAt)) return 'resumed';",
  },
  // Review round 2 F1: an app-code edit that hands the CLI a traffic-suppressing env knob (buildSdkEnv copies process.env then adds
  // the workspace vars). The runner's own env is clean, so only the CLI's /proc environ can see it.
  'traffic-knob-in-sdk-env': {
    file: '/src/main/agent-sdk.ts',
    find: /(  env\.ORCHESTRA_BRANCH = ws\.branch;\n)/g,
    replace: "$1  env.DISABLE_TELEMETRY = '1';\n",
  },
  // Review round 2 F2: a startup call from the APP process (main) to a host nobody budgeted. Node's fetch ignores the proxy env
  // unless the runner started with NODE_USE_ENV_PROXY=1; without that wiring the attempt dies at DNS inside the netns, unseen.
  'app-fetch-new-host': {
    file: '/src/main/agent-sdk.ts',
    find: /(  void consume\(session\);\n)(?=(?:  \/\/[^\n]*\n)*  return session;\n)/g,
    replace: "$1  void fetch('https://telemetry.example.invalid/boot').catch(() => {});\n",
  },
  // #176 re-added: a boot-time getContextUsage() right after consume() starts, before the first turn
  // (git show 89ae8b4b^:src/main/agent-sdk.ts). The control request itself, so it outlives helper renames.
  'boot-context-read': {
    file: '/src/main/agent-sdk.ts',
    find: /(  void consume\(session\);\n)(?=(?:  \/\/[^\n]*\n)*  return session;\n)/g,
    replace: '$1  void session.q.getContextUsage().catch(() => {});\n',
  },
  // #399 re-added: the removed in-process `browser` MCP server (one `navigate` tool is enough to show at session/init and in the model request).
  'browser-mcp-registered': {
    file: '/src/main/agent-sdk.ts',
    find: /(  session\.q = query\(\{\n    prompt: promptStream\(session\),\n    options: \{\n)/g,
    replace: "  const { createSdkMcpServer: __csms, tool: __tool } = (await import('@anthropic-ai/claude-agent-sdk')) as any;\n  const __sbBrowser = __csms({ name: 'browser', version: '1.0.0', tools: [__tool('navigate', 'x', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }))] });\n$1      mcpServers: { browser: __sbBrowser },\n",
  },
  // #210: an app edit registers ONE extra stdio MCP server beside the 4 `.mcp.json` ones — a real session then runs 5 mcp children.
  'mcp-process-extra': {
    file: '/src/main/agent-sdk.ts',
    find: /(  session\.q = query\(\{\n    prompt: promptStream\(session\),\n    options: \{\n)/g,
    replace: `$1      mcpServers: { fixextra: { type: 'stdio', command: process.execPath, args: [${JSON.stringify(FAKE_MCP_SERVER)}, '--name', 'fixextra', '--tools', '1'] } },\n`,
  },
  // #317 re-added: the pre-fix turn-end getContextUsage() (git show 743f9ab0:src/main/agent-sdk.ts, consume() result branch).
  'turn-end-context-read': {
    file: '/src/main/agent-sdk.ts',
    find: /(        releaseTurnGate\(session\);\n)(?=        \/\/ #317)/g,
    replace: '$1        void session.q.getContextUsage().catch(() => {});\n',
  },
  // Rewind rig (rewind.mjs): the pre-fix cut — resume at the PREVIOUS USER PROMPT, which drops that prompt's reply.
  'rewind-cut-at-prev-prompt': {
    file: '/src/main/agent-sdk.ts',
    find: /(    return )r\.cut;\n/g,
    replace: '$1prevRewindId ?? null;\n',
  },
  // Rewind rig: a parked cut ignored by the backfill — a pane reopened before the next send shows the undone turns.
  'rewind-history-ignores-pending-cut': {
    file: '/src/shared/agent-transcript.ts',
    find: /  if \(cutAt >= 0\) entries\.length = cutAt \+ 1;\n/g,
    replace: '',
  },
  // Rewind rig: the pre-fix files path — a hibernated session is not woken, so nothing is restored.
  'rewind-no-wake': {
    file: '/src/main/agent-sdk.ts',
    find: /(async function wakeForRewind\([^)]*\)[^{]*\{\n)/g,
    replace: '$1  if (!globalThis.__never) { const l = sessions.get(wsId); return l && !l.stopping ? l : null; }\n',
  },
  // Rewind rig: the pre-fix teardown — no wait for the gracefully-stopped CLI, so the next send can attach to it.
  'rewind-no-keeper-wait': {
    file: '/src/main/agent-sdk.ts',
    find: /    await killKeeperIf\(wsId, keeperBefore, 'rewind'\);\n/g,
    replace: '',
  },
  // Rewind rig: the pre-fix backfill — every line of the transcript, the branch a rewind abandoned included.
  'rewind-history-keeps-dead-branch': {
    file: '/src/shared/agent-transcript.ts',
    find: /const rewound = rewoundUuids\(entries\);/g,
    replace: 'const rewound = new Set<string>();',
  },
  // Bloc HTML rig (#418): the CLI env flag is set whatever the switch says → OFF sessions get the instruction.
  'bloc-html-env-always': {
    file: '/src/main/agent-sdk.ts',
    find: /if \(isBlocHtmlEnabled\(\)\) env\[BLOC_HTML_ENV\] = '1';/g,
    replace: "if (true) env[BLOC_HTML_ENV] = '1';",
  },
  // Bloc HTML rig (#418): the flag is never set → ON sessions get nothing.
  'bloc-html-env-never': {
    file: '/src/main/agent-sdk.ts',
    find: /if \(isBlocHtmlEnabled\(\)\) env\[BLOC_HTML_ENV\] = '1';/g,
    replace: "if (false) env[BLOC_HTML_ENV] = '1';",
  },
  // Bloc HTML rig (#418): the SessionStart hook is never registered → the script exists but nothing runs it.
  'bloc-html-hook-unwired': {
    file: '/src/main/workspaces.ts',
    find: /    upsertHookCommand\(sessionStartList, HOOK_BLOC_HTML_CMD\);\n/g,
    replace: '',
  },
  // #317 matrix: every network-capable control request, fired at the same turn-end spot — which ones hold the next prompt?
  ...Object.fromEntries([
    ['turn-end-supported-models', 'supportedModels()'],
    ['turn-end-reload-plugins', 'reloadPlugins()'],
    ['turn-end-mcp-status', 'mcpServerStatus()'],
    ['turn-end-mcp-reconnect', "reconnectMcpServer('fixsrv1')"],
    ['turn-end-mcp-toggle', "toggleMcpServer('fixsrv1', false).then(() => session.q.toggleMcpServer('fixsrv1', true))"],
  ].map(([name, call]) => [name, {
    file: '/src/main/agent-sdk.ts',
    find: /(        releaseTurnGate\(session\);\n)(?=        \/\/ #317)/g,
    // First turn end only; times its own request (globalThis.__sbCtl, read by session-runner): a request the slow world did NOT slow proves nothing.
    replace: `$1        if (!globalThis.__sbCtl) { const t0 = Date.now(); globalThis.__sbCtl = { ms: null }; void session.q.${call}.then(() => 'ok', (e) => String(e?.message ?? e)).then((r) => { globalThis.__sbCtl = { ms: Date.now() - t0, result: r }; }); }\n`,
  }])),
};

/** Mutants of the KEEPER bundle (`dist-electron/keeper.js`, a separate process outside `src/` loading): the runner applies one to the
 *  scratch COPY it installs (`mutateKeeperBundle`), never to the built file. #210: the keeper holds 256 MB — the tree-memory budget's must-FAIL. */
export const KEEPER_MUTANTS = {
  'keeper-rss-ballast': {
    find: /^(#!\/usr\/bin\/env node\n"use strict";\n)/g,
    replace: '$1globalThis.__sbBallast = Buffer.alloc(256 * 1024 * 1024, 1);\n',
  },
};

/** The bundle text with keeper mutant `name` applied; throws PATTERN-GONE unless the anchor matches exactly once. */
export function mutateKeeperBundle(name, src) {
  const m = KEEPER_MUTANTS[name];
  const hits = [...src.matchAll(m.find)].length;
  if (hits !== 1) throw new Error(`keeper mutant ${name}: PATTERN-GONE — anchor matched ${hits}× in the keeper bundle (want exactly 1); the mutant no longer describes the shipped code`);
  return src.replace(m.find, m.replace);
}

let active = null;

export async function initialize(data) {
  active = data?.mutant ?? null;
  if (active && !MUTANTS[active] && !KEEPER_MUTANTS[active]) throw new Error(`unknown mutant: ${active}`);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!active || !MUTANTS[active] || !url.endsWith(MUTANTS[active].file)) return result;
  const m = MUTANTS[active];
  const src = String(result.source);
  const hits = [...src.matchAll(m.find)].length;
  if (hits !== 1) throw new Error(`mutant ${active}: PATTERN-GONE — anchor matched ${hits}× in ${m.file} (want exactly 1); the mutant no longer describes the shipped code`);
  return { ...result, source: src.replace(m.find, m.replace) };
}

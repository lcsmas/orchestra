// #317 guard: every SDK control request sent to a live CLI is a conscious, listed decision.
// A slow control request HOLDS the session's next prompt until it settles (measured:
// getContextUsage 39.9 s, reconnectMcpServer / toggleMcpServer 20 s — `node
// scripts/session-budget/turn-boundary.mjs --matrix`). So none may run automatically
// (turn end, boot, a timer) unless proven local + fast. Rule: docs/codebase-map/structured-agent-view.md
// § "Control requests hold the next prompt".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `function name` → control methods it may send. Each entry is user-initiated (an IPC
 *  handler behind a click/CLI verb) unless its comment says otherwise. */
const ALLOWED: Record<string, string[]> = {
  sessionModels: ['supportedModels'], // automatic (model picker mount) — measured local, 1 ms
  probeRuntimeModels: ['supportedModels'], // a SEPARATE probe query, never the session's CLI
  interruptCancellingQueued: ['interrupt'],
  sdkInterruptForPause: ['interrupt'],
  sdkStop: ['interrupt'],
  sdkStopTask: ['stopTask'],
  sdkStopTaskForPause: ['stopTask'],
  sdkBackgroundForegroundTasks: ['backgroundTasks'],
  sdkSetModel: ['setModel'],
  sdkSetEffort: ['applyFlagSettings'],
  sdkSetPermissionMode: ['setPermissionMode'],
  sdkReloadSkills: ['reloadSkills'],
  sdkReloadPlugins: ['reloadPlugins'],
  sdkSetRemoteControl: ['enableRemoteControl'],
  emitMcpServers: ['mcpServerStatus'],
  sdkMcpToggle: ['toggleMcpServer'], // HOLDS the next prompt while the server restarts
  sdkMcpReconnect: ['reconnectMcpServer'], // HOLDS the next prompt while the server restarts
  runMcpAuthFlow: ['mcpServerStatus', 'reconnectMcpServer'],
  sdkRewind: ['rewindFiles'],
  sdkRewindPreview: ['rewindFiles'],
};

/** The SDK's `Query` methods, read from the installed typings, plus undeclared ones we call. */
function controlMethods(): Set<string> {
  const dts = fs.readFileSync(path.join(REPO, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'), 'utf8');
  const body = /^export (?:declare )?interface Query [^{]*\{([\s\S]*?)^\}/m.exec(dts)?.[1] ?? '';
  const names = [...body.matchAll(/^\s+([a-zA-Z]+)\(/gm)].map((m) => m[1]);
  return new Set([...names, 'enableRemoteControl']);
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Every `<x>.q.<method>(` / `q.<method>(` call of a control method, with its enclosing top-level function. */
function callSites(methods: Set<string>, root = path.join(REPO, 'src')) {
  const out: { file: string; line: number; fn: string | null; method: string }[] = [];
  const fnRe = /^(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)/;
  for (const file of sourceFiles(root)) {
    let fn: string | null = null;
    fs.readFileSync(file, 'utf8').split('\n').forEach((l, i) => {
      fn = fnRe.exec(l)?.[1] ?? fn;
      const code = l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''); // comments name methods freely
      for (const m of code.matchAll(/\bq\??\.(\w+)\(/g)) {
        if (methods.has(m[1])) out.push({ file: path.relative(REPO, file), line: i + 1, fn, method: m[1] });
      }
    });
  }
  return out;
}

test('#317: every SDK control request call site is on the allowlist', () => {
  const methods = controlMethods();
  assert.ok(methods.has('getContextUsage') && methods.has('reconnectMcpServer'), 'Query typings not parsed');
  const sites = callSites(methods);
  assert.ok(sites.length >= 15, `scanner found only ${sites.length} sites — it went blind`);
  const bad = sites.filter((s) => !s.fn || !ALLOWED[s.fn]?.includes(s.method));
  assert.deepEqual(
    bad.map((s) => `${s.file}:${s.line} ${s.fn ?? '<top level>'} → ${s.method}()`),
    [],
    'new control request: a slow one holds the next prompt (#317). Prove it user-initiated or local+fast (turn-boundary.mjs --matrix), then list it in ALLOWED.',
  );
});

test('#317: getContextUsage() is never sent (boot #176, turn end #317)', () => {
  const sites = callSites(new Set(['getContextUsage']));
  assert.deepEqual(sites, []);
});

test('#317 scanner positive control: an unlisted call in a new function is caught', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-probe-'));
  try {
    fs.writeFileSync(path.join(tmp, 'probe.ts'), 'function onTurnEnd(session) {\n  void session.q.reconnectMcpServer("x");\n}\n');
    const caught = callSites(controlMethods(), tmp);
    assert.deepEqual(caught.map((s) => [s.fn, s.method]), [['onTurnEnd', 'reconnectMcpServer']]);
    assert.ok(!ALLOWED.onTurnEnd);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

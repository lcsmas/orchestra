// #177 — SOURCE-LEVEL guard for the debug-log wiring in the un-importable
// agent-sdk.ts, plus a check that the SDK actually maps `debugFile` → the CLI
// `--debug-file` flag (the chain the E2E's fake CLI stands in for). The
// behaviour is driven for real by scripts/e2e-session-debug-log.mjs (the file
// appears + rotates through the REAL sdkSend → query() path); this catches the
// realistic regression: the option being dropped or the sweep un-wired.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const agentSdkSrc = read('src/main/agent-sdk.ts');

test('CONTROL: agent-sdk.ts is readable and non-trivial', () => {
  assert.ok(agentSdkSrc.length > 10_000, `agent-sdk.ts short: ${agentSdkSrc.length}`);
  assert.doesNotMatch(agentSdkSrc, /zzzNoSuchPatternZzz/);
});

test('agent-sdk mints a per-session debug file for LOCAL sessions and sets debugFile', () => {
  // The mint is gated on !remote (a remote CLI runs in the container).
  assert.match(
    agentSdkSrc,
    /const debugFile = remote \? null : newSessionDebugLogPath\(wsId\)/,
    'debugFile minted for local sessions only',
  );
  // The option is actually passed to query().
  assert.match(
    agentSdkSrc,
    /\.\.\.\(debugFile \? \{ debugFile \} : \{\}\)/,
    'debugFile spread into the query() options',
  );
});

test('agent-sdk sweeps the black box on spawn (bounded retention)', () => {
  assert.match(agentSdkSrc, /if \(debugFile\) sweepSessionDebugLogs\(debugFile\)/, 'sweep wired at spawn, keeping the new file');
  assert.match(
    agentSdkSrc,
    /import \{ newSessionDebugLogPath, sweepSessionDebugLogs \} from '\.\/session-debug-log-fs'/,
    'the fs helpers are imported',
  );
});

test('the SDK maps `debugFile` to the CLI `--debug-file` flag (chain the E2E relies on)', () => {
  // If this ever stops holding, setting options.debugFile would no longer
  // produce a capture — the whole feature would be silently inert. Assert the
  // bundled SDK still emits the flag AND reads the option.
  const sdkBundle = read('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
  assert.match(sdkBundle, /--debug-file/, 'SDK emits the --debug-file CLI flag');
  assert.match(sdkBundle, /debugFile/, 'SDK reads the debugFile option');
});

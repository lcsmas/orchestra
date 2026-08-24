import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ─── Guard: `sdkMcpRefresh` must keep RESTARTING the CLI ─────────────────────
//
// Issue #23 asked whether the SDK's `Query.setMcpServers()` could replace the
// full CLI restart that `sdkMcpRefresh` performs. It cannot, and the reason is
// NOT discoverable by reading `setMcpServers`'s own documentation — which
// describes a perfectly sane API and reads like a drop-in upgrade. Hence this
// test: the trap is attractive, so the guard has to be mechanical.
//
// MEASURED, 2026-08-24, against the installed CLI via a real `query()` on an
// isolated CLAUDE_CONFIG_DIR (SDK 0.3.241), using toy stdio MCP servers that
// stamp their pid on boot so a "restart" is observed at PROCESS level rather
// than inferred from the call's return shape:
//
//   • Reconnect scope is DELTA ONLY — re-naming an already-live server in the
//     payload does NOT restart it (alpha's pid was identical before/after, and
//     its start log held exactly one line). Note the returned `added` list
//     over-reports: it listed a server whose process never restarted.
//   • The SESSION SURVIVES — same `session_id` before and after add & remove,
//     and the conversation continued normally.
//   • IN-FLIGHT TOOL CALLS ARE UNHARMED — `setMcpServers` returned in ~108ms
//     while an 8s MCP tool call was running; the call finished on the same pid
//     and returned its correct result with `is_error: false`.
//   • SETTINGS-FILE SERVERS ARE INVISIBLE TO IT — a server written into
//     `<configDir>/.claude.json` mid-session was never added, never spawned,
//     and never appeared in `mcpServerStatus()`. CONTROL: a FRESH `query()`
//     over that same file booted it `connected`, proving the config was valid
//     and the negative is a property of the API, not of the fixture.
//
// That last point is the whole story. `sdkMcpRefresh` exists for exactly one
// job — picking up ACCOUNT-LEVEL `claude.ai` connector changes and settings
// changes, which the CLI resolves ONCE at process start (see the function's
// doc header and docs/codebase-map/structured-agent-view.md). `setMcpServers`
// provably does not see that class of change, so swapping the restart for it
// would silently turn the popover's ↻ into a no-op for the only thing users
// press it for — a regression with NO failing test and no error message,
// visible only as "the connector I just added on claude.ai never shows up".
//
// Orchestra's ONLY dynamically-added MCP server is the in-process `browser`
// one; it is never what ↻ is for. So there is nothing for `setMcpServers` to
// usefully do here today, and this test fails loudly if a future change wires
// it into the refresh path or drops the restart.

const ROOT = process.cwd(); // pnpm test runs from the repo root
const AGENT_SDK = path.join(ROOT, 'src', 'main', 'agent-sdk.ts');

/** Extract the body of a top-level `export async function <name>(` … up to the
 *  next top-level `export ` declaration. Brace-counting would be sturdier, but
 *  the file's own formatting (every top-level export starts at column 0) makes
 *  this both simpler and sufficient — and the assertions below fail loudly if
 *  the slice ever comes back empty. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found in agent-sdk.ts — was it renamed?`);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\nexport ');
  return end === -1 ? rest : rest.slice(0, end);
}

test('sdkMcpRefresh still restarts the CLI (setMcpServers cannot replace it — #23)', () => {
  const source = fs.readFileSync(AGENT_SDK, 'utf8');
  const body = functionBody(source, 'sdkMcpRefresh');

  // Positive control: the slice really is the function we mean, not an empty
  // string that would make every assertion below vacuously pass.
  assert.ok(body.length > 200, 'sdkMcpRefresh body came back suspiciously short');
  assert.match(body, /turnGate/, 'sdkMcpRefresh body does not look like the refresh function');

  // The restart is the mechanism. All three steps matter: sdkStop tears the
  // process down, killKeeper stops ensureSession from reattaching to the very
  // process being replaced, ensureSession boots the replacement.
  assert.match(body, /\bsdkStop\(/, 'sdkMcpRefresh must still tear the CLI down via sdkStop()');
  assert.match(body, /\bkillKeeper\(/, 'sdkMcpRefresh must still kill the keeper (else it reattaches to the stale process)');
  assert.match(body, /\bensureSession\(/, 'sdkMcpRefresh must still boot a replacement CLI');

  // And the trap itself: setMcpServers must NOT appear in the refresh path.
  assert.doesNotMatch(
    body,
    /setMcpServers/,
    'sdkMcpRefresh must NOT use setMcpServers(): measured 2026-08-24, it is blind to ' +
      'settings-file and account-level claude.ai connector changes — the only thing the ' +
      'refresh button exists to pick up. See this file\'s header for the measurement.',
  );
});

test('the codebase map records why setMcpServers cannot replace the refresh restart (#23)', () => {
  // The measurement is only durable if it is written where the next agent
  // looks. This asserts the map carries the finding — not merely the word,
  // but the finding attached to the API name.
  const doc = path.join(ROOT, 'docs', 'codebase-map', 'structured-agent-view.md');
  const text = fs.readFileSync(doc, 'utf8');
  assert.match(
    text,
    /setMcpServers/,
    'structured-agent-view.md must name setMcpServers so the #23 finding is discoverable',
  );
  // The specific reason, not just a mention — a bare mention would rot into
  // "someone considered it" without saying what was measured.
  assert.match(
    text,
    /settings|account-level|connector/i,
    'the map must say WHY setMcpServers cannot replace the restart (settings/account-level blindness)',
  );
});

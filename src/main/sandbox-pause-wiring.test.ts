// #226 — WIRING pins for the sandbox pause. agent-sdk.ts / workspaces.ts cannot be imported under
// `node --test` (Electron + extensionless directory imports), so the DECISION is executed in
// src/shared/sandbox-pause.test.ts and the BEHAVIOUR is proven by the built-app arm `sandbox_paused`
// (scripts/e2e-agent-view-removal.mjs); this file pins WHERE the decision sits and that no other
// agent-start site exists — a source pin, so it proves placement, never effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', 'main', f), 'utf8');
const AGENT_SDK = read('agent-sdk.ts');
const WORKSPACES = read('workspaces.ts');

/** Body of a top-level function: from its signature to the next column-0 `}`. */
function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `signature not found: ${signature}`);
  const end = src.indexOf('\n}\n', at);
  assert.ok(end > at, `no closing brace after: ${signature}`);
  return src.slice(at, end);
}
const before = (b: string, guard: string, later: string) => {
  const g = b.indexOf(guard), l = b.indexOf(later);
  assert.ok(g >= 0, `guard missing: ${guard}`);
  assert.ok(l >= 0, `anchor missing: ${later}`);
  assert.ok(g < l, `${guard} must come BEFORE ${later}`);
};

test('SDK funnel: ensureSessionInner refuses a paused sandbox workspace before ANY side effect', () => {
  const b = body(AGENT_SDK, 'async function ensureSessionInner(');
  assert.match(b, /const paused = sandboxPausedMessage\(ws\);\s*\n\s*if \(paused\) throw new Error\(paused\);/);
  // rewind-cut consumption, hibernation clear, env build (+ hook install) and the query() spawn all come after
  for (const later of ['rewindResumeAt.get(wsId)', 'clearHibernated(wsId)', 'installOrchestraHooks(', 'await buildSdkEnv(ws)', 'query({'])
    before(b, 'sandboxPausedMessage(ws)', later);
});

test('enumeration: exactly ONE agent-start query() (inside the funnel); the other is the tmpdir model probe', () => {
  const sites = [...AGENT_SDK.matchAll(/=\s*query\(\{/g)].map((m) => m.index!);
  assert.equal(sites.length, 2, 'a new query({ site is a new agent-start path — route it through ensureSession or add the pause');
  const inner = body(AGENT_SDK, 'async function ensureSessionInner(');
  const innerAt = AGENT_SDK.indexOf(inner);
  assert.ok(sites.some((s) => s > innerAt && s < innerAt + inner.length), 'a query({ must sit inside ensureSessionInner');
  const probe = body(AGENT_SDK, 'async function probeRuntimeModels(');
  const probeAt = AGENT_SDK.indexOf(probe);
  assert.ok(sites.some((s) => s > probeAt && s < probeAt + probe.length), 'the other query({ must be the model probe');
  assert.match(probe, /cwd: os\.tmpdir\(\)/, 'the probe never runs in a workspace directory');
  // ensureSessionInner has ONE caller (ensureSession) — no side door around the funnel
  assert.equal([...AGENT_SDK.matchAll(/ensureSessionInner\(/g)].length, 2, 'definition + the single ensureSession call');
});

test('wake: wakeAgentWithPrompt refuses a paused sandbox workspace before any wake branch', () => {
  const b = body(WORKSPACES, 'export async function wakeAgentWithPrompt(');
  assert.match(b, /const paused = sandboxPausedMessage\(ws\);\s*\n\s*if \(paused\) \{[\s\S]*?return false;\s*\n\s*\}/);
  for (const later of ['clearHibernated(id)', 'sdkDeliver(id, prompt)', 'sdkStartAndDeliver(id, prompt)', 'await startPty('])
    before(b, 'sandboxPausedMessage(ws)', later);
});

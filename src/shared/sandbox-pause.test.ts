// #226 — the sandbox pause decision. Pure, so it is EXECUTED (the wiring into the SDK
// funnel is proven by the built-app arm `sandbox_paused` in scripts/e2e-agent-view-removal.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_PAUSED_MESSAGE, sandboxPausedMessage } from './sandbox-pause.ts';

test('the message names the pause, the follow-up ticket and its title (literal, not the constant)', () => {
  assert.match(SANDBOX_PAUSED_MESSAGE, /Sandbox agents are paused/);
  assert.match(SANDBOX_PAUSED_MESSAGE, /#220 — Reconcile sandbox agents with the Agent view/);
});

test('a sandbox-hosted workspace is refused with exactly that message', () => {
  assert.equal(
    sandboxPausedMessage({ host: { kind: 'sandbox' } }),
    SANDBOX_PAUSED_MESSAGE,
  );
  // the real record shape carries an endpoint too
  assert.equal(
    sandboxPausedMessage({ host: { kind: 'sandbox', endpoint: 'ws://box:8787' } as { kind: string } }),
    SANDBOX_PAUSED_MESSAGE,
  );
});

test('control: local, explicit-local, unhosted and unknown workspaces are NOT refused', () => {
  assert.equal(sandboxPausedMessage({}), null);
  assert.equal(sandboxPausedMessage({ host: undefined }), null);
  assert.equal(sandboxPausedMessage({ host: { kind: 'local' } }), null);
  assert.equal(sandboxPausedMessage(null), null);
  assert.equal(sandboxPausedMessage(undefined), null);
});

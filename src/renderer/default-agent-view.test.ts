import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readDefaultAgentView,
  writeDefaultAgentView,
  terminalTabLabel,
  DEFAULT_AGENT_VIEW_KEY,
} from './default-agent-view.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    _map: map,
  };
}

test('readDefaultAgentView defaults to structured when unset', () => {
  assert.equal(readDefaultAgentView(fakeStorage()), 'structured');
});

test('readDefaultAgentView returns terminal only for the exact value', () => {
  assert.equal(
    readDefaultAgentView(fakeStorage({ [DEFAULT_AGENT_VIEW_KEY]: 'terminal' })),
    'terminal',
  );
  // Any other/garbage value falls back to the primary structured view.
  assert.equal(
    readDefaultAgentView(fakeStorage({ [DEFAULT_AGENT_VIEW_KEY]: 'TERMINAL' })),
    'structured',
  );
  assert.equal(
    readDefaultAgentView(fakeStorage({ [DEFAULT_AGENT_VIEW_KEY]: 'garbage' })),
    'structured',
  );
});

test('readDefaultAgentView tolerates missing storage', () => {
  assert.equal(readDefaultAgentView(undefined), 'structured');
});

test('write then read round-trips', () => {
  const s = fakeStorage();
  writeDefaultAgentView('structured', s);
  assert.equal(readDefaultAgentView(s), 'structured');
  writeDefaultAgentView('terminal', s);
  assert.equal(readDefaultAgentView(s), 'terminal');
});

test('terminalTabLabel is Raw only when structured is the default', () => {
  assert.equal(terminalTabLabel('terminal'), 'Terminal');
  assert.equal(terminalTabLabel('structured'), 'Raw');
});

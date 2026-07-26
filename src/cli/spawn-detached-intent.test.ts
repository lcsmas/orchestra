import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskAsksForStandaloneWorkspace } from './index.ts';

// Regression: `orchestra spawn` NESTS under the caller by default, and
// `--detached` is opt-in. A brief that asks for a "standalone agent" while
// omitting the flag silently produces the OPPOSITE of the request — and nothing
// downstream fails, because the child runs perfectly, it just shows up nested in
// the sidebar. Only a human noticing the tree ever catches it, which is exactly
// what happened: an agent that had just read the rule still spawned nested.
// Hence a mechanical check rather than another restatement of the rule.

test('fires when the brief asks for a standalone/independent WORKSPACE', () => {
  for (const task of [
    'spawn a standalone agent to fix it',
    'I want an independent agent for this',
    'create a separate workspace for the migration',
    'this agent should be standalone',
    'make it a top-level workspace',
    'spawn a detached session',
    'The AGENT must be independent',
  ]) {
    assert.equal(taskAsksForStandaloneWorkspace(task), true, `should fire: ${task}`);
  }
});

// The gate must stay narrow. An over-broad guard that blocks legitimate work is
// worse than none: it teaches people to route around it, killing it for the
// cases it exists to catch. These are all real task texts about CODE that merely
// reuse the vocabulary.
test('does NOT fire on briefs about standalone/independent CODE', () => {
  for (const task of [
    'Refactor auth into a standalone module',
    'Extract this into an independent npm package',
    'Split the parser into a separate file',
    'Make the component independent of Redux',
    'Add a standalone binary target to the Cargo manifest',
    'Fix a crash in the embedded browser panel: 98 logged errors',
    'Write the module so it is independent of Electron',
  ]) {
    assert.equal(taskAsksForStandaloneWorkspace(task), false, `should NOT fire: ${task}`);
  }
});

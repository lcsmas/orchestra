import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #227 — fix-checks / send-review must not answer "requested" for a prompt that went nowhere: when `wakeAgentWithPrompt` returns
// false and no PTY is live they throw AGENT_WAKE_FAILED. api-handlers.ts imports Electron, so this pins the source shape; the
// built-app rig clauses `wake/review-…` / `wake/fix-checks-…` (scripts/e2e-agent-view-removal.mjs) drive the behaviour.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, 'api-handlers.ts'), 'utf8');

function handlerBody(name: string): string {
  const start = src.indexOf(`  ${name}: async (`);
  assert.ok(start > 0, `${name} handler not found`);
  const end = src.indexOf('\n  },\n', start);
  assert.ok(end > start, `${name} handler end not found`);
  return src.slice(start, end);
}

for (const name of ['fixChecks', 'sendReviewToAgent']) {
  test(`${name}: a failed wake with no live PTY throws AGENT_WAKE_FAILED BEFORE any typing into a PTY`, () => {
    const body = handlerBody(name);
    const wake = body.indexOf('wakeAgentWithPrompt(');
    const guard = body.indexOf('if (!isRunning(id)) throw new Error(AGENT_WAKE_FAILED)');
    const write = body.indexOf('writePty(');
    assert.ok(wake >= 0 && guard > wake, `${name}: the guard must follow the wake call`);
    assert.ok(write > guard, `${name}: the guard must precede writePty (nothing is typed into a PTY that does not exist)`);
  });
}

test('AGENT_WAKE_FAILED names the recovery (see the Agent view error, fix the cause, Restart)', () => {
  const m = src.match(/const AGENT_WAKE_FAILED =\s*'([^']+)'/);
  assert.ok(m, 'AGENT_WAKE_FAILED constant not found');
  assert.match(m![1], /Agent view/);
  assert.match(m![1], /Restart/);
});

// #227 F4 (UI half) — a ticket click that ends in a kept, stopped child rejects: the sidebar must SAY why (a dialog), never swallow it.
// A source pin proves placement only; the CLI half is driven end-to-end in src/cli/restart-args.test.ts.
test('Sidebar: the spawn-from-ticket click surfaces a rejection through dialog.error (no silent catch)', () => {
  const sidebar = fs.readFileSync(path.join(HERE, '..', 'renderer', 'components', 'Sidebar.tsx'), 'utf8');
  const at = sidebar.indexOf('void spawnFromTicket(ticket.identifier, repoPath)');
  assert.ok(at > 0, 'the ticket-click spawn call is not where the pin expects');
  const blk = sidebar.slice(at, at + 300);
  assert.match(blk, /\.catch\(\(e\) => \{\s*void dialog\.error\(`Could not start \$\{ticket\.identifier\}`, \(e as Error\)\.message\);/);
});


// #515 — the production wiring of `/fanoutAcceptance` is pinned by source (it imports the store / Electron seam): the route is registered, the spawn goes through the AGENT spawn route
// (name → role table → Opus 5.5), the freeze status is a bus `status` filed in the RECIPIENT's own run. The behaviour is driven in src/cli/fanout-acceptance-forced.test.ts + the rig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');

test('hooks-server routes /fanoutAcceptance to the production dispatcher', () => {
  const src = read('hooks-server.ts');
  assert.match(src, /import \{ dispatchFanoutAcceptanceRequest \} from '\.\/fanout-acceptance-wiring\.ts'/);
  assert.match(src, /route === '\/fanoutAcceptance'[\s\S]{0,400}await dispatchFanoutAcceptanceRequest\(msg\)/);
});

test('wiring: the writer is spawned through dispatchAgentSpawnRequest (the role table pins the model), the status is a bus `status` in the recipient\'s run', () => {
  const src = read('fanout-acceptance-wiring.ts');
  assert.match(src, /dispatchAgentSpawnRequest\(\{[^}]*name: i\.name/);
  assert.doesNotMatch(src, /model:/, 'no model pin of its own: the `accept-` prefix does it (fleet-roles.ts)');
  assert.match(src, /kind: 'status'/);
  assert.match(src, /runId: resolveWaveRunId\(ws\)/);
  assert.match(src, /recipient: to/);
});

test('#614 wiring: the host reports a workspace\'s transcript directory through the SDK\'s own resolution (pinned account + mangled worktree)', () => {
  assert.match(read('fanout-acceptance-wiring.ts'), /transcriptDirOf: \(id\) => \{ const w = store\.getWorkspace\(id\); return w \? transcriptDirOfWorkspace\(w\) : null; \}/);
  assert.match(read('agent-sdk.ts'), /export const transcriptDirOfWorkspace = transcriptDir;/);
});

test('#629 / #628 wiring: the host archives through the app\'s own archiveWorkspace (plan-release: the accepted plan\'s agent; release: a replaced implementer)', () => {
  assert.match(read('fanout-acceptance-wiring.ts'), /import \{ archiveWorkspace, dispatchAgentSpawnRequest,/);
  assert.match(read('fanout-acceptance-wiring.ts'), /archive: \(id\) => archiveWorkspace\(id\)/);
});

// Self-test for the fixture library (issue #47).
//
// TWO ARMS, and the second is the one that matters:
//   1. POSITIVE — every real capture builds and validates. Proves the library
//      is usable and that the adapters still read today's captures.
//   2. NEGATIVE — a deliberately MALFORMED fixture must be REJECTED. A
//      validator nobody has watched fail is indistinguishable from one that
//      CANNOT fail, so each case below is a mutation of a real capture, and the
//      harness fails if any of them LEAKS through.
//
// Run: node scripts/fixtures/self-test.mjs

import {
  liveContextUsage,
  contextCommandUsage,
  toolResultMetaTrio,
  backgroundTasksSequence,
  rawLiveContextUsagePayload,
  rawContextCommandPayload,
} from './index.mjs';

let failures = 0;
const ok = (label) => console.log(`  ok   ${label}`);
const fail = (label, detail) => {
  failures++;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Arm 1: this must BUILD. */
function builds(label, fn, assertFn) {
  try {
    const v = fn();
    if (assertFn) {
      const problem = assertFn(v);
      if (problem) return fail(label, problem);
    }
    ok(label);
  } catch (e) {
    fail(label, `threw: ${e.message}`);
  }
}

/** Arm 2: this must be REJECTED. A leak is a validator that cannot fire. */
function rejects(label, fn) {
  try {
    fn();
    fail(`REJECTS ${label}`, 'it LEAKED through — this validator cannot fire');
  } catch (e) {
    if (e && e.name === 'FixtureError') ok(`rejects ${label}`);
    else fail(`REJECTS ${label}`, `threw the wrong error type: ${e.name}: ${e.message}`);
  }
}

console.log('\nARM 1 — the real captures build and validate:');

builds('live getContextUsage() normalizes', () => liveContextUsage(), (u) => {
  if (u.totalTokens !== 73191) return `totalTokens ${u.totalTokens} !== 73191 (the captured value)`;
  if (u.percentage !== 37) return `percentage ${u.percentage} !== 37`;
  if (u.source !== 'live') return `source ${u.source}`;
  return null;
});

builds('...its NESTED skills.skillFrontmatter[] arm survives', () => liveContextUsage(), (u) => {
  if (!u.skills?.length) return 'skills came back empty';
  const plugin = u.skills.find((s) => s.pluginName);
  if (!plugin) return 'no skill carried pluginName — the #31 disambiguator was dropped';
  return plugin.pluginName === 'slack' ? null : `pluginName '${plugin.pluginName}'`;
});

builds('...and its deferred rows are classified', () => liveContextUsage(), (u) => {
  const d = u.categories.filter((c) => c.kind === 'deferred').length;
  return d === 2 ? null : `expected 2 deferred rows, got ${d}`;
});

builds('/context context_usage normalizes (FLAT skills[])', () => contextCommandUsage(), (u) => {
  if (u.totalTokens !== 68205) return `totalTokens ${u.totalTokens} !== 68205`;
  if (u.source !== 'context-command') return `source ${u.source}`;
  if (!u.skills?.length) return 'flat skills[] arm produced nothing';
  return null;
});

builds('the two shapes stay DISTINCT (a conflated fixture is the classic trap)', () => ({ a: liveContextUsage(), b: contextCommandUsage() }), ({ a, b }) => {
  if (a.totalTokens === b.totalTokens) return 'both captures report the same total — one is probably a copy of the other';
  const rawA = rawLiveContextUsagePayload();
  const rawB = rawContextCommandPayload();
  if ('total_tokens' in rawA) return 'the LIVE capture has snake_case total_tokens — shapes conflated';
  if ('totalTokens' in rawB) return 'the /context capture has camelCase totalTokens — shapes conflated';
  return null;
});

builds('tool_result_meta trio classifies structurally', () => toolResultMetaTrio(), (t) => {
  const want = ['denied', 'interrupted', 'cancelled'];
  for (const k of want) if (!t[k]) return `missing the '${k}' case`;
  return null;
});

builds('background_tasks_changed sequence validates', () => backgroundTasksSequence(), (f) => {
  if (f.length !== 4) return `expected 4 frames, got ${f.length}`;
  if (f.at(-1).tasks.length !== 0) return 'the final frame must drain to empty';
  return null;
});

console.log('\nARM 2 — malformed fixtures are REJECTED (each validator watched failing):');

// Every case below is a real rig-side defect shape from the two retrospectives.
rejects('a category row missing `kind` on the /context wire shape', () =>
  contextCommandUsage({
    categories: [
      { name: 'MCP tools (deferred)', tokens: 100, kind: 'deferred' },
      { name: 'Bogus', tokens: 10 },
    ],
  }),
);

rejects('a category row with an INVENTED kind', () =>
  contextCommandUsage({
    categories: [
      { name: 'MCP tools (deferred)', tokens: 100, kind: 'deferred' },
      { name: 'Bogus', tokens: 10, kind: 'sort-of-used' },
    ],
  }),
);

rejects('an MCP tool with no serverName (panel silently collapses)', () =>
  liveContextUsage({ mcpTools: [{ name: 'mcp__x__y', tokens: 5 }] }),
);

rejects('a non-numeric totalTokens', () => liveContextUsage({ totalTokens: 'lots' }));

rejects('skills emptied — the nested adapter arm regressing', () =>
  liveContextUsage({ skills: { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: [] } }),
);

rejects('a capture with no deferred rows left', () =>
  liveContextUsage({ categories: [{ name: 'Messages', tokens: 5, color: 'claude' }] }),
);

rejects('an INVENTED non_execution_kind (the wave-1 "turn-error" defect shape)', () =>
  toolResultMetaTrio({ denied: { tool_result_meta: [{ id: 'toolu_denied_1', non_execution_kind: 'quantum-refused' }] } }),
);

rejects('a sidecar id that does not match its tool_use_id', () =>
  toolResultMetaTrio({ denied: { tool_result_meta: [{ id: 'toolu_WRONG', non_execution_kind: 'user-rejected' }] } }),
);

rejects('a background frame carrying a non-array tasks (delta, not replace)', () =>
  backgroundTasksSequence({ frames: [{ type: 'system', subtype: 'background_tasks_changed', tasks: 'nope' }] }),
);

rejects('a background sequence that never drains to empty', () =>
  backgroundTasksSequence({
    frames: [
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'a', description: 'x' },
          { task_id: 'b', description: 'y' },
        ],
      },
    ],
  }),
);

rejects('a background task with no description', () =>
  backgroundTasksSequence({
    frames: [
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a' }] },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    ],
  }),
);

console.log('');
if (failures) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('ALL PASS — captures build, malformed fixtures rejected');

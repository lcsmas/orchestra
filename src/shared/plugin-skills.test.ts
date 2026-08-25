import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enabledPluginInstalls,
  manifestSkillPaths,
  pluginSkillName,
  pluginSkillRoots,
} from './plugin-skills.ts';

// ─── Guard: plugin skills must reach the composer WITHOUT a session ──────────
//
// The bug this covers (observed 2026-08-25): typing `/` in a fresh workspace
// listed no plugin skills — the mattpocock-skills set was invisible until the
// user had already sent a message. Cause: `sdkListSkills` scanned only
// `<worktree>/.claude/skills` and `<configDir>/skills`, while plugin skills
// live under `<configDir>/plugins/cache/<marketplace>/<plugin>/<version>/`.
// They therefore reached the menu ONLY via `session/init`'s `slash_commands`,
// which the SDK emits when the FIRST request starts.
//
// The skills were always INVOCABLE from turn one — the runtime resolves them
// regardless of the menu. Only discoverability lagged. So the property under
// test is precedence + naming of the disk scan, never "can it run".

test('enabled plugins resolve to their install paths', () => {
  const got = enabledPluginInstalls(
    { enabledPlugins: { 'mattpocock-skills@official': true } },
    {
      plugins: {
        'mattpocock-skills@official': [
          { installPath: '/cfg/plugins/cache/official/mattpocock-skills/1.2.3' },
        ],
      },
    },
  );
  assert.deepEqual(got, [
    {
      key: 'mattpocock-skills@official',
      pluginName: 'mattpocock-skills',
      installPath: '/cfg/plugins/cache/official/mattpocock-skills/1.2.3',
    },
  ]);
});

test('a DISABLED plugin is excluded even though it is installed', () => {
  // The failure this guards: listing a skill the runtime would reject.
  const installed = {
    plugins: { 'off@official': [{ installPath: '/cfg/off' }] },
  };
  assert.deepEqual(enabledPluginInstalls({ enabledPlugins: { 'off@official': false } }, installed), []);
  // Absent from enabledPlugins entirely = off (CLI semantics).
  assert.deepEqual(enabledPluginInstalls({ enabledPlugins: {} }, installed), []);
  // CONTROL: the same record DOES resolve once enabled, proving the fixture
  // is well-formed and the empty results above are the gate, not a typo.
  assert.equal(
    enabledPluginInstalls({ enabledPlugins: { 'off@official': true } }, installed).length,
    1,
  );
});

test('an enabled plugin with no install record is skipped, not crashed', () => {
  assert.deepEqual(
    enabledPluginInstalls({ enabledPlugins: { 'ghost@official': true } }, { plugins: {} }),
    [],
  );
});

test('multiple install scopes collapse to one entry', () => {
  // installed_plugins.json holds one record per scope (user + project), both
  // pointing at the same versioned path — the menu must not list it twice.
  const got = enabledPluginInstalls(
    { enabledPlugins: { 'p@m': true } },
    { plugins: { 'p@m': [{ installPath: '/a' }, { installPath: '/a' }] } },
  );
  assert.equal(got.length, 1);
});

test('missing settings or installed file yields no plugins', () => {
  assert.deepEqual(enabledPluginInstalls(null, { plugins: {} }), []);
  assert.deepEqual(enabledPluginInstalls({ enabledPlugins: { 'a@b': true } }, null), []);
});

test('manifest skill paths ignore malformed entries', () => {
  assert.deepEqual(manifestSkillPaths({ skills: ['./skills/a', 42, './skills/b'] }), [
    './skills/a',
    './skills/b',
  ]);
  assert.deepEqual(manifestSkillPaths({ skills: 'nope' }), []);
  assert.deepEqual(manifestSkillPaths({}), []);
  assert.deepEqual(manifestSkillPaths(null), []);
});

test('plugin skill names are NAMESPACED to match session/init', () => {
  // If this returned a bare `tdd`, the composer would show the skill twice
  // once session/init arrives (its dedup is keyed on the name), and the bare
  // name would also collide with a user-level skill of the same name.
  assert.equal(pluginSkillName('mattpocock-skills', 'tdd'), 'mattpocock-skills:tdd');
});

// ─── The two plugin LAYOUTS ─────────────────────────────────────────────────
//
// Nearly shipped a manifest-only reader. Of the two plugins installed here:
//   • mattpocock-skills declares 25 explicit `skills` paths (and its tree also
//     carries deprecated/ + in-progress/ dirs the CLI does NOT load).
//   • slack has NO `skills` key at all — 7 skills under a plain `skills/` dir.
// A manifest-only scan found 25 and silently missed all 7. The live scan now
// returns 32. This test is the guard for that second layout.

const join = (...p: string[]) => p.join('/');

test('a manifest WITH skills uses those paths verbatim', () => {
  const got = pluginSkillRoots('/i', { skills: ['./skills/engineering/tdd'] }, join);
  assert.deepEqual(got, { mode: 'manifest', rels: ['./skills/engineering/tdd'] });
});

test('a manifest WITHOUT skills falls back to scanning skills/', () => {
  // The slack shape: real manifest, no `skills` key.
  assert.deepEqual(pluginSkillRoots('/i', { }, join), { mode: 'scan', dir: '/i/skills' });
  // An EMPTY array is also a fallback, not "zero skills" — otherwise a plugin
  // shipping `"skills": []` would go invisible.
  assert.deepEqual(pluginSkillRoots('/i', { skills: [] }, join), { mode: 'scan', dir: '/i/skills' });
  // An unreadable/absent manifest still scans rather than giving up.
  assert.deepEqual(pluginSkillRoots('/i', null, join), { mode: 'scan', dir: '/i/skills' });
});

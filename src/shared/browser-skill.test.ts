// #399 — the bundled orchestra-browser skill is held to the CLI's own allowlist, and every topic the ticket names is in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BROWSER_SKILL, BROWSER_SKILL_EXAMPLE_HEADING, BROWSER_SKILL_NAME, documentedCommands, lintBrowserSkill, shellWords } from './browser-skill.ts';

const mutate = (from: string | RegExp, to: string): string => {
  const out = BROWSER_SKILL.replace(from, to);
  assert.notEqual(out, BROWSER_SKILL, `mutant anchor ${String(from)} must match the skill text`);
  return out;
};

test('the shipped skill is clean: every documented command is accepted by planBrowserCommand, every "cannot do" is refused', () => {
  assert.deepEqual(lintBrowserSkill(BROWSER_SKILL), []);
  const d = documentedCommands(BROWSER_SKILL);
  assert.ok(d.allowed.length >= 40, `${d.allowed.length} allowed commands extracted`);
  assert.ok(d.refused.length >= 8 && d.refusedFlags.length >= 4, `${d.refused.length} refused commands, ${d.refusedFlags.length} refused flags extracted`);
});

test('must-FAIL: the lint reddens on each kind of wrong documentation', () => {
  // a usable command the CLI refuses, a re-pointing flag shown as usable, an unknown command, a leading option, a "cannot do" the CLI actually accepts, a broken frontmatter
  assert.ok(lintBrowserSkill(mutate('orchestra browser open http://localhost:3000/login', 'orchestra browser connect ws://127.0.0.1:1/x')).some((p) => /refused by the CLI.*connect/.test(p)));
  assert.ok(lintBrowserSkill(mutate('b open "$URL"', 'b open "$URL" --session other')).some((p) => /--session/.test(p)));
  assert.ok(lintBrowserSkill(mutate('b wait "#welcome"', 'b frobnicate "#welcome"')).some((p) => /frobnicate/.test(p)));
  assert.ok(lintBrowserSkill(mutate('orchestra browser snapshot -i                        # the page', 'orchestra browser -i snapshot                        # the page')).some((p) => /-i/.test(p)));
  assert.ok(lintBrowserSkill(mutate('§connect§'.replace('§', '`').replace('§', '`'), '`click`')).some((p) => /documented as refused but the CLI accepts it.*click/.test(p)));
  assert.ok(lintBrowserSkill(mutate('name: orchestra-browser', 'name: browser')).some((p) => /frontmatter name/.test(p)));
  assert.ok(lintBrowserSkill(BROWSER_SKILL.replace(/^---\n/, '')).length > 0);
});

test('the skill covers every topic the ticket names (compact snapshot-with-refs, click/fill/type/press/wait, tabs, screenshot-to-file, stale ref, chaining, can-not-do, focus)', () => {
  const need: Array<[string, RegExp]> = [
    ['snapshot with refs', /snapshot -i/], ['refs addressed as @eN', /@e3/], ['click', /click @e5/], ['fill', /fill @e3/], ['type', /keyboard type/], ['press', /press Enter/], ['wait', /wait "#result"/],
    ['tab commands', /tab list.*tab new.*tab close/s], ['tab ownership', /only the tabs YOU opened/], ['screenshot to a file read with Read', /screenshot.*\*\*Read\*\*/s], ['stale ref recovery', /browser_stale_ref[\s\S]*snapshot[\s\S]*again/],
    ['chaining in one call', new RegExp(BROWSER_SKILL_EXAMPLE_HEADING)], ['set -e', /set -e/], ['cannot attach or switch profiles', /cannot attach, switch or create profiles/], ['focus', /not observed to move the human's keyboard focus/],
    ['bring to front', /brings it to the front/], ['hidden pane', /not on screen/], ['hidden-pane wait caveat', /hidden page has no width[\s\S]*times out[\s\S]*wait --fn/], ['errors caveat', /`errors` prints blank lines/],
  ];
  for (const [what, re] of need) assert.match(BROWSER_SKILL, re, what);
});

test('the worked example section holds exactly one bash block that uses $URL and only fixture-neutral names', () => {
  const at = BROWSER_SKILL.indexOf(BROWSER_SKILL_EXAMPLE_HEADING);
  assert.ok(at > 0);
  const rest = BROWSER_SKILL.slice(at);
  const block = /```bash\n([\s\S]*?)```/.exec(rest)?.[1] ?? '';
  assert.match(block, /^set -e\n/);
  assert.match(block, /b open "\$URL"/);
  assert.ok(block.split('\n').filter((l) => l.startsWith('b ')).length >= 4);
});

test('shellWords: quotes group, $(…) collapses to a ref, a trailing comment is dropped', () => {
  assert.deepEqual(shellWords('fill "$(ref \'textbox "Email\')" "me@example.com"'), ['fill', '@e0', 'me@example.com']);
  assert.deepEqual(shellWords('open http://x/y   # note'), ['open', 'http://x/y']);
  assert.deepEqual(shellWords(`eval "document.querySelector('#q').value = 'x'"`), ['eval', `document.querySelector('#q').value = 'x'`]);
});

test('wiring: installHooks writes the skill into every worktree, from this module, under its own name', () => {
  const src = fs.readFileSync(new URL('../main/workspaces.ts', import.meta.url), 'utf8');
  assert.match(src, /import \{ BROWSER_SKILL, BROWSER_SKILL_NAME \} from '\.\.\/shared\/browser-skill\.ts';/);
  assert.match(src, /writeSkill\(BROWSER_SKILL_NAME, BROWSER_SKILL\)/);
  assert.equal(BROWSER_SKILL_NAME, 'orchestra-browser');
  // already-installed worktrees only reinstall when the HOOKS_VERSION digest moves: the skill text must be IN it
  const hv = src.slice(src.indexOf('const HOOKS_VERSION'), src.indexOf(".digest('hex')"));
  assert.match(hv, /\bBROWSER_SKILL,/, 'HOOKS_VERSION must hash BROWSER_SKILL, or a worktree that already carries the stamp never gets the skill');
});

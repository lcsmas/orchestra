// #441 — the generated skills / briefs / reminders describe ONE channel (the bus) and never "bus run — or legacy".
// The skill text lives in src/main/workspaces.ts (Electron seam: not importable under `node --test`), so this reads the SOURCE and
// asserts on the template literals that are written into every worktree (`writeSkill('orchestra-comms', COMMS_SKILL)` …).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'workspaces.ts'), 'utf8');

/** One `const NAME = \`…\`;` template literal, whole (up to the closing backtick at a line start). */
function skill(name: string): string {
  const start = SRC.indexOf(`const ${name} = \``);
  assert.notEqual(start, -1, `${name} not found in workspaces.ts — renamed?`);
  const end = SRC.indexOf('\n`;', start);
  assert.notEqual(end, -1, `${name} has no closing backtick`);
  return SRC.slice(start, end);
}

/** What no generated text may say any more: a switch that no longer exists, a second channel, the no-run fallback. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/delivery[- ](ON|OFF)/i, 'delivery-ON/OFF wording'],
  [/`delivery`|\\`delivery\\`|delivery switch/i, 'a `delivery` switch'],
  [/legacy (channel|delivery|\/ bloc2|run)/i, 'legacy channel / run wording'],
  [/bus run\)? — or|— or orchestra message/i, 'a two-alternative "bus run — or …" instruction'],
  [/plain standalone workspace with no run|no run \(a plain|a run with no row/i, 'the "no run → fall back to message" case'],
  [/refused (on|toward) a delivery/i, 'a refusal scoped to a delivery-ON run'],
];

for (const name of ['COMMS_SKILL', 'SPAWN_SKILL', 'WORKSPACE_ADMIN_SKILL', 'RENAME_SKILL', 'STATUS_SKILL']) {
  test(`#441 ${name}: no delivery-ON/OFF, no legacy channel, no second channel`, () => {
    const text = skill(name);
    for (const [re, what] of FORBIDDEN) assert.doesNotMatch(text, re, `${name} still carries ${what}`);
  });
}

test('#441 orchestra-comms teaches ONE channel: `send` for every peer, `message` refused, only `--emergency` survives (leading token)', () => {
  const t = skill('COMMS_SKILL');
  assert.match(t, /orchestra send --type status --to <peer-id> <your message\.\.\.>/);
  assert.match(t, /the bus is the ONLY channel between agents/i);
  assert.match(t, /orchestra message <peer-id> <text\.\.\.>\\` is REFUSED for every peer/);
  assert.match(t, /orchestra message --emergency <peer-id> <text\.\.\.>/);
  assert.match(t, /--emergency\\` MUST be the leading token/);
  // the only two-case "still works" list of the old text is gone
  assert.doesNotMatch(t, /It still works in two cases/);
});

test('#441 the orchestrator brief + the standing role reminders name `send` and the --emergency-only survivor, never "delivery-ON"', () => {
  const brief = SRC.slice(SRC.indexOf('export function orchestratorBrief('), SRC.indexOf('export function orchestratorBrief(') + 6000);
  assert.match(brief, /the bus is the only channel between agents: `orchestra message` is refused and points at `orchestra send`/);
  for (const [re, what] of FORBIDDEN) assert.doesNotMatch(brief, re, `the orchestrator brief still carries ${what}`);
  // the two standing-role reminders (coordinator pure / dual) are inline strings: scan the whole file for the old wording
  for (const [re, what] of FORBIDDEN) assert.doesNotMatch(SRC.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''), re, `workspaces.ts (outside comments) still carries ${what}`);
});

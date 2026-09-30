import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// #252 fleet PAUSE — the sites the rig (pause-gates.test.ts) cannot LOAD (Electron-bound api-handlers.ts / index.ts), pinned by source
// position, plus the ENUMERATION guard for HUMAN origins. Each arm is what an in-place mutant of that clause reddens (ledger #261).
// Source-shape guards are weaker than the rig: the behavioural proof for every other row is in pause-gates.test.ts.

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', 'main', f), 'utf8');
const API = read('api-handlers.ts');
const INDEX = read('index.ts');
const ROSTER = read('wake-roster.ts');
const body = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `anchor missing: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b > a, `end anchor missing: ${end}`);
  return src.slice(a, b);
};

test('row 11 pty:start: the handler hands the brief to the REAL scheduler (gated at fire time, driven by the `pty_brief` rig arm) and the scheduler gates before it writes', () => {
  const b = body(API, 'ptyStart: async (id, cols, rows) =>', 'ptyWrite: async');
  assert.match(body(b, 'if (!resuming && ws.lastTask)', '\n  },'), /scheduleOpeningBrief\(id, ws\.lastTask, writePty\)/);
  assert.doesNotMatch(b, /writePty\(id, task/, 'the handler no longer types the brief itself');
  assert.doesNotMatch(body(b, 'const resuming', 'if (!resuming && ws.lastTask)'), /pauseRefusal/, 'opening the terminal itself (HUMAN) is not gated');
  const sched = read('opening-brief-pty.ts');
  assert.ok(sched.indexOf("pauseRefusalById(id, 'auto')") >= 0 && sched.indexOf("pauseRefusalById(id, 'auto')") < sched.indexOf("write(id, task + '\\n')"), 'gate precedes the write');
});

test('row 1 composer: the human prompt carries origin human to the sdkSend gate', () => {
  assert.match(body(API, 'agentSdkSend: async', 'agentSdkRunBash'), /sdkSend\(wsId, text, images, undefined, undefined, false, false, 'human'\)/);
});

test('rows 22/28: inbox tray release, Fix checks and Send review are HUMAN clicks (origin human reaches the gates)', () => {
  assert.match(API, /releaseInboxMessage: \(id, text\) => releaseInboxBlock\(id, text, 'human'\)/);
  assert.match(API, /releaseAllInboxBlocks\(id, 'human'\)/);
  assert.equal([...API.matchAll(/wakeAgentWithPrompt\(id, prompt, \{ origin: 'human' \}\)/g)].length, 2, 'fixChecks + sendReviewToAgent');
});

test('row 14 wiring: the boot roster is the REAL wakeRosterEntry, whose wakeable clause carries the pause refusal', () => {
  assert.match(INDEX, /setWakeRoster\(\(\) => store\.workspaces\.map\(wakeRosterEntry\)\);/);
  assert.match(ROSTER, /pauseRefusal\(ws, 'auto'\) === null &&/);
});

test('ENUMERATION: the ONLY sites that pass origin `human` are the composer, tray, Send now, Fix checks, Send review and the toolbar Restart — a new one is a new pause bypass', () => {
  const dir = path.join(process.cwd(), 'src', 'main');
  const found: Record<string, number> = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    // strip comments so prose about 'human' cannot count
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
    const n = [...src.matchAll(/'human'/g)].length;
    if (n > 0) found[f] = n;
  }
  assert.deepEqual(found, {
    'agent-sdk.ts': 1,          // the `origin === 'human'` tag that feeds the drain gate
    'api-handlers.ts': 5,       // composer + tray release + release-all + Fix checks + Send review
    'bus-pause.ts': 1,          // pauseRefusalWith: a human origin is never refused
    'prompt-queue.ts': 1,       // "Send now" (force)
    'restart-workspace.ts': 1,  // trigger 'toolbar' → human
  });
});

test('docs: the orchestra-comms skill SOURCE (COMMS_SKILL) documents the verbs, the refusal text and the human-prompt policy', () => {
  const src = read('workspaces.ts');
  const skill = body(src, 'const COMMS_SKILL = `', 'const WORKSPACE_ADMIN_SKILL').replace(/\\`/g, '`'); // un-escape the template literal's \\`
  assert.match(skill, /orchestra run pause --hard \[--run <id>\]/);
  assert.match(skill, /orchestra run resume \[--run <id>\]/);
  assert.match(skill, /run en pause — orchestra run resume --run <id>/);
  assert.match(skill, /A prompt a HUMAN types in a member's composer is still allowed and does NOT\s*\nlift the pause/);
  assert.match(skill, /`pause`\s*\nswitch ON at wave start \(frozen; default OFF\)/);
});

test('docs: `orchestra --help` lists run as hold / pause / resume', () => {
  const help = fs.readFileSync(path.join(process.cwd(), 'src', 'cli', 'help.ts'), 'utf8');
  assert.match(help, /summary: "Admin: re-freeze a mission run's switches; hold \/ pause \/ resume a run"/);
});

test('F5 (review D1a): D1a\'s texts describe ONLY D1a — no Bilan/snapshot/interrupt/kill promise, and the lift says what really resumes', () => {
  const src = read('workspaces.ts');
  const skill = body(src, 'const COMMS_SKILL = `', 'const WORKSPACE_ADMIN_SKILL').replace(/\\`/g, '`');
  const sect = skill.slice(skill.indexOf('## 7. Pause a run'));
  const help = fs.readFileSync(path.join(process.cwd(), 'src', 'cli', 'help.ts'), 'utf8');
  const runHelp = body(help, "name: 'run',", "name: 'message'");
  const verbs = fs.readFileSync(path.join(process.cwd(), 'src', 'cli', 'bus-verbs.ts'), 'utf8');
  const lifted = body(verbs, 'pause LIFTED', 'Its liveness hold was lifted too');
  for (const [name, text] of [['skill §7', sect], ['run --help', runHelp], ['lift output', lifted]] as const) {
    assert.doesNotMatch(text, /Bilan|snapshot|interrupts the turn|kills tool|Nothing restarts on its own/i, `${name} promises unshipped behaviour`);
  }
  assert.match(lifted, /Queued turns and pending bus mail resume now/);
  assert.match(sect, /queued turns \+ pending mail resume/);
  assert.match(runHelp, /queued turns and pending\s+bus mail resume/);
});

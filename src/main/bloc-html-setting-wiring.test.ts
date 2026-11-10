// #418 — the WIRING of the Bloc HTML switch, pinned structurally (workspaces.ts / agent-sdk.ts / the store import Electron seams and cannot run under `node --test`;
// the behaviour is proven by `pnpm run test:bloc-html-instruction` (scripts/session-budget/bloc-html.mjs): the real CLI against the fake API). Each assertion is a relationship over comment-stripped source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
  return raw.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
}

test('every session start decides the CLI env from the live switch, after dropping an inherited flag', () => {
  const a = codeOf('src/main/agent-sdk.ts');
  const del = a.indexOf('delete env[BLOC_HTML_ENV];');
  const set = a.indexOf("if (isBlocHtmlEnabled()) env[BLOC_HTML_ENV] = '1';");
  assert.ok(del > 0 && set > del, 'delete first, then set only when ON');
  assert.equal((a.match(/BLOC_HTML_ENV\] = /g) ?? []).length, 1, 'one assignment, nothing else sets the flag');
});

test('the SessionStart hook is installed, written and part of the hook-bundle hash', () => {
  const w = codeOf('src/main/workspaces.ts');
  assert.ok(/upsertHookCommand\(sessionStartList, HOOK_BLOC_HTML_CMD\)/.test(w), 'wired on SessionStart');
  assert.ok(/w\('bloc-html-instruction\.sh', BLOC_HTML_INSTRUCTION_SCRIPT\)/.test(w), 'script written');
  const hash = w.slice(w.indexOf('const HOOKS_VERSION'), w.indexOf('.digest('));
  assert.ok(hash.includes('BLOC_HTML_INSTRUCTION_SCRIPT') && hash.includes('HOOK_BLOC_HTML_CMD'), 'a text change forces the one reinstall');
  assert.ok(!/SubagentStart/.test(w.slice(w.indexOf('HOOK_BLOC_HTML_CMD'), w.indexOf('HOOK_BLOC_HTML_CMD') + 400)), 'never on the Agent tool sub-agents');
});

test('the switch has one channel pair, a preload bridge, a typed API and a store field that defaults ON', () => {
  assert.ok(/blocHtmlEnabled: 'settings:blocHtmlEnabled'/.test(codeOf('src/main/api-handlers.ts')));
  assert.ok(/setBlocHtmlEnabled: 'settings:setBlocHtmlEnabled'/.test(codeOf('src/main/api-handlers.ts')));
  assert.ok(/setBlocHtmlEnabled: \(next\) => ipcRenderer\.invoke\('settings:setBlocHtmlEnabled', next\)/.test(codeOf('src/preload/index.ts')));
  assert.ok(/setBlocHtmlEnabled: \(next: boolean\) => Promise<boolean>/.test(codeOf('src/shared/ipc.ts')));
  assert.ok(/return this\.data\.blocHtmlEnabled;/.test(codeOf('src/main/store.ts')), 'raw read — absent stays undefined, the shared normalizer makes it ON');
});

test('the renderer follows the host echo, and a failed boot read renders OFF', () => {
  const s = codeOf('src/renderer/store.ts');
  assert.ok(/blocHtmlEnabled: false,/.test(s), 'false until the boot read answers');
  assert.ok(/orEmpty\('blocHtmlEnabled', window\.orchestra\.blocHtmlEnabled\(\), false\)/.test(s));
  const w = codeOf('src/renderer/components/BlocHtmlSettings.tsx');
  assert.ok(/useStore\.setState\(\{ blocHtmlEnabled: stored \}\)/.test(w), 'the store takes the stored value, never the optimistic one');
});

test('the renderer seam (FI-2) reads the switch from the store, no longer a constant', () => {
  const h = codeOf('src/renderer/components/agent/bloc-html-enabled.ts');
  assert.ok(/return useStore\(\(s\) => s\.blocHtmlEnabled\);/.test(h));
  assert.ok(!/return true;/.test(h), 'the #415 constant stub is gone');
});

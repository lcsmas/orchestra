// #323 (D-Q10 = A + A) — the WIRING of the Plafond mémoire UI, pinned structurally (the components import the store / Electron seams and cannot run under `node --test`; the rendered HTML is proven by
// scripts/memcap-settings-render-smoke.mjs, the pixels + the live commit/refusal by the built-app drive). Each assertion is a relationship over comment-stripped source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = raw.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
  assert.ok(code.length > 300, `comment-stripping ${rel} returned too little`);
  return code;
}

test('WINDOW: the Plafond section commits the PAIR through the shared planner on blur AND Enter of BOTH inputs; an invalid pair is refused inline (nothing sent); only the cap pair travels', () => {
  const w = codeOf('src/renderer/components/MemoryGuardSettings.tsx');
  assert.ok(/planCapCommit\(capDraft\.soft, capDraft\.hard, basis, view\?\.totalBytes\)/.test(w), 'the commit is planned by the shared pure planner over the in-flight basis');
  assert.ok(/p\.kind === 'invalid'\) \{\s*setError\(p\.error\);/.test(w.slice(w.indexOf('const commitCap'))), 'invalid ⇒ the inline error, no apply');
  assert.ok(/void apply\(p\.patch, null, capDraft\);/.test(w), 'valid ⇒ one apply of the planner\'s patch');
  assert.equal((w.match(/onBlur=\{commitCap\}/g) ?? []).length, 2, 'both inputs commit on blur');
  assert.equal((w.match(/if \(e\.key === 'Enter'\) commitCap\(\);/g) ?? []).length, 2, 'both inputs commit on Enter');
  assert.ok(/const shownError = error \?\? liveError \?\? liveCapError \?\? liveWaitError;/.test(w), 'the live refusal while typing shares the one error line');
  assert.ok(/data-mg-cap-soft/.test(w) && /data-mg-cap-hard/.test(w) && /data-mg-cap-section/.test(w) && /data-mg-cap-switch/.test(w), 'the hooks the drive reads');
});

test('WINDOW (D-Q1): the activation is only SHOWN — the window reads ONE light summary (busCapSummary) and never writes a switch', () => {
  const w = codeOf('src/renderer/components/MemoryGuardSettings.tsx');
  assert.ok(/setCapSwitch\(await window\.orchestra\.busCapSummary\(\)\)/.test(w), 'the window asks the dedicated light read, not the whole pane snapshot every 2 s');
  assert.ok(!/busListRuns|busSnapshot/.test(w), 'no pane-projection read from a 2 s poll (review MAJOR 2)');
  assert.ok(!/setBusSwitches/.test(w), 'no write path to the frozen switch from this window');
  assert.equal((w.match(/type="checkbox"/g) ?? []).length, 1, 'the only checkbox is the Admission / fast-Veille toggle');
});

test('RESOURCES: the snapshot carries the levels NOW; the table gets them and the dim summary; a capped row\'s MEM cell holds the bar, an uncapped one is untouched', () => {
  const r = codeOf('src/main/resources.ts');
  assert.ok(/capLevels: \(\(\) => \{\s*const s = store\.getMemoryGuardSettings\(\);\s*return \{ softGb: s\.capSoftGb, hardGb: s\.capHardGb \};\s*\}\)\(\),/.test(r));
  const v = codeOf('src/renderer/components/ResourcesView.tsx');
  assert.ok(/capLine=\{capSummaryLine\(rows\.map\(\(r\) => \(\{ key: r\.key, name: r\.ws \? r\.ws\.branch : r\.fallbackName, cap: r\.cap \}\)\)\)\}/.test(v));
  assert.ok(/capLevels=\{snap\?\.capLevels \?\? null\}/.test(v));
  assert.ok(/\{row\.cap \? \(\s*<span className="res-cell res-mem">\s*\{formatBytes\(row\.memBytes\)\}\s*<CapBar cap=\{row\.cap\} levels=\{capLevels\} \/>\s*<\/span>\s*\) : \(\s*<span className="res-cell">\{formatBytes\(row\.memBytes\)\}<\/span>\s*\)\}/.test(v), 'capped ⇒ figure + bar; else today\'s cell');
  assert.ok(/<CapBar cap=\{row\.cap\} levels=\{capLevels\} \/>/.test(v) && !/<CapBar[^>]*scopeOnly/.test(v));
  const g = codeOf('src/shared/resources.ts');
  assert.ok(/cap: view\?\.cap \?\? null,/.test(g) && /scopeOnly: true, cap: null/.test(g) && /scopeOnly: false, cap: null/.test(g), 'only a live session row carries a cap');
});

test('the settings-changed log line names the cap levels too (a change of the Plafond is an auditable event)', () => {
  const m = codeOf('src/main/memory-guard-settings.ts');
  assert.ok(/memory cap soft \$\{current\.capSoftGb\}→\$\{res\.settings\.capSoftGb\} GB, hard \$\{current\.capHardGb\}→\$\{res\.settings\.capHardGb\} GB/.test(m));
});

test('WINDOW (#326): the Reliquat wait is committed alone through the shared planner on blur AND Enter; an invalid value is refused inline (nothing sent); only that key travels', () => {
  const w = codeOf('src/renderer/components/MemoryGuardSettings.tsx');
  assert.ok(/planReliquatWaitCommit\(waitDraft, basis, view\?\.totalBytes\)/.test(w));
  assert.ok(/p\.kind === 'invalid'\) \{\s*setError\(p\.error\);/.test(w.slice(w.indexOf('const commitWait'))), 'invalid ⇒ the inline error, no apply');
  assert.ok(/void apply\(p\.patch, null, null, waitDraft\);/.test(w));
  assert.ok(/onBlur=\{commitWait\}/.test(w) && /if \(e\.key === 'Enter'\) commitWait\(\);/.test(w));
  assert.ok(/const shownError = error \?\? liveError \?\? liveCapError \?\? liveWaitError;/.test(w));
  assert.ok(/data-mg-reliquat-wait/.test(w));
});

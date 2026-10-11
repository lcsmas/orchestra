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
  assert.ok(/\{row\.cap \? \(\s*<span className="res-cell res-mem">\s*\{formatBytes\(row\.memBytes\)\}\s*<CapBar cap=\{row\.cap\} levels=\{capLevels\} \/>\s*<\/span>\s*\) : row\.capNote === 'not-applied' \? \(\s*<span className="res-cell res-mem-nocap"[^>]*>\s*\{formatBytes\(row\.memBytes\)\}\s*<\/span>\s*\) : \(\s*<span className="res-cell">\{formatBytes\(row\.memBytes\)\}<\/span>\s*\)\}/.test(v), 'capped ⇒ figure + bar; not applied ⇒ figure + dim tooltip; else today\'s cell');
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

test('WINDOW LAYOUT (gate c/6112245304, built app): the fields scroll INSIDE a height-bounded dialog; the refusal line and Done sit OUTSIDE the scrolling part, so a refusal and Done are always on screen', () => {
  const w = codeOf('src/renderer/components/MemoryGuardSettings.tsx');
  const open = w.indexOf('<div className="mg-body" data-mg-body>');
  assert.ok(open > 0, 'the scrolling body exists');
  const err = w.indexOf('{shownError && (');
  const actions = w.indexOf('<div className="modal-actions">');
  assert.ok(err > open && actions > err, 'source order: body … refusal … actions');
  // the body closes right before the refusal, at the body's own indentation (the file is formatted: the closing tag that precedes `{shownError` is the body's)
  const indent = /\n( *)<div className="mg-body" data-mg-body>/.exec(w)?.[1];
  assert.ok(indent !== undefined, 'the opening tag line');
  const m = new RegExp(`\\n${indent}</div>\\s*\\{shownError && \\(`).exec(w);
  assert.ok(m, 'the scrolling body is closed BEFORE the refusal line');
  const close = m!.index;
  for (const hook of ['data-mg-cap-section', 'data-mg-reliquat-wait', 'data-mg-admission', 'data-mg-critical']) {
    const at = w.indexOf(hook);
    assert.ok(at > open && at < close, `${hook} is inside the scrolling body`);
  }
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
  assert.ok(/\.memory-guard-settings \.mg-body \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/.test(css), 'the body is a shrinkable flex child that scrolls');
  assert.ok(/\.memory-guard-settings \.mg-error \{[^}]*flex: none;/.test(css) && /\.memory-guard-settings \.modal-actions \{[^}]*flex: none;/.test(css), 'the refusal and Done never shrink away');
  assert.ok(/\.sound-settings \{[^}]*max-height: min\(80vh, 720px\);[^}]*display: flex;[^}]*flex-direction: column;/.test(css), 'the dialog is height-bounded — the thing the body scrolls against');
});

test('SWAY GATE (OPS review m3): the three viewports are IMPOSED by CDP and the page\'s MEASURED innerWidth/innerHeight (and the decoded PNG size) are asserted equal to the request — the rig tiles a 1600x1000 output, so setContentSize proves nothing', () => {
  const g = fs.readFileSync(path.join(ROOT, 'scripts/memcap-screenshot.mjs'), 'utf8');
  assert.ok(/Emulation\.setDeviceMetricsOverride', \{ width: vw, height: vh, deviceScaleFactor: 1, mobile: false \}/.test(g), 'the viewport is imposed through Emulation.setDeviceMetricsOverride');
  assert.ok(/\[\[1440, 900\], \[1920, 1080\], \[1280, 640\]\]/.test(g), 'the three viewports');
  assert.ok(!/setContentSize\(vw, vh\)/.test(g), 'the window-size lever (blind to a tiling compositor) is gone');
  assert.ok(/m\.vw === f\.vw && m\.vh === f\.vh/.test(g), 'the measured innerWidth x innerHeight is compared with the request, for EVERY state');
  assert.ok(/pp\.w === f\.vw && pp\.h === f\.vh/.test(g), 'and the decoded capture has the requested size');
  assert.ok(/Page\.captureScreenshot/.test(g), 'the capture is the emulated viewport, not the tiled window');
});

test('#323-fu m2: the « not applied » note travels FI-1 limitApplied → ScopeReading → member view capNote → SessionGroup.capNote → the dim tooltip cell (after the capped branch, before the plain one)', () => {
  assert.ok(/limitApplied = parseLimitApplied\(e\.readFile\(path\.join\(d, 'memory\.max'\)\)\);/.test(codeOf('src/main/memory-scope.ts')), 'FI-1 reads memory.max for the applied/not-applied/unknown tri-state');
  assert.ok(/limitApplied: mem\?\.limitApplied \?\? null/.test(codeOf('src/main/member-memory.ts')), 'the producer carries it into the reading');
  const sm = codeOf('src/shared/member-memory.ts');
  assert.ok(/r\.limitApplied === false \? 'not-applied' : null/.test(sm) && /capNote: capNoteOf\(readings\)/.test(sm), 'the view derives the note from the keeper scope, only on an explicit « max »');
  assert.ok(/capNote: view\?\.capNote \?\? null,/.test(codeOf('src/shared/resources.ts')), 'the live session row carries it');
  const v = codeOf('src/renderer/components/ResourcesView.tsx');
  const capped = v.indexOf('{row.cap ? (');
  const noted = v.indexOf("row.capNote === 'not-applied' ? (");
  const plain = v.indexOf('<span className="res-cell">{formatBytes(row.memBytes)}</span>\n            )}');
  assert.ok(capped > 0 && noted > capped && plain > noted, 'branch order: capped bar, then the note, then today\'s plain cell');
  assert.ok(/title=\{CAP_NOT_APPLIED_TIP\} data-res-nocap=""/.test(v) && /import \{ CAP_NOT_APPLIED_TIP, capSummaryLine \}/.test(v));
  assert.ok(/\.res-cell\.res-mem-nocap \{[^}]*cursor: help;[^}]*underline dotted/.test(fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8')), 'the dim cue that a tooltip exists');
});

test('#323-fu m5: the window points at the REAL place of the switch — « Fleet bus mechanisms » (the header bus button) — and never at the read-only Bus page', () => {
  const w = codeOf('src/renderer/components/MemoryGuardSettings.tsx');
  assert.ok(/set it in « Fleet bus mechanisms » \(the bus button in the header\), not here\./.test(w));
  assert.ok(!/Bus page/.test(w), 'no pointer to the read-only pane');
  assert.ok(/<h2>Fleet bus mechanisms<\/h2>/.test(codeOf('src/renderer/components/BusSwitchSettings.tsx')), 'that name exists where the switch is edited');
  assert.ok(/title="Fleet bus mechanisms — one switch per mechanism, frozen per run"/.test(codeOf('src/renderer/components/Sidebar.tsx')), 'and the header button carries it');
});

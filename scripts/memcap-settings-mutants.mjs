// #323 self-gate — IN-PLACE mutation sweep of the Plafond mémoire UI + its data layer (D-Q10 A + A): the applied cap per member (FI-1 v1.11), the usage-vs-cap view logic, the Resources bar, the Memory guard window section.
// Each mutant edits ONE clause of the real source, runs the unit + wiring suites AND the SSR render smoke (scripts/memcap-settings-render-smoke.mjs), and must turn red at least one NAMED test / smoke check.
// Restored by byte-exact backup + `cmp` after every mutant; `git diff` of the mutated files must be empty at the end (commit first). NOT heavy (unit + SSR only; no app, browser, keeper or scope).
// Run: node scripts/memcap-settings-mutants.mjs [--only M01,M02] [--check | --check-anchors]
// `expect` = a substring of a reddened unit test title, or `smoke:<check label>` for a failing smoke check — at least one MUST be red. `smoke: true` also runs the smoke.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKUP = path.join(os.homedir(), '.cache', 'h2-323', 'mutant-backup');
const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--only', '--check-anchors', '--check', '--no-rig']);
const unknownFlags = args.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
if (unknownFlags.length) { // fail CLOSED: a flag this script does not know must never fall through to the full (heavy) sweep (OPS, 2026-10-09: `--check` once did)
  console.error(`REFUSING: unknown option(s) ${unknownFlags.join(' ')} — NOTHING was run. Known: --only ID,ID | --check (alias --check-anchors: dry anchor check, no build / keeper / scope / scratch) | --no-rig`);
  process.exit(2);
}
const dryCheck = args.includes('--check-anchors') || args.includes('--check');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = true;

const SC = 'src/shared/memory-cap-view.ts';
const SM = 'src/shared/member-memory.ts';
const SR = 'src/shared/resources.ts';
const SG = 'src/shared/memory-guard-view.ts';
const MS = 'src/main/memory-scope.ts';
const PM = 'src/main/member-memory.ts';
const RS = 'src/main/resources.ts';
const GS = 'src/main/memory-guard-settings.ts';
const BAR = 'src/renderer/components/CapBar.tsx';
const RV = 'src/renderer/components/ResourcesView.tsx';
const WIN = 'src/renderer/components/MemoryGuardSettings.tsx';
const BP = 'src/main/bus-pane.ts';
const TESTS = ['src/shared/memory-cap-view.test.ts', 'src/shared/memory-guard-view.test.ts', 'src/shared/member-memory.test.ts', 'src/main/member-memory.test.ts', 'src/main/memory-scope.test.ts', 'src/shared/resources.test.ts', 'src/main/memcap-settings-wiring.test.ts', 'src/main/memory-guard-settings.test.ts', 'src/main/member-memory-wiring.test.ts', 'src/main/bus-pane.test.ts'];

const MUTANTS = [
  // ── the applied cap per member (FI-1 v1.11 → member view → row) ──
  { id: 'M01_ws_unreadable_is_raw_bill', file: MS, find: "        return null; // unreadable ⇒ unknown, not « the raw figure »", to: "        return current;", expect: ['readScopeMemory (FI-1 v1.11, #323)'] },
  { id: 'M02_cap_from_any_scope', file: SM, find: "const r = readings.find((x) => x.keeperPid !== null && x.keeperPid !== undefined);", to: "const r = readings[0];", expect: ["C2 (#323) cap is the keeper"] },
  { id: 'M03_zero_limit_is_a_cap', file: SM, find: "|| (r.maxBytes as number) <= 0) return null;", to: "|| (r.maxBytes as number) < 0) return null;", expect: ["C2 (#323) cap is the keeper"] },
  { id: 'M04_unreadable_meter_is_zero_usage', file: SM, find: "if (!r || !finite(r.currentBytes) || !finite(r.maxBytes)", to: "if (!r || !finite(r.maxBytes)", expect: ["C2 (#323) cap is the keeper"] },
  { id: 'M05_junk_working_set_kept', file: SM, find: "workingSetBytes: finite(r.workingSetBytes) ? (r.workingSetBytes as number) : null,", to: "workingSetBytes: (r.workingSetBytes as number | null) ?? null,", expect: ["C2 (#323) cap is the keeper"] },
  { id: 'M06_producer_drops_the_limit', file: PM, find: "maxBytes: mem?.maxBytes ?? null,", to: "maxBytes: null,", expect: ['P15 (#323)', 'P16 (#323)'] },
  { id: 'M07_producer_drops_the_working_set', file: PM, find: "workingSetBytes: mem?.workingSetBytes ?? null,", to: "workingSetBytes: null,", expect: ['P15 (#323)', 'P16 (#323)'] },
  { id: 'M08_row_without_cap', file: SR, find: "      cap: view?.cap ?? null,", to: "      cap: null,", expect: ['G13 (#323)'] },
  { id: 'M09_leftover_scope_row_carries_a_cap', file: SR, find: "scopeOnly: true, cap: null });", to: "scopeOnly: true, cap: m.cap });", expect: ['G13 (#323)'] },
  // ── usage vs cap: the tones, the words ──
  { id: 'V01_red_threshold_strict', file: SC, find: "billFrac >= CAP_NEAR_FRACTION ? 'crit'", to: "billFrac > CAP_NEAR_FRACTION ? 'crit'", expect: ['V2 thresholds'] },
  { id: 'V02_red_threshold_moved', file: SC, find: "export const CAP_NEAR_FRACTION = 0.9;", to: "export const CAP_NEAR_FRACTION = 0.95;", expect: ['V2 thresholds', 'V1 tone'] },
  { id: 'V03_soft_keys_on_the_bill', file: SC, find: "cap.workingSetBytes !== null && cap.workingSetBytes >= (softBytes as number) ? 'warn'", to: "cap.billBytes >= (softBytes as number) ? 'warn'", expect: ['V1 tone', 'smoke:a big page cache alone'], smoke: true },
  { id: 'V04_soft_strict', file: SC, find: "cap.workingSetBytes >= (softBytes as number) ? 'warn'", to: "cap.workingSetBytes > (softBytes as number) ? 'warn'", expect: ['V2 thresholds'] },
  { id: 'V05_unreadable_working_set_warns', file: SC, find: "softOk && cap.workingSetBytes !== null && cap.workingSetBytes", to: "softOk && (cap.workingSetBytes ?? cap.billBytes)", expect: ['V3 an unreadable working set'] },
  { id: 'V06_soft_at_hard_is_marked', file: SC, find: "softBytes > 0 && softBytes < cap.hardBytes;", to: "softBytes > 0 && softBytes <= cap.hardBytes;", expect: ['V3 an unreadable working set'] },
  { id: 'V07_tooltip_unnamed_bill', file: SC, find: " kernel bill (what the hard level compares)", to: " used", expect: ['V5 tooltip', 'smoke:the tooltip names BOTH figures'], smoke: true },
  { id: 'V08_tooltip_hides_a_settings_change', file: SC, find: "  if (hardNow) parts.push(", to: "  if (false) parts.push(", expect: ['V5 tooltip', 'smoke:levels changed since the member started'], smoke: true },
  { id: 'V09_tooltip_invents_levels_when_unknown', file: SC, find: "  if (settings === null) {\n    parts.push(applied);", to: "  if (settings === null) {\n    parts.push(`soft 3 GB (settings now), ${applied}`);", expect: ['V5b tooltip'] },
  { id: 'V10_summary_picks_the_least_loaded', file: SC, find: "b.cap.billBytes / b.cap.hardBytes > a.cap.billBytes / a.cap.hardBytes ? b : a", to: "b.cap.billBytes / b.cap.hardBytes < a.cap.billBytes / a.cap.hardBytes ? b : a", expect: ['V6 summary line'] },
  { id: 'V11_summary_for_nobody', file: SC, find: "  if (capped.length === 0) return null;", to: "  if (capped.length === 0) return '0 capped members';", expect: ['V6 summary line'] },
  { id: 'V12_closed_runs_counted', file: SC, find: "const open = runs.filter((r) => r.closedAt === null);", to: "const open = runs;", expect: ['V7 the activation'] },
  { id: 'V13_live_default_read_as_on', file: SC, find: "const liveOn = live.memoryCap === true;", to: "const liveOn = true;", expect: ['V7 the activation'] },
  // ── the window's commit rule ──
  { id: 'W01_cap_pair_not_validated', file: SG, find: "  const res = patchMemoryGuardSettings(current, { capSoftGb, capHardGb }, totalBytes);\n  if (!res.ok) return", to: "  const res = patchMemoryGuardSettings(current, { capSoftGb, capHardGb }, totalBytes);\n  if (false as boolean) return", expect: ['cap commit (#323): hard ≤ soft is REFUSED'] },
  { id: 'W02_cap_unchanged_always_patches', file: SG, find: "  if (capSoftGb === current.capSoftGb && capHardGb === current.capHardGb) return { kind: 'unchanged' };\n  return { kind: 'patch', patch: { capSoftGb, capHardGb } };", to: "  return { kind: 'patch', patch: { capSoftGb, capHardGb } };", expect: ['cap commit (#323): a valid changed pair'] },
  { id: 'W03_cap_patch_carries_thresholds_too', file: SG, find: "return { kind: 'patch', patch: { capSoftGb, capHardGb } };", to: "return { kind: 'patch', patch: { capSoftGb, capHardGb, admissionGb: current.admissionGb } as { capSoftGb: number; capHardGb: number } };", expect: ['cap commit (#323): the thresholds are untouched'] },
  { id: 'W04_cap_only_half_parsed', file: SG, find: "  if (capSoftGb === null || capHardGb === null) return { kind: 'invalid', error: 'Enter both levels as a number of GB.' };", to: "  if (capSoftGb === null && capHardGb === null) return { kind: 'invalid', error: 'Enter both levels as a number of GB.' };", expect: ['cap commit (#323): hard ≤ soft is REFUSED'] },
  { id: 'W05_log_without_cap', file: GS, find: " memory cap soft ${current.capSoftGb}→${res.settings.capSoftGb} GB, hard ${current.capHardGb}→${res.settings.capHardGb} GB,", to: "", expect: ['the settings-changed log line names the cap levels'] },
  // ── Resources: the bar ──
  { id: 'U01_bar_no_working_set', file: BAR, find: "{u.workingFrac !== null && <i className=\"res-capbar-ws\"", to: "{false && <i className=\"res-capbar-ws\"", expect: ['smoke:fill = bill / hard (35 %)'], smoke: true },
  { id: 'U02_bar_no_soft_tick', file: BAR, find: "{u.softFrac !== null && <i className=\"res-capbar-soft\"", to: "{false && <i className=\"res-capbar-soft\"", expect: ['smoke:fill = bill / hard (35 %)'], smoke: true },
  { id: 'U03_bar_no_tone', file: BAR, find: "className={`res-capbar tone-${u.tone}`}", to: "className=\"res-capbar\"", expect: ['smoke:comfortable member'], smoke: true },
  { id: 'U04_bar_no_clamp', file: BAR, find: "Math.min(1, Math.max(0, f))", to: "f", expect: ['smoke:the bar never draws past its track'], smoke: true },
  { id: 'U05_bar_without_tooltip', file: BAR, find: " title={tip}", to: "", expect: ['smoke:the tooltip names BOTH figures'], smoke: true },
  { id: 'U06_bar_ignores_the_levels', file: BAR, find: "const u = capUsage(cap, levels ? levels.softGb * GIB : null);", to: "const u = capUsage(cap, null);", expect: ['smoke:fill = bill / hard (35 %)', 'smoke:working set at/over the soft level'], smoke: true },
  { id: 'U07_working_set_wider_than_bill', file: BAR, find: "Math.min(u.workingFrac, u.billFrac)", to: "u.workingFrac + 0.4", expect: ['smoke:fill = bill / hard (35 %)'], smoke: true },
  { id: 'U08_table_bar_on_every_row', file: RV, find: "{row.cap ? (\n              <span className=\"res-cell res-mem\">", to: "{true ? (\n              <span className=\"res-cell res-mem\">", expect: ['smoke:CONTROL — a fleet with no capped member', 'RESOURCES'], smoke: true },
  { id: 'U09_table_levels_not_passed_down', file: RV, find: "                  capLevels={capLevels}\n", to: "", expect: ["smoke:with the levels given, every capped row's bar carries the soft tick"], smoke: true },
  { id: 'U10_page_levels_not_read', file: RV, find: "capLevels={snap?.capLevels ?? null}", to: "capLevels={null}", expect: ['RESOURCES'] },
  { id: 'U11_summary_not_passed', file: RV, find: "            capLine={capSummaryLine(", to: "            capLine={null && capSummaryLine(", expect: ['RESOURCES'] },
  { id: 'U12_snapshot_swaps_the_levels', file: RS, find: "return { softGb: s.capSoftGb, hardGb: s.capHardGb };", to: "return { softGb: s.capHardGb, hardGb: s.capSoftGb };", expect: ['RESOURCES'] },
  // ── the window section ──
  { id: 'U13_window_cap_commit_on_blur_missing', file: WIN, find: "                onChange={capField('hard')}\n                onBlur={commitCap}", to: "                onChange={capField('hard')}", expect: ['WINDOW: the Plafond section commits the PAIR'] },
  { id: 'U14_window_invalid_pair_written', file: WIN, find: "    } else if (p.kind === 'invalid') {\n      setError(p.error);\n    } else {\n      void apply(p.patch, null, capDraft);", to: "    } else {\n      void apply((p as { patch: Parameters<typeof apply>[0] }).patch, null, capDraft);", expect: ['WINDOW: the Plafond section commits the PAIR'] },
  { id: 'U15_window_live_refusal_dropped', file: WIN, find: "const shownError = error ?? liveError ?? liveCapError ?? liveWaitError;", to: "const shownError = error ?? liveError ?? liveWaitError;", expect: ['WINDOW: the Plafond section commits the PAIR'] },
  { id: 'U16_window_writes_the_switch', file: WIN, find: "      setCapSwitch(await window.orchestra.busCapSummary());", to: "      setCapSwitch(await window.orchestra.busCapSummary());\n      void window.orchestra.setBusSwitches({ memoryCap: true });", expect: ['WINDOW (D-Q1)'] },
  { id: 'U17_window_switch_is_a_checkbox', file: WIN, find: "<div className=\"mg-cap-switch field-hint\"", to: "<input type=\"checkbox\" data-mg-cap-toggle /><div className=\"mg-cap-switch field-hint\"", expect: ['WINDOW (D-Q1)', 'smoke:the activation is SHOWN read-only'], smoke: true },
  { id: 'U18_window_switch_line_dropped', file: WIN, find: "{capSwitch ? capSwitch.text : '…'}", to: "…", expect: ['smoke:the activation is SHOWN read-only'], smoke: true },
  { id: 'U19_window_inputs_enabled_before_load', file: WIN, find: "                data-mg-cap-soft\n                value={typedCap.soft}\n                disabled={!settings}", to: "                data-mg-cap-soft\n                value={typedCap.soft}", expect: ['smoke:before the first read the cap inputs are DISABLED'], smoke: true },
  { id: 'U20_window_applies_note_dropped', file: WIN, find: "Applies to members started from now on; running sessions keep what they started with.", to: "", expect: ['smoke:it says where the switch IS set'], smoke: true },
  // ── the Reliquat wait (#326) in the same section ──
  { id: 'X01_wait_not_validated', file: SG, find: "  const res = patchMemoryGuardSettings(current, { reliquatWaitMin }, totalBytes); // same write-path validator (see planCapCommit)\n  if (!res.ok) return", to: "  const res = patchMemoryGuardSettings(current, { reliquatWaitMin }, totalBytes); // same write-path validator (see planCapCommit)\n  if (false as boolean) return", expect: ['Reliquat wait commit: out-of-range or non-numeric input is REFUSED'] },
  { id: 'X02_wait_unchanged_always_patches', file: SG, find: "  if (reliquatWaitMin === current.reliquatWaitMin) return { kind: 'unchanged' };\n", to: "", expect: ['Reliquat wait commit (#323/#326): a valid changed value'] },
  { id: 'X03_wait_patch_carries_more', file: SG, find: "return { kind: 'patch', patch: { reliquatWaitMin } };", to: "return { kind: 'patch', patch: { reliquatWaitMin, capHardGb: current.capHardGb } as { reliquatWaitMin: number } };", expect: ['Reliquat wait commit (#323/#326): a valid changed value'] },
  { id: 'X04_wait_text_not_parsed', file: SG, find: "  if (reliquatWaitMin === null) return { kind: 'invalid', error: 'Enter the Reliquat wait as a number of minutes.' };", to: "  if (reliquatWaitMin === null) return { kind: 'unchanged' };", expect: ['Reliquat wait commit: out-of-range or non-numeric input is REFUSED'] },
  { id: 'X05_window_wait_no_commit_on_blur', file: WIN, find: "                onBlur={commitWait}\n", to: "", expect: ['WINDOW (#326)'] },
  { id: 'X06_window_wait_refusal_not_shown', file: WIN, find: "const shownError = error ?? liveError ?? liveCapError ?? liveWaitError;", to: "const shownError = error ?? liveError ?? liveCapError;", expect: ['WINDOW (#326)', 'WINDOW: the Plafond section commits the PAIR'] },
  { id: 'X07_window_wait_field_dropped', file: WIN, find: '<span className="mg-unit">min</span>', to: '', expect: ['smoke:the Reliquat wait (#326) is a third field'], smoke: true },
  { id: 'X08_window_wait_enabled_before_load', file: WIN, find: "                data-mg-reliquat-wait\n                value={typedWait}\n                disabled={!settings}", to: "                data-mg-reliquat-wait\n                value={typedWait}", expect: ['smoke:before the first read the cap inputs are DISABLED'], smoke: true },
  // ── pre-review round (MAJOR 1/2 + minors) ──
  { id: 'Y03_cap_plan_judges_the_stored_admission_pair', file: SG, find: "const res = patchMemoryGuardSettings(current, { capSoftGb, capHardGb }, totalBytes);", to: "const res = validateMemoryGuardSettings({ ...current, capSoftGb, capHardGb }, totalBytes) === null ? ({ ok: true } as const) : ({ ok: false, error: validateMemoryGuardSettings({ ...current, capSoftGb, capHardGb }, totalBytes) as string } as const);", expect: ['cap + Reliquat wait commits (#323 review MAJOR 1)'] },
  { id: 'Y04_wait_plan_judges_the_stored_admission_pair', file: SG, find: "const res = patchMemoryGuardSettings(current, { reliquatWaitMin }, totalBytes);", to: "const res = validateMemoryGuardSettings({ ...current, reliquatWaitMin }, totalBytes) === null ? ({ ok: true } as const) : ({ ok: false, error: validateMemoryGuardSettings({ ...current, reliquatWaitMin }, totalBytes) as string } as const);", expect: ['cap + Reliquat wait commits (#323 review MAJOR 1)'] },
  { id: 'Y05_parser_accepts_hex_and_exponent', file: SG, find: "  if (!/^-?(\\d+\\.?\\d*|\\.\\d+)$/.test(t)) return null;", to: "  if (false) return null;", expect: ['parseGbInput'] },
  { id: 'Y06_parser_reads_a_thousands_group_as_a_decimal', file: SG, find: "  if (/^\\d{1,3}(,\\d{3})+$/.test(text.trim())) return null;", to: "  if (false) return null;", expect: ['parseGbInput'] },
  { id: 'Y07_working_set_without_inactive_file_is_the_raw_bill', file: MS, find: "return Number.isFinite(stat.inactive_file) ? workingSetBytes(current, stat) : null;", to: "return workingSetBytes(current, stat);", expect: ['readScopeMemory (FI-1 v1.11, #323)'] },
  { id: 'Y08_percent_rounded_not_floored', file: SC, find: "Math.floor(frac * 100 + 1e-9)", to: "Math.round(frac * 100)", expect: ['V4b'] },
  { id: 'Y09_summary_cap_rounded_to_one_decimal', file: SC, find: "${pct} % of ${gbExact(worst.cap.hardBytes)}", to: "${pct} % of ${gb(worst.cap.hardBytes)}", expect: ['V6b', 'V6 summary line'] },
  { id: 'Y10_closest_ranked_by_working_set', file: SC, find: "b.cap.billBytes / b.cap.hardBytes > a.cap.billBytes / a.cap.hardBytes ? b : a", to: "(b.cap.workingSetBytes ?? 0) / b.cap.hardBytes > (a.cap.workingSetBytes ?? 0) / a.cap.hardBytes ? b : a", expect: ['V6b'] },
  { id: 'Y11_settings_note_only_when_raised', file: SC, find: "Math.abs(cap.hardBytes - settings.hardGb * GIB) > 0.01 * GIB", to: "settings.hardGb * GIB - cap.hardBytes > 0.01 * GIB", expect: ['V5c'] },
  { id: 'Y12_settings_note_tolerance_one_gb', file: SC, find: "Math.abs(cap.hardBytes - settings.hardGb * GIB) > 0.01 * GIB", to: "Math.abs(cap.hardBytes - settings.hardGb * GIB) > 1 * GIB", expect: ['V5c'] },
  { id: 'Y13_scopes_note_dropped', file: SC, find: "  if ((cap.scopes ?? 1) > 1) parts.push(", to: "  if (false) parts.push(", expect: ['V5c'] },
  { id: 'Y14_scopes_not_counted', file: SM, find: "peakBytes: finite(r.peakBytes) ? (r.peakBytes as number) : null, scopes: readings.length };", to: "peakBytes: finite(r.peakBytes) ? (r.peakBytes as number) : null, scopes: 1 };", expect: ['C1 (#323) memberViewFrom.cap', 'P16'] },
  { id: 'Y15_summary_bus_down_counts_zero', file: BP, find: "  if (!d) return capSwitchSummary(live, null, host);", to: "  if (!d) return capSwitchSummary(live, [], host);", expect: ['#323 (review MAJOR 2)'] },
  { id: 'Y16_summary_unknown_branch_dropped', file: SC, find: "  if (runs === null) return {", to: "  if (false as boolean) return {", expect: ['V7b'] },
  { id: 'Y17_host_note_dropped', file: SC, find: "const hostNote = host !== null && !host.ok ?", to: "const hostNote = false ?", expect: ['V7b'] },
  { id: 'Y18_window_polls_the_whole_pane_snapshot', file: WIN, find: "setCapSwitch(await window.orchestra.busCapSummary());", to: "setCapSwitch(capSwitchSummary(await window.orchestra.busSwitches(), (await window.orchestra.busSnapshot(null)).runs));", expect: ['WINDOW (D-Q1)'] },
  { id: 'Y19_cap_summary_not_a_read_channel', file: BP, find: "{ channel: 'bus:capSummary', writes: false,", to: "{ channel: 'bus:capSummary', writes: true,", expect: ['#323 (review MAJOR 2)'] },
  { id: 'Y20_reliquat_hint_drops_the_veille_caveat', file: WIN, find: "Counts only above the normal Veille delay; a fast Veille under memory pressure never waits. ", to: "", expect: ['smoke:the Reliquat wait (#326) is a third field'], smoke: true },
  { id: 'Y21_unknown_runs_text_dropped', file: WIN, find: "{capSwitch ? capSwitch.text : '…'}", to: "{capSwitch ? `Cap is ${capSwitch.liveOn ? 'ON' : 'OFF'} for new runs · ON on ${capSwitch.runsOn} of ${capSwitch.runsOpen} open runs` : '…'}", expect: ['smoke:a bus that is not open reads'], smoke: true },
  { id: 'Y22_existing_threshold_hook_renamed_ordering_check_vacuous', file: WIN, find: "data-mg-critical", to: "data-mg-criticalx", expect: ['smoke:the section is there', 'smoke:the existing threshold fields are untouched'], smoke: true },
];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 500_000, ...opts });

function unitRed() {
  const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...TESTS]);
  const names = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1].replace(/\\([#])/g, '$1'));
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  return { names, pass, skipped, status: r.status };
}
function smokeRed() {
  const r = sh(process.execPath, [path.join(HERE, 'memcap-settings-render-smoke.mjs')]);
  const out = r.stdout ?? '';
  const fails = [...out.matchAll(/^\s+FAIL (.*?)(?: — .*)?$/gm)].map((m) => `smoke:${m[1]}`);
  if (r.status !== 0 && fails.length === 0) fails.push(`smoke:(crashed, exit ${r.status})`);
  return { fails, pass: (out.match(/^\s+ok /gm) ?? []).length, status: r.status };
}
function rigRed() { return { red: [], pass: 0, line: '(no rig in this harness)' }; }
const buildCli = () => { const r = sh('pnpm', ['run', 'build:cli']); if (r.status !== 0) throw new Error(`build:cli failed: ${r.stderr}`); };
const strays = () => 0;
const _unusedStrays = () => {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try { if (fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').includes('e2e-resilient-watchers.mjs')) out.push(Number(n)); } catch { /* gone */ }
  }
  return out.length;
};
const scratchLeft = () => 0;

const editsOf = (m) => m.edits ?? [{ find: m.find, to: m.to }];
// a restore re-stamps the file: any mutant under src/shared or src/cli (the CLI bundle's inputs) makes the bundle STALE for the next mutant's rig — rebuild around it, always
for (const m of MUTANTS) if (m.file.startsWith('src/shared/') || m.file.startsWith('src/cli/')) m.cli = true;
if (dryCheck) {
  let bad = 0;
  for (const m of MUTANTS) {
    let text = fs.readFileSync(path.join(REPO, m.file), 'utf8'); let why = null;
    for (const e of editsOf(m)) { const c = text.split(e.find).length - 1; if (c !== 1) { why = `${c}× ${e.find.slice(0, 80)}`; break; } text = text.replace(e.find, () => e.to); }
    if (why) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${why}`); }
  }
  console.log(`ANCHORS: ${MUTANTS.length - bad}/${MUTANTS.length} resolve exactly once`);
  process.exit(bad ? 1 : 0);
}
fs.mkdirSync(BACKUP, { recursive: true }); // scratch exists only for a real sweep, never for the dry check

const files = [...new Set(MUTANTS.map((m) => m.file))];
const dirty = sh('git', ['diff', '--quiet', '--', ...files, ...TESTS, 'scripts/memcap-settings-mutants.mjs', 'scripts/memcap-settings-render-smoke.mjs']).status !== 0;
if (dirty) { console.error('REFUSING: the mutated files / suites / rig have uncommitted changes — commit first (the end-of-sweep `git diff` must prove restoration)'); process.exit(2); }
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
buildCli();

// ── POSITIVE CONTROL: the unmutated tree must be all green (and the CLI fresh), else every "killed" below is vacuous ──
const base = unitRed();
const baseRig = rigRed();
const baseSmoke = smokeRed();
console.log(`BASELINE unit: pass ${base.pass} fail ${base.names.length} skipped ${base.skipped} | rig: ${baseRig.line} (pass ${baseRig.pass}, red ${JSON.stringify(baseRig.red)}) | smoke ok ${baseSmoke.pass} fail ${baseSmoke.fails.length} | strays ${strays()} scratch ${scratchLeft()}`);
if (base.names.length || base.status !== 0 || base.skipped !== 0 || baseSmoke.fails.length || baseSmoke.status !== 0) { console.error('BASELINE NOT GREEN — aborting (nothing was mutated)'); process.exit(2); }

const rows = [];
let restoreBad = false;
const restore = (m, backupFile) => {
  fs.copyFileSync(backupFile, path.join(REPO, m.file));
  if (spawnSync('cmp', ['-s', backupFile, path.join(REPO, m.file)]).status !== 0) { restoreBad = true; console.error(`RESTORE FAILED for ${m.file} — stop and fix by hand: git checkout -- ${m.file}`); }
};
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const abs = path.join(REPO, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  let mutated = original; let anchorBad = null;
  for (const e of editsOf(m)) { const c = mutated.split(e.find).length - 1; if (c !== 1) { anchorBad = `find occurs ${c}× (need exactly 1): ${e.find.slice(0, 60)}`; break; } mutated = mutated.replace(e.find, () => e.to); }
  if (anchorBad) { rows.push({ id: m.id, verdict: 'ANCHOR-BAD', detail: anchorBad }); continue; }
  const backupFile = path.join(BACKUP, `${m.id}.orig`);
  fs.writeFileSync(backupFile, original);
  const onSig = () => { restore(m, backupFile); process.exit(130); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  try {
    fs.writeFileSync(abs, mutated);
    if (fs.readFileSync(abs, 'utf8') === original) { rows.push({ id: m.id, verdict: 'NO-OP', detail: 'the mutation changed nothing' }); continue; }
    if (m.cli) buildCli();
    const u = unitRed();
    const r = rigRed();
    const sm = m.smoke ? smokeRed() : { fails: [] };
    const red = [...u.names, ...r.red, ...sm.fails];
    const hit = m.expect.filter((e) => red.some((n) => n.includes(e)));
    rows.push({ id: m.id, verdict: hit.length > 0 ? 'KILLED' : red.length ? 'KILLED-BUT-NOT-BY-NAMED-ARM' : 'SURVIVED', detail: `named ${JSON.stringify(m.expect)} hit ${JSON.stringify(hit)}; red: ${red.slice(0, 4).join(' | ')}${red.length > 4 ? ` (+${red.length - 4})` : ''}` });
  } finally {
    restore(m, backupFile);
    process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig);
    if (m.cli) buildCli();
  }
}
const after = Object.fromEntries(files.map((f) => [f, sha(f)]));
const sameSha = files.every((f) => before[f] === after[f]);
const gitClean = sh('git', ['diff', '--quiet', '--', ...files]).status === 0;
const post = unitRed();
for (const r of rows) console.log(`${r.verdict.padEnd(30)} ${r.id.padEnd(40)} ${r.detail}`);
const killed = rows.filter((r) => r.verdict === 'KILLED').length;
const sv = strays(); const sc = scratchLeft();
console.log(`RESTORED: sha-identical ${sameSha} · git diff clean ${gitClean} · cmp-restore ${!restoreBad} · post-sweep unit fail ${post.names.length} · survivors: rig processes=${sv} scratch dirs=${sc}`);
console.log(`MUTANTS: ${killed}/${rows.length} killed by their NAMED test/arm${rows.length === killed ? '' : ` — NOT ALL: ${rows.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id}=${r.verdict}`).join(', ')}`}`);
process.exit(rows.length === killed && sameSha && gitClean && !restoreBad && post.names.length === 0 && sv === 0 && sc === 0 ? 0 : 1);

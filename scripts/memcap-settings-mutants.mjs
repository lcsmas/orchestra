// #323 self-gate — IN-PLACE mutation sweep of the Plafond mémoire UI + its data layer (D-Q10 A + A): the applied cap per member (FI-1 v1.11), the usage-vs-cap view logic, the Resources bar, the Memory guard window section.
// Each mutant edits ONE clause of the real source, runs the unit + wiring suites AND the SSR render smoke (scripts/memcap-settings-render-smoke.mjs), and must turn red at least one NAMED test / smoke check.
// Restored by byte-exact backup + `cmp` after every mutant; `git diff` of the mutated files must be empty at the end (commit first). NOT heavy (unit + SSR only; no app, browser, keeper or scope).
// Run: node scripts/memcap-settings-mutants.mjs [--only M01_ws_unreadable_is_raw_bill,M02_cap_from_any_scope] [--check | --check-anchors]
// `expect` = a substring of a reddened unit test title, or `smoke:<check label>` for a failing smoke check — at least one MUST be red. `smoke: true` also runs the smoke.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SWEEP_MARK_ENV, finishRunDir, makeRunDir, settleBackups, strayProcesses } from './mutant-survivors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKUP_BASE = path.join(os.homedir(), '.cache', 'h2-323', 'mutant-backup');
const RUN_TOKEN = `${process.pid}-${Date.now()}`;
process.env[SWEEP_MARK_ENV] = RUN_TOKEN; // inherited by EVERY process this harness spawns (orphans included): the survivors line selects them by this marker, not by ancestry
let BACKUP = ''; // THIS run's own scratch dir (created once a real sweep starts)
const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--only', '--check-anchors', '--check', '--no-rig']);
const unknownFlags = args.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
if (unknownFlags.length) { // fail CLOSED: a flag this script does not know must never fall through to the full (heavy) sweep (OPS, 2026-10-09: `--check` once did)
  console.error(`REFUSING: unknown option(s) ${unknownFlags.join(' ')} — NOTHING was run. Known: --only ID,ID | --check (alias --check-anchors: dry anchor check, no build / keeper / scope / scratch) | --no-rig`);
  process.exit(2);
}
const dryCheck = args.includes('--check-anchors') || args.includes('--check');
const only = args.includes('--only') && (args[args.indexOf('--only') + 1] ?? '') !== '' ? new Set(args[args.indexOf('--only') + 1].split(',')) : null; // a missing / empty value is refused below, never a crash
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
const TESTS = ['src/shared/memory-cap-view.test.ts', 'src/shared/memory-guard-view.test.ts', 'src/shared/member-memory.test.ts', 'src/main/member-memory.test.ts', 'src/main/memory-scope.test.ts', 'src/shared/resources.test.ts', 'src/main/memcap-settings-wiring.test.ts', 'src/main/memory-guard-settings.test.ts', 'src/main/member-memory-wiring.test.ts', 'src/main/bus-pane.test.ts', 'src/main/mutant-survivors.test.ts'];

const MUTANTS = [
  // ── the applied cap per member (FI-1 v1.11 → member view → row) ──
  { id: 'M01_ws_unreadable_is_raw_bill', file: MS, find: "        return null; // unreadable ⇒ unknown, not « the raw figure »", to: "        return current;", expect: ['readScopeMemory (FI-1 v1.11, #323)'] },
  { id: 'M02_cap_from_any_scope', file: SM, find: "readings.find((x) => x.keeperPid !== null && x.keeperPid !== undefined);", to: "readings[0];", expect: ["C2 (#323) cap is the keeper", "C3 (#323-fu, review m2) capNote"] },
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
  { id: 'U13_window_cap_commit_on_blur_missing', file: WIN, find: "                  onChange={capField('hard')}\n                  onBlur={commitCap}", to: "                  onChange={capField('hard')}", expect: ['WINDOW: the Plafond section commits the PAIR'] },
  { id: 'U14_window_invalid_pair_written', file: WIN, find: "    } else if (p.kind === 'invalid') {\n      setError(p.error);\n    } else {\n      void apply(p.patch, null, capDraft);", to: "    } else {\n      void apply((p as { patch: Parameters<typeof apply>[0] }).patch, null, capDraft);", expect: ['WINDOW: the Plafond section commits the PAIR'] },
  { id: 'U15_window_live_refusal_dropped', file: WIN, find: "const shownError = error ?? liveError ?? liveCapError ?? liveWaitError;", to: "const shownError = error ?? liveError ?? liveWaitError;", expect: ['WINDOW: the Plafond section commits the PAIR'] },
  { id: 'U16_window_writes_the_switch', file: WIN, find: "      setCapSwitch(await window.orchestra.busCapSummary());", to: "      setCapSwitch(await window.orchestra.busCapSummary());\n      void window.orchestra.setBusSwitches({ memoryCap: true });", expect: ['WINDOW (D-Q1)'] },
  { id: 'U17_window_switch_is_a_checkbox', file: WIN, find: "<div className=\"mg-cap-switch field-hint\"", to: "<input type=\"checkbox\" data-mg-cap-toggle /><div className=\"mg-cap-switch field-hint\"", expect: ['WINDOW (D-Q1)', 'smoke:the activation is SHOWN read-only'], smoke: true },
  { id: 'U18_window_switch_line_dropped', file: WIN, find: "{capSwitch ? capSwitch.text : '…'}", to: "…", expect: ['smoke:the activation is SHOWN read-only'], smoke: true },
  { id: 'U19_window_inputs_enabled_before_load', file: WIN, find: "                  data-mg-cap-soft\n                  value={typedCap.soft}\n                  disabled={!settings}", to: "                  data-mg-cap-soft\n                  value={typedCap.soft}", expect: ['smoke:before the first read the cap inputs are DISABLED'], smoke: true },
  { id: 'U20_window_applies_note_dropped', file: WIN, find: "Applies to members started from now on; running sessions keep what they started with.", to: "", expect: ['smoke:it says where the switch IS set'], smoke: true },
  // ── the Reliquat wait (#326) in the same section ──
  { id: 'X01_wait_not_validated', file: SG, find: "  const res = patchMemoryGuardSettings(current, { reliquatWaitMin }, totalBytes); // same write-path validator (see planCapCommit)\n  if (!res.ok) return", to: "  const res = patchMemoryGuardSettings(current, { reliquatWaitMin }, totalBytes); // same write-path validator (see planCapCommit)\n  if (false as boolean) return", expect: ['Reliquat wait commit: out-of-range or non-numeric input is REFUSED'] },
  { id: 'X02_wait_unchanged_always_patches', file: SG, find: "  if (reliquatWaitMin === current.reliquatWaitMin) return { kind: 'unchanged' };\n", to: "", expect: ['Reliquat wait commit (#323/#326): a valid changed value'] },
  { id: 'X03_wait_patch_carries_more', file: SG, find: "return { kind: 'patch', patch: { reliquatWaitMin } };", to: "return { kind: 'patch', patch: { reliquatWaitMin, capHardGb: current.capHardGb } as { reliquatWaitMin: number } };", expect: ['Reliquat wait commit (#323/#326): a valid changed value'] },
  { id: 'X04_wait_text_not_parsed', file: SG, find: "  if (reliquatWaitMin === null) return { kind: 'invalid', error: 'Enter the Reliquat wait as a number of minutes.' };", to: "  if (reliquatWaitMin === null) return { kind: 'unchanged' };", expect: ['Reliquat wait commit: out-of-range or non-numeric input is REFUSED'] },
  { id: 'X05_window_wait_no_commit_on_blur', file: WIN, find: "                onBlur={commitWait}\n", to: "", expect: ['WINDOW (#326)'] },
  { id: 'X06_window_wait_refusal_not_shown', file: WIN, find: "const shownError = error ?? liveError ?? liveCapError ?? liveWaitError;", to: "const shownError = error ?? liveError ?? liveCapError;", expect: ['WINDOW (#326)', 'WINDOW: the Plafond section commits the PAIR'] },
  { id: 'X07_window_wait_field_dropped', file: WIN, find: '<span className="mg-unit">min</span>', to: '', expect: ['smoke:the Reliquat wait (#326) is a third field'], smoke: true },
  { id: 'X08_window_wait_enabled_before_load', file: WIN, find: "                  data-mg-reliquat-wait\n                  value={typedWait}\n                  disabled={!settings}", to: "                  data-mg-reliquat-wait\n                  value={typedWait}", expect: ['smoke:before the first read the cap inputs are DISABLED'], smoke: true },
  // ── pre-review round (MAJOR 1/2 + minors) ──
  { id: 'Y03_cap_plan_judges_the_stored_admission_pair', file: SG, find: "const res = patchMemoryGuardSettings(current, { capSoftGb, capHardGb }, totalBytes);", to: "const res = validateMemoryGuardSettings({ ...current, capSoftGb, capHardGb }, totalBytes) === null ? ({ ok: true } as const) : ({ ok: false, error: validateMemoryGuardSettings({ ...current, capSoftGb, capHardGb }, totalBytes) as string } as const);", expect: ['cap + Reliquat wait commits (#323 review MAJOR 1)'] },
  { id: 'Y04_wait_plan_judges_the_stored_admission_pair', file: SG, find: "const res = patchMemoryGuardSettings(current, { reliquatWaitMin }, totalBytes);", to: "const res = validateMemoryGuardSettings({ ...current, reliquatWaitMin }, totalBytes) === null ? ({ ok: true } as const) : ({ ok: false, error: validateMemoryGuardSettings({ ...current, reliquatWaitMin }, totalBytes) as string } as const);", expect: ['cap + Reliquat wait commits (#323 review MAJOR 1)'] },
  { id: 'Y05_parser_accepts_hex_and_exponent', file: SG, find: "  if (!/^-?(\\d+\\.?\\d*|\\.\\d+)$/.test(t)) return null;", to: "  if (false) return null;", expect: ['parseGbInput'] },
  { id: 'Y06_parser_reads_a_thousands_group_as_a_decimal', file: SG, find: "  if (/^\\d{1,3}(,\\d{3})+$/.test(text.trim())) return null;", to: "  if (false) return null;", expect: ['parseGbInput'] },
  { id: 'Y07_working_set_without_inactive_file_is_the_raw_bill', file: MS, find: "return Number.isFinite(stat.inactive_file) ? workingSetBytes(capCurrent, stat) : null;", to: "return workingSetBytes(capCurrent, stat);", expect: ['readScopeMemory (FI-1 v1.11, #323)'] },
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
  { id: 'Y22_existing_threshold_hook_renamed_ordering_check_vacuous', file: WIN, find: "data-mg-critical", to: "data-mg-crit", expect: ['smoke:the section is there', 'smoke:the existing threshold fields are untouched'], smoke: true },
  // ── gate c/6112245304: window layout (scroll body, refusal + Done pinned), S10 ranking, measured survivors ──
  { id: 'L01_body_does_not_scroll', file: 'src/renderer/styles.css', find: "min-height: 0; overflow-y: auto; margin: 0 -6px;", to: "min-height: 0; margin: 0 -6px;", expect: ['WINDOW LAYOUT'] },
  { id: 'L02_body_cannot_shrink', file: 'src/renderer/styles.css', find: "flex: 1 1 auto; min-height: 0; overflow-y: auto;", to: "flex: 1 1 auto; overflow-y: auto;", expect: ['WINDOW LAYOUT'] },
  { id: 'L03_refusal_scrolls_with_the_fields', file: WIN, find: "        </div>\n\n        {shownError && (", to: "\n        {shownError && (", expect: ['WINDOW LAYOUT'] },
  { id: 'L04_dialog_not_height_bounded', file: 'src/renderer/styles.css', find: ".sound-settings { max-height: min(80vh, 720px); display: flex; flex-direction: column; }", to: ".sound-settings { display: flex; flex-direction: column; }", expect: ['WINDOW LAYOUT'] },
  { id: 'L05_done_shrinks_away', file: 'src/renderer/styles.css', find: ".memory-guard-settings .modal-actions { flex: none; }", to: "", expect: ['WINDOW LAYOUT'] },
  { id: 'L06_refusal_shrinks_away', file: 'src/renderer/styles.css', find: ".memory-guard-settings .mg-error { flex: none; margin-top: 8px; }", to: ".memory-guard-settings .mg-error { margin-top: 8px; }", expect: ['WINDOW LAYOUT'] },
  { id: 'L07_body_wrapper_dropped', file: WIN, find: "<div className=\"mg-body\" data-mg-body>", to: "<div>", expect: ['WINDOW LAYOUT'] },
  { id: 'S10_closest_ranked_in_absolute_bytes', file: SC, find: "b.cap.billBytes / b.cap.hardBytes > a.cap.billBytes / a.cap.hardBytes ? b : a", to: "b.cap.billBytes > a.cap.billBytes ? b : a", expect: ['V6c'] },
  { id: 'S10b_closest_ranked_by_the_smallest_cap', file: SC, find: "b.cap.billBytes / b.cap.hardBytes > a.cap.billBytes / a.cap.hardBytes ? b : a", to: "b.cap.hardBytes < a.cap.hardBytes ? b : a", expect: ['V6c'] },
  { id: 'G01_viewport_not_imposed', file: 'scripts/memcap-screenshot.mjs', find: "await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false });", to: "win.setContentSize(vw, vh);", expect: ['SWAY GATE (OPS review m3)'] },
  { id: 'G02_measured_viewport_not_asserted', file: 'scripts/memcap-screenshot.mjs', find: "m.vw === f.vw && m.vh === f.vh, `measured", to: "true, `measured", expect: ['SWAY GATE (OPS review m3)'] },
  { id: 'G03_png_size_not_asserted', file: 'scripts/memcap-screenshot.mjs', find: "!!pp && pp.w === f.vw && pp.h === f.vh,", to: "!!pp,", expect: ['SWAY GATE (OPS review m3)'] },
  { id: 'G04_a_viewport_dropped', file: 'scripts/memcap-screenshot.mjs', find: "[[1440, 900], [1920, 1080], [1280, 640]]", to: "[[1440, 900], [1920, 1080]]", expect: ['SWAY GATE (OPS review m3)'] },
  // ── follow-up round (#323-fu): m2 « not applied », m5 wording ──
  { id: 'N01_max_read_as_applied', file: 'src/shared/memory-scope.ts', find: "  if (v === 'max') return false;", to: "  if (v === 'max') return true;", expect: ['limitApplied tells'] },
  { id: 'N02_garbage_read_as_not_applied', file: 'src/shared/memory-scope.ts', find: "return /^\\d+$/.test(v) ? true : null;", to: "return /^\\d+$/.test(v) ? true : false;", expect: ['limitApplied tells'] },
  { id: 'N03_unreadable_limit_read_as_not_applied', file: MS, find: "    limitFileAbsent = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' && e.exists(capDir);", to: "    limitFileAbsent = true;", expect: ['#323-fu × #332 (3/3)', 'P18 (#323-fu × #332)'] },
  { id: 'N04_producer_drops_limit_applied', file: PM, find: "peakBytes: mem?.peakBytes ?? null, limitApplied: mem?.limitApplied ?? null };", to: "peakBytes: mem?.peakBytes ?? null, limitApplied: null };", expect: ['P17 (#323-fu', '#323-fu m2: the « not applied » note travels'] },
  { id: 'N05_note_without_an_explicit_max', file: SM, find: "r.limitApplied === false ? 'not-applied' : null", to: "r.limitApplied !== true ? 'not-applied' : null", expect: ['C3 (#323-fu'] },
  { id: 'N06_note_on_an_unreadable_meter', file: SM, find: "return r && finite(r.currentBytes) && r.limitApplied === false", to: "return r && r.limitApplied === false", expect: ['C3 (#323-fu'] },
  { id: 'N07_note_not_carried_to_the_row', file: SR, find: "      capNote: view?.capNote ?? null,\n", to: "", expect: ['G14 (#323-fu', '#323-fu m2: the « not applied » note travels'] },
  { id: 'N08_note_cell_without_the_tooltip', file: RV, find: "title={CAP_NOT_APPLIED_TIP} data-res-nocap=\"\"", to: "data-res-nocap=\"\"", expect: ['smoke:#323-fu (m2): a tracked member whose scope has NO limit', '#323-fu m2: the « not applied » note travels'], smoke: true },
  { id: 'N09_tooltip_claims_a_cause', file: SC, find: "so nothing stops it at the hard level.'", to: "so nothing stops it at the hard level, because the Plafond mémoire is disabled.'", expect: ['smoke:#323-fu (m2): the tooltip does not claim a cause'], smoke: true },
  { id: 'N10_note_cell_without_the_dotted_cue', file: 'src/renderer/styles.css', find: "cursor: help; text-decoration: underline dotted var(--text-dim);", to: "", expect: ['#323-fu m2: the « not applied » note travels'] },
  { id: 'N11_note_on_the_capped_branch_order', file: RV, find: "{row.cap ? (", to: "{row.capNote === 'not-applied' ? (<span className=\"res-cell res-mem-nocap\" title={CAP_NOT_APPLIED_TIP} data-res-nocap=\"\">{formatBytes(row.memBytes)}</span>) : row.cap ? (", expect: ['#323-fu m2: the « not applied » note travels', 'RESOURCES: the snapshot carries the levels NOW'], smoke: true },
  { id: 'N12_window_points_at_the_bus_page', file: WIN, find: "set it in « Fleet bus mechanisms » (the bus button in the header), not here.", to: "set it on the Bus page, not here.", expect: ['#323-fu m5', 'smoke:it says where the switch IS set'], smoke: true },
  // ── the survivors instrument itself (review m1/m2): it must be able to say FAIL ──
  { id: 'V20_marker_prefix_match', file: 'scripts/mutant-survivors.mjs', find: "if (!env.includes(needle)) continue;", to: "if (!env.some((e) => e.startsWith(needle))) continue;", expect: ['markedProcesses over a fake /proc'] },
  { id: 'V21_strays_only_descendants', file: 'scripts/mutant-survivors.mjs', find: "return [...new Set([...descendantsOf(rootPid, procDir), ...markedProcesses(token, procDir, rootPid)])]", to: "return [...new Set([...descendantsOf(rootPid, procDir)])]", expect: ['markedProcesses / strayProcesses: an ORPHAN'] },
  { id: 'V22_marker_counts_zombies', file: 'scripts/mutant-survivors.mjs', find: "if (/^\\d+ \\(.*\\) Z /s.test(stat)) continue;", to: "", expect: ['markedProcesses over a fake /proc'] },
  { id: 'V23_marker_counts_self', file: 'scripts/mutant-survivors.mjs', find: "if (!/^\\d+$/.test(n) || Number(n) === self) continue;", to: "if (!/^\\d+$/.test(n)) continue;", expect: ['markedProcesses over a fake /proc'] },
  { id: 'V24_run_dir_not_unique', file: 'scripts/mutant-survivors.mjs', find: "const dir = path.join(base, `run-${pid}-${now}`);", to: "const dir = path.join(base, 'run');", expect: ['per-run scratch'] },
  { id: 'V25_run_dir_never_removed', file: 'scripts/mutant-survivors.mjs', find: "if (left === 0) fs.rmSync(dir, { recursive: true, force: true });", to: "", expect: ['per-run scratch'] },
  { id: 'V26_unrestored_backup_deleted', file: 'scripts/mutant-survivors.mjs', find: "    if (same) fs.rmSync(full, { force: true });\n    else left++;", to: "    fs.rmSync(full, { force: true });", expect: ['settleBackups', 'per-run scratch'] },
  { id: 'V27_empty_token_selects_everything', file: 'scripts/mutant-survivors.mjs', find: "if (!token) throw new Error(", to: "if (false) throw new Error(", expect: ['markedProcesses / strayProcesses: an ORPHAN'] },
  // ── pre-review round of the follow-up ──
  { id: 'N13_note_cell_without_aria_label', file: RV, find: " aria-label={`${formatBytes(row.memBytes)} — ${CAP_NOT_APPLIED_TIP}`}", to: "", expect: ['smoke:#323-fu (m2, review): the cell is keyboard-focusable', '#323-fu m2: the « not applied » note travels'], smoke: true },
  { id: 'N14_note_cell_not_focusable', file: RV, find: " tabIndex={0} role=\"note\"", to: " role=\"note\"", expect: ['smoke:#323-fu (m2, review): the cell is keyboard-focusable', '#323-fu m2: the « not applied » note travels'], smoke: true },
  { id: 'N15_dotted_cue_loses_its_hairline', file: 'src/renderer/styles.css', find: " text-decoration-thickness: 1px; text-underline-offset: 3px; }", to: " }", expect: ['#323-fu m2: the « not applied » note travels'] },
  { id: 'N16_dotted_cue_loses_its_dim_colour', file: 'src/renderer/styles.css', find: "text-decoration: underline dotted var(--text-dim);", to: "text-decoration: underline dotted;", expect: ['#323-fu m2: the « not applied » note travels'] },
  { id: 'N17_remote_row_reads_a_local_view', file: SR, find: "const view = remote ? undefined : viewFor(members, key);", to: "const view = viewFor(members, key);", expect: ['G14 (#323-fu'] },
  { id: 'N18_undefined_keeper_counts_as_the_keeper', file: SM, find: "readings.find((x) => x.keeperPid !== null && x.keeperPid !== undefined);", to: "readings.find((x) => x.keeperPid !== null);", expect: ['C3 (#323-fu'] },
  { id: 'N19_applied_flag_dropped_at_the_single_read', file: MS, find: "limitApplied: limitText !== null ? parseLimitApplied(limitText) : limitFileAbsent ? false : null,", to: "limitApplied: null,", expect: ['limitApplied tells', '#323-fu m2: the « not applied » note travels'] },
  { id: 'N20_max_bytes_and_applied_read_apart', file: MS, find: "maxBytes: limitText === null ? null : parseCgroupLimit(limitText),", to: "maxBytes: lim('memory.max'),", expect: ['#323-fu m2: the « not applied » note travels'] },
  { id: 'V28_strays_only_the_marker', file: 'scripts/mutant-survivors.mjs', find: "return [...new Set([...descendantsOf(rootPid, procDir), ...markedProcesses(token, procDir, rootPid)])]", to: "return [...new Set([...markedProcesses(token, procDir, rootPid)])]", expect: ['strayProcesses = marked ∪ descendants'] },
  { id: 'V29_baseline_helper_removes_the_run_dir', file: 'scripts/mutant-survivors.mjs', find: "export function settleBackups(dir, sourceOf) {", to: "export function settleBackups(dir, sourceOf) {\n  process.nextTick(() => { try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* */ } });", expect: ['the sweep harness measures scratch MID-run'] },
  // ── the #332 seam (OPS 7262): limitApplied follows the CAP cgroup; absent ⇒ false; EACCES/EIO/vanished ⇒ null ──
  { id: 'Z01_limit_read_from_the_scope_not_the_cap_cgroup', file: MS, find: "limitText = e.readFile(path.join(capDir, 'memory.max'));", to: "limitText = e.readFile(path.join(d, 'memory.max'));", expect: ['#323-fu × #332 (1/3)', 'P18 (#323-fu × #332)'] },
  { id: 'Z02_absent_limit_file_stays_unknown', file: MS, find: "limitApplied: limitText !== null ? parseLimitApplied(limitText) : limitFileAbsent ? false : null,", to: "limitApplied: limitText !== null ? parseLimitApplied(limitText) : null,", expect: ['#323-fu × #332 (2/3)', 'P18 (#323-fu × #332)', 'readScopeMemory (#323-fu, review m2)'] },
  { id: 'Z03_any_read_error_counts_as_absent', file: MS, find: "(err as NodeJS.ErrnoException | null)?.code === 'ENOENT' && e.exists(capDir);", to: "e.exists(capDir);", expect: ['#323-fu × #332 (3/3)', 'P18 (#323-fu × #332)'] },
  { id: 'Z04_vanished_scope_counts_as_absent', file: MS, find: "(err as NodeJS.ErrnoException | null)?.code === 'ENOENT' && e.exists(capDir);", to: "(err as NodeJS.ErrnoException | null)?.code === 'ENOENT';", expect: ['#323-fu × #332 (3/3)'] },
  { id: 'Z05_max_bytes_from_the_scope_again', file: MS, find: "maxBytes: limitText === null ? null : parseCgroupLimit(limitText),", to: "maxBytes: lim('memory.max'),", expect: ['#323-fu m2: the « not applied » note travels'] },
  { id: 'Z06_absent_limit_file_reads_a_stale_number', file: MS, find: "maxBytes: limitText === null ? null : parseCgroupLimit(limitText),", to: "maxBytes: limitText === null ? (limitFileAbsent ? 1 : null) : parseCgroupLimit(limitText),", expect: ['#323-fu × #332 (2/3)'] },
];

// `--only` takes EXACT mutant ids: an unknown / missing id used to select nothing and print « MUTANTS: 0/0 killed » with exit 0 (OPS review, #323 m3) — now exit 2, nothing run.
{
  const i = args.indexOf('--only');
  const value = i >= 0 ? args[i + 1] : undefined;
  if (i >= 0 && (value === undefined || value.startsWith('-') || value === '')) { console.error('REFUSING: --only needs a comma-separated list of EXACT mutant ids — NOTHING was run.'); process.exit(2); }
  if (only && [...only].some((id) => id.trim() === '')) { console.error('REFUSING: --only has an EMPTY id (a stray comma?) — NOTHING was run.'); process.exit(2); }
  const unknown = only ? [...only].filter((id) => !MUTANTS.some((m) => m.id === id)) : [];
  if (unknown.length) {
    console.error(`REFUSING: unknown mutant id(s) ${unknown.join(', ')} — NOTHING was run (ids are exact, e.g. ${MUTANTS[0].id}).`);
    process.exit(2);
  }
}
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
// MEASURED (gate c/6112245304: these used to return the constant 0): everything of THIS run still alive (marker + descendants, review m1) and THIS run's own backups not proven restored (identical ones cleaned, the rest counted; per-run dir, review m2)
const strays = () => strayProcesses(process.pid, RUN_TOKEN).length;
const sourceOfBackup = (id) => path.join(REPO, MUTANTS.find((m) => m.id === id)?.file ?? '/nonexistent');
const scratchLeft = () => settleBackups(BACKUP, sourceOfBackup); // mid-run (the baseline reads it): settles, NEVER removes the run dir — the next mutant still writes there
const scratchFinish = () => finishRunDir(BACKUP, sourceOfBackup); // END of run only; per RUN: another run's backups are never read, counted or deleted

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
BACKUP = makeRunDir(BACKUP_BASE); // scratch exists only for a real sweep, never for the dry check

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
const sv = strays(); const sc = scratchFinish();
console.log(`RESTORED: sha-identical ${sameSha} · git diff clean ${gitClean} · cmp-restore ${!restoreBad} · post-sweep unit fail ${post.names.length} · survivors: rig processes=${sv} scratch dirs=${sc}`);
console.log(`MUTANTS: ${killed}/${rows.length} killed by their NAMED test/arm${rows.length === killed ? '' : ` — NOT ALL: ${rows.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id}=${r.verdict}`).join(', ')}`}`);
process.exit(rows.length === killed && sameSha && gitClean && !restoreBad && post.names.length === 0 && sv === 0 && sc === 0 ? 0 : 1);

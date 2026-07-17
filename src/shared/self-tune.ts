// Pure logic for the monthly "Insights & Improvements" self-tune pipeline:
// which logins to run `/insights` for, whether a run is due this month, which
// report file is the newest, and the fold-pass prompt that distills lessons
// across every login into ~/.claude/LESSONS.md. Everything here is
// dependency-free (no electron, no fs) so it runs under `node --test`; the
// impure half (spawning claude, streaming output, persistence) lives in
// src/main/self-tune.ts.

// Explicit .ts extension so Node's type-stripping test runner can resolve the
// import (vite/esbuild accept it too — see tsconfig's allowImportingTsExtensions).
import { expandConfigDir, type Account } from './accounts.ts';

export type SelfTuneStepStatus = 'pending' | 'running' | 'ok' | 'failed';

/** One login the pipeline runs `/insights` under. `id` is 'default' for the
 *  global `~/.claude` (spawned with CLAUDE_CONFIG_DIR *unset*) or the account
 *  id for a configured alternate login (spawned with CLAUDE_CONFIG_DIR set to
 *  `configDir`). */
export interface SelfTuneLogin {
  id: string;
  label: string;
  configDir: string;
}

/** One step of a run: an `/insights` pass for a login, or the single final
 *  fold pass that updates LESSONS.md from every login's newest report. */
export interface SelfTuneStep {
  /** `insights:<loginId>` or `fold`. */
  id: string;
  kind: 'insights' | 'fold';
  loginId: string;
  label: string;
  configDir: string;
  status: SelfTuneStepStatus;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  /** Spawn-level failure (command not found, …) — distinct from a non-zero exit. */
  error?: string;
}

/** A whole pipeline run. Persisted in store.json (bounded history) so the last
 *  outcome survives restarts; the step transcripts live outside the store. */
export interface SelfTuneRun {
  id: string;
  trigger: 'auto' | 'manual';
  status: 'running' | 'ok' | 'failed';
  startedAt: number;
  finishedAt?: number;
  steps: SelfTuneStep[];
  /** Short human outcome parsed from the fold pass's marker line, e.g.
   *  "2 lessons added" — drives the sidebar's idle row. */
  summary?: string;
}

/** Newest report per login, for the fold prompt and the UI's "open report"
 *  buttons. `reportPath` is null when the login has no report yet. */
export interface SelfTuneReport {
  loginId: string;
  label: string;
  configDir: string;
  reportPath: string | null;
}

/** A run is due when there has been no successful run in the current calendar
 *  month (local time). `lastSuccessAt` is the `finishedAt` of the newest ok
 *  run, or null/undefined when none exists. */
export function isSelfTuneDue(lastSuccessAt: number | null | undefined, now: number): boolean {
  if (!lastSuccessAt) return true;
  const last = new Date(lastSuccessAt);
  const cur = new Date(now);
  return last.getFullYear() !== cur.getFullYear() || last.getMonth() !== cur.getMonth();
}

/** The `finishedAt` of the newest successful run, or null. Feed to
 *  {@link isSelfTuneDue}. */
export function lastSuccessAt(runs: SelfTuneRun[]): number | null {
  let best: number | null = null;
  for (const r of runs) {
    if (r.status === 'ok' && typeof r.finishedAt === 'number') {
      if (best === null || r.finishedAt > best) best = r.finishedAt;
    }
  }
  return best;
}

/** The logins to run `/insights` for, default login first. The default is
 *  always `<home>/.claude` (CLAUDE_CONFIG_DIR deliberately unset when it runs);
 *  each configured account follows iff its config-dir template expands to a
 *  non-empty path that isn't already covered (the default's dir, or a
 *  duplicate of an earlier account's). Existence-on-disk is the caller's
 *  concern — this stays fs-free. */
export function enumerateSelfTuneLogins(
  accounts: Account[],
  home: string,
  env: Record<string, string | undefined>,
): SelfTuneLogin[] {
  const defaultDir = `${home}/.claude`;
  const out: SelfTuneLogin[] = [{ id: 'default', label: 'default login', configDir: defaultDir }];
  const seen = new Set([defaultDir]);
  for (const a of accounts) {
    const dir = expandConfigDir(a.configDir, home, env);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push({ id: a.id, label: a.label, configDir: dir });
  }
  return out;
}

/** Pick the newest insights report among a usage-data dir's entries. Reports
 *  are named `report-YYYY-MM-DD-HHMMSS.html`, so a lexicographic sort IS a
 *  chronological sort; the bare `report.html` copy is a fallback only. */
export function newestReport(fileNames: string[]): string | null {
  const stamped = fileNames
    .filter((n) => /^report-.*\.html$/.test(n))
    .sort();
  if (stamped.length > 0) return stamped[stamped.length - 1];
  return fileNames.includes('report.html') ? 'report.html' : null;
}

/** Marker line the fold prompt asks claude to end with, so the UI can show a
 *  one-line outcome ("2 lessons added") without parsing free-form output. */
export const FOLD_RESULT_MARKER = 'SELF-TUNE-RESULT:';

/** Extract the fold pass's outcome from its streamed output — the text after
 *  the last {@link FOLD_RESULT_MARKER} line — or null when the pass never
 *  printed one (crashed, or an older prompt). */
export function parseFoldSummary(output: string): string | null {
  let found: string | null = null;
  for (const line of output.split('\n')) {
    const i = line.indexOf(FOLD_RESULT_MARKER);
    if (i >= 0) {
      const rest = line.slice(i + FOLD_RESULT_MARKER.length).trim();
      if (rest) found = rest;
    }
  }
  return found;
}

/** The fold-pass prompt: ONE run (under the default login) that reads every
 *  login's newest report, dedupes friction lessons ACROSS logins, and updates
 *  ~/.claude/LESSONS.md per that file's own rules. Mirrors the prompt the
 *  retired systemd script (`monthly-insights-retro.sh`) used, extended to
 *  multiple logins and the result marker line. */
export function buildFoldPrompt(reports: SelfTuneReport[], home: string): string {
  const lines = reports.map((r) =>
    r.reportPath
      ? `- ${r.label}: ${r.reportPath}`
      : `- ${r.label}: (no report generated — skip this login)`,
  );
  return `You are running the monthly insights self-tune (headless, no user present).

Insights reports were just regenerated for every Claude Code login. The newest
report for each login:
${lines.join('\n')}

1. Read each listed report's friction / what-goes-wrong content (each sits in
   its login's usage-data directory; a facets/ directory may sit alongside it).
2. Read ${home}/.claude/LESSONS.md and ${home}/.claude/CLAUDE.md.
3. For each recurring friction pattern in the reports that is NOT already
   covered by an existing lesson or CLAUDE.md rule, append one dated bullet to
   ${home}/.claude/LESSONS.md, phrased as a direct instruction. Dedupe across
   the logins' reports first — the same pattern showing up under several logins
   is ONE lesson, not one per login. Then follow the file's own rules: dedupe
   against existing bullets, sharpen an existing bullet instead of adding a
   near-duplicate, and keep the file under ~30 bullets by merging or deleting
   the weakest/stalest ones.
4. If a lesson has kept recurring across months despite being listed, add
   " (recurring — consider promoting to a CLAUDE.md rule/skill/hook)" to it.
5. Append a 3-6 line summary of what you changed (or "no changes needed") to
   ${home}/.claude/usage-data/self-tune.log.
6. Finally print exactly one line of the form
   \`${FOLD_RESULT_MARKER} <short outcome>\` (e.g. \`${FOLD_RESULT_MARKER} 2 lessons added\`
   or \`${FOLD_RESULT_MARKER} no changes needed\`) so the UI can show the outcome.

Do not modify anything other than LESSONS.md and self-tune.log.`;
}

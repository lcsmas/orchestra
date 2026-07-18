import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, shell } from 'electron';
import { store } from './store';
import { log } from './logger';
import {
  buildFoldPrompt,
  diffLessons,
  ensureLessonsImport,
  enumerateSelfTuneLogins,
  isSelfTuneDue,
  lastSuccessAt,
  LESSONS_BOOTSTRAP,
  newestReport,
  parseFoldSummary,
  summarizeLessonsDiff,
  type SelfTuneLogin,
  type SelfTuneReport,
  type SelfTuneRun,
  type SelfTuneStep,
} from '../shared/self-tune';

// Monthly Claude Code self-tuning, orchestra-native (replaces the old systemd
// timer): for every login (the default ~/.claude plus each configured
// account's config dir) run a headless `claude -p "/insights"` to regenerate
// that login's usage report, then ONE fold pass — under the default login —
// that reads every newest report and distills new friction lessons into
// ~/.claude/LESSONS.md (the file @-imported by the global CLAUDE.md, so
// lessons load in every session and login) and appends a summary to
// ~/.claude/usage-data/self-tune.log.
//
// The pipeline's pure half (login enumeration, due-date math, report
// resolution, the fold prompt) lives in src/shared/self-tune.ts; this module
// owns the impure half: spawning, streaming, persistence, scheduling, IPC.

/** Test seam: overrides the `claude` executable for every pipeline spawn, so
 *  tests/e2e exercise the full pipeline with a fast fake instead of a real
 *  multi-minute claude run. The fake receives the exact same argv
 *  (`-p <prompt> --dangerously-skip-permissions`). */
function claudeCmd(): string {
  return process.env.ORCHESTRA_SELF_TUNE_CMD || 'claude';
}

let mainWindow: BrowserWindow | null = null;
let current: SelfTuneRun | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let kickoff: ReturnType<typeof setTimeout> | null = null;

// Live transcript per run: an in-memory bounded buffer for streaming to the
// UI, mirrored to a file so the last run's transcript survives a restart.
// (Statuses/timestamps persist in store.json; transcripts deliberately don't.)
const OUTPUT_CAP = 512 * 1024;
const outputs = new Map<string, string>();

function transcriptDir(): string {
  return path.join(app.getPath('userData'), 'orchestra', 'self-tune');
}

function transcriptPath(runId: string): string {
  return path.join(transcriptDir(), `${runId}.log`);
}

function appendOutput(runId: string, chunk: string): void {
  const prev = outputs.get(runId) ?? '';
  const next = prev + chunk;
  outputs.set(runId, next.length > OUTPUT_CAP ? next.slice(-OUTPUT_CAP) : next);
  try {
    fs.appendFileSync(transcriptPath(runId), chunk);
  } catch {
    // Transcript persistence is best-effort — the live buffer still streams.
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('selfTune:output', runId, chunk);
  }
}

/** The buffered transcript of a run — from memory while the app that ran it
 *  is alive, else from the mirrored file (tail-bounded like the buffer). */
export function getSelfTuneOutput(runId: string): string {
  const mem = outputs.get(runId);
  if (mem !== undefined) return mem;
  try {
    const raw = fs.readFileSync(transcriptPath(runId), 'utf8');
    return raw.length > OUTPUT_CAP ? raw.slice(-OUTPUT_CAP) : raw;
  } catch {
    return '';
  }
}

async function persistAndBroadcast(run: SelfTuneRun): Promise<void> {
  await store.saveSelfTuneRun(run);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('selfTune:update', run);
  }
}

/** Runs, newest first, with the in-flight one (if any) up to date. */
export function getSelfTuneRuns(): SelfTuneRun[] {
  return [...store.selfTuneRuns].reverse();
}

/** The logins the next run would cover: default `~/.claude` first, then each
 *  configured account whose config dir expands non-empty AND exists on disk
 *  (a never-logged-in account has no history to generate insights from). */
function usableLogins(): SelfTuneLogin[] {
  return enumerateSelfTuneLogins(store.accounts, os.homedir(), process.env).filter((l) =>
    fs.existsSync(l.configDir),
  );
}

function resolveReport(login: SelfTuneLogin): SelfTuneReport {
  const dir = path.join(login.configDir, 'usage-data');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No usage-data dir yet — the login has never had an insights run.
  }
  const newest = newestReport(names);
  return {
    loginId: login.id,
    label: login.label,
    configDir: login.configDir,
    reportPath: newest ? path.join(dir, newest) : null,
  };
}

/** Newest report per usable login — drives the fold prompt and the UI's
 *  "open report" buttons. */
export function listSelfTuneReports(): SelfTuneReport[] {
  return usableLogins().map(resolveReport);
}

/** Open a login's newest report HTML in the default browser. Resolves false
 *  when the login has no report yet. */
export async function openSelfTuneReport(loginId: string): Promise<boolean> {
  const report = listSelfTuneReports().find((r) => r.loginId === loginId);
  if (!report?.reportPath) return false;
  const err = await shell.openPath(report.reportPath);
  if (err) throw new Error(err);
  return true;
}

/** The current ~/.claude/LESSONS.md content for the read-only UI view. */
export function readSelfTuneLessons(): string {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.claude', 'LESSONS.md'), 'utf8');
  } catch {
    return '';
  }
}

/** Make sure the fold pass's write targets exist on a machine that has never
 *  had them: LESSONS.md (created with its canonical header so the agent has
 *  the file's rules to follow), the usage-data dir for self-tune.log, and —
 *  the load-bearing one — the `@LESSONS.md` import in the global CLAUDE.md,
 *  without which the lessons the fold writes are never loaded by any session.
 *  The fold prompt forbids the agent from touching CLAUDE.md, so this edit
 *  has to happen here. Returns transcript lines for what was bootstrapped. */
function ensureFoldTargets(home: string): string[] {
  const actions: string[] = [];
  const claudeDir = path.join(home, '.claude');
  try {
    fs.mkdirSync(path.join(claudeDir, 'usage-data'), { recursive: true });
    const lessonsPath = path.join(claudeDir, 'LESSONS.md');
    if (!fs.existsSync(lessonsPath)) {
      fs.writeFileSync(lessonsPath, LESSONS_BOOTSTRAP);
      actions.push(`bootstrapped ${lessonsPath}`);
    }
    const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(claudeMdPath, 'utf8');
    } catch {
      // Missing CLAUDE.md — ensureLessonsImport(null) creates it from scratch.
    }
    const updated = ensureLessonsImport(existing);
    if (updated !== null) {
      fs.writeFileSync(claudeMdPath, updated);
      actions.push(
        existing === null
          ? `created ${claudeMdPath} with the @LESSONS.md import`
          : `added the @LESSONS.md import to ${claudeMdPath}`,
      );
    }
  } catch (err) {
    log.warn('self-tune: failed to bootstrap fold targets', err);
    actions.push(`bootstrap of fold targets failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return actions;
}

/** Spawn one pipeline step and stream its output into the run transcript.
 *  Resolves the exit code; a spawn-level failure (ENOENT…) resolves -1 with
 *  the error recorded on the step. */
function runStep(
  run: SelfTuneRun,
  step: SelfTuneStep,
  args: string[],
  configDirEnv: string | null,
): Promise<number> {
  return new Promise((resolve) => {
    // CLAUDE_CONFIG_DIR must be *unset* for the default login (and the fold
    // pass) — a leftover value from orchestra's own environment would silently
    // retarget the run — and set to the login dir for alternate accounts.
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    if (configDirEnv) env.CLAUDE_CONFIG_DIR = configDirEnv;
    const child = spawn(claudeCmd(), args, { cwd: os.homedir(), env });
    child.stdout.on('data', (d: Buffer) => appendOutput(run.id, d.toString()));
    child.stderr.on('data', (d: Buffer) => appendOutput(run.id, d.toString()));
    child.on('error', (err) => {
      step.error = err.message;
      appendOutput(run.id, `spawn failed: ${err.message}\n`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

async function executeRun(run: SelfTuneRun, logins: SelfTuneLogin[]): Promise<void> {
  const stepsById = new Map(run.steps.map((s) => [s.id, s]));

  // Phase 1: `/insights` per login, sequentially. A failed login is tolerated
  // — the fold pass then reads that login's newest *existing* report (or skips
  // it), matching the old script's behaviour.
  for (const login of logins) {
    const step = stepsById.get(`insights:${login.id}`);
    if (!step) continue;
    step.status = 'running';
    step.startedAt = Date.now();
    await persistAndBroadcast(run);
    appendOutput(run.id, `\n=== /insights — ${login.label} (${login.configDir}) ===\n`);
    const code = await runStep(
      run,
      step,
      ['-p', '/insights', '--dangerously-skip-permissions'],
      login.id === 'default' ? null : login.configDir,
    );
    step.exitCode = code;
    step.finishedAt = Date.now();
    step.status = code === 0 ? 'ok' : 'failed';
    if (code !== 0) {
      appendOutput(run.id, `insights for ${login.label} exited ${code}; folding from the newest existing report\n`);
    }
    await persistAndBroadcast(run);
  }

  // Phase 2: ONE fold pass under the default login, its prompt listing every
  // login's newest report explicitly so lessons dedupe ACROSS logins.
  const fold = stepsById.get('fold');
  if (fold) {
    fold.status = 'running';
    fold.startedAt = Date.now();
    await persistAndBroadcast(run);
    appendOutput(run.id, `\n=== fold — distill lessons into ~/.claude/LESSONS.md ===\n`);
    for (const action of ensureFoldTargets(os.homedir())) {
      appendOutput(run.id, `${action}\n`);
    }
    // Snapshot LESSONS.md around the fold so the run records what actually
    // changed (ground truth for the UI's "new since last run" view) — after
    // ensureFoldTargets, so a fresh bootstrap doesn't count as a change.
    const lessonsBefore = readSelfTuneLessons();
    const reports = logins.map(resolveReport);
    const prompt = buildFoldPrompt(reports, os.homedir());
    const code = await runStep(run, fold, ['-p', prompt, '--dangerously-skip-permissions'], null);
    fold.exitCode = code;
    fold.finishedAt = Date.now();
    fold.status = code === 0 ? 'ok' : 'failed';
    run.lessons = diffLessons(lessonsBefore, readSelfTuneLessons());
  }

  // The fold pass is the run's point: insights failures are per-login noise,
  // but no fold means no lessons landed — that's a failed run.
  run.status = fold?.status === 'ok' ? 'ok' : 'failed';
  run.finishedAt = Date.now();
  const summary = parseFoldSummary(getSelfTuneOutput(run.id));
  if (summary) run.summary = summary;
  else if (run.lessons && run.status === 'ok') run.summary = summarizeLessonsDiff(run.lessons);
  await persistAndBroadcast(run);
}

/** Start a self-tune run. Rejects while one is already in flight (one at a
 *  time). Resolves with the run *record* as soon as the pipeline has started —
 *  progress streams via `selfTune:update` / `selfTune:output` events. */
export function startSelfTuneRun(trigger: 'auto' | 'manual'): SelfTuneRun {
  if (current && current.status === 'running') {
    throw new Error('A self-tune run is already in progress');
  }
  const logins = usableLogins();
  const steps: SelfTuneStep[] = logins.map((l) => ({
    id: `insights:${l.id}`,
    kind: 'insights' as const,
    loginId: l.id,
    label: l.label,
    configDir: l.configDir,
    status: 'pending' as const,
  }));
  steps.push({
    id: 'fold',
    kind: 'fold',
    loginId: 'default',
    label: 'fold lessons',
    configDir: path.join(os.homedir(), '.claude'),
    status: 'pending',
  });
  const run: SelfTuneRun = {
    id: randomUUID(),
    trigger,
    status: 'running',
    startedAt: Date.now(),
    steps,
  };
  current = run;
  try {
    fs.mkdirSync(transcriptDir(), { recursive: true });
  } catch {
    /* transcript mirroring stays best-effort */
  }
  log.info(`self-tune run started (${trigger}, ${logins.length} logins)`);
  void persistAndBroadcast(run);
  void executeRun(run, logins)
    .catch((err) => {
      log.error('self-tune run crashed', err);
      run.status = 'failed';
      run.finishedAt = Date.now();
      for (const s of run.steps) if (s.status === 'running') s.status = 'failed';
      void persistAndBroadcast(run);
    })
    .finally(() => {
      if (current === run) current = null;
      log.info(`self-tune run finished: ${run.status}${run.summary ? ` (${run.summary})` : ''}`);
    });
  return run;
}

// Check cadence: cheap pure date math against the persisted history, so a
// wasteful spawn never happens when the month is already covered.
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
// Small startup grace so the auto-kickoff never competes with window load,
// agent resume, and the first poller burst.
const STARTUP_DELAY_MS = 15_000;

function autoRunIfDue(): void {
  if (current) return;
  if (!isSelfTuneDue(lastSuccessAt(store.selfTuneRuns), Date.now())) return;
  try {
    startSelfTuneRun('auto');
  } catch (err) {
    log.warn('self-tune auto-run failed to start', err);
  }
}

/** Start the monthly scheduler: shortly after app ready, and every ~6h, kick
 *  off a run iff no successful run exists in the current calendar month. Also
 *  sweeps any `running` run left over from a previous session to `failed`
 *  (a child process can't survive a restart). */
export function startSelfTuneScheduler(window: BrowserWindow): void {
  mainWindow = window;
  for (const run of store.selfTuneRuns) {
    if (run.status === 'running') {
      run.status = 'failed';
      run.finishedAt = run.finishedAt ?? Date.now();
      for (const s of run.steps) if (s.status === 'running') s.status = 'failed';
      void store.saveSelfTuneRun(run);
    }
  }
  if (timer) return;
  kickoff = setTimeout(autoRunIfDue, STARTUP_DELAY_MS);
  timer = setInterval(autoRunIfDue, CHECK_EVERY_MS);
}

export function stopSelfTuneScheduler(): void {
  if (kickoff) {
    clearTimeout(kickoff);
    kickoff = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

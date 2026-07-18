import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { parseLessonBullets, type SelfTuneReport, type SelfTuneRun, type SelfTuneStep } from '../../shared/self-tune';
import { dialog } from './Dialog';

// Insights & Improvements — orchestra-native monthly Claude Code self-tuning.
// `InsightsSection` is the sidebar entry (bottom of the sidebar, above the
// usage bars): one row when idle, one row per login while a run is in flight.
// `InsightsView` is the main-pane view it opens: live transcript, run history,
// per-login report links, and a read-only view of ~/.claude/LESSONS.md.
// All state comes from the store's `selfTuneRuns` (hydrated on load, patched
// by `selfTune:update` events); the pipeline itself lives in main.

export function SparkleIcon({ size = 14 }: { size?: number }) {
  // Lucide `sparkles` — the self-tune "make Claude a little better" pass.
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </svg>
  );
}

function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(a: number, b: number): string {
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** One-line outcome for a finished run: "Jul 18 · 2 lessons added" style. */
function runOutcome(run: SelfTuneRun): string {
  const day = fmtDay(run.finishedAt ?? run.startedAt);
  if (run.status === 'running') return `${day} · running…`;
  if (run.status === 'failed') return `${day} · failed`;
  return `${day} · ${run.summary ?? 'completed'}`;
}

function StepStatusIcon({ status }: { status: SelfTuneStep['status'] }) {
  if (status === 'running') return <span className="ws-spinner insights-step-spinner" role="status" aria-label="Running" />;
  if (status === 'ok') return <span className="insights-step-icon ok" aria-label="Succeeded">✓</span>;
  if (status === 'failed') return <span className="insights-step-icon fail" aria-label="Failed">✕</span>;
  return <span className="insights-step-icon pending" aria-label="Pending">○</span>;
}

/** Sidebar entry: idle → one row with the last outcome; running → the per-step
 *  status rows so progress is visible without opening the pane. */
export function InsightsSection() {
  const runs = useStore((s) => s.selfTuneRuns);
  const insightsOpen = useStore((s) => s.insightsOpen);
  const setInsightsOpen = useStore((s) => s.setInsightsOpen);
  const last = runs[0];
  const running = last?.status === 'running' ? last : null;

  return (
    <div className="insights-section">
      <button
        className={`insights-row ${insightsOpen ? 'active' : ''}`}
        onClick={() => setInsightsOpen(!insightsOpen)}
        title="Insights & Improvements — monthly Claude Code self-tuning"
        aria-expanded={insightsOpen}
      >
        <span className="insights-row-icon" aria-hidden="true">
          <SparkleIcon />
        </span>
        <span className="insights-row-title">Insights</span>
        <span className="insights-row-sub">
          {running ? 'self-tuning…' : last ? runOutcome(last) : 'not run yet'}
        </span>
      </button>
      {running && (
        <div className="insights-steps">
          {running.steps.map((step) => (
            <div key={step.id} className="insights-step">
              <StepStatusIcon status={step.status} />
              <span className="insights-step-label">
                {step.kind === 'fold' ? 'fold lessons' : step.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Main-pane view: live transcript of the selected (default: newest) run, run
 *  history, per-login report links, Run-now, and the LESSONS.md view. */
export function InsightsView() {
  const runs = useStore((s) => s.selfTuneRuns);
  const setInsightsOpen = useStore((s) => s.setInsightsOpen);
  const running = runs[0]?.status === 'running' ? runs[0] : null;

  // Which run's transcript is shown. Follows the newest run automatically
  // unless the user picked one from the history explicitly.
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const shownRun = (pickedRunId && runs.find((r) => r.id === pickedRunId)) || runs[0] || null;

  const [transcript, setTranscript] = useState('');
  const [reports, setReports] = useState<SelfTuneReport[]>([]);
  const [lessons, setLessons] = useState('');
  const [starting, setStarting] = useState(false);
  const transcriptRef = useRef<HTMLPreElement>(null);

  // Seed the transcript when the shown run changes, then live-append chunks
  // for it. The seed + append can race (a chunk landing between the fetch and
  // its set), so re-fetch-on-id-change and append share the same guard id.
  const shownRunId = shownRun?.id ?? null;
  useEffect(() => {
    setTranscript('');
    if (!shownRunId) return;
    let cancelled = false;
    void window.orchestra
      .getSelfTuneOutput(shownRunId)
      .then((out) => {
        if (!cancelled) setTranscript(out);
      })
      .catch(() => {});
    const off = window.orchestra.onSelfTuneOutput((runId, chunk) => {
      if (runId === shownRunId) setTranscript((t) => t + chunk);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [shownRunId]);

  // Keep the transcript pinned to the bottom while streaming.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  // Reports and lessons change only when a run finishes (or on first open).
  const lastFinishedAt = runs[0]?.finishedAt ?? 0;
  useEffect(() => {
    void window.orchestra.listSelfTuneReports().then(setReports).catch(() => {});
    void window.orchestra.readSelfTuneLessons().then(setLessons).catch(() => {});
  }, [lastFinishedAt]);

  // The newest run that recorded a LESSONS.md diff supplies "what's new since
  // the last self-tune": its added bullets get highlighted in the panel below.
  const latestDiff = runs.find((r) => r.lessons)?.lessons ?? null;
  const newLessons = new Set(latestDiff?.added ?? []);
  const lessonCount = parseLessonBullets(lessons).length;

  const onRunNow = async () => {
    setStarting(true);
    try {
      await window.orchestra.startSelfTune();
      setPickedRunId(null); // follow the new run
    } catch (e) {
      void dialog.error('Could not start self-tune', (e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const onOpenReport = async (loginId: string) => {
    try {
      const ok = await window.orchestra.openSelfTuneReport(loginId);
      if (!ok) void dialog.alert({ title: 'No report yet', message: 'This login has no insights report — run self-tune first.' });
    } catch (e) {
      void dialog.error('Could not open report', (e as Error).message);
    }
  };

  return (
    <div className="insights-view">
      <div className="insights-view-header">
        <span className="insights-view-icon" aria-hidden="true">
          <SparkleIcon size={16} />
        </span>
        <div className="insights-view-titles">
          <h2>Insights &amp; Improvements</h2>
          <div className="insights-view-sub">
            Monthly self-tune: regenerate each login&apos;s Claude Code insights report, then distill new friction lessons into ~/.claude/LESSONS.md
          </div>
        </div>
        <button
          className="primary insights-run-btn"
          onClick={() => void onRunNow()}
          disabled={!!running || starting}
          title={running ? 'A run is already in progress' : 'Run the self-tune pipeline now'}
        >
          {running ? 'Running…' : 'Run now'}
        </button>
        <button
          className="insights-close"
          onClick={() => setInsightsOpen(false)}
          title="Close"
          aria-label="Close Insights"
        >
          ×
        </button>
      </div>

      <div className="insights-view-body">
        {shownRun ? (
          <section className="insights-panel">
            <div className="insights-panel-title">
              {shownRun.status === 'running' ? 'Current run' : 'Last run'}
              <span className="insights-panel-meta">
                {fmtDay(shownRun.startedAt)} {fmtTime(shownRun.startedAt)} · {shownRun.trigger}
                {shownRun.finishedAt ? ` · ${fmtDuration(shownRun.startedAt, shownRun.finishedAt)}` : ''}
              </span>
            </div>
            <div className="insights-steps insights-steps-pane">
              {shownRun.steps.map((step) => (
                <div key={step.id} className="insights-step">
                  <StepStatusIcon status={step.status} />
                  <span className="insights-step-label">
                    {step.kind === 'fold' ? 'fold lessons' : `/insights — ${step.label}`}
                  </span>
                  <span className="insights-step-meta">
                    {step.startedAt && step.finishedAt && fmtDuration(step.startedAt, step.finishedAt)}
                    {step.status === 'failed' && step.exitCode !== undefined && step.exitCode !== 0
                      ? ` · exit ${step.exitCode}`
                      : ''}
                    {step.error ? ` · ${step.error}` : ''}
                  </span>
                </div>
              ))}
            </div>
            {shownRun.lessons && (shownRun.lessons.added.length > 0 || shownRun.lessons.removed.length > 0) && (
              <div className="insights-diff">
                <div className="insights-diff-title">LESSONS.md changes</div>
                {shownRun.lessons.added.map((b) => (
                  <div key={`+${b}`} className="insights-diff-line added">
                    <span className="insights-diff-sign" aria-label="Added">+</span>
                    <span>{b}</span>
                  </div>
                ))}
                {shownRun.lessons.removed.map((b) => (
                  <div key={`-${b}`} className="insights-diff-line removed">
                    <span className="insights-diff-sign" aria-label="Removed">−</span>
                    <span>{b}</span>
                  </div>
                ))}
              </div>
            )}
            <pre className="insights-transcript" ref={transcriptRef}>
              {transcript || (shownRun.status === 'running' ? 'Waiting for output…' : 'No transcript available for this run.')}
            </pre>
          </section>
        ) : (
          <section className="insights-panel">
            <div className="insights-panel-title">No runs yet</div>
            <div className="insights-empty-hint">
              The pipeline runs automatically once per calendar month — or start one with &ldquo;Run now&rdquo;.
            </div>
          </section>
        )}

        <section className="insights-panel">
          <div className="insights-panel-title">Reports</div>
          <div className="insights-reports">
            {reports.map((r) => (
              <button
                key={r.loginId}
                className="insights-report-btn"
                onClick={() => void onOpenReport(r.loginId)}
                disabled={!r.reportPath}
                title={r.reportPath ?? 'No report generated yet for this login'}
              >
                {r.label}
                <span className="insights-report-open">{r.reportPath ? 'open ↗' : 'no report'}</span>
              </button>
            ))}
            {reports.length === 0 && <div className="insights-empty-hint">No logins found.</div>}
          </div>
        </section>

        {runs.length > 1 && (
          <section className="insights-panel">
            <div className="insights-panel-title">History</div>
            <div className="insights-history">
              {runs.map((r) => (
                <button
                  key={r.id}
                  className={`insights-history-row ${r.id === shownRun?.id ? 'selected' : ''}`}
                  onClick={() => setPickedRunId(r.id)}
                  title="Show this run's transcript"
                >
                  <span className={`insights-history-status ${r.status}`} aria-hidden="true" />
                  <span className="insights-history-when">
                    {fmtDay(r.startedAt)} {fmtTime(r.startedAt)}
                  </span>
                  <span className="insights-history-trigger">{r.trigger}</span>
                  <span className="insights-history-summary">
                    {r.status === 'running' ? 'running…' : r.status === 'failed' ? 'failed' : r.summary ?? 'completed'}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="insights-panel">
          <div className="insights-panel-title">
            LESSONS.md
            <span className="insights-panel-meta">
              ~/.claude/LESSONS.md · {lessonCount} lesson{lessonCount === 1 ? '' : 's'}
              {latestDiff && latestDiff.added.length > 0
                ? ` · ${latestDiff.added.length} new since the last run`
                : ''}
              {' · @-imported into every session'}
            </span>
          </div>
          <pre className="insights-lessons">
            {lessons
              ? lessons.split('\n').map((line, i) => {
                  const t = line.trim();
                  const isNew = t.startsWith('- ') && newLessons.has(t.slice(2).trim());
                  return isNew ? (
                    <span key={i} className="insights-lesson-new">{`${line}\n`}</span>
                  ) : (
                    `${line}\n`
                  );
                })
              : 'No LESSONS.md found.'}
          </pre>
        </section>
      </div>
    </div>
  );
}

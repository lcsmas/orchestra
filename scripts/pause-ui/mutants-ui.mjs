// In-place mutants of the fleet-Pause UI components (#257) — same schema as scripts/pause-ui/mutate-unit.mjs; loaded by it. `tests` may name a `*-render-smoke.mjs` (run on its own, its `  FAIL <label>` lines are the red arms).
const ROW = 'src/renderer/components/pause/PauseRow.tsx', BUS = 'src/renderer/components/pause/BusPauseSection.tsx', ACT = 'src/renderer/components/pause/pause-actions.ts', BLK = 'src/renderer/components/pause/PauseBlocks.tsx';
const VIEW = 'src/shared/pause-ui-view.ts', SB = 'src/renderer/components/Sidebar.tsx', APP = 'src/renderer/App.tsx', STORE = 'src/renderer/store.ts';
const SHARED = 'src/shared/pause-ui.test.ts';
const SMOKE = 'scripts/pause-ui-render-smoke.mjs', WIRING = 'src/main/pause-ui-wiring.test.ts', VT = 'src/shared/pause-ui-view.test.ts';

export const MUTANTS = [
  // ── row parts
  { id: 'row-no-glyph-swap', file: ROW, find: 'return st ? <PauseGlyph wsId={wsId} ui={st.ui} /> : <>{children}</>;', rep: 'return <>{children}</>;', tests: [SMOKE], expect: /a member under the pause: its badge/ },
  { id: 'row-badge-for-everyone', file: ROW, find: 'return st ? <PauseBadge wsId={wsId} ui={st.ui} /> : null;', rep: "return <PauseBadge wsId={wsId} ui={st?.ui ?? 'paused'} />;", tests: [SMOKE], expect: /nothing paused: badge|NOT under the pause/ },
  { id: 'row-note-for-closed-reprise', file: ROW, find: "return run && run.phase !== 'active' ? <NoteLine wsId={wsId} /> : <>{children}</>;", rep: 'return run ? <NoteLine wsId={wsId} /> : <>{children}</>;', tests: [SMOKE], expect: /CLOSED Reprise/ },
  { id: 'row-bar-for-closed-reprise', file: ROW, find: "  if (!run || run.phase === 'active') return null;\n  const n = rowNoteText(run, now);\n  return (\n    <div className=\"pause-rowbar\">", rep: "  if (!run) return null;\n  const n = rowNoteText(run, now);\n  return (\n    <div className=\"pause-rowbar\">", tests: [SMOKE], expect: /CLOSED Reprise/ },
  { id: 'row-pausing-no-hard-button', file: ROW, find: "      btns.push({ kind: 'hard', title: 'Pause dure maintenant', tone: 'warn', icon: 'stop', onClick: () => void runPause(wsId, 'hard', rect) });\n", rep: '', tests: [SMOKE], expect: /hover actions follow the phase/ },
  { id: 'row-covered-no-resume', file: ROW, find: '    } else if (ctl.coveredBy) {', rep: '    } else if (false) {', tests: [SMOKE], expect: /hover actions follow the phase/ },
  { id: 'row-worker-under-pause-offered', file: ROW, find: '  } else if (!under) {', rep: '  } else {', tests: [SMOKE], expect: /a WORKER row not under a pause/ },
  { id: 'row-worker-no-button', file: ROW, find: '  } else if (!under) {', rep: '  } else if (false) {', tests: [SMOKE], expect: /a WORKER row not under a pause/ },
  { id: 'row-release-all-hidden', file: ROW, find: 'if (run && sc.own.length + sc.below.length > 0) {', rep: 'if (false) {', tests: [SMOKE], expect: /hover actions follow the phase/ },
  { id: 'row-release-tooltip-count', file: ROW, find: 'title: releaseLabel(sc)', rep: "title: 'Libérer les bloqués'", tests: [SMOKE], expect: /release-all names ITS scope/ },
  // ── click handlers
  { id: 'act-release-all-sends-explicit-ids', file: ACT, find: "useStore.getState().pauseRelease(wsId, 'all', run.carrierRunId)", rep: 'useStore.getState().pauseRelease(wsId, releasableIds(run), run.carrierRunId)', tests: [SMOKE], expect: /« Libérer tout » sends 'all'/ },
  { id: 'act-release-no-carrier', file: ACT, find: "useStore.getState().pauseRelease(wsId, 'all', run.carrierRunId)", rep: "useStore.getState().pauseRelease(wsId, 'all', null)", tests: [SMOKE], expect: /« Libérer tout » sends 'all'/ },
  { id: 'act-second-gesture-sends-all', file: ACT, find: 'useStore.getState().pauseRelease(wsId, ids.slice(), carrierRunId)', rep: "useStore.getState().pauseRelease(wsId, 'all', carrierRunId)", tests: [SMOKE], expect: /second gesture/ },
  { id: 'act-refusal-swallowed', file: ACT, find: '  if (anchor) show({ kind: \'explain\', wsId, anchor, explains, codes });', rep: '  if (false && anchor) show({ kind: \'explain\', wsId, anchor, explains, codes });', tests: [SMOKE], expect: /refusal comes back EXPLAINED/ },
  { id: 'act-success-keeps-panel', file: ACT, find: '  if (explains.length === 0) { close(); return []; }', rep: '  if (explains.length === 0) { return []; }', tests: [SMOKE], expect: /a success closes the panel/ },
  { id: 'act-anchorless-opens-panel', file: ACT, find: '  if (anchor) show({ kind: \'explain\', wsId, anchor, explains, codes });', rep: "  show({ kind: 'explain', wsId, anchor: anchor as never, explains, codes });", tests: [SMOKE], expect: /Bus-page click/ },
  { id: 'act-pause-mode-dropped', file: ACT, find: 'await useStore.getState().pausePause(wsId, mode);', rep: "await useStore.getState().pausePause(wsId, 'hard');", tests: [SMOKE], expect: /refusal comes back EXPLAINED/ },
  // ── Bus section
  { id: 'bus-shows-when-bus-down', file: BUS, find: 'if (!o.available) return <section className="bus-section" data-section="pause"><h3>Pause de flotte</h3><PauseUnreadable error={o.error} /></section>;', rep: 'if (!o.available) return null;', tests: [SMOKE], expect: /overview UNREADABLE: the Bus section/ },
  { id: 'bus-release-on-every-row', file: BUS, find: "run.phase === 'resuming' && m.ui === 'blocked' ? (", rep: "run.phase === 'resuming' ? (", tests: [SMOKE], expect: /Reprise: "N\/M repris"/ },
  { id: 'bus-closed-reprise-has-actions', file: BUS, find: "{run.phase === 'paused' && <PauseActionButton kind=\"resume\"", rep: "{(run.phase === 'paused' || run.phase === 'active') && <PauseActionButton kind=\"resume\"", tests: [SMOKE], expect: /closed Reprise still collecting/ },
  { id: 'bus-missing-hidden', file: BUS, find: "{run.progress.missing.length > 0 && (run.phase === 'pausing' || run.phase === 'paused') && ", rep: '{false && ', tests: [SMOKE], expect: /douce waiting/ },
  { id: 'bus-bilan-without-escalade-note', file: BUS, find: "missing === 'pending' ? \"après l'escalade\" : '—'}", rep: "missing === 'pending' ? '' : '—'}", tests: [SMOKE], expect: /douce waiting/ },
  // ── building blocks
  { id: 'blk-blocked-not-dim', file: BLK, find: "${ui === 'blocked' ? ' is-blocked' : ''}", rep: '', tests: [SMOKE], expect: /blocked badge carries is-blocked/ },
  { id: 'blk-bar-unclamped', file: BLK, find: 'Math.round(Math.max(0, Math.min(1, fraction)) * 100)', rep: 'Math.round(fraction * 100)', tests: [SMOKE], expect: /progress bar clamps/ },
  { id: 'blk-error-as-status', file: BLK, find: "role={explain.tone === 'error' ? 'alert' : 'status'}", rep: 'role="status"', tests: [SMOKE], expect: /refusal block/ },
  { id: 'blk-disabled-unexplained', file: BLK, find: 'title={disabled ? why : undefined}', rep: 'title={undefined}', tests: [SMOKE], expect: /disabled action is EXPLAINED/ },
  { id: 'blk-explain-fix-dropped', file: BLK, find: ') : explain.fix.length > 0 && (', rep: ') : false && (', tests: [SMOKE], expect: /refusal block/ },
  { id: 'blk-actions-as-bullets', file: BLK, find: 'explain.actions && explain.actions.length > 0 && onAction ? (', rep: 'false ? (', tests: [SMOKE], expect: /the ONE follow-up an explanation may carry/ },
  { id: 'blk-release-wrong-row', file: BLK, find: 'data-pause-fix="release" data-pause-for={a.wsId}', rep: 'data-pause-fix="release" data-pause-for="x"', tests: [SMOKE], expect: /the ONE follow-up an explanation may carry/ },
  { id: 'blk-action-ids-dropped', file: BLK, find: 'data-pause-ids={a.ids.join(\',\')}', rep: 'data-pause-ids=""', tests: [SMOKE], expect: /the ONE follow-up an explanation may carry/ },
  { id: 'bus-manquent-in-reprise', file: BUS, find: "(run.phase === 'pausing' || run.phase === 'paused') && ", rep: "run.phase !== 'active' && ", tests: [SMOKE], expect: /Reprise: "N\/M repris"/ },
  { id: 'act-double-click-sends-twice', file: ACT, find: '  if (inflight.has(key)) return fallback;', rep: '', tests: [SMOKE], expect: /double-click sends ONE write/ },
  { id: 'act-ipc-failure-unhandled', file: ACT, find: "return report(wsId, anchor, [ipcFailure(e)], ['ipc-failed']);\n    }\n  });\n}\n\nexport async function runResume", rep: "throw e;\n    }\n  });\n}\n\nexport async function runResume", tests: [SMOKE], expect: /a rejected invoke is EXPLAINED too for a pause/ },
  { id: 'act-resume-ipc-failure-unhandled', file: ACT, find: "pauseResume(wsId);\n      return report(wsId, anchor, res.explain ? [res.explain] : [], [res.outcome]);\n    } catch (e) {\n      return report(wsId, anchor, [ipcFailure(e)], ['ipc-failed']);", rep: "pauseResume(wsId);\n      return report(wsId, anchor, res.explain ? [res.explain] : [], [res.outcome]);\n    } catch (e) {\n      throw e;", tests: [SMOKE], expect: /a rejected invoke is EXPLAINED \("La commande/ },
  { id: 'bus-detail-rows-dropped', file: BUS, find: '{hasDetail && (', rep: '{false && (', tests: [SMOKE], expect: /a member with a problem SHOWS it/ },
  { id: 'bus-killed-not-listed', file: BUS, find: 'const killed = b ? b.killed.slice(0, 4) : [];', rep: 'const killed: never[] = [];', tests: [SMOKE], expect: /what it was doing and what was killed/ },
  { id: 'menu-escape-bubbles', file: 'src/renderer/components/pause/PauseMenu.tsx', find: 'e.stopImmediatePropagation(); ', rep: '', tests: [WIRING], expect: /Escape closes the PANEL only/ },
  { id: 'menu-escape-not-capture', file: 'src/renderer/components/pause/PauseMenu.tsx', find: "window.addEventListener('keydown', onKey, true);", rep: "window.addEventListener('keydown', onKey);", tests: [WIRING], expect: /Escape closes the PANEL only/ },
  { id: 'bus-release-label-counts-all', file: 'src/shared/pause-ui-view.ts', find: "  const n = sc.own.length;\n  const m = sc.below.length;", rep: "  const n = sc.own.length + sc.below.length;\n  const m = 0;", tests: [VT], expect: /releaseLabel/ },
  // ── pure view helpers
  { id: 'view-releasable-includes-released', file: VIEW, find: "return run.members.filter((m) => m.ui === 'blocked').map((m) => m.wsId);", rep: "return run.members.filter((m) => m.ui !== 'resumed').map((m) => m.wsId);", tests: [VT], expect: /groupByMemberRun keeps/ },
  { id: 'view-countdown-negative', file: VIEW, find: 'const s = Math.max(0, Math.round((deadlineAt - now) / 1000));', rep: 'const s = Math.round((deadlineAt - now) / 1000);', tests: [VT], expect: /countdown \/ ago/ },
  { id: 'view-agents-counts-archived', file: VIEW, find: 'if (!w.archived && w.parentId)', rep: 'if (w.parentId)', tests: [VT], expect: /agentsUnder/ },
  { id: 'view-killed-pending-reads-none', file: VIEW, find: "  if (b.trap === 'pending') return 'trap en cours';\n", rep: '', tests: [VT], expect: /Bilan texts/ },
  { id: 'view-killed-survivors-hidden', file: VIEW, find: "  return n > 0 ? `${base} · ⚠ ${n} encore vivant${n > 1 ? 's' : ''}` : base;", rep: '  return base;', tests: [VT], expect: /Bilan texts/ },
  { id: 'view-attention-error-dropped', file: VIEW, find: "  else if (b.error) out.push({ tone: 'error', text: `erreur : ${b.error}` });", rep: '', tests: [VT], expect: /bilanAttention/ },
  { id: 'view-attention-survivor-dropped', file: VIEW, find: "  for (const x of b.survivors) out.push(", rep: "  for (const x of []) out.push(", tests: [VT], expect: /bilanAttention/ },
  { id: 'view-attention-interrupt-dropped', file: VIEW, find: "  if (b.interrupt === 'unresponsive' || b.interrupt === 'failed') out.push(", rep: "  if (false) out.push(", tests: [VT], expect: /bilanAttention/ },
  { id: 'view-nogit-error-red', file: VIEW, find: "  if (b.error && b.snapshotRef === null && /not a git repository/i.test(b.error)) out.push(", rep: "  if (false) out.push(", tests: [VT], expect: /bilanAttention/ },
  { id: 'bus-info-opens-detail', file: BUS, find: "attention.some((x) => x.tone !== 'info') || killed.length > 0 || doing !== null;", rep: 'attention.length > 0 || killed.length > 0 || doing !== null;', tests: [SMOKE], expect: /info-only lines do not open/ },
  { id: 'view-dim-for-released', file: VIEW, find: "return st && (st.ui === 'pausing' || st.ui === 'paused' || st.ui === 'blocked') ? ' pause-dim' : '';", rep: "return st ? ' pause-dim' : '';", tests: [VT], expect: /pauseDimClass/ },
  { id: 'view-paused-bar-always-full', file: VIEW, find: "title: pausePhaseWord('paused', run.mode), count, sub: `${by}${when}`, fraction };", rep: "title: pausePhaseWord('paused', run.mode), count, sub: `${by}${when}`, fraction: 1 };", tests: [VT], expect: /runHeadline/ },
  { id: 'view-blocked-green', file: VIEW, find: "return ui === 'pausing' ? 'pausing' : ui === 'paused' || ui === 'blocked' ? 'paused' : 'resumed';", rep: "return ui === 'pausing' ? 'pausing' : ui === 'paused' ? 'paused' : 'resumed';", tests: [VT], expect: /words and tones/ },
  { id: 'view-auto-owner-hidden', file: VIEW, find: "const by = run.auto ? 'posée par l\\'hôte (limite d\\'usage)'", rep: "const by = false ? 'posée par l\\'hôte (limite d\\'usage)'", tests: [VT], expect: /runHeadline/ },
  { id: 'view-douce-no-deadline', file: VIEW, find: "const left = run.deadlineAt !== null ? ` · dure dans ${countdown(run.deadlineAt, now)}` : '';", rep: "const left = '';", tests: [VT], expect: /rowNoteText/ },
  // ── wiring
  { id: 'sb-badge-missing-pinned-path', file: SB, find: '\n                <PauseRowBadge wsId={w.id} />\n                <HibernatedChip w={w} />', rep: '\n                <HibernatedChip w={w} />', tests: [WIRING], expect: /SIDEBAR: both row render paths/ },
  { id: 'sb-bar-missing-repo-path', file: SB, find: '                  <PauseRowBar wsId={w.id} />\n                </div>', rep: '                </div>', tests: [WIRING], expect: /SIDEBAR: both row render paths/ },
  { id: 'sb-menu-host-unmounted', file: SB, find: '      <PauseMenuHost />\n', rep: '', tests: [WIRING], expect: /SIDEBAR: both row render paths/ },
  { id: 'app-no-pause-slot', file: APP, find: '<BusPane pauseSlot={<BusPauseSection />} />', rep: '<BusPane />', tests: [WIRING], expect: /BUS PAGE/ },
  { id: 'store-push-merges', file: STORE, find: 'useStore.setState((st) => ({ pauseOverview: newerOverview(st.pauseOverview, overview) }));', rep: 'useStore.setState((s) => ({ pauseOverview: s.pauseOverview ?? overview }));', tests: [WIRING], expect: /RENDERER: the overview slice/ },
];

// the main-side clauses added by the pre-review (pause-ui.ts)
MUTANTS.push(
  { id: 'bilan-killed-read-as-array', file: 'src/main/pause-ui.ts', find: '  const merged = killedCommands({ snapshotRef: b.snapshotRef, dirty: b.dirty, killed: b.killed, error: b.error, activity: a });', rep: '  const merged = Array.isArray(b.killed) ? (b.killed as Array<{ cmd: string; cwd: string | null }>) : [];', tests: ['src/main/pause-ui.test.ts'], expect: /toBilanLine reads the REAL killed_json/ },
  { id: 'bilan-pending-reads-done', file: 'src/main/pause-ui.ts', find: "b.killed === null || b.killed === undefined ? 'pending' : report?.skipped ? 'skipped' : 'done'", rep: "report?.skipped ? 'skipped' : 'done'", tests: ['src/main/pause-ui.test.ts'], expect: /toBilanLine reads the REAL killed_json/ },
  { id: 'bilan-survivors-dropped', file: 'src/main/pause-ui.ts', find: 'survivors: (report?.survivors ?? []).slice(0, 6).map(', rep: 'survivors: ([] as Array<{ cmd?: string; pid?: number; reason?: string }>).slice(0, 6).map(', tests: ['src/main/pause-ui.test.ts'], expect: /toBilanLine reads the REAL killed_json/ },
  { id: 'origin-not-recorded', file: 'src/main/pause-ui.ts', find: '      if (made && made.pausedAt >= at) recordPauseOrigin(db, t.runId, made.pausedAt, []);', rep: '      void made;', tests: ['src/main/pause-ui.test.ts'], expect: /records an EMPTY origin/ },
  { id: 'pause-writer-throw-escapes', file: 'src/main/pause-ui.ts', find: '    return failed(db, deps, t.runId, actor, e);\n  }\n  return { outcome, runId: t.runId, actor, explain: explainPauseOutcome(', rep: '    throw e;\n  }\n  return { outcome, runId: t.runId, actor, explain: explainPauseOutcome(', tests: ['src/main/pause-ui.test.ts'], expect: /writer that THROWS/ },
  { id: 'release-writer-throw-escapes', file: 'src/main/pause-ui.ts', find: '    const f = failed(db, deps, t.runId, actor, e);\n    return { result: null,', rep: '    throw e;\n    const f = failed(db, deps, t.runId, actor, e);\n    return { result: null,', tests: ['src/main/pause-ui.test.ts'], expect: /writer that THROWS/ },
  { id: 'failed-ctx-throws-again', file: 'src/main/pause-ui.ts', find: '  } catch {\n    ctx = ctxStub(deps, actor);\n  }', rep: '  } catch (e2) {\n    throw e2;\n  }', tests: ['src/main/pause-ui.test.ts'], expect: /writer that THROWS/ },
  { id: 'fingerprint-misses-pause-auto', file: 'src/main/pause-ui.ts', find: "COALESCE(SUM(pause_auto IS NOT NULL),0) AS a, COALESCE(SUM(pause_mode = 'soft'),0) AS m,", rep: "COALESCE(SUM(pause_mode = 'soft'),0) AS m,", tests: ['src/main/pause-ui.test.ts'], expect: /pauseOverviewFingerprint/ },
  { id: 'fingerprint-misses-bilan-notes', file: 'src/main/pause-ui.ts', find: "COALESCE(SUM(length(coalesce(activity,''))),0) AS a, ", rep: '', tests: ['src/main/pause-ui.test.ts'], expect: /pauseOverviewFingerprint/ },
  { id: 'fingerprint-misses-roster-role', file: 'src/main/pause-ui.ts', find: "COALESCE(SUM(role = 'coordinator'),0) AS k,\n", rep: '\n', tests: ['src/main/pause-ui.test.ts'], expect: /pauseOverviewFingerprint/ },
  { id: 'fingerprint-misses-coordinator', file: 'src/main/pause-ui.ts', find: "COALESCE(group_concat(id || ':' || coordinator, ','),'') AS who", rep: "COALESCE(group_concat(id, ','),'') AS who", tests: ['src/main/pause-ui.test.ts'], expect: /pauseOverviewFingerprint/ },
  { id: 'fingerprint-thrashes-on-messages', file: 'src/main/pause-ui.ts', find: "const flags = one('SELECT COUNT(*) AS n, COALESCE(SUM(length(flags)),0) AS l FROM run_flags');", rep: "const flags = one('SELECT COUNT(*) AS n, COALESCE(SUM(length(flags)),0) AS l, (SELECT COUNT(*) FROM messages) AS msgs FROM run_flags');", tests: ['src/main/pause-ui.test.ts'], expect: /pauseOverviewFingerprint/ },
);

// the explainers' remedy buttons (shared, pure)
MUTANTS.push(
  { id: 'explain-covered-fix-wrong-run', file: 'src/shared/pause-ui.ts', find: "fix: [`Reprendre ${c.cover.label} (survol de sa ligne → ▶)`]", rep: "fix: [`Reprendre ${c.runLabel} (survol de sa ligne → ▶)`]", tests: [SHARED], expect: /explainResumeOutcome/ },
);

// ── fix round 1 (review R1-1..R1-8)
MUTANTS.push(
  // R1-1 the snapshot's gaps
  { id: 'bilan-notcaptured-dropped', file: 'src/main/pause-ui.ts', find: 'notCaptured: skippedLarge.slice(0, 6).map(', rep: 'notCaptured: ([] as typeof skippedLarge).slice(0, 6).map(', tests: ['src/main/pause-ui.test.ts'], expect: /did NOT capture/ },
  { id: 'bilan-notcaptured-count-capped', file: 'src/main/pause-ui.ts', find: 'notCapturedCount: a?.skippedLargeCount ?? skippedLarge.length,', rep: 'notCapturedCount: skippedLarge.length,', tests: ['src/main/pause-ui.test.ts'], expect: /did NOT capture/ },
  { id: 'bilan-notcaptured-smallest-first', file: 'src/main/pause-ui.ts', find: '.sort((x, y) => Number(y.bytes) - Number(x.bytes))', rep: '.sort((x, y) => Number(x.bytes) - Number(y.bytes))', tests: ['src/main/pause-ui.test.ts'], expect: /did NOT capture/ },
  { id: 'bilan-submodules-dropped', file: 'src/main/pause-ui.ts', find: 'submodules: (a?.submodules ?? []).slice(0, 6).map(', rep: 'submodules: ([] as NonNullable<typeof a>["submodules"] & unknown[]).slice(0, 6).map(', tests: ['src/main/pause-ui.test.ts'], expect: /did NOT capture/ },
  { id: 'bilan-snapshotnotes-dropped', file: 'src/main/pause-ui.ts', find: 'snapshotNotes: (a?.snapshotNotes ?? []).slice(0, NOTES_CAP).map(', rep: 'snapshotNotes: ([] as string[]).slice(0, NOTES_CAP).map(', tests: ['src/main/pause-ui.test.ts'], expect: /did NOT capture/ },
  { id: 'view-notcaptured-silent', file: 'src/shared/pause-ui-view.ts', find: '  if (b.notCapturedCount > 0) {', rep: '  if (false) {', tests: [VT], expect: /did NOT capture is SHOWN/ },
  { id: 'view-submodule-failure-silent', file: 'src/shared/pause-ui-view.ts', find: "    if (m.error) out.push({ tone: 'warn',", rep: "    if (false) out.push({ tone: 'warn',", tests: [VT], expect: /did NOT capture is SHOWN/ },
  { id: 'view-size-text-wrong-unit', file: 'src/shared/pause-ui-view.ts', find: "return mo >= 1024 ? `${f(mo / 1024)} Go` : `${f(mo)} Mo`;", rep: 'return `${f(mo)} Mo`;', tests: [VT], expect: /sizeText|did NOT capture/ },
  { id: 'bus-notcaptured-not-rendered', file: BUS, find: "const attention = memberAttention(b, run);", rep: "const attention = memberAttention(b, run).filter((x) => !x.text.startsWith('NON capturé'));", tests: [SMOKE], expect: /a member with a problem SHOWS it/ },
  // R1-6 control / bidi
  { id: 'bilan-control-chars-kept', file: 'src/main/pause-ui.ts', find: '  const t = stripControl(v);', rep: '  const t = String(v);', tests: ['src/main/pause-ui.test.ts'], expect: /strips control/ },
  { id: 'bilan-branch-unclean', file: 'src/main/pause-ui.ts', find: '    branch: clOrNull(a?.branch, 200),', rep: '    branch: a?.branch ?? null,', tests: ['src/main/pause-ui.test.ts'], expect: /strips control/ },
  { id: 'bilan-submodule-path-unclean', file: 'src/main/pause-ui.ts', find: "submodules: (a?.submodules ?? []).slice(0, 6).map((m) => ({ path: cl(m.path, 300),", rep: "submodules: (a?.submodules ?? []).slice(0, 6).map((m) => ({ path: m.path,", tests: ['src/main/pause-ui.test.ts'], expect: /strips control/ },
  { id: 'bilan-survivor-reason-unclean', file: 'src/main/pause-ui.ts', find: "survivors: (report?.survivors ?? []).slice(0, 6).map((x) => ({ cmd: cl(x.cmd, 200), pid: Number(x.pid ?? 0), reason: cl(x.reason, 200) })),", rep: "survivors: (report?.survivors ?? []).slice(0, 6).map((x) => ({ cmd: cl(x.cmd, 200), pid: Number(x.pid ?? 0), reason: String(x.reason ?? '') })),", tests: ['src/main/pause-ui.test.ts'], expect: /strips control/ },
  // R1-3 hold
  { id: 'resume-hold-not-lifted', file: 'src/main/pause-ui.ts', find: "    holdLifted = setRunHold(db, t.runId, false, actor, { human: true }) === 'resumed';", rep: '    holdLifted = false;', tests: ['src/main/pause-ui.test.ts'], expect: /uiResume = `orchestra run resume`/ },
  { id: 'resume-hold-human-option-dropped', file: 'src/main/pause-ui.ts', find: "    holdLifted = setRunHold(db, t.runId, false, actor, { human: true }) === 'resumed';", rep: "    holdLifted = setRunHold(db, t.runId, false, actor) === 'resumed';", tests: ['src/main/pause-ui.test.ts'], expect: /uiResume = `orchestra run resume`/ },
  // R1-4 run anchors
  { id: 'controls-only-orchestrators', file: 'src/main/pause-ui.ts', find: '      if (!nodeOrchestrates(ws) && !ownsRun) continue;', rep: '      if (!nodeOrchestrates(ws)) continue;', tests: ['src/main/pause-ui.test.ts'], expect: /PLAIN run-anchoring parent/ },
  // R1-2 « tout libérer »
  { id: 'explain-below-no-second-gesture', file: 'src/shared/pause-ui.ts', find: "      ...(c.actorId && c.carrierRunId\n        ? {", rep: "      ...(false\n        ? {", tests: [SHARED], expect: /explainReleaseResult/ },
  { id: 'release-ctx-ids-dropped', file: 'src/main/pause-ui.ts', find: 'actorId: req.wsId, carrierRunId: carrier ?? t.runId, all: req.targets', rep: 'all: req.targets', tests: ['src/main/pause-ui.test.ts'], expect: /« Libérer tout » = `release --all`/ },
  { id: 'view-release-scope-all-own', file: VIEW, find: "    if (m.role === 'worker' && m.memberRun !== null && m.memberRun !== run.carrierRunId) below.push(m.wsId);\n    else own.push(m.wsId);", rep: '    own.push(m.wsId);', tests: [VT], expect: /releaseScope/ },
  // R1-7 no remedy shortcut
  // R1-8 empty roster
  { id: 'view-empty-roster-full-bar', file: VIEW, find: '  const count = total === 0 && run.phase !== \'active\' ?', rep: '  const count = false ?', tests: [VT], expect: /EMPTY roster/ },
  { id: 'view-note-empty-roster-count', file: VIEW, find: "  if (total === 0 && run.phase !== 'active') {\n    const word", rep: "  if (false) {\n    const word", tests: [VT], expect: /EMPTY roster/ },
  // R1-5 coalescer
  { id: 'coalesce-no-maxwait', file: 'src/main/pause-ui-coalesce.ts', find: 'const wait = Math.max(0, Math.min(opts.debounceMs, pendingSince + opts.maxWaitMs - now));', rep: 'const wait = opts.debounceMs;', tests: ['src/main/pause-ui-coalesce.test.ts'], expect: /SUSTAINED writes/ },
  { id: 'coalesce-pending-since-reset', file: 'src/main/pause-ui-coalesce.ts', find: '      if (timer === null) pendingSince = now;\n      else deps.clearTimer(timer);', rep: '      pendingSince = now;\n      if (timer !== null) deps.clearTimer(timer);', tests: ['src/main/pause-ui-coalesce.test.ts'], expect: /SUSTAINED writes/ },
  { id: 'coalesce-cancel-ignored', file: 'src/main/pause-ui-coalesce.ts', find: "      if (timer !== null) deps.clearTimer(timer);\n      timer = null;\n      pendingSince = 0;\n    },", rep: '      timer = timer;\n    },', tests: ['src/main/pause-ui-coalesce.test.ts'], expect: /burst that ENDS/ },
  { id: 'host-watch-bypasses-coalescer', file: 'src/main/pause-ui-host.ts', find: '      coalescer.poke();', rep: '      broadcastPauseOverview();', tests: [WIRING], expect: /max-wait coalescer/ },
  { id: 'host-maxwait-removed', file: 'src/main/pause-ui-host.ts', find: 'maxWaitMs: WATCH_MAX_WAIT_MS', rep: 'maxWaitMs: 1_000_000', tests: [WIRING], expect: /max-wait coalescer/ },
);

// ── fix round 1b (pre-review R1b-1..4 + minors)
MUTANTS.push(
  // R1b-1 an unreadable overview is said out loud
  { id: 'sidebar-strip-removed', file: SB, find: '      <PauseUnreadableStrip />\n      <div className="sidebar-footer">', rep: '      <div className="sidebar-footer">', tests: [WIRING], expect: /UNREADABLE overview is said out loud/ },
  { id: 'strip-always-shown', file: ROW, find: 'return o && !o.available ? <PauseUnreadable error={o.error} /> : null;', rep: 'return o ? <PauseUnreadable error={o.error} /> : null;', tests: [SMOKE, WIRING], expect: /READABLE overview shows no unreadable strip|UNREADABLE overview is said out loud/ },
  { id: 'strip-never-shown', file: ROW, find: 'return o && !o.available ? <PauseUnreadable error={o.error} /> : null;', rep: 'return null;', tests: [SMOKE], expect: /overview UNREADABLE: the sidebar strip/ },
  { id: 'strip-drops-reason', file: BLK, find: "{error ?? ''}</span>", rep: '</span>', tests: [SMOKE], expect: /overview UNREADABLE/ },
  // R1b-3 a member with no Bilan row, past the trap
  { id: 'bus-absent-no-warn', file: BUS, find: 'const attention = memberAttention(b, run);', rep: 'const attention = b ? memberAttention(b, run) : [];', tests: [SMOKE], expect: /no Bilan row once the trap is DONE/ },
  { id: 'bus-absent-shows-pending', file: BUS, find: "{b ? killedText(b) : missing === 'absent' ? 'aucun Bilan' : missing === 'pending' ? \"après l'escalade\" : '—'}", rep: "{b ? killedText(b) : \"après l'escalade\"}", tests: [SMOKE], expect: /no Bilan row once the trap is DONE/ },
  { id: 'bus-pending-shows-absent', file: BUS, find: "missing === 'absent' ? 'aucun Bilan' : missing === 'pending' ? \"après l'escalade\" : '—'}", rep: "'aucun Bilan'}", tests: [SMOKE], expect: /no Bilan row while the trap is still owed/ },
  { id: 'view-nobilan-always-pending', file: VIEW, find: "  if (run.trapAt !== null) return 'absent';", rep: "  if (false) return 'absent';", tests: [VT], expect: /noBilanState/ },
  { id: 'view-member-attention-silent', file: VIEW, find: "  return noBilanState(run) === 'absent' ? [{ tone: 'warn'", rep: "  return false ? [{ tone: 'warn'", tests: [VT], expect: /noBilanState/ },
  // R1b-2 a write reply racing a fresher push
  { id: 'view-newer-always-next', file: VIEW, find: 'next.rev < cur.rev ? cur : next;', rep: 'false ? cur : next;', tests: [VT], expect: /newerOverview/ },
  { id: 'view-newer-drops-equal', file: VIEW, find: 'next.rev < cur.rev ? cur : next;', rep: 'next.rev <= cur.rev ? cur : next;', tests: [VT], expect: /newerOverview/ },
  { id: 'view-newer-unstamped-loses', file: VIEW, find: 'cur.rev !== undefined && next.rev !== undefined && next.rev < cur.rev', rep: 'cur.rev !== undefined && (next.rev === undefined || next.rev < cur.rev)', tests: [VT], expect: /newerOverview/ },
  { id: 'host-reply-not-pushed', file: 'src/main/pause-ui-host.ts', find: 'return pushed ? { ...res, overview: pushed } : res;', rep: 'return res;', tests: [WIRING], expect: /OLDER than the push/ },
  { id: 'host-no-rev-stamp', file: 'src/main/pause-ui-host.ts', find: 'rev: ++overviewRev', rep: 'rev: overviewRev', tests: [WIRING], expect: /OLDER than the push/ },
  { id: 'host-boot-read-unstamped', file: 'src/main/pause-ui-host.ts', find: "(): PauseUiOverview => stamped(readPauseOverview(getBus(), realPauseUiDeps())));", rep: "(): PauseUiOverview => readPauseOverview(getBus(), realPauseUiDeps()));", tests: [WIRING], expect: /OLDER than the push/ },
  { id: 'host-release-bypasses-afterwrite', file: 'src/main/pause-ui-host.ts', find: "released ${res.result?.released.length ?? 0}`);\n    return afterWrite(res);", rep: "released ${res.result?.released.length ?? 0}`);\n    return res;", tests: [WIRING], expect: /OLDER than the push|every write re-publishes/ },
  { id: 'store-load-overwrites', file: STORE, find: 'pauseOverview: pauseOverview ? newerOverview(get().pauseOverview, pauseOverview) : pauseOverview,', rep: 'pauseOverview,', tests: [WIRING], expect: /OLDER than the push/ },
  { id: 'store-resume-overwrites', file: STORE, find: "    const res = await window.orchestra.pauseResume(wsId);\n    set((st) => ({ pauseOverview: newerOverview(st.pauseOverview, res.overview) }));", rep: "    const res = await window.orchestra.pauseResume(wsId);\n    set({ pauseOverview: res.overview });", tests: [WIRING], expect: /OLDER than the push|RENDERER: the overview slice/ },
  // minors fixed with it
  { id: 'host-clock-wall', file: 'src/main/pause-ui-host.ts', find: 'now: () => performance.now()', rep: 'now: () => Date.now()', tests: [WIRING], expect: /MONOTONIC/ },
  { id: 'host-mode-defaults-hard', file: 'src/main/pause-ui-host.ts', find: "{ wsId: String(wsId ?? ''), mode });\n    log.info(`pause-ui: pause", rep: "{ wsId: String(wsId ?? ''), mode: mode === 'soft' ? 'soft' : 'hard' });\n    log.info(`pause-ui: pause", tests: [WIRING], expect: /OLDER than the push/ },
  { id: 'mode-validation-removed', file: 'src/main/pause-ui.ts', find: "if (req.mode !== 'soft' && req.mode !== 'hard') return failed(", rep: "if (false) return failed(", tests: ['src/main/pause-ui.test.ts'], expect: /UNKNOWN pause mode/ },
  { id: 'mode-validation-lets-empty', file: 'src/main/pause-ui.ts', find: "if (req.mode !== 'soft' && req.mode !== 'hard') return failed(", rep: "if (req.mode !== 'soft' && req.mode !== 'hard' && req.mode !== undefined && String(req.mode) !== '') return failed(", tests: ['src/main/pause-ui.test.ts'], expect: /UNKNOWN pause mode/ },
  { id: 'menu-no-epoch-close', file: 'src/renderer/components/pause/PauseMenu.tsx', find: 'if (seen.current.epoch !== epoch) { seen.current = null; close(); }', rep: 'if (false) { seen.current = null; close(); }', tests: [WIRING], expect: /closed when its Reprise epoch changes/ },
  // R1b-4 labels + format controls
  { id: 'label-unsanitized', file: 'src/main/pause-ui.ts', find: 'cl(deps.labelOf(id) ?? short(id), 160);', rep: '(deps.labelOf(id) ?? short(id));', tests: ['src/main/pause-ui.test.ts'], expect: /LABELS are sanitized/ },
  { id: 'label-not-kept', file: 'src/main/pause-ui.ts', find: 'cl(deps.labelOf(id) ?? short(id), 160);', rep: "cl(deps.labelOf(id) ?? short(id), 160).replace(/[a-z]/g, '');", tests: ['src/main/pause-ui.test.ts'], expect: /LABELS are sanitized/ },
  { id: 'strip-206f-missing', file: 'src/shared/pause-consigne.ts', find: '[0x2060, 0x206f],', rep: '[0x2060, 0x2064], [0x2066, 0x2069],', tests: ['src/main/pause-ui.test.ts'], expect: /LABELS are sanitized|strips control/ },
);

// ── follow-up r2 (review round 2: R2-1..R2-4)
MUTANTS.push(
  // R2-1 a lifted hold is said
  { id: 'explain-hold-not-named', file: 'src/shared/pause-ui.ts', find: 'if (!base || !c.holdLifted) return base;', rep: 'return base;', tests: [SHARED], expect: /names a lifted liveness HOLD/ },
  { id: 'explain-hold-always-named', file: 'src/shared/pause-ui.ts', find: 'if (!base || !c.holdLifted) return base;', rep: 'if (!base) return base;', tests: [SHARED], expect: /names a lifted liveness HOLD/ },
  { id: 'explain-hold-wrong-run', file: 'src/shared/pause-ui.ts', find: 'Le hold de liveness de ${c.runLabel} a quand même été levé', rep: 'Le hold de liveness de ${c.actorLabel} a quand même été levé', tests: [SHARED], expect: /names a lifted liveness HOLD/ },
  { id: 'resume-hold-not-passed-to-explain', file: 'src/main/pause-ui.ts', find: '{ ...ctxFor(db, deps, t.runId, req.wsId, cover), holdLifted }', rep: 'ctxFor(db, deps, t.runId, req.wsId, cover)', tests: ['src/main/pause-ui.test.ts'], expect: /R2-1/ },
  // R2-2 a cancelled douce raises no alarm
  { id: 'view-nobilan-trap-ignored-in-resuming', file: VIEW, find: "  if (run.trapAt !== null) return 'absent';", rep: "  if (run.trapAt !== null && run.phase !== 'resuming') return 'absent';", tests: [VT], expect: /noBilanState/ },
  { id: 'bus-none-shows-absent', file: BUS, find: "<td>{b ? treeText(b) : missing === 'absent' ? 'aucun Bilan' : '—'}</td>", rep: "<td>{b ? treeText(b) : 'aucun Bilan'}</td>", tests: [SMOKE], expect: /CANCELLED before it escalated/ },
  { id: 'bus-none-cell-absent', file: BUS, find: "missing === 'pending' ? \"après l'escalade\" : '—'}</td>", rep: "missing === 'pending' ? \"après l'escalade\" : 'aucun Bilan'}</td>", tests: [SMOKE], expect: /CANCELLED before it escalated/ },
  // R2-3 « tout libérer » is pinned in the release gate (`pnpm test`)
  { id: 'act-release-all-explicit-ids-in-gate', file: ACT, find: "useStore.getState().pauseRelease(wsId, 'all', run.carrierRunId)", rep: 'useStore.getState().pauseRelease(wsId, releasableIds(run), run.carrierRunId)', tests: [WIRING], expect: /pinned in the RELEASE gate/ },
  { id: 'act-release-all-no-carrier-in-gate', file: ACT, find: "useStore.getState().pauseRelease(wsId, 'all', run.carrierRunId)", rep: "useStore.getState().pauseRelease(wsId, 'all', null)", tests: [WIRING], expect: /pinned in the RELEASE gate/ },
  { id: 'act-many-sends-all-in-gate', file: ACT, find: 'useStore.getState().pauseRelease(wsId, ids.slice(), carrierRunId)', rep: "useStore.getState().pauseRelease(wsId, 'all', carrierRunId)", tests: [WIRING], expect: /pinned in the RELEASE gate/ },
  { id: 'host-expands-all', file: 'src/main/pause-ui-host.ts', find: "targets: targets === 'all' ? 'all' :", rep: "targets: targets === 'ALL' ? 'all' :", tests: [WIRING], expect: /pinned in the RELEASE gate/ },
  { id: 'row-release-all-not-all', file: ROW, find: 'runReleaseAll(wsId, run, rect)', rep: 'runReleaseMany(wsId, releasableIds(run), run.carrierRunId, rect)', tests: [WIRING], expect: /pinned in the RELEASE gate/ },
  // R2-4 a child of a plain run-anchoring parent is explained against that parent
  { id: 'nearest-run-ignores-anchors', file: 'src/main/pause-ui.ts', find: 'if ((cur.id === ws.id || usable(cur.id)) && (nodeOrchestrates(cur) || anchors(cur.id))) return cur.id;', rep: 'if ((cur.id === ws.id || usable(cur.id)) && nodeOrchestrates(cur)) return cur.id;', tests: ['src/main/pause-ui.test.ts'], expect: /R2-4/ },
  { id: 'nearest-run-no-walk', file: 'src/main/pause-ui.ts', find: 'const parent = deps.getWorkspace(cur.parentId);', rep: 'const parent = undefined as WaveNode | undefined;', tests: ['src/main/pause-ui.test.ts'], expect: /R2-4/ },
  { id: 'nearest-run-anchor-over-orchestrator', file: 'src/main/pause-ui.ts', find: 'if ((cur.id === ws.id || usable(cur.id)) && (nodeOrchestrates(cur) || anchors(cur.id))) return cur.id;', rep: 'if ((cur.id === ws.id || usable(cur.id)) && anchors(cur.id)) return cur.id;', tests: ['src/main/pause-ui.test.ts'], expect: /R2-4/ },
);

// ── follow-up r2, after the pre-review (R2-2 hard trap that never finished, covered-hold wording, archived anchor)
MUTANTS.push(
  { id: 'view-nobilan-paused-not-pending', file: VIEW, find: "if (run.phase === 'pausing' || run.phase === 'paused') return 'pending';", rep: "if (false) return 'pending';", tests: [VT], expect: /noBilanState/ },
  { id: 'view-nobilan-active-absent', file: VIEW, find: "if (run.phase === 'active') return 'none';", rep: "if (false) return 'none';", tests: [VT], expect: /noBilanState/ },
  { id: 'view-nobilan-hard-unfinished-none', file: VIEW, find: "run.mode !== 'soft' || run.escalatedAt !== null ? 'absent' : 'none'", rep: "run.escalatedAt !== null ? 'absent' : 'none'", tests: [VT, SMOKE], expect: /noBilanState|a dure whose trap never finished/ },
  { id: 'view-nobilan-escalated-douce-none', file: VIEW, find: "run.mode !== 'soft' || run.escalatedAt !== null ? 'absent' : 'none'", rep: "run.mode !== 'soft' ? 'absent' : 'none'", tests: [VT], expect: /noBilanState/ },
  { id: 'view-nobilan-cancelled-douce-absent', file: VIEW, find: "run.mode !== 'soft' || run.escalatedAt !== null ? 'absent' : 'none'", rep: "'absent'", tests: [VT, SMOKE], expect: /noBilanState|CANCELLED before it escalated/ },
  { id: 'explain-hold-covered-wrong', file: 'src/shared/pause-ui.ts', find: 'ses membres restent suspendus tant que ${c.cover.label} tient la pause', rep: "l'escalade de liveness est de nouveau active pour ses membres", tests: [SHARED], expect: /names a lifted liveness HOLD/ },
  { id: 'nearest-run-archived-anchor', file: 'src/main/pause-ui.ts', find: 'return !!w && !w.archived;', rep: 'return !!w;', tests: ['src/main/pause-ui.test.ts'], expect: /R2-4/ },
);

// ── D-pick delta (Q1 the UI acts as the HUMAN; Q3 both release paths exist; Q5 worker refusal = explanation + LINK to its orchestrator)
const SH = 'src/shared/pause-ui.ts', GATES = 'src/main/pause-gates-wiring.test.ts', CLI_STATUS = 'src/cli/run-status.test.ts', LIFE = 'src/shared/pause-lifecycle.ts', CONS = 'src/shared/pause-consigne.ts';
const BP = 'src/main/bus-pause.ts', BR = 'src/main/bus-runs.ts', PR = 'src/main/pause-reprise.ts', UIM = 'src/main/pause-ui.ts', UIT = 'src/main/pause-ui.test.ts';
const RULE_PAUSE = "if (!human && (!who || ![auth.coordinator, ...auth.ancestors].some((c) => isCoordinatorHandle(c, who)))) {";
MUTANTS.push(
  // the writers: the human skips the coordinator rule ONLY through the option; recorded as the human
  { id: 'human-pause-who-is-actor', file: BP, find: "const who = human ? PAUSE_HUMAN_BY : (actor?.trim() ?? '');", rep: "const who = actor?.trim() ?? '';", tests: [UIT], expect: /Q1 writers/ },
  { id: 'human-pause-rule-not-skipped', file: BP, find: RULE_PAUSE, rep: "if ((!who || ![auth.coordinator, ...auth.ancestors].some((c) => isCoordinatorHandle(c, who)))) {", tests: [UIT], expect: /Q1 writers|uiPause as an ORCHESTRATOR row/ },
  { id: 'human-pause-string-is-a-credential', file: BP, find: RULE_PAUSE, rep: "if (!human && who !== PAUSE_HUMAN_BY && (!who || ![auth.coordinator, ...auth.ancestors].some((c) => isCoordinatorHandle(c, who)))) {", tests: [UIT], expect: /Q1 writers/ },
  { id: 'human-hold-who-is-actor', file: BR, find: "const who = human ? PAUSE_HUMAN_BY : (actor?.trim() ?? '');", rep: "const who = actor?.trim() ?? '';", tests: [UIT], expect: /Q1 writers|uiResume = `orchestra run resume`/ },
  { id: 'human-hold-rule-not-skipped', file: BR, find: RULE_PAUSE, rep: "if ((!who || ![auth.coordinator, ...auth.ancestors].some((c) => isCoordinatorHandle(c, who)))) {", tests: [UIT], expect: /Q1 writers|uiResume = `orchestra run resume`/ },
  { id: 'human-hold-string-is-a-credential', file: BR, find: RULE_PAUSE, rep: "if (!human && who !== PAUSE_HUMAN_BY && (!who || ![auth.coordinator, ...auth.ancestors].some((c) => isCoordinatorHandle(c, who)))) {", tests: [UIT], expect: /Q1 writers/ },
  { id: 'human-reprise-rule-not-skipped', file: PR, find: 'if (opts?.host !== true && opts?.human !== true) {', rep: 'if (opts?.host !== true) {', tests: [UIT], expect: /Q1 writers|uiResume|FULL CYCLE/ },
  { id: 'human-reprise-string-is-a-credential', file: PR, find: 'if (opts?.host !== true && opts?.human !== true) {', rep: 'if (opts?.host !== true && opts?.human !== true && actor !== PAUSE_HUMAN_BY) {', tests: [UIT], expect: /Q1 writers/ },
  { id: 'human-release-by-is-actor', file: PR, find: 'const by = human ? PAUSE_HUMAN_BY : actor;', rep: 'const by = actor;', tests: [UIT], expect: /Q1 writers|record the HUMAN/ },
  { id: 'human-release-rule-not-skipped', file: PR, find: 'if (!human && !may.some((c) => isCoordinatorHandle(c, actor))) {', rep: 'if (!may.some((c) => isCoordinatorHandle(c, actor))) {', tests: [UIT], expect: /Q1 writers|FULL CYCLE|record the HUMAN/ },
  { id: 'human-release-string-is-a-credential', file: PR, find: 'if (!human && !may.some((c) => isCoordinatorHandle(c, actor))) {', rep: 'if (!human && actor !== PAUSE_HUMAN_BY && !may.some((c) => isCoordinatorHandle(c, actor))) {', tests: [UIT], expect: /Q1 writers/ },
  { id: 'human-release-all-ignores-ownruns', file: PR, find: "(human ? [...(opts?.ownRuns ?? [])] : ownRuns(db, tree, actor))", rep: 'ownRuns(db, tree, actor)', tests: [UIT], expect: /Q1 writers|FULL CYCLE/ },
  { id: 'human-release-all-everything-own', file: PR, find: "(human ? [...(opts?.ownRuns ?? [])] : ownRuns(db, tree, actor))", rep: "(human ? ['L', 'O', 'S', 'Z'] : ownRuns(db, tree, actor))", tests: [UIT], expect: /Q1 writers|FULL CYCLE/ },
  { id: 'human-release-sender-is-actor', file: PR, find: "row.memberRun ?? carrierRunId), sender: by, kind: 'reprise',", rep: "row.memberRun ?? carrierRunId), sender: actor, kind: 'reprise',", tests: [UIT], expect: /Q1 writers|record the HUMAN/ },
  { id: 'human-release-consigne-by-actor', file: PR, find: '{ releasedBy: by }', rep: '{ releasedBy: actor }', tests: [UIT], expect: /Q1 writers|record the HUMAN/ },
  // display: « humain » never reaches a screen / the Consigne / the CLI raw
  { id: 'consigne-pauser-raw', file: CONS, find: 'trimTo(actorText(c.pausedBy) ?? c.pausedBy, 80)', rep: 'trimTo(c.pausedBy, 80)', tests: [UIT], expect: /Q1 writers|record the HUMAN/ },
  { id: 'consigne-releaser-raw', file: CONS, find: 'trimTo(actorText(opts.releasedBy) ?? opts.releasedBy, 80)', rep: 'trimTo(opts.releasedBy, 80)', tests: [UIT], expect: /Q1 writers|record the HUMAN/ },
  { id: 'consigne-coordinator-row-pauser-raw', file: CONS, find: 'trimTo(actorText(args.pausedBy) ?? args.pausedBy, 80)', rep: 'trimTo(args.pausedBy, 80)', tests: [UIT], expect: /record the HUMAN/ },
  { id: 'cli-status-paused-raw', file: 'src/cli/run-status.ts', find: "since ${iso(p.pausedAt)} by ${c(actorText(p.pausedBy) ?? 'unknown')}`", rep: "since ${iso(p.pausedAt)} by ${c(p.pausedBy ?? 'unknown')}`", tests: [CLI_STATUS], expect: /says a HUMAN paused it/ },
  { id: 'cli-status-resuming-raw', file: 'src/cli/run-status.ts', find: "(by ${c(actorText(p.pausedBy) ?? 'unknown')}) is being lifted", rep: "(by ${c(p.pausedBy ?? 'unknown')}) is being lifted", tests: [CLI_STATUS], expect: /says a HUMAN paused it/ },
  { id: 'actor-text-fr-for-en', file: LIFE, find: "(lang === 'fr' ? 'un humain' : 'a human (from the Orchestra app)')", rep: "(lang === 'fr' ? 'a human (from the Orchestra app)' : 'un humain')", tests: [SHARED], expect: /actorText/ },
  { id: 'actor-text-human-verbatim', file: LIFE, find: "return by === PAUSE_HUMAN_BY ? (", rep: "return by === 'never' ? (", tests: [SHARED], expect: /actorText/ },
  { id: 'actor-text-empty-not-null', file: LIFE, find: "if (by === null || by === undefined || by === '') return null;", rep: "if (by === null || by === undefined) return null;", tests: [SHARED], expect: /actorText/ },
  { id: 'human-constant-renamed', file: LIFE, find: "export const PAUSE_HUMAN_BY = 'humain';", rep: "export const PAUSE_HUMAN_BY = 'human';", tests: [SHARED, UIT], expect: /actorText|uiPause as an ORCHESTRATOR row/ },
  // the UI layer: the human acts; a worker row is not a wave
  { id: 'ui-pause-human-option-dropped', file: UIM, find: 'setRunPause(db, t.runId, true, actor, req.mode, { human: true })', rep: 'setRunPause(db, t.runId, true, actor, req.mode)', tests: [UIT], expect: /uiPause as an ORCHESTRATOR row/ },
  { id: 'ui-resume-human-option-dropped', file: UIM, find: "beginReprise(db, t.runId, actor, { reason: 'manual', human: true })", rep: "beginReprise(db, t.runId, actor, { reason: 'manual' })", tests: [UIT], expect: /FULL CYCLE|uiResume|R2-1/ },
  { id: 'ui-release-human-option-dropped', file: UIM, find: '{ human: true, ownRuns: [t.runId] }', rep: 'undefined', tests: [UIT], expect: /FULL CYCLE|record the HUMAN/ },
  { id: 'ui-release-ownruns-empty', file: UIM, find: '{ human: true, ownRuns: [t.runId] }', rep: '{ human: true, ownRuns: [] }', tests: [UIT], expect: /FULL CYCLE/ },
  { id: 'ui-worker-row-allowed', file: UIM, find: 'return t.runId !== wsId;', rep: 'return false;', tests: [UIT], expect: /REFUSAL — a WORKER row/ },
  { id: 'ui-worker-row-inverted', file: UIM, find: 'return t.runId !== wsId;', rep: 'return t.runId === wsId;', tests: [UIT], expect: /REFUSAL — a WORKER row|uiPause as an ORCHESTRATOR row/ },
  { id: 'ui-worker-resume-not-refused', file: UIM, find: "if (isWorkerRow(t, req.wsId)) return { outcome: 'refused', runId: t.runId, actor: null, explain: explainWorkerRow('resume'", rep: "if (false) return { outcome: 'refused', runId: t.runId, actor: null, explain: explainWorkerRow('resume'", tests: [UIT], expect: /REFUSAL — a WORKER row|uiResume/ },
  { id: 'ui-worker-release-not-refused', file: UIM, find: "if (isWorkerRow(t, req.wsId)) return { result: null,", rep: "if (false) return { result: null,", tests: [UIT], expect: /REFUSAL — a WORKER row|FULL CYCLE/ },
  { id: 'ui-pausedby-label-raw', file: UIM, find: "pv.pausedBy === PAUSE_HUMAN_BY ? actorText(pv.pausedBy, 'fr') : pv.pausedBy === PAUSE_AUTO_BY ? \"l'hôte (limite d'usage)\" : label(pv.pausedBy)", rep: "pv.pausedBy === PAUSE_AUTO_BY ? \"l'hôte (limite d'usage)\" : label(pv.pausedBy)", tests: [UIT], expect: /uiPause as an ORCHESTRATOR row|record the HUMAN/ },
  // Q5: the worker refusal links to the orchestrator and offers nothing that acts
  { id: 'worker-refusal-no-link', file: SH, find: "...(boss ? { actions: [{ kind: 'goto' as const, wsId: boss, label: `Aller à ${c.label(boss)}` }] } : {}),", rep: '', tests: [SHARED, UIT], expect: /explainPauseOutcome|REFUSAL — a WORKER row/ },
  { id: 'worker-refusal-link-to-ancestor', file: SH, find: 'const boss = c.runId;', rep: 'const boss = c.mayBe[0] ?? c.runId;', tests: [SHARED, UIT], expect: /explainPauseOutcome|explainResumeOutcome|REFUSAL — a WORKER row|R2-4/ },
  { id: 'worker-refusal-offers-a-shortcut', file: SH, find: "    fix: [],\n    ...(boss ?", rep: "    fix: [`Mettre ${c.label(c.mayBe[c.mayBe.length - 1] ?? 'x')} en pause`],\n    ...(boss ?", tests: [SHARED, UIT], expect: /explainPauseOutcome|REFUSAL — a WORKER row/ },
  { id: 'worker-refusal-title-not-agent', file: SH, find: "est un agent, pas une vague`", rep: "n'est pas coordinateur`", tests: [SHARED], expect: /explainPauseOutcome/ },
  { id: 'worker-refusal-label-wrong', file: SH, find: "label: `Aller à ${c.label(boss)}` }", rep: "label: `Aller à ${boss}` }", tests: [SHARED], expect: /explainPauseOutcome/ },
  { id: 'avail-no-run-still-checked', file: SH, find: "if (!i.runKnown) return {", rep: "if (false) return {", tests: [SHARED], expect: /availabilityFor/ },
  // renderer: the link is navigation only
  { id: 'blk-goto-wrong-row', file: BLK, find: 'data-pause-fix="goto" data-pause-for={a.wsId}', rep: 'data-pause-fix="goto" data-pause-for="x"', tests: [SMOKE], expect: /LINKS to its orchestrator/ },
  { id: 'blk-goto-is-a-button', file: BLK, find: 'className="pause-link" data-pause-fix="goto"', rep: 'className="pause-btn pause-btn-go" data-pause-fix="goto"', tests: [SMOKE], expect: /LINKS to its orchestrator/ },
  { id: 'blk-goto-label-dropped', file: BLK, find: '{a.label} →', rep: '→', tests: [SMOKE], expect: /LINKS to its orchestrator/ },
  { id: 'goto-no-setactive', file: ACT, find: '  st.setActive(wsId);\n  return true;', rep: '  return true;', tests: [SMOKE, WIRING], expect: /Aller à wave-ops|routed by KIND/ },
  { id: 'goto-archived-allowed', file: ACT, find: 'w.id === wsId && !w.archived', rep: 'w.id === wsId', tests: [SMOKE, WIRING], expect: /no longer exists|routed by KIND/ },
  { id: 'goto-panel-not-closed', file: ACT, find: '  usePausePanel.getState().close();\n  st.setActive(wsId);', rep: '  st.setActive(wsId);', tests: [SMOKE, WIRING], expect: /Aller à wave-ops|routed by KIND/ },
  { id: 'menu-goto-not-routed', file: 'src/renderer/components/pause/PauseMenu.tsx', find: ' : gotoWorkspace(a.wsId))}', rep: ' : undefined)}', tests: [WIRING], expect: /routed by KIND/ },
  { id: 'bus-goto-not-routed', file: BUS, find: ' : gotoWorkspace(a.wsId) || setExplains([GONE_ROW]))}', rep: ' : undefined)}', tests: [WIRING], expect: /routed by KIND/ },
  { id: 'bus-says-pauser-label-raw', file: VIEW, find: "run.pausedByLabel ? `posée par ${run.pausedByLabel}` : 'posée'", rep: "'posée'", tests: [SMOKE], expect: /says a HUMAN paused it/ },
  // the guard: the human option is passed by pause-ui.ts only, never by the CLI / the socket
  { id: 'enum-extra-human-site', file: UIM, find: '{ human: true, ownRuns: [t.runId] }', rep: '{ human: true, human: true, ownRuns: [t.runId] }', tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
  { id: 'enum-cli-sets-human', file: 'src/cli/bus-verbs.ts', find: 'deps.setRunPause(ctx.db, runId, true, actor, mode)', rep: 'deps.setRunPause(ctx.db, runId, true, actor, mode, { human: true })', tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
  { id: 'enum-writer-reads-extra-site', file: BR, find: 'const human = opts?.human === true;', rep: 'const human = opts?.human === true || opts?.human === true;', tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
);

// ── D-pick delta, after the pre-review (link target = the row that owns the run; archived rows; a spelling-proof guard; a human Reprise's coordinators)
MUTANTS.push(
  { id: 'worker-link-to-coordinator-handle', file: 'src/main/pause-ui.ts', find: 'runLabel: labeler(deps)(runId), runId, actorLabel', rep: 'runLabel: labeler(deps)(runId), actorLabel', tests: ['src/main/pause-ui.test.ts'], expect: /REFUSAL — a WORKER row|R2-4/ },
  { id: 'nearest-run-archived-orchestrator', file: 'src/main/pause-ui.ts', find: 'if ((cur.id === ws.id || usable(cur.id)) && (nodeOrchestrates(cur) || anchors(cur.id))) return cur.id;', rep: 'if (nodeOrchestrates(cur) || ((cur.id === ws.id || usable(cur.id)) && anchors(cur.id))) return cur.id;', tests: ['src/main/pause-ui.test.ts'], expect: /R2-4/ },
  { id: 'goto-gone-silent', file: ACT, find: "    if (p && p.kind === 'explain') usePausePanel.getState().show({ ...p, explains: [GONE_ROW], codes: ['gone'] });", rep: '', tests: [SMOKE, WIRING], expect: /never a silent dead link|routed by KIND/ },
  { id: 'bus-goto-gone-silent', file: BUS, find: 'gotoWorkspace(a.wsId) || setExplains([GONE_ROW])', rep: 'gotoWorkspace(a.wsId)', tests: [WIRING], expect: /routed by KIND/ },
  { id: 'human-reprise-coordinators-host', file: 'src/main/pause-reprise.ts', find: 'now, undefined, opts?.human === true ? PAUSE_HUMAN_BY : HOST_SENDER);', rep: 'now, undefined, HOST_SENDER);', tests: ['src/main/pause-ui.test.ts'], expect: /record the HUMAN everywhere/ },
  { id: 'cli-reprise-releaser-not-host', file: 'src/main/pause-reprise.ts', find: 'now, undefined, opts?.human === true ? PAUSE_HUMAN_BY : HOST_SENDER);', rep: 'now, undefined, PAUSE_HUMAN_BY);', tests: ['src/main/pause-reprise.test.ts'], expect: /RESUMING: stamps resume_started_at|REPRISE ROWS/ },
  { id: 'coordinator-release-sender-not-by', file: 'src/main/pause-reprise.ts', find: 'bilans.get(row.wsId)?.memberRun ?? null, run), sender: by, kind', rep: 'bilans.get(row.wsId)?.memberRun ?? null, run), sender: HOST_SENDER, kind', tests: ['src/main/pause-ui.test.ts'], expect: /record the HUMAN everywhere/ },
  { id: 'takeover-label-raw', file: 'src/main/pause-ui.ts', find: "pv.pausedBy === PAUSE_AUTO_BY ? \"l'hôte (limite d'usage)\" : label(pv.pausedBy)", rep: 'label(pv.pausedBy)', tests: ['src/main/pause-ui.test.ts'], expect: /taken over by a human|TAKEN OVER/i },
  { id: 'cli-reprise-dep-not-fenced', file: 'src/cli/bus-verbs.ts', find: '  beginReprise?: CliRepriseEntry;', rep: '  beginReprise?: RepriseEntry;', tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
  // evasion spellings in a NEW site (the AST guard sees them all)
  { id: 'enum-evasion-string-key', file: 'src/cli/bus-verbs.ts', find: 'deps.setRunPause(ctx.db, runId, true, actor, mode)', rep: 'deps.setRunPause(ctx.db, runId, true, actor, mode, { "human": true })', tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
  { id: 'enum-evasion-shorthand', file: 'src/cli/bus-verbs.ts', find: 'deps.setRunPause(ctx.db, runId, true, actor, mode)', rep: 'deps.setRunPause(ctx.db, runId, true, actor, mode, ((human) => ({ human }))(true))', tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
  { id: 'enum-evasion-reader-destructure', file: BR, find: 'const human = opts?.human === true;', rep: 'const human = opts?.human === true;\n  const { human: viaDestructure } = opts ?? {};\n  void viaDestructure;', tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
);

// ── D-pick delta, fix round (review: M1 archived carrier, M2 human escalation / takeover, m1 AST guard)
MUTANTS.push(
  { id: 'nearest-run-own-archived-skipped', file: 'src/main/pause-ui.ts', find: 'if ((cur.id === ws.id || usable(cur.id)) && (nodeOrchestrates(cur) || anchors(cur.id))) return cur.id;', rep: 'if (usable(cur.id) && (nodeOrchestrates(cur) || anchors(cur.id))) return cur.id;', tests: ['src/main/pause-ui.test.ts'], expect: /M1: the Bus card of an ARCHIVED carrier/ },
  { id: 'nearest-run-ancestor-archived-kept', file: 'src/main/pause-ui.ts', find: '(cur.id === ws.id || usable(cur.id))', rep: '(true)', tests: ['src/main/pause-ui.test.ts'], expect: /M1: the Bus card of an ARCHIVED carrier|R2-4/ },
  { id: 'escalate-keeps-agent-pauser', file: 'src/main/bus-pause.ts', find: "pause_escalated_at = ?${human ? ', paused_by = ?' : ''}\n            WHERE id = ? AND paused_at = ? AND pause_mode = 'soft' AND pause_escalated_at IS NULL AND pause_trap_at IS NULL`,\n        ).run(...(human ? [Date.now(), PAUSE_HUMAN_BY, runId, row!.pausedAt] : [Date.now(), runId, row!.pausedAt])).changes;", rep: "pause_escalated_at = ?\n            WHERE id = ? AND paused_at = ? AND pause_mode = 'soft' AND pause_escalated_at IS NULL AND pause_trap_at IS NULL`,\n        ).run(Date.now(), runId, row!.pausedAt).changes;", tests: ['src/main/pause-ui.test.ts'], expect: /M2: the human.s Pause dure over an AGENT.s douce/ },
  { id: 'escalate-rewrites-pauser-for-agents', file: 'src/main/bus-pause.ts', find: "pause_escalated_at = ?${human ? ', paused_by = ?' : ''}\n            WHERE id = ? AND paused_at = ? AND pause_mode = 'soft' AND pause_escalated_at IS NULL AND pause_trap_at IS NULL`,\n        ).run(...(human ? [Date.now(), PAUSE_HUMAN_BY, runId, row!.pausedAt] : [Date.now(), runId, row!.pausedAt])).changes;", rep: "pause_escalated_at = ?, paused_by = ?\n            WHERE id = ? AND paused_at = ? AND pause_mode = 'soft' AND pause_escalated_at IS NULL AND pause_trap_at IS NULL`,\n        ).run(Date.now(), PAUSE_HUMAN_BY, runId, row!.pausedAt).changes;", tests: ['src/main/pause-ui.test.ts'], expect: /M2: the human.s Pause dure over an AGENT.s douce/ },
  { id: 'takeover-human-not-recorded', file: 'src/main/bus-pause.ts', find: "  if (human) db.prepare('UPDATE runs SET paused_by = ? WHERE id = ? AND paused_at IS NOT NULL AND pause_auto IS NOT NULL').run(PAUSE_HUMAN_BY, runId);\n", rep: '', tests: ['src/main/pause-ui.test.ts'], expect: /M2 \(host pause\)/ },
  { id: 'takeover-rewrites-coordinator-pause', file: 'src/main/bus-pause.ts', find: 'WHERE id = ? AND paused_at IS NOT NULL AND pause_auto IS NOT NULL', rep: 'WHERE id = ? AND paused_at IS NOT NULL', tests: ['src/main/pause-ui.test.ts'], expect: /M2 \(host pause\)/ },
  { id: 'takeover-by-anyone-rewrites', file: 'src/main/bus-pause.ts', find: '  if (human) db.prepare(\'UPDATE runs SET paused_by = ? WHERE id = ? AND paused_at IS NOT NULL AND pause_auto IS NOT NULL\')', rep: '  if (true) db.prepare(\'UPDATE runs SET paused_by = ? WHERE id = ? AND paused_at IS NOT NULL AND pause_auto IS NOT NULL\')', tests: ['src/main/pause-ui.test.ts'], expect: /M2 \(host pause\)/ },
  { id: 'ui-escalated-origin-kept', file: 'src/main/pause-ui.ts', find: 'replacePauseOrigin(db, t.runId, made.pausedAt, []);', rep: 'void made;', tests: ['src/main/pause-ui.test.ts'], expect: /M2: the human.s Pause dure over an AGENT.s douce/ },
  { id: 'ui-escalated-origin-wrong-chain', file: 'src/main/pause-ui.ts', find: 'replacePauseOrigin(db, t.runId, made.pausedAt, []);', rep: "replacePauseOrigin(db, t.runId, made.pausedAt, [{ pid: 1, ppid: 0, startTicks: 1, comm: 'x' }]);", tests: ['src/main/pause-ui.test.ts'], expect: /M2: the human.s Pause dure over an AGENT.s douce/ },
  { id: 'replace-origin-is-first-wins', file: 'src/main/bus-pause-records.ts', find: '    updateBilan(db, row.id, { activity: { ...(row.activity ?? { surface: \'none\' }), origin: { chain } } });', rep: '    void row;', tests: ['src/main/pause-ui.test.ts'], expect: /M2: the human.s Pause dure over an AGENT.s douce/ },
  { id: 'replace-origin-no-insert', file: 'src/main/bus-pause-records.ts', find: '    if (!row) {\n      insertBilan(db, { runId: carrierRunId, wsId: PAUSE_ORIGIN_WS, pausedAt, activity: { surface: \'none\', origin: { chain } }, snapshotRef: null, dirty: null, killed: null, error: null });\n      return;\n    }\n    updateBilan', rep: '    if (!row) return;\n    updateBilan', tests: ['src/main/pause-ui.test.ts'], expect: /M2: the human.s Pause dure over an AGENT.s douce/ },
  // m1: a `.ts` file parsed as itself, and the CLI deps typed without an options parameter
  { id: 'enum-evasion-type-assertion', file: 'src/cli/bus-verbs.ts', find: 'deps.setRunPause(ctx.db, runId, true, actor, mode)', rep: 'deps.setRunPause(ctx.db, runId, true, actor, mode, <any>{ human: true })', tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
  { id: 'cli-dep-pause-gains-options', file: 'src/cli/bus-verbs.ts', find: 'setRunPause: (db: BusDb, runId: string, pause: boolean, actor: string | null, mode?: PauseMode) => RunPauseOutcome;', rep: 'setRunPause: (db: BusDb, runId: string, pause: boolean, actor: string | null, mode?: PauseMode, opts?: object) => RunPauseOutcome;', tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
  { id: 'cli-dep-hold-gains-options', file: 'src/cli/bus-verbs.ts', find: 'setRunHold: (db: BusDb, runId: string, hold: boolean, actor: string | null) => RunHoldOutcome;', rep: 'setRunHold: (db: BusDb, runId: string, hold: boolean, actor: string | null, opts?: object) => RunHoldOutcome;', tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
  { id: 'cli-dep-release-gains-options', file: 'src/cli/bus-verbs.ts', find: "releaseMembers?: (db: BusDb, carrierRunId: string, actor: string, targets: readonly string[] | 'all') => ReleaseResult;", rep: "releaseMembers?: (db: BusDb, carrierRunId: string, actor: string, targets: readonly string[] | 'all', now?: number, opts?: object) => ReleaseResult;", tests: [GATES], expect: /ENUMERATION \(extends the guard/ },
);

// ── D-pick delta, fix round 2 (pre-review minors: one atomic escalate statement, idempotent + epoch-safe origin repair, the race-adopt site)
MUTANTS.push(
  { id: 'ui-origin-replaced-for-coordinator-pause', file: 'src/main/pause-ui.ts', find: 'made.pausedBy === PAUSE_HUMAN_BY && (readPauseOrigin', rep: '(readPauseOrigin', tests: ['src/main/pause-ui.test.ts'], expect: /M2 \(idempotent \+ epoch-safe\)/ },
  { id: 'ui-origin-repair-only-on-escalated', file: 'src/main/pause-ui.ts', find: "outcome === 'escalated' || outcome === 'already-paused'", rep: "outcome === 'escalated'", tests: ['src/main/pause-ui.test.ts'], expect: /M2 \(idempotent \+ epoch-safe\)/ },
  { id: 'adopt-race-site-not-human', file: 'src/main/bus-pause.ts', find: "      adoptPause(db, runId, human);\n      return 'already-paused';\n    }\n    return 'paused';", rep: "      adoptPause(db, runId, false);\n      return 'already-paused';\n    }\n    return 'paused';", tests: ['src/main/pause-ui.test.ts'], expect: /M2 \(idempotent \+ epoch-safe\)/ },
  { id: 'adopt-first-site-not-human', file: 'src/main/bus-pause.ts', find: "      adoptPause(db, runId, human);\n      return 'already-paused';\n    }\n    const now = Date.now();", rep: "      adoptPause(db, runId, false);\n      return 'already-paused';\n    }\n    const now = Date.now();", tests: ['src/main/pause-ui.test.ts'], expect: /M2 \(host pause\)/ },
  { id: 'already-paused-text-claims-original-author', file: 'src/shared/pause-ui.ts', find: "elle devient manuelle — la vôtre : plus de reprise automatique.", rep: "elle devient manuelle : plus de reprise automatique.", tests: ['src/shared/pause-ui.test.ts'], expect: /explainPauseOutcome/ },
);

// ── D-pick delta follow-up (review r2 m-A): importers of the UI entry points + every writer call site pinned
MUTANTS.push(
  { id: 'importer-route-imports-ui', file: 'src/main/api-handlers.ts', find: "import path from 'node:path';", rep: "import path from 'node:path';\nimport { uiPause as __uiPause } from './pause-ui';\nexport const __leak = __uiPause;", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'importer-namespace-import', file: 'src/main/api-handlers.ts', find: "import path from 'node:path';", rep: "import path from 'node:path';\nimport * as __ui from './pause-ui.ts';\nvoid __ui;", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'importer-reexport', file: 'src/main/api-handlers.ts', find: "import path from 'node:path';", rep: "import path from 'node:path';\nexport { uiResume } from './pause-ui';", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'importer-dynamic-import', file: 'src/main/api-handlers.ts', find: "import path from 'node:path';", rep: "import path from 'node:path';\nvoid import('./pause-ui');", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'importer-from-cli', file: 'src/cli/bus-verbs.ts', find: "import { actorText, SOFT_PAUSE_DEADLINE_MS,", rep: "import { uiRelease as __uiRelease } from '../main/pause-ui';\nvoid __uiRelease;\nimport { actorText, SOFT_PAUSE_DEADLINE_MS,", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'call-relayed-6th-arg', file: 'src/cli/bus-verbs.ts', find: 'deps.setRunPause(ctx.db, runId, true, actor, mode)', rep: "deps.setRunPause(ctx.db, runId, true, actor, mode, JSON.parse('{}'))", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'call-spread-object', file: 'src/cli/bus-verbs.ts', find: "hold.pause.beginReprise(ctx.db, runId, actor, { reason: 'manual' })", rep: "hold.pause.beginReprise(ctx.db, runId, actor, { ...({ reason: 'manual' }) })", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'call-computed-key', file: 'src/cli/bus-verbs.ts', find: "hold.pause.beginReprise(ctx.db, runId, actor, { reason: 'manual' })", rep: "hold.pause.beginReprise(ctx.db, runId, actor, { ['rea' + 'son']: 'manual' })", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'call-extra-property', file: 'src/cli/bus-verbs.ts', find: "hold.pause.beginReprise(ctx.db, runId, actor, { reason: 'manual' })", rep: "hold.pause.beginReprise(ctx.db, runId, actor, { reason: 'manual', humanish: true })", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'call-new-site-in-cli-index', file: 'src/cli/index.ts', find: 'setRunPause: busPause.setRunPause,', rep: "setRunPause: busPause.setRunPause,\n        __x: busPause.setRunPause(db, 'a', true, 'b', 'hard', JSON.parse('{}')),", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'call-new-site-in-main', file: 'src/main/pause-auto.ts', find: "outcome = deps.beginReprise(db, run.runId, 'host', { host: true, reason: 'usage_limit' });", rep: "outcome = deps.beginReprise(db, run.runId, 'host', { host: true, reason: 'usage_limit' });\n    releaseMembers(db, run.runId, 'x', 'all');", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
);

// ── D-pick follow-up, after the guard's pre-review (casts / element access / .call-.apply-.bind / beginRepriseCore / host / JS files / the UI layer's own objects)
const IDX_ANCHOR = 'setRunPause: busPause.setRunPause,';
const NEW_SITE = (code) => IDX_ANCHOR + '\n        __x: ' + code + ',';
MUTANTS.push(
  { id: 'site-cast-callee', file: 'src/cli/index.ts', find: IDX_ANCHOR, rep: NEW_SITE("(busPause.setRunPause as any)(db, 'a', true, 'b', 'hard', JSON.parse('{}'))"), tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'site-type-assertion-callee', file: 'src/cli/index.ts', find: IDX_ANCHOR, rep: NEW_SITE("(<any>busPause.setRunPause)(db, 'a', true, 'b', 'hard', JSON.parse('{}'))"), tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'site-element-access', file: 'src/cli/index.ts', find: IDX_ANCHOR, rep: NEW_SITE("busPause['setRunPause'](db, 'a', true, 'b', 'hard', JSON.parse('{}'))"), tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'site-dot-call', file: 'src/cli/index.ts', find: IDX_ANCHOR, rep: NEW_SITE("busPause.setRunPause.call(busPause, db, 'a', true, 'b', 'hard', JSON.parse('{}'))"), tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'site-dot-apply', file: 'src/cli/index.ts', find: IDX_ANCHOR, rep: NEW_SITE("busPause.setRunPause.apply(busPause, [db, 'a', true, 'b', 'hard', JSON.parse('{}')])"), tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'site-begin-reprise-core', file: 'src/cli/index.ts', find: IDX_ANCHOR, rep: NEW_SITE("beginRepriseCore(db, 'a', 'b', JSON.parse('{}'), [])"), tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'host-key-in-cli-reprise', file: 'src/cli/bus-verbs.ts', find: "hold.pause.beginReprise(ctx.db, runId, actor, { reason: 'manual' })", rep: "hold.pause.beginReprise(ctx.db, runId, actor, { reason: 'manual', host: true })", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'ui-layer-relayed-object', file: 'src/main/pause-ui.ts', find: '{ human: true, ownRuns: [t.runId] }', rep: '{ ...({ human: true }), ownRuns: [t.runId] }', tests: [GATES], expect: /ENUMERATION/ },
  { id: 'importer-js-file-dot-js-specifier', file: 'src/renderer/components/agent/__smoke__/run-smoke.mjs', find: "import { dirname, resolve } from 'node:path';", rep: "import { dirname, resolve } from 'node:path';\nimport { uiPause as __u } from '../../../../main/pause-ui.js';\nvoid __u;", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
  { id: 'importer-type-only', file: 'src/main/api-handlers.ts', find: "import path from 'node:path';", rep: "import path from 'node:path';\nimport type { PauseUiDeps as __D } from './pause-ui';", tests: [GATES], expect: /ENUMERATION \(importers \+ call sites\)/ },
);

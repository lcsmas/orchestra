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
  { id: 'bus-bilan-without-escalade-note', file: BUS, find: "missing === 'absent' ? 'aucun Bilan' : \"après l'escalade\"}", rep: "missing === 'absent' ? 'aucun Bilan' : ''}", tests: [SMOKE], expect: /douce waiting/ },
  // ── building blocks
  { id: 'blk-blocked-not-dim', file: BLK, find: "${ui === 'blocked' ? ' is-blocked' : ''}", rep: '', tests: [SMOKE], expect: /blocked badge carries is-blocked/ },
  { id: 'blk-bar-unclamped', file: BLK, find: 'Math.round(Math.max(0, Math.min(1, fraction)) * 100)', rep: 'Math.round(fraction * 100)', tests: [SMOKE], expect: /progress bar clamps/ },
  { id: 'blk-error-as-status', file: BLK, find: "role={explain.tone === 'error' ? 'alert' : 'status'}", rep: 'role="status"', tests: [SMOKE], expect: /refusal block/ },
  { id: 'blk-disabled-unexplained', file: BLK, find: 'title={disabled ? why : undefined}', rep: 'title={undefined}', tests: [SMOKE], expect: /disabled action is EXPLAINED/ },
  { id: 'blk-explain-fix-dropped', file: BLK, find: ') : explain.fix.length > 0 && (', rep: ') : false && (', tests: [SMOKE], expect: /refusal block/ },
  { id: 'blk-actions-as-bullets', file: BLK, find: 'explain.actions && explain.actions.length > 0 && onAction ? (', rep: 'false ? (', tests: [SMOKE], expect: /the ONE follow-up an explanation may carry/ },
  { id: 'blk-action-wrong-row', file: BLK, find: 'data-pause-fix={a.kind} data-pause-for={a.wsId}', rep: 'data-pause-fix={a.kind} data-pause-for="x"', tests: [SMOKE], expect: /the ONE follow-up an explanation may carry/ },
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
  { id: 'resume-hold-not-lifted', file: 'src/main/pause-ui.ts', find: "    holdLifted = setRunHold(db, t.runId, false, actor) === 'resumed';", rep: '    holdLifted = false;', tests: ['src/main/pause-ui.test.ts'], expect: /uiResume = `orchestra run resume`/ },
  { id: 'resume-hold-lifted-by-anyone', file: 'src/main/pause-ui.ts', find: "    holdLifted = setRunHold(db, t.runId, false, actor) === 'resumed';", rep: "    holdLifted = setRunHold(db, t.runId, false, t.runId) === 'resumed';", tests: ['src/main/pause-ui.test.ts'], expect: /uiResume = `orchestra run resume`/ },
  // R1-4 run anchors
  { id: 'controls-only-orchestrators', file: 'src/main/pause-ui.ts', find: '      if (!nodeOrchestrates(ws) && !ownsRun) continue;', rep: '      if (!nodeOrchestrates(ws)) continue;', tests: ['src/main/pause-ui.test.ts'], expect: /PLAIN run-anchoring parent/ },
  { id: 'anchor-target-ignored', file: 'src/main/pause-ui.ts', find: '  return { ws, runId: own ? ws.id : nearestOrchestratorId(ws, deps.getWorkspace) };', rep: '  return { ws, runId: nearestOrchestratorId(ws, deps.getWorkspace) };', tests: ['src/main/pause-ui.test.ts'], expect: /PLAIN run-anchoring parent/ },
  // R1-2 « tout libérer »
  { id: 'explain-below-no-second-gesture', file: 'src/shared/pause-ui.ts', find: "      ...(c.actorId && c.carrierRunId\n        ? {", rep: "      ...(false\n        ? {", tests: [SHARED], expect: /explainReleaseResult/ },
  { id: 'release-ctx-ids-dropped', file: 'src/main/pause-ui.ts', find: 'actorId: actor, carrierRunId: carrier ?? t.runId, all: req.targets', rep: 'all: req.targets', tests: ['src/main/pause-ui.test.ts'], expect: /« Libérer tout » = `release --all`/ },
  { id: 'view-release-scope-all-own', file: VIEW, find: "    if (m.role === 'worker' && m.memberRun !== null && m.memberRun !== run.carrierRunId) below.push(m.wsId);\n    else own.push(m.wsId);", rep: '    own.push(m.wsId);', tests: [VT], expect: /releaseScope/ },
  // R1-7 no remedy shortcut
  { id: 'explain-refused-offers-button', file: 'src/shared/pause-ui.ts', find: "        // NAMED, not offered as a button:", rep: "        actions: c.mayBe.map((id) => ({ kind: 'release' as const, wsId: id, carrierRunId: id, ids: [], label: 'x' })),\n        // NAMED, not offered as a button:", tests: [SHARED, 'src/main/pause-ui.test.ts'], expect: /explainPauseOutcome|REFUSAL — a WORKER row/ },
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
  { id: 'bus-absent-shows-pending', file: BUS, find: "{b ? killedText(b) : missing === 'absent' ? 'aucun Bilan' : \"après l'escalade\"}", rep: "{b ? killedText(b) : \"après l'escalade\"}", tests: [SMOKE], expect: /no Bilan row once the trap is DONE/ },
  { id: 'bus-pending-shows-absent', file: BUS, find: "missing === 'absent' ? 'aucun Bilan' : \"après l'escalade\"}", rep: "'aucun Bilan'}", tests: [SMOKE], expect: /no Bilan row while the trap is still owed/ },
  { id: 'view-nobilan-always-pending', file: VIEW, find: "? (run.trapAt !== null ? 'absent' : 'pending') : 'absent';", rep: "? 'pending' : 'pending';", tests: [VT], expect: /noBilanState/ },
  { id: 'view-nobilan-trap-done-pending', file: VIEW, find: "? (run.trapAt !== null ? 'absent' : 'pending') : 'absent';", rep: "? 'pending' : 'absent';", tests: [VT], expect: /noBilanState/ },
  { id: 'view-nobilan-resuming-pending', file: VIEW, find: "? (run.trapAt !== null ? 'absent' : 'pending') : 'absent';", rep: "? (run.trapAt !== null ? 'absent' : 'pending') : 'pending';", tests: [VT], expect: /noBilanState/ },
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

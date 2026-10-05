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
  { id: 'row-release-all-hidden', file: ROW, find: 'if (run && n > 0) btns.push(', rep: 'if (false && run && n > 0) btns.push(', tests: [SMOKE], expect: /hover actions follow the phase/ },
  { id: 'row-release-tooltip-count', file: ROW, find: 'title: `Libérer les ${n} bloqué${n > 1 ? \'s\' : \'\'}`', rep: "title: 'Libérer les bloqués'", tests: [SMOKE], expect: /release-all names the blocked count/ },
  // ── click handlers
  { id: 'act-release-all-uses-all', file: ACT, find: 'useStore.getState().pauseRelease(wsId, ids, run.carrierRunId)', rep: "useStore.getState().pauseRelease(wsId, 'all', run.carrierRunId)", tests: [SMOKE], expect: /EXPLICIT ids/ },
  { id: 'act-release-no-carrier', file: ACT, find: 'useStore.getState().pauseRelease(wsId, ids, run.carrierRunId)', rep: 'useStore.getState().pauseRelease(wsId, ids, null)', tests: [SMOKE], expect: /EXPLICIT ids/ },
  { id: 'act-refusal-swallowed', file: ACT, find: '  if (anchor) show({ kind: \'explain\', wsId, anchor, explains, codes });', rep: '  if (false && anchor) show({ kind: \'explain\', wsId, anchor, explains, codes });', tests: [SMOKE], expect: /refusal comes back EXPLAINED/ },
  { id: 'act-success-keeps-panel', file: ACT, find: '  if (explains.length === 0) { close(); return []; }', rep: '  if (explains.length === 0) { return []; }', tests: [SMOKE], expect: /a success closes the panel/ },
  { id: 'act-anchorless-opens-panel', file: ACT, find: '  if (anchor) show({ kind: \'explain\', wsId, anchor, explains, codes });', rep: "  show({ kind: 'explain', wsId, anchor: anchor as never, explains, codes });", tests: [SMOKE], expect: /Bus-page click/ },
  { id: 'act-pause-mode-dropped', file: ACT, find: 'await useStore.getState().pausePause(wsId, mode);', rep: "await useStore.getState().pausePause(wsId, 'hard');", tests: [SMOKE], expect: /refusal comes back EXPLAINED/ },
  // ── Bus section
  { id: 'bus-shows-when-bus-down', file: BUS, find: 'if (!o || !o.available || o.runs.length === 0) return null;', rep: 'if (!o || o.runs.length === 0) return null;', tests: [SMOKE], expect: /overview unavailable/ },
  { id: 'bus-release-on-every-row', file: BUS, find: "run.phase === 'resuming' && m.ui === 'blocked' ? (", rep: "run.phase === 'resuming' ? (", tests: [SMOKE], expect: /Reprise: "N\/M repris"/ },
  { id: 'bus-closed-reprise-has-actions', file: BUS, find: "{run.phase === 'paused' && <PauseActionButton kind=\"resume\"", rep: "{(run.phase === 'paused' || run.phase === 'active') && <PauseActionButton kind=\"resume\"", tests: [SMOKE], expect: /closed Reprise still collecting/ },
  { id: 'bus-missing-hidden', file: BUS, find: "{run.progress.missing.length > 0 && (run.phase === 'pausing' || run.phase === 'paused') && ", rep: '{false && ', tests: [SMOKE], expect: /douce waiting/ },
  { id: 'bus-bilan-without-escalade-note', file: BUS, find: "{b ? killedText(b) : \"après l'escalade\"}", rep: "{b ? killedText(b) : ''}", tests: [SMOKE], expect: /douce waiting/ },
  // ── building blocks
  { id: 'blk-blocked-not-dim', file: BLK, find: "${ui === 'blocked' ? ' is-blocked' : ''}", rep: '', tests: [SMOKE], expect: /blocked badge carries is-blocked/ },
  { id: 'blk-bar-unclamped', file: BLK, find: 'Math.round(Math.max(0, Math.min(1, fraction)) * 100)', rep: 'Math.round(fraction * 100)', tests: [SMOKE], expect: /progress bar clamps/ },
  { id: 'blk-error-as-status', file: BLK, find: "role={explain.tone === 'error' ? 'alert' : 'status'}", rep: 'role="status"', tests: [SMOKE], expect: /refusal block/ },
  { id: 'blk-disabled-unexplained', file: BLK, find: 'title={disabled ? why : undefined}', rep: 'title={undefined}', tests: [SMOKE], expect: /disabled action is EXPLAINED/ },
  { id: 'blk-explain-fix-dropped', file: BLK, find: ') : explain.fix.length > 0 && (', rep: ') : false && (', tests: [SMOKE], expect: /refusal block/ },
  { id: 'blk-actions-as-bullets', file: BLK, find: 'explain.actions && explain.actions.length > 0 && onAction ? (', rep: 'false ? (', tests: [SMOKE], expect: /remedies the UI can DO/ },
  { id: 'blk-action-wrong-row', file: BLK, find: 'data-pause-fix={a.kind} data-pause-for={a.wsId}', rep: 'data-pause-fix={a.kind} data-pause-for="x"', tests: [SMOKE], expect: /remedies the UI can DO/ },
  { id: 'bus-manquent-in-reprise', file: BUS, find: "(run.phase === 'pausing' || run.phase === 'paused') && ", rep: "run.phase !== 'active' && ", tests: [SMOKE], expect: /Reprise: "N\/M repris"/ },
  { id: 'act-double-click-sends-twice', file: ACT, find: '  if (inflight.has(key)) return fallback;', rep: '', tests: [SMOKE], expect: /double-click sends ONE write/ },
  { id: 'act-ipc-failure-unhandled', file: ACT, find: "return report(wsId, anchor, [ipcFailure(e)], ['ipc-failed']);\n    }\n  });\n}\n\nexport async function runResume", rep: "throw e;\n    }\n  });\n}\n\nexport async function runResume", tests: [SMOKE], expect: /a rejected invoke is EXPLAINED too for a pause/ },
  { id: 'act-resume-ipc-failure-unhandled', file: ACT, find: "return report(wsId, anchor, [ipcFailure(e)], ['ipc-failed']);\n    }\n  });\n}\n\n/** \"Libérer", rep: "throw e;\n    }\n  });\n}\n\n/** \"Libérer", tests: [SMOKE], expect: /a rejected invoke is EXPLAINED \("La commande/ },
  { id: 'bus-detail-rows-dropped', file: BUS, find: '{hasDetail && (', rep: '{false && (', tests: [SMOKE], expect: /a member with a problem SHOWS it/ },
  { id: 'bus-killed-not-listed', file: BUS, find: 'const killed = b ? b.killed.slice(0, 4) : [];', rep: 'const killed: never[] = [];', tests: [SMOKE], expect: /what it was doing and what was killed/ },
  { id: 'menu-escape-bubbles', file: 'src/renderer/components/pause/PauseMenu.tsx', find: 'e.stopImmediatePropagation(); ', rep: '', tests: [WIRING], expect: /Escape closes the PANEL only/ },
  { id: 'menu-escape-not-capture', file: 'src/renderer/components/pause/PauseMenu.tsx', find: "window.addEventListener('keydown', onKey, true);", rep: "window.addEventListener('keydown', onKey);", tests: [WIRING], expect: /Escape closes the PANEL only/ },
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
  { id: 'view-paused-bar-always-full', file: VIEW, find: 'sub: `${by}${when}`, fraction: total > 0 ? fraction : 1 };', rep: 'sub: `${by}${when}`, fraction: 1 };', tests: [VT], expect: /runHeadline/ },
  { id: 'view-blocked-green', file: VIEW, find: "return ui === 'pausing' ? 'pausing' : ui === 'paused' || ui === 'blocked' ? 'paused' : 'resumed';", rep: "return ui === 'pausing' ? 'pausing' : ui === 'paused' ? 'paused' : 'resumed';", tests: [VT], expect: /words and tones/ },
  { id: 'view-auto-owner-hidden', file: VIEW, find: "const by = run.auto ? 'posée par l\\'hôte (limite d\\'usage)'", rep: "const by = false ? 'posée par l\\'hôte (limite d\\'usage)'", tests: [VT], expect: /runHeadline/ },
  { id: 'view-douce-no-deadline', file: VIEW, find: "const left = run.deadlineAt !== null ? ` · dure dans ${countdown(run.deadlineAt, now)}` : '';", rep: "const left = '';", tests: [VT], expect: /rowNoteText/ },
  // ── wiring
  { id: 'sb-badge-missing-pinned-path', file: SB, find: '\n                <PauseRowBadge wsId={w.id} />\n                <HibernatedChip w={w} />', rep: '\n                <HibernatedChip w={w} />', tests: [WIRING], expect: /SIDEBAR: both row render paths/ },
  { id: 'sb-bar-missing-repo-path', file: SB, find: '                  <PauseRowBar wsId={w.id} />\n                </div>', rep: '                </div>', tests: [WIRING], expect: /SIDEBAR: both row render paths/ },
  { id: 'sb-menu-host-unmounted', file: SB, find: '      <PauseMenuHost />\n', rep: '', tests: [WIRING], expect: /SIDEBAR: both row render paths/ },
  { id: 'app-no-pause-slot', file: APP, find: '<BusPane pauseSlot={<BusPauseSection />} />', rep: '<BusPane />', tests: [WIRING], expect: /BUS PAGE/ },
  { id: 'store-push-merges', file: STORE, find: 'useStore.setState({ pauseOverview: overview });', rep: 'useStore.setState((s) => ({ pauseOverview: s.pauseOverview ?? overview }));', tests: [WIRING], expect: /RENDERER: the overview slice/ },
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
  { id: 'explain-refused-actions-dropped', file: 'src/shared/pause-ui.ts', find: "        actions: c.mayBe.map((id) => ({ kind: 'pause' as const, wsId: id, label: `Mettre ${c.label(id)} en pause…` })),\n", rep: '', tests: [SHARED], expect: /explainPauseOutcome/ },
  { id: 'explain-covered-action-wrong-run', file: 'src/shared/pause-ui.ts', find: "actions: [{ kind: 'resume', wsId: c.cover.runId, label: `Reprendre ${c.cover.label}…` }]", rep: "actions: [{ kind: 'resume', wsId: c.runLabel, label: `Reprendre ${c.cover.label}…` }]", tests: [SHARED], expect: /explainResumeOutcome/ },
);

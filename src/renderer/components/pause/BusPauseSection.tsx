// Fleet Pause, option A (#257) — the "Pause de flotte" section of the Bus page: one header card per pause carrier (phase, N/M, the actions) and its Bilan de pause as a compact table.
// Pure render over `pauseOverview` (the store slice) — the page's own 2 s poll is untouched; the overview rides its own push. Nothing renders while no run holds a pause / Reprise.

import { useState } from 'react';
import { useStore } from '../../store';
import type { PauseUiExplain, PauseUiMember, PauseUiRun } from '../../../shared/pause-ui';
import { killedText, releasableIds, runHeadline, treeText } from '../../../shared/pause-ui-view';
import { PauseActionButton, PauseBadge, PauseBar, PauseExplain, PauseGlyph, PauseIcon, useNowTick } from './PauseBlocks';
import { runPause, runRelease, runReleaseAll, runResume, selectPauseOverview } from './pause-actions';

const VIA: Record<string, string> = { member: 'accusé', 'host-idle': 'au repos', trap: 'trap hôte' };

function BilanRow({ run, m, onRelease }: { run: PauseUiRun; m: PauseUiMember; onRelease: (m: PauseUiMember) => void }) {
  const b = m.bilan;
  return (
    <tr data-pause-bilan={m.wsId} data-pause-state={m.ui}>
      <td className="pause-bilan-agent"><PauseGlyph wsId={m.wsId} ui={m.ui} />{m.label}</td>
      <td className="pause-bilan-dim">{m.role === 'coordinator' ? 'coord.' : 'worker'}</td>
      <td><PauseBadge wsId={m.wsId} ui={m.ui} /></td>
      <td className="pause-bilan-dim">{m.confirmVia ? VIA[m.confirmVia] : '—'}</td>
      <td className="pause-bilan-ref" title={b?.snapshotRef ?? undefined}>{b?.snapshotRef ?? '—'}</td>
      <td>{b ? treeText(b) : '—'}</td>
      <td className="pause-bilan-dim" title={b?.killed.map((k) => k.cmd).join('\n')}>{b ? killedText(b) : "après l'escalade"}</td>
      <td className="pause-bilan-act">
        {run.phase === 'resuming' && m.ui === 'blocked' ? (
          <PauseActionButton kind="release" wsId={run.carrierRunId} tone="go" onClick={() => onRelease(m)}>Libérer</PauseActionButton>
        ) : null}
      </td>
    </tr>
  );
}

function RunCard({ run }: { run: PauseUiRun }) {
  const now = useNowTick(run.phase === 'pausing');
  const [explains, setExplains] = useState<PauseUiExplain[]>([]);
  const [repause, setRepause] = useState(false);
  const h = runHeadline(run, now);
  const actor = run.carrierRunId;
  const blocked = releasableIds(run).length;
  const act = async (p: Promise<PauseUiExplain[]>) => setExplains(await p);
  return (
    <div className="pause-run" data-pause-section={run.carrierRunId} data-pause-phase={run.phase} data-pause-mode={run.mode ?? ''}>
      <div className={`pause-run-head pause-run-${h.tone}`}>
        <span className={`pause-run-icon pause-t-${h.tone}`}><PauseIcon kind={h.tone === 'pausing' ? 'clock' : h.tone === 'resumed' ? 'play' : 'pause'} size={14} /></span>
        <div className="pause-run-title">
          <b>{h.title}</b> <span className="pause-run-carrier">{run.carrierLabel}</span>
          <div className="pause-run-sub">{h.sub}</div>
          {run.progress.missing.length > 0 && run.phase !== 'active' && <div className="pause-run-sub">manquent : {run.progress.missing.map((id) => run.members.find((m) => m.wsId === id)?.label ?? id.slice(0, 8)).join(', ')}</div>}
        </div>
        <div className="pause-run-prog">
          <PauseBar fraction={h.fraction} tone={h.tone} done={run.progress.done} total={run.progress.total} kind={run.progress.kind} />
          <div className="pause-run-count" data-pause-count={run.carrierRunId}>{h.count}</div>
        </div>
        <div className="pause-run-actions">
          {run.phase === 'pausing' && (
            <>
              <PauseActionButton kind="hard" wsId={actor} tone="warn" onClick={() => void act(runPause(actor, 'hard', null))}>Pause dure maintenant</PauseActionButton>
              <PauseActionButton kind="resume" wsId={actor} onClick={() => void act(runResume(actor, null))}>Reprendre</PauseActionButton>
            </>
          )}
          {run.phase === 'paused' && <PauseActionButton kind="resume" wsId={actor} tone="go" onClick={() => void act(runResume(actor, null))}>Reprendre</PauseActionButton>}
          {run.phase === 'resuming' && (
            <>
              {blocked > 0 && <PauseActionButton kind="release-all" wsId={actor} tone="go" onClick={() => void act(runReleaseAll(actor, run, null))}>Libérer les {blocked} bloqué{blocked > 1 ? 's' : ''}</PauseActionButton>}
              {!repause ? (
                <PauseActionButton kind="repause" wsId={actor} onClick={() => setRepause(true)}>Re-pause</PauseActionButton>
              ) : (
                <>
                  <PauseActionButton kind="soft" wsId={actor} tone="warn" onClick={() => { setRepause(false); void act(runPause(actor, 'soft', null)); }}>douce</PauseActionButton>
                  <PauseActionButton kind="hard" wsId={actor} tone="primary" onClick={() => { setRepause(false); void act(runPause(actor, 'hard', null)); }}>dure</PauseActionButton>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {explains.length > 0 && (
        <div className="pause-run-explains">
          {explains.map((e, i) => <PauseExplain key={i} explain={e} />)}
        </div>
      )}
      <h3>Bilan de pause</h3>
      <table className="pause-bilan">
        <thead>
          <tr><th>Agent</th><th>Rôle</th><th>État</th><th>Accusé</th><th>Snapshot (git diff &lt;head&gt; &lt;ref&gt;)</th><th>Arbre</th><th>Outils</th><th /></tr>
        </thead>
        <tbody>
          {run.members.map((m) => <BilanRow key={m.wsId} run={run} m={m} onRelease={(t) => void act(runRelease(actor, t.wsId, run.carrierRunId, null))} />)}
        </tbody>
      </table>
      {run.phase === 'resuming' && run.blocked.length > 0 && (
        <div className="pause-run-sub pause-run-blocked">Bloqués : {run.blocked.map((id) => run.members.find((m) => m.wsId === id)?.label ?? id.slice(0, 8)).join(', ')} — leur coordinateur les libère (<code>orchestra run release</code>) ; vous pouvez aussi les libérer ici.</div>
      )}
    </div>
  );
}

/** Rendered by BusPane after the live-switch summary; null while nothing is paused or resuming. */
export function BusPauseSection() {
  const o = useStore(selectPauseOverview);
  if (!o || !o.available || o.runs.length === 0) return null;
  return (
    <section className="bus-section" data-section="pause">
      <h3>Pause de flotte</h3>
      {o.runs.map((r) => <RunCard key={`${r.carrierRunId}@${r.pausedAt}`} run={r} />)}
    </section>
  );
}

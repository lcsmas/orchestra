import { useState } from 'react';
import type { Workspace } from '../../shared/types';

interface Props {
  ws: Workspace;
  onClose: () => void;
}

type Stage = 'form' | 'committing' | 'pushing' | 'creating' | 'done' | 'error';

export function PRModal({ ws, onClose }: Props) {
  const [title, setTitle] = useState(ws.lastTask?.split('\n')[0]?.slice(0, 72) ?? ws.branch);
  const [body, setBody] = useState(ws.lastTask ?? '');
  const [commitMsg, setCommitMsg] = useState(title);
  const [stage, setStage] = useState<Stage>('form');
  const [result, setResult] = useState('');
  const [err, setErr] = useState('');

  const run = async () => {
    try {
      setStage('committing');
      await window.orchestra.commit(ws.id, commitMsg).catch(() => {
        // no-op if nothing to commit
      });
      setStage('pushing');
      await window.orchestra.push(ws.id);
      setStage('creating');
      const url = await window.orchestra.createPR(ws.id, title, body);
      setResult(url);
      setStage('done');
    } catch (e) {
      setErr((e as Error).message);
      setStage('error');
    }
  };

  return (
    <div
      className="modal-backdrop"
      // Close only when the press starts on the backdrop, so a text-selection
      // drag that ends over the backdrop doesn't dismiss the dialog mid-edit.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <h2>Open pull request</h2>
        {stage === 'form' && (
          <>
            <div className="field">
              <label>Commit message</label>
              <input value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)} />
            </div>
            <div className="field">
              <label>PR title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field">
              <label>PR body</label>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              Will commit, push <code>{ws.branch}</code>, and run <code>gh pr create</code>.
            </div>
            <div className="modal-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={run}>Open PR</button>
            </div>
          </>
        )}
        {stage !== 'form' && stage !== 'done' && stage !== 'error' && (
          <div style={{ padding: '20px 0' }}>
            {stage === 'committing' && 'Committing changes…'}
            {stage === 'pushing' && 'Pushing to origin…'}
            {stage === 'creating' && 'Creating PR via gh…'}
          </div>
        )}
        {stage === 'done' && (
          <div>
            <p>PR opened:</p>
            <p><a href={result} target="_blank" rel="noreferrer">{result}</a></p>
            <div className="modal-actions">
              <button className="primary" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
        {stage === 'error' && (
          <div>
            <p style={{ color: 'var(--red)' }}>Error: {err}</p>
            <div className="modal-actions">
              <button onClick={() => setStage('form')}>Back</button>
              <button onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

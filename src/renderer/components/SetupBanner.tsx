import { useState } from 'react';
import type { Workspace } from '../../shared/types';

interface Props {
  workspace: Workspace;
}

/** Inline banner above the workspace pane. Renders only while the setup
 * script is running or has failed — `ok`/`undefined` means out of the way. */
export function SetupBanner({ workspace }: Props) {
  const status = workspace.setupStatus;
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState('');
  const [retrying, setRetrying] = useState(false);

  if (status !== 'running' && status !== 'failed') return null;

  const onViewLog = async () => {
    if (logOpen) {
      setLogOpen(false);
      return;
    }
    try {
      const text = await window.orchestra.readSetupLog(workspace.id);
      setLog(text || '(no setup log captured yet)');
      setLogOpen(true);
    } catch (err) {
      setLog(`failed to read setup log: ${(err as Error).message}`);
      setLogOpen(true);
    }
  };

  const onRetry = async () => {
    setRetrying(true);
    try {
      await window.orchestra.retrySetup(workspace.id);
      // Banner auto-hides on success via setupStatus change.
    } catch (err) {
      setLog((prev) => `${prev}\n\nretry failed: ${(err as Error).message}`);
      setLogOpen(true);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={`setup-banner ${status}`}>
      <div className="setup-banner-row">
        {status === 'running' ? (
          <>
            <span className="setup-banner-spinner" aria-hidden="true" />
            <div className="setup-banner-text">
              <strong>Running setup script…</strong>
              <span className="setup-banner-sub">First-time setup for this worktree</span>
            </div>
            <button onClick={onViewLog}>{logOpen ? 'Hide log' : 'View log'}</button>
          </>
        ) : (
          <>
            <span className="setup-banner-x" aria-hidden="true">
              !
            </span>
            <div className="setup-banner-text">
              <strong>Setup script failed</strong>
              <span className="setup-banner-sub">
                {workspace.setupError || 'see log for details'}
              </span>
            </div>
            <button onClick={onViewLog}>{logOpen ? 'Hide log' : 'View log'}</button>
            <button className="primary" onClick={onRetry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </>
        )}
      </div>
      {logOpen && <pre className="setup-banner-log">{log}</pre>}
    </div>
  );
}

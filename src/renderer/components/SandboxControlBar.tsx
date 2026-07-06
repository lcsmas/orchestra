/**
 * Read-only banner for sandbox-hosted workspaces (cross-machine ownership,
 * P4 item C). A sandbox accepts several attached machines but exactly one —
 * the driver — may type; the shim broadcasts who that is. When THIS machine
 * is not the driver, the bar names who is and offers an explicit take-over
 * (the previous driver drops to read-only and sees this same bar).
 *
 * Renders null for local workspaces, before the first broadcast, and while we
 * hold the drive — the common cases cost nothing.
 */
import { useEffect, useState } from 'react';
import type { Workspace, SandboxControlState } from '../../shared/types';

export function SandboxControlBar({ workspace }: { workspace: Workspace }) {
  const endpoint = workspace.host?.kind === 'sandbox' ? workspace.host.endpoint : null;
  const [state, setState] = useState<SandboxControlState | null>(null);

  useEffect(() => {
    if (!endpoint) return;
    let alive = true;
    // Seed from the manager's mirror (covers mounting after the broadcast),
    // then follow pushes. State is per ENDPOINT: one sandbox, one driver.
    void window.orchestra.sandboxControlState(workspace.id).then((s) => {
      if (alive && s) setState(s);
    });
    const off = window.orchestra.onSandboxControl((s) => {
      if (s.endpoint === endpoint) setState(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, [endpoint, workspace.id]);

  if (!endpoint || !state || state.isDriver) return null;

  return (
    <div className="sandbox-control-bar" role="status">
      <span className="sandbox-control-dot" aria-hidden="true" />
      <span className="sandbox-control-text">
        {state.driverId ? (
          <>
            Read-only — <strong>{state.driverName ?? state.driverId}</strong> is driving this
            sandbox
          </>
        ) : (
          <>Read-only — nobody is driving this sandbox</>
        )}
      </span>
      <button
        className="sandbox-control-take"
        title="Make this machine the driver — the current driver becomes read-only"
        onClick={() => void window.orchestra.takeSandboxControl(workspace.id)}
      >
        Take control
      </button>
    </div>
  );
}

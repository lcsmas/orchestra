import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { BootStallBadgeView, BootStallRowView } from './BootStallView';

/** 1 s clock, mounted only while a workspace is boot-stalled (cheap). */
function useSecondClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function useBootStallSince(workspaceId: string): number | null {
  return useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.bootStallSince ?? null);
}

/** Sidebar badge: "⚠ 1 min 12" while the CLI has shown no proof of life. */
export function BootStallBadge({ workspaceId }: { workspaceId: string }): React.ReactElement | null {
  const since = useBootStallSince(workspaceId);
  return since == null ? null : <TickingBadge since={since} />;
}
function TickingBadge({ since }: { since: number }) {
  const now = useSecondClock();
  return <BootStallBadgeView since={since} now={Math.max(now, since)} />;
}

/** Composer row: live timer + Relancer, docked above the input. */
export function BootStallRow({ workspaceId }: { workspaceId: string }): React.ReactElement | null {
  const since = useBootStallSince(workspaceId);
  return since == null ? null : <TickingRow since={since} workspaceId={workspaceId} />;
}
function TickingRow({ since, workspaceId }: { since: number; workspaceId: string }) {
  const now = useSecondClock();
  const [busy, setBusy] = useState(false);
  return (
    <BootStallRowView
      since={since}
      now={Math.max(now, since)}
      busy={busy}
      onRestart={() => {
        setBusy(true);
        void window.orchestra.restartAgent(workspaceId).finally(() => setBusy(false));
      }}
    />
  );
}

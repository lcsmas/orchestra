import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import {
  BootStallBadgeView,
  BootStallRowView,
  BootWedgedBadgeView,
  BootWedgedRowView,
} from './BootStallView';

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

function useBootWedged(workspaceId: string): boolean {
  return useStore(
    (s) => (s.workspaces.find((w) => w.id === workspaceId)?.bootWedgedSince ?? null) != null,
  );
}

/** Sidebar badge. The WEDGED state (issue #197 — auto-restarts exhausted) WINS
 *  over the transient boot-stall badge: it is the terminal, human-needed state,
 *  so a workspace that reached the bound shows "bloquée", not a ticking timer. */
export function BootStallBadge({ workspaceId }: { workspaceId: string }): React.ReactElement | null {
  const wedged = useBootWedged(workspaceId);
  const since = useBootStallSince(workspaceId);
  if (wedged) return <BootWedgedBadgeView />;
  return since == null ? null : <TickingBadge since={since} />;
}
function TickingBadge({ since }: { since: number }) {
  const now = useSecondClock();
  return <BootStallBadgeView since={since} now={Math.max(now, since)} />;
}

/** Composer row: live timer + Relancer, docked above the input. The WEDGED row
 *  (issue #197) wins over the transient stall row, for the same reason. */
export function BootStallRow({ workspaceId }: { workspaceId: string }): React.ReactElement | null {
  const wedged = useBootWedged(workspaceId);
  const since = useBootStallSince(workspaceId);
  if (wedged) return <WedgedRow workspaceId={workspaceId} />;
  return since == null ? null : <TickingRow since={since} workspaceId={workspaceId} />;
}
function WedgedRow({ workspaceId }: { workspaceId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <BootWedgedRowView
      busy={busy}
      onRestart={() => {
        setBusy(true);
        void window.orchestra
          .restartAgent(workspaceId)
          .catch((e) => console.error('restartAgent failed', e))
          .finally(() => setBusy(false));
      }}
    />
  );
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
        void window.orchestra
          .restartAgent(workspaceId)
          .catch((e) => console.error('restartAgent failed', e))
          .finally(() => setBusy(false));
      }}
    />
  );
}

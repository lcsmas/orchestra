// Controls bar for the structured agent view: interrupt the in-flight turn,
// switch model, switch permission mode. All three call the reverse IPC A1 wired.
//
// Interrupt: window.orchestra.agentSdkInterrupt(wsId). Per spike (d), interrupt
// makes the SDK iterator throw; A1's manager folds that into a normal turn-end
// (stopReason 'interrupted') / error event. So this component only fires the IPC
// and reflects `session.running` — it never has to handle a crash itself.
//
// The model/permission switchers are AvMenus (custom glass dropdowns) — no
// field labels, the tinted icon + value carry the meaning.

import React from 'react';
import type { AgentPermissionMode, AgentSession } from '../../../shared/types';
import { AvMenu, type AvMenuItem } from './AvMenu';
import { MODEL_CHOICES, describeLiveModel, effectiveModel } from './model-util';

function icon(paths: React.ReactNode, viewBox = '0 0 16 16') {
  return (
    <svg
      width="14"
      height="14"
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}

const sparkles = icon(
  <>
    <path d="M8 2.2 9.4 6l3.8 1.4L9.4 8.8 8 12.6 6.6 8.8 2.8 7.4 6.6 6z" />
    <path d="M12.8 11.2l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" strokeWidth="1.2" />
  </>,
);
const zap = icon(<path d="M8.8 1.8 3.4 9h3.5l-.7 5.2L11.6 7H8.1z" />);
const feather = icon(
  <>
    <path d="M12.8 3.2c-2.9-1-6.2.3-7.7 3.1-1 1.9-1.2 4.6-1.3 6.5 1.9-.1 4.6-.3 6.5-1.3 2.8-1.5 4.1-4.8 3.1-7.7z" />
    <path d="M3.8 12.9 10.5 6" />
  </>,
);
const gear = icon(
  <>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 2.8v1.4M8 11.8v1.4M13.2 8h-1.4M4.2 8H2.8M11.7 4.3l-1 1M5.3 10.7l-1 1M11.7 11.7l-1-1M5.3 5.3l-1-1" />
  </>,
);
const shieldAsk = icon(
  <>
    <path d="M8 1.8 13 3.6v3.6c0 3.2-2 5.6-5 7-3-1.4-5-3.8-5-7V3.6z" />
    <path d="M6.6 6.3a1.5 1.5 0 1 1 2.1 1.8c-.4.2-.7.5-.7.9" strokeWidth="1.3" />
    <circle cx="8" cy="10.9" r="0.4" fill="currentColor" stroke="none" />
  </>,
);
const pencilCheck = icon(
  <>
    <path d="M9.5 3.5 12.5 6.5 6 13H3v-3z" />
    <path d="M10 12.2l1.3 1.3 2.4-2.6" strokeWidth="1.3" />
  </>,
);
const compass = icon(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M10.5 5.5 9 9l-3.5 1.5L7 7z" />
  </>,
);
const bolt = icon(
  <>
    <path d="M8 1.8 13 3.6v3.6c0 3.2-2 5.6-5 7-3-1.4-5-3.8-5-7V3.6z" opacity="0.45" />
    <path d="M8.7 4.6 6 8.4h1.9l-.5 3 2.7-3.8H8.2z" />
  </>,
);

/** Permission modes, in the order Claude Code presents them. Bypass is the
 *  default (Orchestra runs autonomous agents in isolated worktrees). */
const PERMISSION_ITEMS: (AvMenuItem & { value: AgentPermissionMode })[] = [
  {
    value: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'Everything runs unprompted',
    icon: bolt,
    tint: '#ffc857',
  },
  {
    value: 'acceptEdits',
    label: 'Auto-accept edits',
    description: 'File edits run without asking',
    icon: pencilCheck,
    tint: '#5bd68b',
  },
  {
    value: 'default',
    label: 'Ask each time',
    description: 'Every tool call needs approval',
    icon: shieldAsk,
    tint: '#6ea8ff',
  },
  {
    value: 'plan',
    label: 'Plan mode',
    description: 'Read-only — no changes',
    icon: compass,
    tint: '#8b7cff',
  },
];

/** Per-model icon + tint, zipped onto the pure {@link MODEL_CHOICES} data
 *  (kept in model-util.ts so it's unit-testable without React). */
const MODEL_ICONS: Record<string, { icon: React.ReactNode; tint: string }> = {
  'claude-fable-5': { icon: sparkles, tint: '#e0a3ff' },
  'claude-opus-4-8': { icon: sparkles, tint: '#8b7cff' },
  'claude-sonnet-5': { icon: zap, tint: '#6ea8ff' },
  'claude-haiku-4-5': { icon: feather, tint: '#7ee787' },
};

/** Model choices offered in the switcher. The live model is shown even if not
 *  in this list (from session.model — e.g. the account default resolves to a
 *  context-suffixed variant like `claude-opus-4-8[1m]`, surfaced verbatim by
 *  the `model`-not-in-list fallback below via {@link describeLiveModel}). */
const MODEL_ITEMS: AvMenuItem[] = MODEL_CHOICES.map((c) => ({
  ...c,
  ...(MODEL_ICONS[c.value] ?? { icon: gear, tint: '#949eb0' }),
}));

export function AgentControls({
  workspaceId,
  session,
  wsModel,
  wsPermissionMode,
}: {
  workspaceId: string;
  session: AgentSession | undefined;
  /** Persisted workspace model — the dropdown's source of truth before a session
   *  exists, so a pre-session choice sticks. A live session's model (once known)
   *  takes precedence as the actually-active value. */
  wsModel?: string;
  wsPermissionMode?: AgentPermissionMode;
}) {
  const running = session?.running ?? false;
  // Trust the folded session's model/mode only once it has actually INITED
  // (`session/init` is the only setter of sessionId). A history-backfilled
  // session (reopened workspace, no live subprocess) folds from emptySession —
  // model '' / permissionMode bypass — and those PLACEHOLDER values must not
  // mask the persisted ws choice: `session?.model ?? wsModel` never falls
  // through '', so picking a model on a reopened workspace looked like a no-op
  // (persisted fine, display never moved).
  const inited = Boolean(session?.sessionId);
  const mode =
    (inited ? session?.permissionMode : undefined) ?? wsPermissionMode ?? 'bypassPermissions';
  const explicitModel = effectiveModel(session, wsModel, '');

  // When nothing is explicitly chosen, show the account's DEFAULT model (read
  // from Claude Code's settings.json) instead of an opaque placeholder, so the
  // dropdown tells the user which model will actually run. Fetched once per
  // workspace and only while no explicit model is set; the live `session.model`
  // (once a turn starts) always supersedes it.
  const [defaultModel, setDefaultModel] = React.useState('');
  React.useEffect(() => {
    if (explicitModel) return; // an explicit choice already answers the question
    let alive = true;
    void window.orchestra.agentSdkDefaultModel(workspaceId).then((m) => {
      if (alive) setDefaultModel(m);
    });
    return () => {
      alive = false;
    };
  }, [workspaceId, explicitModel]);

  const model = explicitModel || defaultModel;

  const modelItems = MODEL_ITEMS.some((m) => m.value === model)
    ? MODEL_ITEMS
    : model
      ? [
          { value: model, ...describeLiveModel(model), icon: gear, tint: '#949eb0' },
          ...MODEL_ITEMS,
        ]
      : MODEL_ITEMS;

  return (
    <div className="av-controls" role="toolbar" aria-label="Agent controls">
      <button
        type="button"
        className="av-controls-interrupt av-btn av-btn-danger"
        disabled={!running}
        title={running ? 'Stop the current turn' : 'Nothing is running'}
        onClick={() => void window.orchestra.agentSdkInterrupt(workspaceId)}
      >
        <span className="av-controls-interrupt-dot" aria-hidden="true" />
        Interrupt
      </button>

      <div className="av-controls-menus">
        <AvMenu
          items={modelItems}
          value={model}
          placeholder="Account default"
          ariaLabel="Model"
          onSelect={(v) => void window.orchestra.agentSdkSetModel(workspaceId, v || undefined)}
        />
        <AvMenu
          items={PERMISSION_ITEMS}
          value={mode}
          ariaLabel="Permission mode"
          onSelect={(v) =>
            void window.orchestra.agentSdkSetPermissionMode(workspaceId, v as AgentPermissionMode)
          }
        />
      </div>
    </div>
  );
}

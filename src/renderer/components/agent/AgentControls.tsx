// Controls bar for the structured agent view: interrupt the in-flight turn,
// switch model, switch permission mode. All three call the reverse IPC A1 wired.
//
// Interrupt: window.orchestra.agentSdkInterrupt(wsId). Per spike (d), interrupt
// makes the SDK iterator throw; A1's manager folds that into a normal turn-end
// (stopReason 'interrupted') / error event. So this component only fires the IPC
// and reflects `session.running` — it never has to handle a crash itself.

import type { AgentPermissionMode, AgentSession } from '../../../shared/types';

/** Permission modes with human labels, in the order Claude Code presents them. */
const PERMISSION_MODES: { value: AgentPermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask each time' },
  { value: 'acceptEdits', label: 'Auto-accept edits' },
  { value: 'plan', label: 'Plan (read-only)' },
  { value: 'bypassPermissions', label: 'Bypass (allow all)' },
];

/** Model choices offered in the switcher. Empty value = session default. The
 *  live model is shown even if not in this list (from session.model). */
const MODELS: { value: string; label: string }[] = [
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

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
  // Prefer the live session's value when present (it's what's actually active),
  // else the persisted workspace choice, else the default. This makes the
  // dropdowns reflect a selection made before the first message is sent.
  const mode = session?.permissionMode ?? wsPermissionMode ?? 'default';
  const model = session?.model ?? wsModel ?? '';

  const modelOptions = MODELS.some((m) => m.value === model)
    ? MODELS
    : model
      ? [{ value: model, label: model }, ...MODELS]
      : MODELS;

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

      <label className="av-controls-field">
        <span className="av-controls-label">Model</span>
        <select
          className="av-controls-select av-controls-model"
          value={model}
          onChange={(e) =>
            void window.orchestra.agentSdkSetModel(workspaceId, e.target.value || undefined)
          }
        >
          {modelOptions.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label className="av-controls-field">
        <span className="av-controls-label">Permissions</span>
        <select
          className="av-controls-select av-controls-mode"
          value={mode}
          onChange={(e) =>
            void window.orchestra.agentSdkSetPermissionMode(
              workspaceId,
              e.target.value as AgentPermissionMode,
            )
          }
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentModelInfo } from '../../shared/types';
import {
  ACCOUNT_DEFAULT_MODEL,
  INITIAL_DEFAULT_MODEL,
  type ModelDefaultKind,
  type ModelDefaults,
} from '../../shared/model-defaults';
import { modelChoicesFrom, type ModelChoice } from './agent/model-util';

interface Props {
  /** A workspace to ask for the live model list (the list is per account/CLI);
   *  absent → the static fallback list. */
  workspaceId?: string;
  onClose: () => void;
}

const FIELDS: { kind: ModelDefaultKind; label: string; hint: string }[] = [
  {
    kind: 'workspace',
    label: 'New workspaces',
    hint: 'Workspaces you create yourself (sidebar, spawn from a Linear ticket).',
  },
  {
    kind: 'spawned',
    label: 'Spawned agents',
    hint: 'Workspaces an agent creates with orchestra spawn (no --model).',
  },
];

/** Options for one select: the account default first, then the model list,
 *  plus the stored value verbatim if no option covers it. */
function optionsFor(choices: ModelChoice[], value: string): { value: string; label: string }[] {
  const opts = [
    { value: ACCOUNT_DEFAULT_MODEL, label: 'Account default' },
    ...choices
      .filter((c) => c.value !== ACCOUNT_DEFAULT_MODEL)
      .map((c) => ({ value: c.value, label: `${c.label} — ${c.value}` })),
  ];
  if (value && !opts.some((o) => o.value === value)) opts.unshift({ value, label: value });
  return opts;
}

/** The two default models (CONTEXT.md "Default model"). A change applies to
 *  workspaces created AFTERWARDS only — each workspace keeps the model it was
 *  created with, and its Model dropdown still switches it. */
export function ModelDefaultsSettings({ workspaceId, onClose }: Props) {
  const [defaults, setDefaults] = useState<ModelDefaults>({
    workspace: INITIAL_DEFAULT_MODEL,
    spawned: INITIAL_DEFAULT_MODEL,
  });
  const [live, setLive] = useState<AgentModelInfo[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.orchestra.modelDefaults().then(setDefaults).catch(() => {});
    if (workspaceId) void window.orchestra.agentModels(workspaceId).then(setLive).catch(() => {});
  }, [workspaceId]);

  const choices = modelChoicesFrom(live);

  const change = async (kind: ModelDefaultKind, value: string) => {
    if (busy) return;
    setBusy(true);
    const prev = defaults;
    setDefaults({ ...defaults, [kind]: value });
    try {
      // Trust the backend's normalized echo over the optimistic state.
      setDefaults(await window.orchestra.setModelDefaults({ [kind]: value }));
    } catch {
      setDefaults(prev);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal sound-settings model-defaults-settings" role="dialog" aria-label="Default models">
        <h2>Default models</h2>
        <div className="sound-hint">
          The model a new workspace starts on when none is picked. <strong>Applies to
          workspaces created from now on</strong> — existing ones keep their model (switch it
          from their Model dropdown).
        </div>
        {FIELDS.map((f) => (
          <label className="field" key={f.kind}>
            <div className="field-head">
              <span className="field-label">{f.label}</span>
              <span className="field-hint">{f.hint}</span>
            </div>
            <select
              className="field-select"
              data-model-default={f.kind}
              value={defaults[f.kind]}
              disabled={busy}
              onChange={(e) => void change(f.kind, e.target.value)}
            >
              {optionsFor(choices, defaults[f.kind]).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

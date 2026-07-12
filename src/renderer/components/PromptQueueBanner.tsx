import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { formatResetsIn } from './UsageBars';
import { dialog } from './Dialog';
import { usageLimitedUntil, type UsageWindows } from '../../shared/accounts';
import type { Workspace } from '../../shared/types';

interface Props {
  workspace: Workspace;
}

/** Inline banner above the workspace pane, shown while the workspace's account
 * is over its usage limit (typing into the terminal would just burn the turn on
 * a "limit reached" error) — or while any prompts are still parked on the
 * queue. Offers a composer that queues prompts instead; the main-process
 * flusher (src/main/prompt-queue.ts) delivers the queue automatically once a
 * fresh usage reading shows the limit has reset. Same above-the-pane-row
 * placement as SetupBanner so the absolutely-positioned TerminalView can't
 * eclipse it. */
export function PromptQueueBanner({ workspace }: Props) {
  // Atomic selectors — same discipline as UsageBars: subscribe only to the
  // slices this banner reads so agent:tool ticks don't re-render it.
  const workspaceAccounts = useStore((s) => s.workspaceAccounts);
  const accountUsage = useStore((s) => s.accountUsage);
  const globalUsage = useStore((s) => s.globalUsage);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const queue = workspace.queuedPrompts ?? [];

  // The freshest usage reading for this workspace's login — mirrors the
  // main-process flusher's source selection (pinned account → per-account
  // poller; default login → global poller).
  const wsAccount = workspaceAccounts[workspace.id];
  const accountId = wsAccount?.accountId ?? null;
  const data: UsageWindows | null = accountId
    ? accountUsage[accountId]?.data ?? null
    : globalUsage;
  const limitedUntil = data ? usageLimitedUntil(data, now) : null;
  const limited = limitedUntil !== null;
  const visible = limited || queue.length > 0;

  // Keep the countdown moving while visible; a minute of drift is fine.
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [visible]);

  if (!visible) return null;

  const label = wsAccount?.label ?? 'default';
  const resets = limited ? formatResetsIn(new Date(limitedUntil).toISOString(), now) : '';

  const onQueue = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await window.orchestra.queuePrompt(workspace.id, text);
      setDraft('');
    } catch (e) {
      void dialog.error(`Could not queue prompt: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onSendNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await window.orchestra.flushQueuedPrompts(workspace.id);
      if (!res.ok) void dialog.error(`Could not send queued prompts: ${res.error ?? 'unknown error'}`);
    } catch (e) {
      void dialog.error(`Could not send queued prompts: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onRemove = (promptId: string) => {
    void window.orchestra.removeQueuedPrompt(workspace.id, promptId).catch(() => {});
  };

  return (
    <div className={`queue-banner${limited ? ' limited' : ''}`}>
      <div className="queue-banner-row">
        <span className="queue-banner-icon" aria-hidden="true">⏳</span>
        <div className="queue-banner-text">
          {limited ? (
            <>
              <strong>
                Usage limit reached ({label}){resets ? ` — ${resets}` : ''}
              </strong>
              <span className="queue-banner-sub">
                Queue prompts below — they're sent automatically when the limit resets.
              </span>
            </>
          ) : (
            <>
              <strong>
                {queue.length} queued prompt{queue.length === 1 ? '' : 's'}
              </strong>
              <span className="queue-banner-sub">
                Sending automatically once a fresh usage check confirms the reset.
              </span>
            </>
          )}
        </div>
        {queue.length > 0 && (
          <button className="primary" onClick={() => void onSendNow()} disabled={busy}>
            Send now
          </button>
        )}
      </div>
      {queue.length > 0 && (
        <ul className="queue-banner-list">
          {queue.map((p, i) => (
            <li key={p.id} className="queue-banner-item" title={p.text}>
              <span className="queue-banner-item-n">{i + 1}</span>
              <span className="queue-banner-item-text">{p.text}</span>
              <button
                className="queue-banner-item-x"
                onClick={() => onRemove(p.id)}
                title="Remove from queue"
                aria-label="Remove queued prompt"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="queue-banner-compose">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter queues; Shift+Enter inserts a newline — the same submit
            // gesture as the agent TUI the user would otherwise be typing into.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onQueue();
            }
          }}
          placeholder={`Prompt for ${workspace.branch} — queued until the limit resets…`}
          rows={2}
          spellCheck={false}
        />
        <button onClick={() => void onQueue()} disabled={busy || !draft.trim()}>
          Queue
        </button>
      </div>
    </div>
  );
}

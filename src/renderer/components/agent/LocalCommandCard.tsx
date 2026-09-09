import React from 'react';
import type { RenderMessage } from '../../../shared/types';

interface Props {
  message: RenderMessage;
}

/**
 * Renders a `local-command` RenderMessage — a `!command` bash-mode run (composer
 * bash mode, parity with Claude Code), or an Orchestra-answered slash command
 * like `/status`. Shows the command with a chip naming what actually ran, a
 * running spinner while it executes, then its captured stdout/stderr in a mono
 * block with a non-zero exit code badge. The command ran LOCALLY in the
 * worktree (not the model); its output is also fed to the agent's next turn.
 *
 * Memoized on the fields that affect output so an unrelated token delta elsewhere
 * (which produces a new session object each RAF flush) doesn't re-render it.
 */
function LocalCommandCardImpl({ message }: Props) {
  const lc = message.localCommand;
  if (!lc) return null;
  const { command, running, output, exitCode } = lc;
  const failed = exitCode !== null && exitCode !== undefined && exitCode !== 0;
  // Orchestra answers a few slash commands itself (see sdkStatus) and reports
  // them through this same row; labelling those `bash` would be a lie.
  const chip = command.startsWith('/') ? command.split(/\s/)[0] : 'bash';
  const hasOutput = typeof output === 'string' && output.length > 0;

  return (
    <div className="av-localcmd" data-running={running ? 'true' : 'false'} data-failed={failed ? 'true' : 'false'}>
      <div className="av-localcmd-head">
        <span className="av-localcmd-chip">{chip}</span>
        {chip === 'bash' && <code className="av-localcmd-cmd">{command}</code>}
        {running ? (
          <span className="av-localcmd-spinner" aria-label="Running" title="Running" />
        ) : failed ? (
          <span className="av-localcmd-exit" title={`Exited with code ${exitCode}`}>
            exit {exitCode}
          </span>
        ) : null}
      </div>
      {hasOutput ? (
        <pre className="av-localcmd-output">
          <code>{output}</code>
        </pre>
      ) : !running ? (
        <div className="av-localcmd-empty">(no output)</div>
      ) : null}
    </div>
  );
}

function areEqual(a: Props, b: Props): boolean {
  const x = a.message.localCommand;
  const y = b.message.localCommand;
  return (
    a.message.id === b.message.id &&
    x?.command === y?.command &&
    x?.running === y?.running &&
    x?.output === y?.output &&
    x?.exitCode === y?.exitCode
  );
}

export const LocalCommandCard = React.memo(LocalCommandCardImpl, areEqual);

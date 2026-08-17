import React, { useState } from 'react';
import type { OversizedMemoryNotice } from '../../../shared/types';
import { formatChars, formatLimit } from '../../../shared/memory-size';

/**
 * Pinned warning strip for CLAUDE.md memory files over the model's per-file
 * char limit — Orchestra's rendering of the banner the Claude Code CLI prints
 * at startup but never sends over the wire (main measures it; see
 * `src/main/memory-files.ts` and `src/shared/memory-size.ts`).
 *
 * Pinned rather than folded into the transcript because it describes a standing
 * property of the environment: it stays true until the user edits the file, so
 * a row that scrolls away after one turn would be the wrong shape.
 *
 * Dismissal is per-mount and deliberately NOT persisted — the condition is
 * cheap to re-surface at the next session start, and a dismissal remembered
 * across restarts would silently hide a warning that is still true.
 */
function MemorySizeBannerImpl({ files }: { files: OversizedMemoryNotice[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (!files.length || dismissed) return null;

  return (
    <div className="av-memory-banner" role="status">
      <span className="av-memory-banner-icon" aria-hidden>
        ⚠
      </span>
      <div className="av-memory-banner-body">
        {files.map((f) => (
          <div key={f.path} className="av-memory-banner-line">
            <span className="av-memory-banner-path">{f.path}</span> is over the{' '}
            {formatLimit(f.limit)}-char limit ({formatChars(f.chars)} chars)
            <span className="av-memory-banner-hint"> · /memory to free up context</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="av-memory-banner-close"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss memory size warning"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export const MemorySizeBanner = React.memo(MemorySizeBannerImpl);

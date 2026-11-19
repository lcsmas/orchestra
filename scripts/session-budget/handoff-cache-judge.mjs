// Pure judgement of the handoff-cache rig (#466) — split from handoff-cache.mjs (which RUNS the rig on import) so a unit test can drive it.

/** Anthropic's published cache price multipliers on the base input price: write 1.25×, read 0.1×. Base-input-token equivalents. */
export const weighted = (r, prev = false) => { const u = prev ? r.prevOnly : r; return Math.round(u.cacheCreationTokens * 1.25 + u.cacheReadTokens * 0.1); };

/** Judge one arm's report against the baseline's. `drop` = the claim: the handoff arm's cache-read total is LOWER than the baseline's. Pure — unit-tested. */
export function judgeHandoffCache(kind, r, baseline) {
  const common = {
    ran: !r.error && r.mainRequests >= r.turns,
    controlsRefuse: r.controlWrongKey === 'handoff-unvouched' && r.controlNoRun === 'handoff-outside-run',
  };
  if (kind === 'baseline') return { ...common, quiet: r.nudges === 0 && r.handoffsDispatched === 0 && r.openingRequests === 0 };
  return {
    ...common,
    nudged: r.nudgeRequests >= 2 && r.nudgeRequests === r.nudges,
    handedOff: r.handoffsDispatched >= 2 && r.dispatchResults.every((d) => d === 'scheduled') && r.handoffFiles === r.handoffsDispatched,
    opened: r.openingRequests === r.handoffsDispatched && r.freshContextAfterHandoff === true,
    drop: !!baseline && r.cacheReadTokens < baseline.cacheReadTokens && r.lastRequestTokens < baseline.lastRequestTokens,
  };
}


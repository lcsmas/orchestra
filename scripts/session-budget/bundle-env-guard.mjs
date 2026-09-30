// FIRST import of bundle-entry.mjs (C4 #211): ES import order is evaluation order, so this runs before agent-sdk /
// store / logger can read HOME, ORCHESTRA_HOME or CLAUDE_CONFIG_DIR at module load. The launcher (harness.mjs
// `launch.env`) must hand the bundle a SCRATCH env; a packaged run that inherited the app's live one would run
// account-inheritance sync against the user's real ~/.claude* (incidents 2026-09-29/30). Refuses, never repairs.
import { assertScratch } from './scratch-guard.mjs';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
if (!cfg.root) throw new Error('session-budget bundle: SB_CONFIG.root missing — this bundle is launched by the harness, not by hand');
// `cfg.live ?? []` would FAIL OPEN for a caller that skips the harness (review of #208 F10): the list of live dirs is mandatory.
if (!Array.isArray(cfg.live) || cfg.live.length === 0) throw new Error('scratch-guard: REFUSED SB_CONFIG.live missing/empty — the harness must hand over the live-dir list');
for (const k of ['HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) {
  if (!process.env[k]) throw new Error(`scratch-guard: REFUSED ${k} unset — the launcher must pin a scratch ${k} before the bundle loads`);
  assertScratch(k, process.env[k], cfg.root, cfg.live);
}

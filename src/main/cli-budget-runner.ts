// Production wiring of the CLI-version budget re-run (#211): binds ./cli-budget-rerun.ts to the platform seam, the
// logger, the harness, and — what makes it work in a PACKAGED app, which has no `src/` and no repo checkout — the
// BUNDLED runner `dist-electron/session-budget.js` (built by `pnpm run build:session-budget`, required by the
// afterPack check), launched as this very executable with ELECTRON_RUN_AS_NODE. Absent bundle (a `pnpm dev` tree
// that never built it) ⇒ skip + one log line, never a repo-relative fallback.
import fs from 'node:fs';
import path from 'node:path';
import { orchestraHome, platform } from './platform';
import { scoped } from './logger';
import { resolveClaudeBinary } from './claude-binary.ts';
import { detectContainment, runSessionArm } from '../../scripts/session-budget/harness.mjs';
import {
  makeVersionProbe,
  sampleResources,
  startCliBudgetRerun,
  type CliBudgetDeps,
} from './cli-budget-rerun.ts';

const log = scoped('cli-budget');

/** `dist-electron/` — where main.js, keeper.js and session-budget.js sit, in dev and inside app.asar alike. */
const bundleDir = (): string => __dirname;
const runnerBundle = (): string => path.join(bundleDir(), 'session-budget.js');
const keeperBundle = (): string => path.join(bundleDir(), 'keeper.js');

let containment: ReturnType<typeof detectContainment> | null = null;
/** Probed once (two `bwrap … true` spawns): the host's containment cannot change while the app runs. */
const hostContainment = () => (containment ??= detectContainment());

export function cliBudgetDeps(): CliBudgetDeps {
  return {
    home: orchestraHome(),
    now: () => Date.now(),
    probeVersion: makeVersionProbe(resolveClaudeBinary),
    supported: process.platform === 'linux', // the census + containment read /proc and use bwrap
    runnerAvailable: () => fs.existsSync(runnerBundle()) && fs.existsSync(keeperBundle()),
    // D6: an unattended run needs the network namespace (no path to a real host by construction) — else skip + one log line.
    containmentOk: () => hostContainment().name === 'netns+pidns',
    resources: sampleResources,
    notify: (n) => {
      // The OS toast is not observable headless; this line is the call-site evidence (D5: log line + existing notice only).
      log.info(`notice: ${n.title} — ${n.body}`);
      platform.notify({ wsId: '', kind: 'needsInput', title: n.title, body: n.body });
    },
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
    async runSuite({ signal, killAfterMs, turnTimeoutMs, nice }) {
      const result = await runSessionArm({
        repo: path.resolve(bundleDir(), '..'),
        arm: 'cli-version-rerun',
        containment: hostContainment(),
        timeoutMs: turnTimeoutMs,
        killAfterMs,
        niceness: nice,
        signal,
        launch: (root) => ({
          argv: [process.execPath, runnerBundle()],
          cwd: root,
          // The runner refuses a non-scratch env (bundle-env-guard.mjs): pin all three BEFORE it loads.
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            ORCHESTRA_HOME: path.join(root, 'orchestra'),
            CLAUDE_CONFIG_DIR: path.join(root, 'home', '.claude'),
          },
        }),
      });
      return { result, timedOut: result.rc === 'TIMEOUT', cancelled: result.rc === 'CANCELLED' || signal.aborted };
    },
  };
}

/** Called once from index.ts after boot. Idempotent. */
export function startCliBudgetWatch(): void {
  startCliBudgetRerun(cliBudgetDeps());
}

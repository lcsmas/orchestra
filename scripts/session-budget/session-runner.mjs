// One session-budget run, INSIDE its containment (see harness.mjs): Orchestra's REAL session path —
// agent-sdk.ts `sdkSend` → `ensureSession` → SDK `query()` → the real detached KEEPER → the real `claude`
// CLI — in a generated heavy fixture repo, against the LOCAL FAKE Anthropic API (zero tokens, D6).
// Module state in agent-sdk.ts is global, so ONE run per process. Config arrives as JSON in SB_CONFIG;
// the last stdout line is the JSON result `{ report, judgement }`. The run BODY is session-run.mjs `runSession` (shared
// with the bundled runner a packaged app ships, C4 #211); this file is the SOURCE loader: guard + pin env FIRST, then import.
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
const { REPO, root, arm, mutant = null, replyDelayMs = 500, settleMs = 2500, timeoutMs = 90_000, pidns = false, containment = 'proxy-only', profile = {}, realApi = null } = cfg;
const HERE = path.join(REPO, 'scripts', 'session-budget');

// D7: scratch HOME / config dir / ORCHESTRA_HOME only — refuse anything live BEFORE the app can boot.
const { assertScratch } = await import(`${HERE}/scratch-guard.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
// Fails CLOSED: without the invoker's live-dir list the guard would compare against nothing (F10).
if (!Array.isArray(cfg.live) || cfg.live.length === 0) throw new Error('session-runner: cfg.live (the invoker\'s live-dir list) is absent or empty — refusing to run without the scratch guard\'s live list');
for (const [label, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(label, p, root, cfg.live);
fs.mkdirSync(cfgDir, { recursive: true });
fs.mkdirSync(orchHome, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = orchHome;
process.env.CLAUDE_CONFIG_DIR = cfgDir;

if (mutant) register(pathToFileURL(`${HERE}/mutants.mjs`).href, { parentURL: import.meta.url, data: { mutant } });

const { startFakeApi } = await import(`${HERE}/fake-anthropic-api.mjs`);
const { generateHeavyFixture } = await import(`${HERE}/fixture.mjs`);
const { census } = await import(`${HERE}/proc-census.mjs`);
const { judgeSessionBudget, summarizeWindow, egressUpTo, TRAFFIC_KNOBS, STARTUP_CUT_MARGIN_MS } = await import(`${REPO}/src/shared/session-budget.ts`);
const { runSession } = await import(`${HERE}/session-run.mjs`);
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const keeper = await import(`${REPO}/src/main/keeper-client.ts`);

const result = await runSession(cfg, { startFakeApi, generateHeavyFixture, census, judgeSessionBudget, summarizeWindow, egressUpTo, TRAFFIC_KNOBS, STARTUP_CUT_MARGIN_MS, initPlatform, store, sdk, keeper });
console.log(JSON.stringify(result));
process.exit(0);

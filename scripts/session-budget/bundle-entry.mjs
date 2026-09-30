// The BUNDLED session-budget runner (C4 #211): built by `pnpm run build:session-budget` to
// dist-electron/session-budget.js and shipped in the packaged app, which has no `src/` tree and (Electron 33 =
// Node 20) no --experimental-strip-types. Same `runSession` as the source runner, every module passed in
// statically. Launched by the harness (`runSessionArm({ launch })`), one session per process:
//   ELECTRON_RUN_AS_NODE=1 <execPath> <asar>/dist-electron/session-budget.js     (SB_CONFIG = the run's JSON)
import './bundle-env-guard.mjs'; // MUST stay first — refuses a non-scratch env before anything else loads
import fs from 'node:fs';
import path from 'node:path';
import { startFakeApi } from './fake-anthropic-api.mjs';
import { generateHeavyFixture } from './fixture.mjs';
import { census } from './proc-census.mjs';
import { runSession } from './session-run.mjs';
import fakeMcpSource from './fake-mcp-server.mjs?raw';
import { judgeSessionBudget, summarizeWindow, egressUpTo, TRAFFIC_KNOBS, STARTUP_CUT_MARGIN_MS } from '../../src/shared/session-budget.ts';
import { initPlatform } from '../../src/main/platform/index.ts';
import { store } from '../../src/main/store.ts';
import * as sdk from '../../src/main/agent-sdk.ts';
import * as keeper from '../../src/main/keeper-client.ts';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');

/** The fixture's MCP servers point at `fake-mcp-server.mjs` next to the fixture module — a path that does not
 *  exist inside an asar bundle, and `process.execPath` is Electron (needs ELECTRON_RUN_AS_NODE, which the CLI
 *  does NOT forward to stdio MCP servers). Write the embedded server out and repoint `.mcp.json`. */
function repointMcp(fixtureDir, scratchRoot) {
  const script = path.join(scratchRoot, 'fake-mcp-server.mjs');
  fs.writeFileSync(script, fakeMcpSource);
  const file = path.join(fixtureDir, '.mcp.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of Object.values(j.mcpServers)) {
    s.args = [script, ...s.args.slice(1)];
    if (process.versions.electron) s.env = { ...(s.env ?? {}), ELECTRON_RUN_AS_NODE: '1' };
  }
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}

const mods = {
  startFakeApi, census, judgeSessionBudget, summarizeWindow, egressUpTo, TRAFFIC_KNOBS, STARTUP_CUT_MARGIN_MS, initPlatform, store, sdk, keeper,
  generateHeavyFixture: (dir, profile) => {
    const fx = generateHeavyFixture(dir, profile);
    repointMcp(fx.dir, cfg.root);
    return fx;
  },
};

runSession({ ...cfg, keeperBundle: cfg.keeperBundle ?? path.join(__dirname, 'keeper.js') }, mods)
  .then((res) => { console.log(JSON.stringify(res)); process.exit(0); })
  .catch((e) => { console.error(`session-budget bundle: ${e?.stack ?? e}`); process.exit(2); });

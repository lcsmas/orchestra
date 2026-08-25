// reviewer-90 R1 probe: does recycleSession double-deliver / lose parked blocks?
// Drives the REAL session-watchdog recycleSession via watchdogTick, the REAL
// inbox-tray, and the REAL agent-sdk promptStream through __setQueryFactoryForTests.
// ARM: 'live' = the UserPromptSubmit hook drains the inbox when a turn starts
//               (what the SHIPPED shell hook does: cat "$f"; rm -f "$f").
//      'nohook' = CONTROL: hook never runs. If both arms print the same thing,
//               the rig is not sensitive to the hook and the measurement is void.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const RREPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
import fs from 'node:fs';
const ARM = process.argv[2] ?? 'live';

const tmpHome = `/tmp/rev90-home/${ARM}`;
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(`${tmpHome}/.orchestra/inbox`, { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${RREPO}/src/main/platform/index.ts`);
initPlatform({ kind:'headless-rev90', broadcast:()=>{}, broadcastPtyData:()=>{}, canBroadcast:()=>true,
  isFocused:()=>false, hasAttachedUi:()=>false, notify:()=>{}, openExternal:()=>{}, showItemInFolder:()=>{},
  openPath:()=>{}, openAccountLoginUrl:()=>{}, closeAccountLogin:()=>{}, getUserDataDir:()=>tmpHome,
  getLogsDir:()=>`${tmpHome}/logs`, getAppVersion:()=>'0.0.0-rev90', getAppMetrics:()=>[],
  isEncryptionAvailable:()=>false, encryptString:(s)=>s, decryptString:(s)=>s });

const { store } = await import(`${RREPO}/src/main/store.ts`);
const sdk = await import(`${RREPO}/src/main/agent-sdk.ts`);
const wd = await import(`${RREPO}/src/main/session-watchdog.ts`);
const tray = await import(`${RREPO}/src/main/inbox-tray.ts`);
const { serializeInboxBlocks } = await import(`${RREPO}/src/shared/inbox-blocks.ts`);

const WS = 'ws-rev90';
await store.load?.();
const CREATED = Date.now() - 60*60*1000;
await store.upsertWorkspace({ id: WS, name:'rev90', kind:'scratch', repoPath:'', worktreePath: tmpHome,
  status:'idle', createdAt: CREATED, hasInput:true, parkedInboxCount: 3,
  lastTurnStartAt: Date.now() - 40*60*1000 });

// Seed THREE distinguishable parked blocks (different expected values, per the
// wave rule: identical values cannot reveal a mix-up).
const BLOCKS = ['MSG-ALPHA from peer A', 'MSG-BRAVO from peer B', 'MSG-CHARLIE from peer C'];
const inboxFile = tray.inboxFilePath(WS);
fs.writeFileSync(inboxFile, serializeInboxBlocks(BLOCKS), 'utf8');
console.error('[rig] inbox seeded at', inboxFile, 'blocks=', tray.readInbox(WS).length);

// What the agent ACTUALLY receives, in order. This is the observable.
const received = [];
let hookDrains = 0;

sdk.__setQueryFactoryForTests(({ prompt }) => {
  void (async () => {
    try {
      for await (const m of prompt) {
        const c = m?.message?.content;
        const text = typeof c === 'string' ? c : (c?.map?.(b=>b.text).join('')??'');
        received.push(text);
        // ── THE SHELL HOOK. UserPromptSubmit fires on every turn start and runs
        //    `cat "$f"; rm -f "$f"` (workspaces.ts INBOX_INSTRUCTION_SCRIPT).
        if (ARM === 'live') {
          try {
            if (fs.statSync(inboxFile).size > 0) {
              const body = fs.readFileSync(inboxFile,'utf8');
              hookDrains++;
              for (const b of tray.readInbox(WS)) received.push(`HOOK-DRAIN:${b.text.trim()}`);
              fs.rmSync(inboxFile, { force:true });
            }
          } catch {}
        }
      }
    } catch {}
  })();
  let done = false;
  return { async *[Symbol.asyncIterator]() {
      yield { type:'system', subtype:'init', session_id:'rev90', tools:[], slash_commands:[] };
      let n=0;
      while(!done && n<2){
        await new Promise(r=>setTimeout(r,30));
        n++;
        yield { type:'result', subtype:'success', session_id:'rev90', is_error:false, num_turns:1,
                duration_ms:5, total_cost_usd:0, result:'ok' };
      }
      // Then SILENT forever: a genuine wedge. The rig backdates lastStreamAt
      // below so the watchdog's progress guard is satisfied and recycleSession
      // is actually REACHED -- otherwise this arm tests nothing.
      await new Promise(()=>{});
    }, interrupt: async()=>{done=true}, setModel: async()=>{}, setPermissionMode: async()=>{},
    mcpServerStatus: async()=>({}), supportedCommands: async()=>[], supportedModels: async()=>[] };
});

const keepalive = setInterval(()=>{},250);
// Watchdog baseline: observableSince far in the past so the stall age is real.
wd.__resetSessionWatchdogForTests(Date.now() - 50*60*1000);

// Sanity control: the detector MUST say stalled, else the whole run is vacuous.
const { workspaceQueueStall } = await import(`${RREPO}/src/shared/queue-stall.ts`);
const verdict = workspaceQueueStall(store.getWorkspace(WS), Date.now(), Date.now()-50*60*1000);
console.error('[rig] POSITIVE CONTROL decideQueueStall =', JSON.stringify(verdict));

// sdkSessionLive must be true for the recycle to fire -> start a session first.
await sdk.sdkSend(WS, 'preexisting turn');
await new Promise(r=>setTimeout(r,300));
const { sdkSessionLive } = await import(`${RREPO}/src/main/sdk-delivery.ts`);
console.error('[rig] sdkSessionLive =', sdkSessionLive(WS));
// Reset the observable list: we only care about what the RECYCLE delivers.
received.length = 0; hookDrains = 0;
// Re-seed (the preexisting turn's hook drain may have eaten it) so the recycle
// faces the field state: parked work + a live session.
fs.writeFileSync(inboxFile, serializeInboxBlocks(BLOCKS), 'utf8');
console.error('[rig] re-seeded, parked=', tray.readInbox(WS).length);

sdk.__backdateStreamForTests?.(WS, 11*60*1000);
const probeB = sdk.sdkGateProbe(WS);
console.error('[rig] PRE-TICK silentMs=', Date.now()-(probeB?.lastStreamAt??0), 'gateHeld=', probeB?.gateHeld);
await wd.watchdogTick(Date.now());
await new Promise(r=>setTimeout(r,900));

const remaining = tray.readInbox(WS).map(b=>b.text.trim());
const counts = {};
for (const r of received) {
  for (const b of BLOCKS) { if (r.includes(b)) counts[b] = (counts[b]??0)+1; }
}
clearInterval(keepalive);
console.log(JSON.stringify({
  arm: ARM,
  hookDrains,
  deliveredCounts: counts,
  duplicated: Object.entries(counts).filter(([,n])=>n>1).map(([k,n])=>`${k} x${n}`),
  neverDelivered: BLOCKS.filter(b=>!counts[b]),
  remainingInInbox: remaining.length,
  remainingTexts: remaining,
  rawReceived: received.map(r=>r.slice(0,60)),
}, null, 1));
process.exit(0);

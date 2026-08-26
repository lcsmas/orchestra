// reviewer-90 R2 probe: does the watchdog recycle a BUSY, HEALTHY session whose
// status reads 'idle' or 'waiting'? Both are field-observed states (issue #90
// body: "statuses show BOTH idle and running variants"; two provably-working
// sessions read idle) and 'waiting' is the DESIGNED state for a permission block.
//
// The subject is a session actively mid-turn (turnGate held, stream emitting)
// with parked mail and a status the app itself recorded.
// ARMS: idle | waiting | running(CONTROL, must NOT recycle for the RIGHT reason)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const RREPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
import fs from 'node:fs';
const ARM = process.argv[2] ?? 'idle';
const tmpHome = `/tmp/rev90-fp/${ARM}`;
fs.rmSync(tmpHome,{recursive:true,force:true}); fs.mkdirSync(`${tmpHome}/.orchestra/inbox`,{recursive:true});
process.env.ORCHESTRA_HOME = tmpHome; process.env.HOME = tmpHome;
const { initPlatform } = await import(`${RREPO}/src/main/platform/index.ts`);
initPlatform({ kind:'headless-rev90fp', broadcast:()=>{}, broadcastPtyData:()=>{}, canBroadcast:()=>true,
  isFocused:()=>false, hasAttachedUi:()=>false, notify:()=>{}, openExternal:()=>{}, showItemInFolder:()=>{},
  openPath:()=>{}, openAccountLoginUrl:()=>{}, closeAccountLogin:()=>{}, getUserDataDir:()=>tmpHome,
  getLogsDir:()=>`${tmpHome}/logs`, getAppVersion:()=>'0', getAppMetrics:()=>[],
  isEncryptionAvailable:()=>false, encryptString:(s)=>s, decryptString:(s)=>s });
const { store } = await import(`${RREPO}/src/main/store.ts`);
const sdk = await import(`${RREPO}/src/main/agent-sdk.ts`);
const wd = await import(`${RREPO}/src/main/session-watchdog.ts`);
const tray = await import(`${RREPO}/src/main/inbox-tray.ts`);
const { serializeInboxBlocks } = await import(`${RREPO}/src/shared/inbox-blocks.ts`);
const WS='ws-fp';
await store.load?.();
await store.upsertWorkspace({ id:WS, name:'fp', kind:'scratch', repoPath:'', worktreePath:tmpHome,
  status: ARM==='running'?'running':(ARM==='waiting'?'waiting':'idle'),
  createdAt: Date.now()-3*60*60*1000, hasInput:true, parkedInboxCount:1,
  lastTurnStartAt: Date.now()-45*60*1000 });
fs.writeFileSync(tray.inboxFilePath(WS), serializeInboxBlocks(['MSG-PARKED-WHILE-BUSY']),'utf8');

// The subject: a turn that is ACTIVELY EMITTING the whole time — unambiguously
// healthy and busy. It never produces a `result` only because it is still working.
let emitted=0, stop=false; let interrupted=false;
const yieldedTurns=[];
sdk.__setQueryFactoryForTests(({prompt})=>{
  void (async()=>{ try{ for await(const m of prompt){ yieldedTurns.push(m?.uuid); } }catch{} })();
  return { async *[Symbol.asyncIterator](){
      yield {type:'system',subtype:'init',session_id:'fp',tools:[],slash_commands:[]};
      while(!stop){ // CONSTANT PROGRESS: this is a live agent working.
        yield {type:'assistant',session_id:'fp',message:{role:'assistant',content:[{type:'text',text:`work ${++emitted}`}]}};
        await new Promise(r=>setTimeout(r,50));
      }
      await new Promise(()=>{});
    }, interrupt: async()=>{interrupted=true; stop=true;}, setModel:async()=>{}, setPermissionMode:async()=>{},
       mcpServerStatus:async()=>({}), supportedCommands:async()=>[], supportedModels:async()=>[] };
});
const ka=setInterval(()=>{},250);
await sdk.sdkSend(WS,'a long, healthy, still-emitting turn');
await new Promise(r=>setTimeout(r,400));
const emittedBefore = emitted;
const probe = sdk.sdkGateProbe(WS);
const { sdkSessionLive } = await import(`${RREPO}/src/main/sdk-delivery.ts`);
// Re-assert the PRECONDITION next to the verdict (drifts silently otherwise).
const wsNow = store.getWorkspace(WS);
console.error(`[rig] PRECONDITION status=${wsNow.status} parked=${tray.readInbox(WS).length} gateHeld=${probe?.gateHeld} live=${sdkSessionLive(WS)} emitting=${emittedBefore>0}`);
const { workspaceQueueStall } = await import(`${RREPO}/src/shared/queue-stall.ts`);
const obs = Date.now()-60*60*1000;
const verdict = workspaceQueueStall(wsNow, Date.now(), obs);
wd.__resetSessionWatchdogForTests(obs);
await wd.watchdogTick(Date.now());
await new Promise(r=>setTimeout(r,800));
const emittedAfter = emitted;
clearInterval(ka);
console.log(JSON.stringify({
  arm:ARM, status:wsNow.status,
  stallVerdict: verdict ? 'STALLED' : 'not-stalled',
  wasStillEmittingBeforeTick: emittedBefore,
  interruptedByWatchdog: interrupted,
  RECYCLED_A_HEALTHY_BUSY_AGENT: interrupted,
  sessionStillLive: sdkSessionLive(WS),
  turnsYielded: yieldedTurns.length,
},null,1));
process.exit(0);

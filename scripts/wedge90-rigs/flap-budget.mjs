// reviewer-90 R3: does the anti-flap budget get burned in 3 minutes and then
// the watchdog SILENTLY stands down forever? Drive 6 consecutive ticks against a
// workspace whose status never leaves 'idle' (the field condition), and count
// recycles + whether anything but a log line surfaces the stand-down.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const RREPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
import fs from 'node:fs';
const tmpHome='/tmp/rev90-flap'; fs.rmSync(tmpHome,{recursive:true,force:true});
fs.mkdirSync(`${tmpHome}/.orchestra/inbox`,{recursive:true});
process.env.ORCHESTRA_HOME=tmpHome; process.env.HOME=tmpHome;
const { initPlatform } = await import(`${RREPO}/src/main/platform/index.ts`);
const broadcasts=[];
initPlatform({ kind:'h', broadcast:(ch,...a)=>{broadcasts.push(ch)}, broadcastPtyData:()=>{}, canBroadcast:()=>true,
  isFocused:()=>false, hasAttachedUi:()=>false, notify:(...a)=>{broadcasts.push('NOTIFY:'+JSON.stringify(a).slice(0,80))},
  openExternal:()=>{}, showItemInFolder:()=>{}, openPath:()=>{}, openAccountLoginUrl:()=>{}, closeAccountLogin:()=>{},
  getUserDataDir:()=>tmpHome, getLogsDir:()=>`${tmpHome}/logs`, getAppVersion:()=>'0', getAppMetrics:()=>[],
  isEncryptionAvailable:()=>false, encryptString:(s)=>s, decryptString:(s)=>s });
const { store } = await import(`${RREPO}/src/main/store.ts`);
const sdk = await import(`${RREPO}/src/main/agent-sdk.ts`);
const wd = await import(`${RREPO}/src/main/session-watchdog.ts`);
const tray = await import(`${RREPO}/src/main/inbox-tray.ts`);
const { serializeInboxBlocks } = await import(`${RREPO}/src/shared/inbox-blocks.ts`);
const WS='ws-flap'; await store.load?.();
await store.upsertWorkspace({ id:WS,name:'flap',kind:'scratch',repoPath:'',worktreePath:tmpHome,
  status:'idle',createdAt:Date.now()-5*60*60*1000,hasInput:true,parkedInboxCount:1,
  lastTurnStartAt: Date.now()-60*60*1000 });
let interrupts=0, stop=false;
sdk.__setQueryFactoryForTests(({prompt})=>{
  void (async()=>{ try{ for await(const m of prompt){} }catch{} })();
  return { async *[Symbol.asyncIterator](){
      yield {type:'system',subtype:'init',session_id:'f',tools:[],slash_commands:[]};
      // Emits nothing further: a turn that starts but never reaches the spool,
      // so `status` never becomes 'running' -- exactly the field condition.
      await new Promise(()=>{});
    }, interrupt:async()=>{interrupts++;}, setModel:async()=>{}, setPermissionMode:async()=>{},
    mcpServerStatus:async()=>({}), supportedCommands:async()=>[], supportedModels:async()=>[] };
});
const ka=setInterval(()=>{},250);
const obs=Date.now()-2*60*60*1000;
wd.__resetSessionWatchdogForTests(obs);
// seed a live session
await sdk.sdkSend(WS,'seed'); await new Promise(r=>setTimeout(r,300));
const rows=[];
const T0=Date.now();
for(let i=0;i<6;i++){
  // ticks 60s apart, as the real TICK_MS
  const now=T0 + i*60_000;
  fs.writeFileSync(tray.inboxFilePath(WS), serializeInboxBlocks([`PARKED-${i}`]),'utf8');
  await store.upsertWorkspace({...store.getWorkspace(WS), parkedInboxCount:1});
  const before=interrupts;
  // Backdate the stream stamp EVERY tick. Without this the rig is VACUOUS on a
  // build carrying the review-R1 progress guard: decideSessionRecycle refuses
  // any session whose stream is not silent for GATE_SILENCE_RELEASE_MS, so the
  // recycle is never reached and the arm prints totalRecycles:0 -- which reads
  // like "anti-flap works" and actually means "nothing was measured".
  // Measured 2026-08-26 on 545de4b: without this line, 0/6 ticks recycle.
  sdk.__backdateStreamForTests?.(WS, 11*60*1000);
  await wd.watchdogTick(now);
  await new Promise(r=>setTimeout(r,250));
  const ws=store.getWorkspace(WS);
  rows.push({tick:i, minutes:i, recycled:interrupts>before, status:ws.status,
             lastTurnStartAgeMin: Math.round((now-(ws.lastTurnStartAt??0))/60000)});
}
clearInterval(ka);
if(interrupts===0){ console.error('[rig] VACUITY GUARD: 0 recycles across all ticks -- the rig did not reach recycleSession. Refusing a verdict.'); }
console.log(JSON.stringify({
  totalRecycles:interrupts, perTick:rows,
  // Did ANYTHING reach a human surface? (broadcast channels / notify)
  surfacedChannels:[...new Set(broadcasts)].filter(c=>!c.startsWith('agent:')),
},null,1));
process.exit(0);

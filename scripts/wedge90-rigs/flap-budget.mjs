// reviewer-90 R3: does the anti-flap budget get burned in 3 minutes and then
// the watchdog SILENTLY stands down forever? Drive 6 consecutive ticks against a
// workspace whose status never leaves 'idle' (the field condition), and count
// recycles + whether anything but a log line surfaces the stand-down.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const RREPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
import fs from 'node:fs';
// Home is isolated per-run so the unit-test harness can drive it in parallel
// without colliding on one /tmp dir (default keeps the reviewer's manual path).
const tmpHome=process.env.FLAP_HOME||'/tmp/rev90-flap'; fs.rmSync(tmpHome,{recursive:true,force:true});
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
// 14 ticks, 60s apart (real TICK_MS). Long enough that the #97 WIDENING backoff
// spaces the 3 budgeted recycles (T0, then ~+2min, then ~+6min as the interval
// doubles), the budget is spent, and the watchdog then STANDS DOWN -- so the
// flap-limit surface actually fires within the run. The pre-#97 build recycled
// on 3 CONSECUTIVE ticks (0,1,2) and stood down by tick 3; the spacing below is
// itself the observable difference the backoff produces.
const TICKS=14;
const recycleTicks=[];    // which ticks actually recycled (spacing = the backoff)
let flapLimitTick=null;   // first tick the surface fired
for(let i=0;i<TICKS;i++){
  // ticks 60s apart, as the real TICK_MS
  const now=T0 + i*60_000;
  fs.writeFileSync(tray.inboxFilePath(WS), serializeInboxBlocks([`PARKED-${i}`]),'utf8');
  await store.upsertWorkspace({...store.getWorkspace(WS), parkedInboxCount:1});
  const before=interrupts;
  const chBefore=broadcasts.length;
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
  const recycled=interrupts>before;
  if(recycled) recycleTicks.push(i);
  const firedFlap=broadcasts.slice(chBefore).some(c=>c==='watchdog:flap-limit');
  if(firedFlap && flapLimitTick===null) flapLimitTick=i;
  rows.push({tick:i, minutes:i, recycled, flapLimit:firedFlap, status:ws.status,
             lastTurnStartAgeMin: Math.round((now-(ws.lastTurnStartAt??0))/60000)});
}
clearInterval(ka);

// ── POSITIVE TERMINATORS (carry-forward 3/4) ────────────────────────────────
// Each claim is asserted on a channel that SPEAKS on success, not on an absent
// failure. surfacedChannels comes straight from the platform.broadcast / notify
// calls the real module made -- an unaudited zero cannot masquerade as a pass.
const surfacedChannels=[...new Set(broadcasts.map(c=>c.startsWith('NOTIFY:')?'NOTIFY':c))]
  .filter(c=>!c.startsWith('agent:'));
// COUNT the surface fires, do NOT collapse to a boolean (review F2): `true` is
// identical for "fired once" and "fired 54 times", so a boolean assertion is
// structurally blind to the toast STORM F1 fixes. The edge-triggered surface
// must fire EXACTLY ONCE even though the flap-limit CONDITION holds for many
// ticks (overBudgetTicks below). On the un-guarded build these counts equal
// overBudgetTicks (the storm); on the fixed build they are 1.
const flapBroadcastCount=broadcasts.filter(c=>c==='watchdog:flap-limit').length;
const flapNotifyCount=broadcasts.filter(c=>c.startsWith('NOTIFY:')).length;
// How many ticks the flap-limit CONDITION held (the surface COULD have fired).
// Once the budget is spent at flapLimitTick, the condition holds for EVERY
// remaining tick in this rig: the run is 14 min, the recycle window is 60 min so
// nothing ages out, status stays idle and the stream stays backdated. So the
// number of condition-holding ticks is TICKS - flapLimitTick (>= 7 here). The
// un-guarded build fires the surface on ALL of them; the fixed build fires once.
const overBudgetTicks=flapLimitTick===null?0:TICKS-flapLimitTick;
const flapBroadcast=flapBroadcastCount>0;
const flapNotify=flapNotifyCount>0;
// The backoff observable: recycles must NOT be on consecutive ticks. The pre-#97
// build recycles on 0,1,2; this build spaces them as the interval doubles.
const gaps=recycleTicks.slice(1).map((t,i)=>t-recycleTicks[i]);
const spaced=gaps.every(g=>g>=1) && gaps.some(g=>g>1); // at least one gap widened past 1 tick

if(interrupts===0){ console.error('[rig] VACUITY GUARD: 0 recycles across all ticks -- the rig did not reach recycleSession. Refusing a verdict.'); }
if(!flapBroadcast){ console.error('[rig] SURFACE GUARD: flap-limit never fired in '+TICKS+' ticks -- cannot certify the surface.'); }

console.log(JSON.stringify({
  totalRecycles:interrupts,
  recycleTicks,           // spacing between these = the #97 backoff, observed end-to-end
  backoffGaps:gaps,
  backoffSpaced:spaced,   // POSITIVE: recycles are NOT back-to-back (pre-#97 was 0,1,2)
  flapLimitTick,          // POSITIVE: the tick the stand-down first surfaced
  overBudgetTicks,        // how many ticks the flap-limit condition held (surface COULD fire)
  flapBroadcastCount,     // review F2: COUNT, not boolean. Fixed=1, un-guarded storm=overBudgetTicks
  flapNotifyCount,        // review F2: COUNT of OS toasts. Fixed=1, un-guarded storm=overBudgetTicks
  flapBroadcast,          // POSITIVE: watchdog:flap-limit broadcast fired at least once
  flapNotify,             // POSITIVE: an OS notify() fired at least once
  surfacedChannels,       // human-visible channels the real module emitted
  perTick:rows,
},null,1));
process.exit(0);

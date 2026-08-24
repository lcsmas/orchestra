// E2E gate for the queue tray, driven over CDP against a REAL built Orchestra.
//
// WHY BOTH THIS AND queue-tray-render-smoke.mjs: the smoke test renders the
// component in isolation and is structurally blind to two bugs that shipped
// here and were caught only by driving the real DOM:
//   1. MessageBubble is React.memo'd behind an ALLOWLIST comparator that did
//      not include `queued`, so the store cleared and the DOM stayed stale.
//   2. The queued-bubble CSS lived in agent-view-theme.css, which ties on
//      specificity with agent-view-flat.css and LOSES on load order — the
//      attribute applied and the bubble painted identically to a sent one.
// Both are invisible to unit tests and to isolated rendering. Hence this file.
//
// Prereqs: `npx vite build`, then launch with ORCHESTRA_DEBUG_PORT=9418 on a
// headless compositor (see the `verify` skill). Then: node scripts/verify-queue-tray.mjs
import WebSocket from 'ws';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Overridable so this is not welded to one agent's worktree/port.
const PORT = Number(process.env.ORCHESTRA_DEBUG_PORT || 9418);
const OUT = process.env.QTRAY_OUT || '/tmp/qtray-verify';
const MATCH = process.env.QTRAY_URL_MATCH || 'dist/index.html';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find(t=>t.type==='page'&&t.url.includes(MATCH));
if (!page) throw new Error(`no page target matching ${MATCH} on port ${PORT}`);
// Driving the packaged build instead of this worktree silently verifies the
// WRONG code — refuse rather than report a confident pass.
if (page.url.includes('app.asar')) throw new Error('CDP target is the PACKAGED app (app.asar) — build and launch this worktree instead');
fs.mkdirSync(OUT, { recursive: true });
const ws=new WebSocket(page.webSocketDebuggerUrl,{maxPayload:2e8});
await new Promise(r=>ws.on('open',r));
let id=0;const pend=new Map();
ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}});
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
await send('Page.enable');await send('Runtime.enable');
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,500));return r.result.value;};
const hashes=new Map();
const shot=async n=>{const{data}=await Promise.race([send('Page.captureScreenshot',{format:'png'}),new Promise((_,j)=>setTimeout(()=>j(new Error('hung')),15000))]);
 const b=Buffer.from(data,'base64');const h=crypto.createHash('sha256').update(b).digest('hex').slice(0,12);
 if(hashes.has(h))console.log(`  !! DUPLICATE FRAME ${n} == ${hashes.get(h)}`);hashes.set(h,n);
 fs.writeFileSync(`${OUT}/shot-${n}.png`,b);return h;};
let fails=0;const check=(l,c,d='')=>{console.log(`  ${c?'ok  ':'FAIL'} ${l}${c?'':' — '+d}`);if(!c)fails++;};
await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});

const W='paint-ws-'+Date.now();
// Seed a scratch workspace (no git needed) + select it + structured view.
await ev(`(() => {
  window.__orchestraSetState({
    workspaces: [{
      id: ${JSON.stringify(W)}, name: 'Queue tray paint probe', kind: 'scratch',
      repoPath: '', baseBranch: '', branch: 'probe',
      worktreePath: '/tmp', status: 'running', createdAt: Date.now(),
    }],
    activeId: ${JSON.stringify(W)},
    view: 'structured',
  });
})()`);
await new Promise(r=>setTimeout(r,600));
check('the structured view mounted', await ev(`!!document.querySelector('.av-view')`));

// Now inject the running turn + parked prompts through the real fold.
await ev(`(() => {
  let seq=0; const at=Date.now(); const W=${JSON.stringify(W)};
  const mk=b=>({...b,seq:seq++,at});
  window.__injectAgentEvent(W, mk({type:'user-message',text:'Refactor the queue banner to use the new tokens.'}));
  window.__injectAgentEvent(W, mk({type:'user-message',text:'Also update the codebase map doc.',rewindId:'q1',queued:true}));
  window.__injectAgentEvent(W, mk({type:'user-message',text:'And check the light theme still works.',rewindId:'q2',queued:true}));
  window.__injectAgentEvent(W, mk({type:'user-message',text:'Then run the typecheck.',rewindId:'q3',queued:true}));
  window.__injectAgentEvent(W, mk({type:'queue-update',queued:[
    {id:'q1',text:'Also update the codebase map doc.',coalesceWithNext:false},
    {id:'q2',text:'And check the light theme still works.',coalesceWithNext:false},
    {id:'q3',text:'Then run the typecheck.',coalesceWithNext:false},
  ]}));
})()`);
await new Promise(r=>setTimeout(r,700));

console.log('\nPaint — the tray is on screen:');
const geo = await ev(`(() => {
  const t=document.querySelector('.av-queue');
  if(!t) return {present:false};
  const r=t.getBoundingClientRect();
  const cs=getComputedStyle(t);
  const rows=[...document.querySelectorAll('.av-queue-row')];
  const comp=document.querySelector('.av-composer-field');
  const cr=comp?comp.getBoundingClientRect():null;
  return {present:true,x:r.x,y:r.y,w:r.width,h:r.height,
    opacity:cs.opacity,display:cs.display,visibility:cs.visibility,
    bg:cs.backgroundColor,rows:rows.length,
    inViewport:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,
    aboveComposer: cr? r.bottom<=cr.top+1 : null,
    headText:(document.querySelector('.av-queue-head')||{}).textContent,
    ghosts:document.querySelectorAll('.av-message-user[data-queued="1"]').length,
  };
})()`);
check('the tray element exists', geo.present, JSON.stringify(geo));
if(geo.present){
  check('it has real size (painted, not collapsed)', geo.w>200&&geo.h>40, `${geo.w}x${geo.h}`);
  check('it is fully inside the viewport', geo.inViewport===true, JSON.stringify({x:geo.x,y:geo.y,w:geo.w,h:geo.h}));
  check('it is not transparent/hidden', geo.opacity==='1'&&geo.visibility==='visible'&&geo.display!=='none', JSON.stringify(geo));
  check('it renders one row per queued prompt', geo.rows===3, String(geo.rows));
  check('it sits ABOVE the composer input', geo.aboveComposer===true, String(geo.aboveComposer));
  check('the header states the turn count', /3 queued/.test(geo.headText||'')&&/as 3 turns/.test(geo.headText||''), JSON.stringify(geo.headText));
  check('the parked bubbles are marked in the transcript', geo.ghosts===3, String(geo.ghosts));
}
// The queued bubble must be VISUALLY distinct from a sent one. This is a
// cascade assertion, not a DOM one: agent-view-flat.css loads after the theme
// layer and ties on specificity, so a rule in the wrong file applies the
// attribute and paints nothing (measured — that exact bug shipped here once).
const contrast = await ev(`(() => {
  const all=[...document.querySelectorAll('.av-message-user')];
  const sent=all.find(n=>!n.hasAttribute('data-queued'));
  const parked=all.find(n=>n.getAttribute('data-queued')==='1');
  if(!sent||!parked) return {err:'need one of each', n:all.length};
  const a=getComputedStyle(sent), b=getComputedStyle(parked);
  return {sentBorder:a.borderTopStyle,parkedBorder:b.borderTopStyle,
    sentBg:a.backgroundColor,parkedBg:b.backgroundColor,
    sentInk:a.color,parkedInk:b.color};
})()`);
check('a parked bubble is DASHED where a sent one is solid',
  contrast.parkedBorder==='dashed'&&contrast.sentBorder==='solid', JSON.stringify(contrast));
check('a parked bubble is unfilled where a sent one is filled',
  contrast.parkedBg!==contrast.sentBg&&/rgba\(0, 0, 0, 0\)|transparent/.test(contrast.parkedBg), JSON.stringify(contrast));
check('a parked bubble uses dimmed ink', contrast.parkedInk!==contrast.sentInk, JSON.stringify(contrast));

const h1 = await shot('tray-3-separate-turns');

// Merge all → the SAME queue must now read as one turn (state must CHANGE).
console.log('\nMerging changes the stated outcome:');
await ev(`(() => {
  let seq=500; const at=Date.now(); const W=${JSON.stringify(W)};
  window.__injectAgentEvent(W,{type:'queue-update',seq:seq++,at,queued:[
    {id:'q1',text:'Also update the codebase map doc.',coalesceWithNext:true},
    {id:'q2',text:'And check the light theme still works.',coalesceWithNext:true},
    {id:'q3',text:'Then run the typecheck.',coalesceWithNext:false},
  ]});
})()`);
await new Promise(r=>setTimeout(r,600));
const merged = await ev(`(() => ({
  head:(document.querySelector('.av-queue-head')||{}).textContent,
  mergedRows:document.querySelectorAll('.av-queue-row-merged').length,
  mergeAllGone: !/Merge all/.test(document.body.textContent||''),
}))()`);
check('the header now reads ONE turn', /as 1 turn/.test(merged.head||''), JSON.stringify(merged.head));
check('two rows carry the fused-merge styling', merged.mergedRows===2, String(merged.mergedRows));
check('merge-all hides once everything is one turn', merged.mergeAllGone===true, String(merged.mergeAllGone));
const h2 = await shot('tray-merged-one-turn');
check('the merge actually repainted (frames differ)', h1!==h2, `${h1} vs ${h2}`);

// Drain → tray disappears.
console.log('\nDrain removes the tray entirely:');
await ev(`window.__injectAgentEvent(${JSON.stringify(W)},{type:'queue-update',seq:900,at:Date.now(),queued:[]})`);
await new Promise(r=>setTimeout(r,600));
const gone = await ev(`({tray:!!document.querySelector('.av-queue'),ghosts:document.querySelectorAll('.av-message-user[data-queued="1"]').length})`);
check('the tray is gone', gone.tray===false, JSON.stringify(gone));
check('no bubble still reads as pending', gone.ghosts===0, JSON.stringify(gone));
const h3 = await shot('tray-drained-empty');
check('the drain repainted (frames differ)', h2!==h3, `${h2} vs ${h3}`);

console.log(`\n${fails===0?'PASS':fails+' FAILURE(S)'} — shots in ${OUT}`);
ws.close();process.exit(fails?1:0);

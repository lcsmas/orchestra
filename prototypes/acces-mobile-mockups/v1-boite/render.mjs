// V1 — Boîte de réception: dark, Orchestra look, "À traiter" pinned on top of a repo-grouped list.
import { WS, STATUS_LABEL, dstatus, needsMe, counts, byRepo, byUrgency, CONVO_ASK, CONVO_ELICIT, CONVO_RUNNING, CONVO_FAILED, SYNC } from '../shared/data.mjs';
import { esc, md, icon, toolIcon, ring, keyboard, groupTools } from '../shared/chrome.mjs';

export const meta = {
  id: 'v1', cls: 'v1', name: 'V1 · Boîte de réception',
  idea: 'dark, look du bureau ; « À traiter » épinglé en tête (en attente puis non lu), le reste groupé par repo ; conversation = document, question en carte dans le flux',
};

const C = counts();
const ws = (id) => WS.find((w) => w.id === id);

const glyph = (s) => ({
  waiting: '<span class="g g-wait"></span>',
  unread: `<span class="g g-unread">${icon('bell', 17)}</span>`,
  running: `<span class="g g-run">${ring(19)}</span>`,
  idle: '<span class="g g-idle"></span>',
  error: `<span class="g g-err">${icon('alert', 17)}</span>`,
  stopped: '<span class="g g-stop"></span>',
}[s]);
const acct = (a) => `<span class="acct a-${a}">${a}</span>`;

const rowBig = (w) => {
  const s = dstatus(w);
  const tag = w.kind === 'elicitation' ? 'Bureau' : s === 'waiting' ? 'Question' : 'Terminé';
  return `<div class="row big ${s}">${glyph(s)}<div class="rb">
    <div class="r1"><b>${w.name}</b><time>${w.ago}</time></div>
    <div class="r2"><span class="repo">${w.repo}</span><span class="br">${w.branch}</span>${acct(w.account)}</div>
    <p class="pv"><em>${tag}</em> ${esc(w.preview)}</p></div></div>`;
};
const rowSmall = (w) => {
  const s = dstatus(w);
  return `<div class="row small ${s}">${glyph(s)}<div class="rb">
    <div class="r1"><b>${w.name}</b><time>${s === 'running' ? 'en cours' : w.ago}</time></div>
    <div class="r2"><span class="br">${w.branch}</span>${acct(w.account)}</div></div></div>`;
};

const seg = (on) => `<div class="seg"><button class="${on === 'tout' ? 'on' : ''}">Tout <b>${C.total}</b></button><button class="${on === 'needs' ? 'on' : ''}">${icon('bell', 14)}À traiter <b class="hot">${C.needs}</b></button></div>`;
const top = (on, off = false) => `<header class="top"><div class="tt"><h1>Workspaces</h1><span class="live${off ? ' off' : ''}"><i></i>${off ? 'hors ligne' : 'en ligne'}</span></div>${seg(on)}</header>`;

const needsBlock = () => {
  const wait = WS.filter((w) => dstatus(w) === 'waiting'), unr = WS.filter((w) => dstatus(w) === 'unread');
  return `<section class="needs"><h2 class="sub w"><span class="d"></span>En attente <b>${wait.length}</b></h2>${wait.map(rowBig).join('')}
    <h2 class="sub u">${icon('bell', 12)}Non lu <b>${unr.length}</b></h2>${unr.map(rowBig).join('')}</section>`;
};
const repoBlocks = () => byRepo().map(({ repo, items }) => {
  const rest = items.filter((w) => !needsMe(w));
  if (!rest.length) return '';
  return `<section class="repo-g"><h2 class="rh">${icon('chevD', 13)}<span>${repo}</span><b>${rest.length}</b></h2>${rest.map(rowSmall).join('')}</section>`;
}).join('');

const listTout = (extra = '') => `<div class="col">${extra}${top('tout')}<main class="scroll">${needsBlock()}${repoBlocks()}</main></div>`;
const listNeeds = () => `<div class="col">${top('needs')}<main class="scroll">${needsBlock()}
  <p class="empty">${icon('check', 16)}Rien d’autre ne t’attend.<br><span>${C.total - C.needs} workspaces masqués par le filtre.</span></p></main></div>`;
const listOffline = () => `<div class="col">${top('tout', true)}
  <div class="offline">${icon('wifiOff', 22)}<div><b>Orchestra injoignable</b><p>L’app est fermée ou Accès mobile est désactivé. Dernier état connu à ${SYNC}.</p>
  <div class="oa"><button class="btn">${icon('refresh', 15)}Réessayer</button><span>nouvelle tentative dans 8 s</span></div></div></div>
  <main class="scroll stale">${needsBlock()}${repoBlocks()}</main></div>`;

// ── conversation ────────────────────────────────────────────────────────
const header = (w, pill) => `<header class="ch"><button class="back">${icon('chevL', 24)}<span class="bk">${C.needs - (needsMe(w) ? 1 : 0)}</span></button>
  <div class="ct"><b>${w.name}</b><span class="cs">${icon('branch', 12)}<span>${w.branch}</span>${acct(w.account)}</span></div>
  <span class="pill ${pill.cls}">${pill.text}</span></header>`;

const stream = (turns) => groupTools(turns).map((t) => {
  if (t.role === 'user') return `<div class="u${t.queued ? ' q' : ''}${t.failed ? ' f' : ''}"><p>${md(t.text)}</p>${t.queued ? '<span class="tag">En file · part à la fin du tour</span>' : ''}${t.failed ? `<span class="tag err">Non envoyé · <u>Réessayer</u></span>` : ''}</div>`;
  if (t.role === 'assistant') return `<div class="a"><p>${md(t.text)}${t.streaming ? '<i class="cur"></i>' : ''}</p>${t.streaming ? `<div class="working">${ring(14)}En cours…</div>` : ''}</div>`;
  return `<div class="tools">${t.items.map((x) => `<div class="tl${x.running ? ' run' : ''}">${x.running ? ring(14) : toolIcon(x.kind, 14)}<b>${x.verb}</b><span>${esc(x.arg)}</span>${x.note ? `<em>${x.note}</em>` : ''}</div>`).join('')}</div>`;
}).join('');

const askCard = (a) => `<section class="ask"><div class="ask-h">${icon('help', 15)}<span>Question</span><i>·</i><span>${a.header}</span></div><h3>${a.question}</h3>
  ${a.options.map((o, i) => `<button class="opt"><span class="n">${i + 1}</span><span class="ot"><b>${o.label}</b><small>${o.desc}</small></span></button>`).join('')}
  <div class="other"><span>Autre réponse…</span><button class="send" aria-label="Envoyer">${icon('up', 18)}</button></div></section>`;
const elicCard = (e) => `<section class="elic"><div class="elic-h">${icon('monitor', 15)}<span>Élicitation MCP · ${e.server}</span></div><p>${esc(e.message)}</p>
  <div class="desk">${icon('monitor', 16)}À traiter sur le bureau</div><small>Orchestra attend ta réponse sur l’ordinateur.</small></section>`;

const composer = ({ placeholder, draft = '', hint = '', toast = '', kb = false }) => `${toast}<footer class="cmp${kb ? ' kb-on' : ''}">${hint}
  <div class="fld"><span class="${draft ? 'dr' : 'ph'}">${draft ? esc(draft) + '<i class="caret"></i>' : placeholder}</span><button class="send${draft ? ' on' : ''}" aria-label="Envoyer">${icon('up', 18)}</button></div></footer>`;

const convoScreen = ({ w, pill, turns, tail = '', cmp }) =>
  `<div class="col${cmp.kb ? ' with-kb' : ''}">${header(w, pill)}<main class="stream">${stream(turns)}${tail}</main>${composer(cmp)}</div>${cmp.kb ? keyboard('dark') : ''}`;

export function screens() {
  const ask = ws(CONVO_ASK.ws), el = ws(CONVO_ELICIT.ws), run = ws(CONVO_RUNNING.ws), fl = ws(CONVO_FAILED.ws);
  return [
    { file: '01-liste-tout', title: 'Liste — tout', body: listTout() },
    { file: '02-liste-a-traiter', title: 'Liste — filtre « à traiter »', body: listNeeds() },
    { file: '03-conversation-question', title: 'Conversation — question en attente', body: convoScreen({ w: ask, pill: { cls: 'wait', text: 'en attente' }, turns: CONVO_ASK.turns, tail: askCard(CONVO_ASK.ask), cmp: { placeholder: `Écrire à ${ask.name}` } }) },
    { file: '04-conversation-elicitation', title: 'Conversation — élicitation MCP', body: convoScreen({ w: el, pill: { cls: 'wait', text: 'en attente' }, turns: CONVO_ELICIT.turns, tail: elicCard(CONVO_ELICIT.elicitation), cmp: { placeholder: `Écrire à ${el.name}` } }) },
    { file: '05-composer', title: 'Composer — tour en cours, message mis en file', body: convoScreen({ w: run, pill: { cls: 'run', text: 'en cours' }, turns: CONVO_RUNNING.turns, cmp: { placeholder: '', draft: CONVO_RUNNING.draft, kb: true, hint: `<div class="hint">${ring(13)}Tour en cours — ton message sera mis en file</div>` } }) },
    { file: '06-envoi-echoue', title: 'Composer — envoi échoué', body: convoScreen({ w: fl, pill: { cls: 'idle', text: 'inactif' }, turns: CONVO_FAILED.turns, cmp: { placeholder: `Écrire à ${fl.name}`, toast: `<div class="toast">${icon('alert', 17)}<span>${CONVO_FAILED.error}</span><button>Réessayer</button></div>` } }) },
    { file: '07-injoignable', title: 'Orchestra injoignable', body: listOffline() },
  ];
}

// V2 — Messages: light, native-iOS feel. "À traiter" is its own tab with cards you can answer from;
// the conversation is a chat; unreachable is a full-screen state.
import { WS, dstatus, needsMe, counts, byRepo, CONVO_ASK, CONVO_ELICIT, CONVO_RUNNING, CONVO_FAILED, SYNC } from '../shared/data.mjs';
import { esc, md, icon, toolIcon, ring, keyboard, groupTools } from '../shared/chrome.mjs';

export const meta = {
  id: 'v2', cls: 'v2', name: 'V2 · Messages',
  idea: 'clair, ressenti app iOS native ; onglets À traiter / Tous, cartes avec réponse rapide depuis la liste ; conversation en bulles ; « injoignable » en plein écran',
};

const C = counts();
const ws = (id) => WS.find((w) => w.id === id);
const REPO = { orchestra: ['Or', 'blue'], 'api-v2': ['A2', 'violet'], 'next-api': ['Nx', 'teal'], 'vecna-front': ['Vf', 'orange'], dotfiles: ['Df', 'gray'] };

const badge = (s) => ({
  waiting: `<i class="bd wait">${icon('help', 12)}</i>`,
  running: `<i class="bd run">${ring(12)}</i>`,
  error: `<i class="bd err">${icon('alert', 12)}</i>`,
  stopped: '<i class="bd stop"></i>',
}[s] || '');
const avatar = (w, size = '') => `<div class="av ${REPO[w.repo][1]} ${size}"><span>${REPO[w.repo][0]}</span>${badge(dstatus(w))}</div>`;
const acct = (a) => `<span class="acct a-${a}">${a}</span>`;

const seg = (on) => `<div class="seg"><button class="${on === 'needs' ? 'on' : ''}">À traiter <b class="hot">${C.needs}</b></button><button class="${on === 'tout' ? 'on' : ''}">Tous <b>${C.total}</b></button></div>`;
const top = (title, on, off = false) => `<header class="top"><div class="tt"><h1>${title}</h1><span class="live${off ? ' off' : ''}"><i></i>${off ? 'hors ligne' : 'en ligne'}</span></div>${seg(on)}</header>`;

// ── tab « À traiter » ──
const cardAsk = (w) => `<article class="card wait"><div class="ch">${avatar(w)}<div class="cn"><b>${w.name}</b><span>${w.repo} · ${w.branch}</span></div><div class="cr"><time>${w.ago}</time>${acct(w.account)}</div></div>
  <p class="q">${esc(w.preview)}</p>
  <div class="chips">${CONVO_ASK.ask.options.map((o) => `<button>${o.label}</button>`).join('')}<button class="oth">Autre réponse…</button></div></article>`;
const cardElic = (w) => `<article class="card wait"><div class="ch">${avatar(w)}<div class="cn"><b>${w.name}</b><span>${w.repo} · ${w.branch}</span></div><div class="cr"><time>${w.ago}</time>${acct(w.account)}</div></div>
  <p class="q">${esc(w.preview)}</p><div class="desk">${icon('monitor', 17)}À traiter sur le bureau</div></article>`;
const unreadRow = (w) => `<div class="urow"><i class="ud"></i>${avatar(w)}<div class="un"><div class="u1"><b>${w.name}</b><time>${w.ago}</time></div><p>${esc(w.preview)}</p><div class="u3">${w.repo} · ${w.branch}${acct(w.account)}</div></div></div>`;
const needsTab = () => {
  const wait = WS.filter((w) => dstatus(w) === 'waiting'), unr = WS.filter((w) => dstatus(w) === 'unread');
  return `<main class="scroll"><h2 class="sh">Te demandent une réponse <b>${wait.length}</b></h2>${wait.map((w) => (w.kind === 'ask' ? cardAsk(w) : cardElic(w))).join('')}
    <h2 class="sh">Non lu <b>${unr.length}</b></h2><div class="group">${unr.map(unreadRow).join('')}</div>
    <p class="more">${C.running} en cours · ${C.idle} inactifs · ${C.error} erreur · ${C.stopped} arrêtés<span>Voir dans « Tous » ${icon('chevR', 14)}</span></p></main>`;
};

// ── tab « Tous » ──
const sico = (s) => ({
  waiting: `<i class="si wait">${icon('help', 20)}</i>`, unread: `<i class="si unread">${icon('bell', 19)}</i>`, running: `<i class="si run">${ring(20)}</i>`,
  error: `<i class="si err">${icon('alert', 20)}</i>`, idle: '<i class="si idle"><b></b></i>', stopped: '<i class="si stop"><b></b></i>',
}[s]);
const row = (w) => {
  const s = dstatus(w);
  const lbl = { waiting: 'en attente', unread: 'non lu', running: 'en cours', error: 'erreur', stopped: 'arrêté', idle: '' }[s];
  return `<div class="trow ${s}">${sico(s)}<div class="tn"><b>${w.name}</b><span>${w.branch}</span></div><div class="tr"><time>${s === 'running' ? '' : w.ago}</time>${lbl ? `<em class="l-${s}">${lbl}</em>` : ''}${acct(w.account)}</div></div>`;
};
const toutTab = () => `<main class="scroll">${byRepo().map(({ repo, items }) => `<h2 class="sh">${repo} <b>${items.length}</b></h2><div class="group">${items.map(row).join('')}</div>`).join('')}</main>`;

const listNeeds = () => `<div class="col">${top('À traiter', 'needs')}${needsTab()}</div>`;
const listTout = () => `<div class="col">${top('Workspaces', 'tout')}${toutTab()}</div>`;
const offline = () => `<div class="col off"><div class="offc"><div class="ico">${icon('wifiOff', 40)}</div>
  <h1>Orchestra injoignable</h1><p>L’app est fermée ou l’Accès mobile est désactivé. Tes agents tournent peut-être toujours.</p>
  <button class="btn">${icon('refresh', 18)}Réessayer</button><div class="auto">${ring(14)}Reconnexion automatique…</div></div>
  <div class="stale">Dernière synchro à ${SYNC}<a>Voir le dernier état connu ${icon('chevR', 14)}</a></div></div>`;

// ── conversation ──
const head = (w, st) => `<header class="mh"><button class="back">${icon('chevL', 26)}<span class="bk">${C.needs - (needsMe(w) ? 1 : 0)}</span></button>
  ${avatar(w, 'sm')}<b>${w.name}</b><span class="ms">${w.account} · ${w.branch}</span><span class="stt ${st.cls}">${st.text}</span></header>`;

const stream = (turns) => groupTools(turns).map((t) => {
  if (t.role === 'user') return `<time class="td">${t.t}</time><div class="b u${t.queued ? ' q' : ''}${t.failed ? ' f' : ''}">${t.failed ? `<i class="fail">${icon('alert', 16)}</i>` : ''}<p>${md(t.text)}</p></div>${t.queued ? '<span class="cap">En file · part à la fin du tour</span>' : ''}${t.failed ? '<span class="cap err">Non envoyé · Appuie pour réessayer</span>' : ''}`;
  if (t.role === 'assistant') return `<div class="b a"><p>${md(t.text)}${t.streaming ? '<i class="cur"></i>' : ''}</p></div>${t.streaming ? `<span class="wk">${ring(13)}En cours…</span>` : ''}`;
  return `<div class="tools">${t.items.map((x) => `<span class="chip${x.running ? ' run' : ''}">${x.running ? ring(13) : toolIcon(x.kind, 13)}<b>${x.verb}</b>${esc(x.arg)}${x.note ? `<em>${x.note}</em>` : ''}</span>`).join('')}</div>`;
}).join('');

const askCard = (a) => `<section class="ask"><div class="ask-h"><i>${icon('help', 16)}</i><span>${a.header}</span></div><h3>${a.question}</h3>
  ${a.options.map((o) => `<button class="opt"><span class="rd"></span><span class="ot"><b>${o.label}</b><small>${o.desc}</small></span></button>`).join('')}
  <div class="other"><span>Autre réponse…</span><button class="go">Envoyer</button></div></section>`;
const elicCard = (e) => `<section class="elic"><div class="ico">${icon('monitor', 22)}</div><b>À traiter sur le bureau</b>
  <p>Le serveur MCP « ${e.server} » demande : ${esc(e.message)}</p><small>Cette demande ne peut pas être traitée depuis le téléphone.</small></section>`;

const composer = ({ placeholder, draft = '', hint = '', toast = '', kb = false }) => `${toast}<footer class="cmp">${hint}
  <div class="fld"><span class="${draft ? 'dr' : 'ph'}">${draft ? esc(draft) + '<i class="caret"></i>' : placeholder}</span>${draft ? `<button class="send">${icon('up', 17)}</button>` : ''}</div></footer>`;

const convoScreen = ({ w, st, turns, tail = '', cmp }) =>
  `<div class="col convo${cmp.kb ? ' with-kb' : ''}">${head(w, st)}<main class="stream">${stream(turns)}${tail}</main>${composer(cmp)}</div>${cmp.kb ? keyboard('light') : ''}`;

export function screens() {
  const ask = ws(CONVO_ASK.ws), el = ws(CONVO_ELICIT.ws), run = ws(CONVO_RUNNING.ws), fl = ws(CONVO_FAILED.ws);
  return [
    { file: '01-liste-tout', title: 'Liste — Tous', body: listTout() },
    { file: '02-liste-a-traiter', title: 'Liste — À traiter', body: listNeeds() },
    { file: '03-conversation-question', title: 'Conversation — question en attente', body: convoScreen({ w: ask, st: { cls: 'wait', text: 'en attente de ta réponse' }, turns: CONVO_ASK.turns, tail: askCard(CONVO_ASK.ask), cmp: { placeholder: 'Message' } }) },
    { file: '04-conversation-elicitation', title: 'Conversation — élicitation MCP', body: convoScreen({ w: el, st: { cls: 'wait', text: 'en attente · sur le bureau' }, turns: CONVO_ELICIT.turns, tail: elicCard(CONVO_ELICIT.elicitation), cmp: { placeholder: 'Message' } }) },
    { file: '05-composer', title: 'Composer — tour en cours, message mis en file', body: convoScreen({ w: run, st: { cls: 'run', text: 'en cours…' }, turns: CONVO_RUNNING.turns, cmp: { draft: CONVO_RUNNING.draft, kb: true, hint: `<div class="hint">${ring(13)}Tour en cours — ton message sera mis en file</div>` } }) },
    { file: '06-envoi-echoue', title: 'Composer — envoi échoué', body: convoScreen({ w: fl, st: { cls: 'idle', text: 'inactif' }, turns: CONVO_FAILED.turns, cmp: { placeholder: 'Message', toast: `<div class="toast">${icon('alert', 17)}<span>${CONVO_FAILED.error}</span><button>Réessayer</button></div>` } }) },
    { file: '07-injoignable', title: 'Orchestra injoignable', body: offline() },
  ];
}

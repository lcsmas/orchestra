// V3 — Console: OLED black, dense, mono chrome. Repo tree with per-repo tallies (urgent repos open, the rest folded),
// conversation = transcript with a turn rail, the question is a bottom sheet in thumb reach.
import { WS, dstatus, needsMe, counts, byRepo, CONVO_ASK, CONVO_ELICIT, CONVO_RUNNING, CONVO_FAILED, SYNC } from '../shared/data.mjs';
import { esc, md, icon, toolIcon, ring, keyboard, groupTools } from '../shared/chrome.mjs';

export const meta = {
  id: 'v3', cls: 'v3', name: 'V3 · Console',
  idea: 'noir OLED, très dense, chrome mono ; arbre par repo avec compteurs (repos urgents ouverts, le reste replié) ; transcript à rail ; question en bottom sheet sous le pouce',
};

const C = counts();
const ws = (id) => WS.find((w) => w.id === id);

const dia = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 2.5 21.5 12 12 21.5 2.5 12Z" fill="currentColor"/></svg>`;
const hollow = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="6.5"/></svg>`;
const sq = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>`;
const gly = (st, s = 18) => `<span class="g g-${st}">${{ waiting: dia(s - 2), unread: icon('bell', s), running: ring(s), idle: hollow(s), error: icon('x', s), stopped: sq(s) }[st]}</span>`;
const acct = (a) => `<span class="acct a-${a}">${a}</span>`;

const tally = (items) => {
  const n = (s) => items.filter((w) => dstatus(w) === s).length;
  return ['waiting', 'unread', 'error', 'running'].filter(n).map((s) => `<span class="tl-${s}">${gly(s, 12)}${n(s)}</span>`).join('');
};

const row = (w, tall) => {
  const s = dstatus(w);
  if (!tall) return `<div class="r ${s} one">${gly(s)}<b>${w.name}</b><span class="br">${w.branch}</span>${acct(w.account)}</div>`;
  return `<div class="r ${s} tall">${gly(s)}<div class="rb"><div class="l1"><b>${w.name}</b><span class="tm">${w.ago}</span></div>
    <div class="l2"><span class="br">${w.branch}</span>${acct(w.account)}</div><p class="pv">${esc(w.preview)}</p></div></div>`;
};
const summary = (items) => {
  const n = (s) => items.filter((w) => dstatus(w) === s).length;
  const parts = [[n('running'), 'en cours'], [n('idle'), 'inactifs'], [n('stopped'), 'arrêté']].filter(([k]) => k).map(([k, l]) => `${k} ${l}`);
  return parts.length ? `<div class="more">+ ${parts.join(' · ')}${icon('chevR', 13)}</div>` : '';
};
const group = ({ repo, items }, filterOn) => {
  const urgent = items.filter((w) => needsMe(w) || dstatus(w) === 'error');
  const open = urgent.length > 0;
  const head = `<h2 class="gh">${icon(open ? 'chevD' : 'chevR', 13)}<span class="gn">${repo}</span><span class="gc">${items.length}</span><span class="tal">${tally(items)}</span></h2>`;
  if (filterOn) {
    const nm = items.filter(needsMe);
    return nm.length ? `<section>${head}${nm.map((w) => row(w, true)).join('')}</section>` : '';
  }
  if (!open) return `<section class="fold">${head}</section>`;
  const running = items.filter((w) => dstatus(w) === 'running');
  const shown = [...urgent, ...running.slice(0, 2)];
  const rest = items.filter((w) => !shown.includes(w));
  return `<section>${head}${shown.map((w) => row(w, needsMe(w) || dstatus(w) === 'error')).join('')}${summary(rest)}</section>`;
};

const bar = (off = false) => `<header class="bar"><span class="wm">orchestra<i></i></span><span class="live${off ? ' off' : ''}"><i></i>${off ? 'hors ligne' : `${C.total} ws`}</span><button class="gear">${icon('gear', 18)}</button></header>`;
const strip = (on) => `<div class="strip"><button class="tg${on ? ' on' : ''}">${icon('bell', 14)}À traiter<b>${C.needs}</b></button>
  <span class="leg"><span class="tl-waiting">${gly('waiting', 12)}${C.waiting}</span><span class="tl-unread">${gly('unread', 12)}${C.unread}</span><span class="tl-running">${gly('running', 12)}${C.running}</span><span class="tl-error">${gly('error', 12)}${C.error}</span></span></div>`;

const listTout = () => `<div class="col">${bar()}${strip(false)}<main class="scroll">${byRepo().map((g) => group(g, false)).join('')}</main></div>`;
const listNeeds = () => `<div class="col">${bar()}${strip(true)}<main class="scroll">${byRepo().map((g) => group(g, true)).join('')}
  <p class="end">— fin · ${C.total - C.needs} workspaces masqués —</p></main></div>`;
const listOffline = () => `<div class="col off">${bar(true)}<div class="dead">${ring(15)}<b>INJOIGNABLE</b><span>reconnexion #3 · 00:08</span></div>
  <main class="scroll stale">${byRepo().map((g) => group(g, false)).join('')}</main>
  <div class="dock"><div><b>Orchestra injoignable</b><span>app fermée ou Accès mobile désactivé · dernière synchro ${SYNC}</span></div><button class="retry">${icon('refresh', 15)}réessayer</button></div></div>`;

// ── conversation ──
const head = (w, chip) => `<header class="ch"><button class="back">${icon('chevL', 22)}<span class="bk">${C.needs - (needsMe(w) ? 1 : 0)}</span></button>
  <div class="ct"><span class="rp">${w.repo}/</span><b>${w.name}</b></div><span class="chip ${chip.cls}">${chip.text}</span></header>
  <div class="meta"><span>${icon('branch', 11)}${w.branch}</span>${acct(w.account)}</div>`;

const stream = (turns) => groupTools(turns).map((t) => {
  if (t.role === 'user') return `<div class="m u${t.queued ? ' q' : ''}${t.failed ? ' f' : ''}"><div class="who">vous<i>${t.t}</i>${t.queued ? '<em class="qd">en file</em>' : ''}${t.failed ? '<em class="er">non envoyé</em>' : ''}</div><p>${md(t.text)}</p>${t.failed ? `<div class="fb">${icon('alert', 14)}<span>${CONVO_FAILED.error}</span><button>réessayer</button></div>` : ''}</div>`;
  if (t.role === 'assistant') return `<div class="m a${t.streaming ? ' strm' : ''}"><div class="who">claude<i>${t.t}</i>${t.streaming ? `<em class="wk">${ring(11)}en cours</em>` : ''}</div><p>${md(t.text)}${t.streaming ? '<i class="cur"></i>' : ''}</p></div>`;
  return `<div class="tools">${t.items.map((x) => `<div class="tl${x.running ? ' run' : ''}">${x.running ? ring(12) : toolIcon(x.kind, 12)}<b>${x.verb}</b><span>${esc(x.arg)}</span>${x.note ? `<em>${x.note}</em>` : ''}</div>`).join('')}</div>`;
}).join('');

const sheet = (a) => `<section class="sheet"><i class="grab"></i><div class="sh-h">${icon('help', 14)}QUESTION<span>·</span>${a.header}</div><h3>${a.question}</h3>
  ${a.options.map((o, i) => `<button class="o"><span class="n">${i + 1}</span><span class="ot"><b>${o.label}</b><small>${o.desc}</small></span>${icon('chevR', 16)}</button>`).join('')}
  <div class="oth"><span class="pr">›</span><span class="ph">autre réponse…</span><button class="go">${icon('return', 16)}</button></div></section>`;
const elic = (e) => `<section class="el"><div class="el-h">${icon('monitor', 13)}ÉLICITATION MCP<span>·</span>${e.server}</div><p>${esc(e.message)}</p>
  <div class="desk">${icon('monitor', 15)}à traiter sur le bureau</div></section>`;

const composer = ({ placeholder, draft = '', hint = '', kb = false }) => `<footer class="cmp">${hint}<div class="fld"><span class="pr">›</span><span class="${draft ? 'dr' : 'ph'}">${draft ? esc(draft) + '<i class="caret"></i>' : placeholder}</span><button class="send${draft ? ' on' : ''}">${icon('up', 18)}</button></div></footer>`;

const convoScreen = ({ w, chip, turns, tail = '', cmp, sheetHtml = '' }) =>
  `<div class="col convo${cmp && cmp.kb ? ' with-kb' : ''}${sheetHtml ? ' with-sheet' : ''}">${head(w, chip)}<main class="stream">${stream(turns)}${tail}</main>${sheetHtml || composer(cmp)}</div>${cmp && cmp.kb ? keyboard('dark') : ''}`;

export function screens() {
  const ask = ws(CONVO_ASK.ws), el = ws(CONVO_ELICIT.ws), run = ws(CONVO_RUNNING.ws), fl = ws(CONVO_FAILED.ws);
  return [
    { file: '01-liste-tout', title: 'Liste — tout', body: listTout() },
    { file: '02-liste-a-traiter', title: 'Liste — filtre « à traiter »', body: listNeeds() },
    { file: '03-conversation-question', title: 'Conversation — question en attente (bottom sheet)', body: convoScreen({ w: ask, chip: { cls: 'wait', text: 'EN ATTENTE' }, turns: CONVO_ASK.turns, sheetHtml: sheet(CONVO_ASK.ask) }) },
    { file: '04-conversation-elicitation', title: 'Conversation — élicitation MCP', body: convoScreen({ w: el, chip: { cls: 'wait', text: 'EN ATTENTE' }, turns: CONVO_ELICIT.turns, tail: elic(CONVO_ELICIT.elicitation), cmp: { placeholder: `message à ${el.name}…` } }) },
    { file: '05-composer', title: 'Composer — tour en cours, message mis en file', body: convoScreen({ w: run, chip: { cls: 'run', text: 'EN COURS' }, turns: CONVO_RUNNING.turns, cmp: { draft: CONVO_RUNNING.draft, kb: true, hint: `<div class="hint">${ring(12)}tour en cours · sera mis en file<b>1 en file</b></div>` } }) },
    { file: '06-envoi-echoue', title: 'Composer — envoi échoué', body: convoScreen({ w: fl, chip: { cls: 'idle', text: 'INACTIF' }, turns: CONVO_FAILED.turns, cmp: { placeholder: `message à ${fl.name}…` } }) },
    { file: '07-injoignable', title: 'Orchestra injoignable', body: listOffline() },
  ];
}

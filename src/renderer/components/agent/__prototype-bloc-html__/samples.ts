// PROTOTYPE — throwaway. Fake conversation for the Bloc HTML mockups.
// The three blocs are written the way the model would write them: self-contained, no network,
// colours through `var(--bloc-*, <fallback>)` so they follow the app theme when one is injected
// and still read as a plain light page when it is not (variant B).

const comparatif = `<style>
.g{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.c{border:1px solid var(--bloc-border,#d9dde3);border-radius:10px;padding:12px;background:var(--bloc-surface,#f6f7f9)}
.c h3{margin:0 0 6px;font-size:14px}
.pill{display:inline-block;font-size:11px;padding:1px 8px;border-radius:99px;font-weight:600}
.ok{background:color-mix(in srgb,var(--bloc-ok,#1a7f4b) 18%,transparent);color:var(--bloc-ok,#1a7f4b)}
.warn{background:color-mix(in srgb,var(--bloc-warn,#a86400) 18%,transparent);color:var(--bloc-warn,#a86400)}
.err{background:color-mix(in srgb,var(--bloc-err,#c62828) 18%,transparent);color:var(--bloc-err,#c62828)}
.big{font-size:22px;font-weight:700;margin:8px 0 0}
.big small{font-size:12px;font-weight:400;color:var(--bloc-muted,#5b6472)}
ul{margin:8px 0 0;padding-left:16px;color:var(--bloc-muted,#5b6472);font-size:12.5px}
</style>
<div class="g">
  <div class="c"><h3>Bloc dans la réponse</h3><span class="pill ok">recommandé</span>
    <p class="big">1 <small>surface à maintenir</small></p>
    <ul><li>Se lit à l'endroit où il est écrit</li><li>Rejoué à la réouverture</li><li>Repli en bloc de code partout ailleurs</li></ul></div>
  <div class="c"><h3>Réponse entière en HTML</h3><span class="pill err">écarté</span>
    <p class="big">0 <small>streaming bloc par bloc</small></p>
    <ul><li>Casse la copie et les aperçus</li><li>Le téléphone ne lit plus rien</li></ul></div>
  <div class="c"><h3>Page dans le panneau Browser</h3><span class="pill warn">existe déjà</span>
    <p class="big">2 <small>clics pour la voir</small></p>
    <ul><li>Hors du fil de la conversation</li><li>Un fichier à écrire puis à ouvrir</li></ul></div>
</div>`;

const memoire = `<style>
.bar{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.bar b{font-size:13px}
button{font:inherit;font-size:12px;padding:2px 10px;border-radius:6px;border:1px solid var(--bloc-border,#cfd4dc);background:var(--bloc-surface,#f6f7f9);color:inherit;cursor:pointer}
button[aria-pressed=true]{border-color:var(--bloc-accent,#2563eb);color:var(--bloc-accent,#2563eb)}
svg{display:block;width:100%;height:auto}
text{fill:var(--bloc-muted,#5b6472);font-size:11px}
rect.v{fill:var(--bloc-accent,#2563eb);opacity:.85}
rect.v:hover{opacity:1}
#tip{font-size:12px;color:var(--bloc-muted,#5b6472);min-height:18px;margin-top:4px}
</style>
<div class="bar"><b>Mémoire par espace de travail</b><span style="flex:1"></span>
  <button id="mo" aria-pressed="true">Mo</button><button id="pc" aria-pressed="false">% du total</button></div>
<svg id="c" viewBox="0 0 640 220" role="img" aria-label="Mémoire par espace de travail"></svg>
<div id="tip">Survole une barre.</div>
<script>
const data=[['lead',1840],['ops-wave-h',1320],['h1-plafond',980],['h2-ui',760],['h3-canary',2210],['verifier',640],['mobile',410]];
const total=data.reduce((s,d)=>s+d[1],0);let unit='mo';
function draw(){const svg=document.getElementById('c');const max=Math.max(...data.map(d=>d[1]));const w=640/data.length;
  svg.innerHTML=data.map((d,i)=>{const h=Math.round(d[1]/max*160);const label=unit==='mo'?d[1]+' Mo':Math.round(d[1]/total*100)+' %';
    return '<rect class="v" data-i="'+i+'" x="'+(i*w+12)+'" y="'+(180-h)+'" width="'+(w-24)+'" height="'+h+'" rx="4"></rect>'
      +'<text x="'+(i*w+w/2)+'" y="'+(172-h)+'" text-anchor="middle">'+label+'</text>'
      +'<text x="'+(i*w+w/2)+'" y="200" text-anchor="middle">'+d[0]+'</text>'}).join('');
  svg.querySelectorAll('rect').forEach(r=>r.addEventListener('mouseenter',()=>{const d=data[r.dataset.i];
    document.getElementById('tip').textContent=d[0]+' : '+d[1]+' Mo, soit '+Math.round(d[1]/total*100)+' % des '+total+' Mo de la flotte.'}))}
for(const id of ['mo','pc'])document.getElementById(id).onclick=()=>{unit=id;document.getElementById('mo').setAttribute('aria-pressed',id==='mo');document.getElementById('pc').setAttribute('aria-pressed',id==='pc');draw()};
draw();
</script>`;

const rows = [
  ['#320', 'Plafond mémoire', 'fusionné', 'ok'], ['#321', 'Docker relay HOLD', 'fusionné', 'ok'], ['#322', 'Avis de kill', 'fusionné', 'ok'],
  ['#324', 'Canary memory-hog', 'fusionné', 'ok'], ['#325', 'Reliquats : kill du scope', 'fusionné', 'ok'], ['#326', 'Veille et Reliquats', 'fusionné', 'ok'],
  ['#327', 'Arrêt du scope', 'fusionné', 'ok'], ['#328', 'Mémoire par membre', 'fusionné', 'ok'], ['#330', 'Watchers résilients', 'fusionné', 'ok'],
  ['#331', 'Reliquats navigateur', 'fusionné', 'ok'], ['#332', 'La session survit au plafond', 'fusionné', 'ok'], ['#341', 'Sortie des commandes intégrées', 'en revue', 'warn'],
  ['#343', 'Avis de kill du filet', 'en revue', 'warn'], ['#361', 'État de Connexion partout', 'à faire', 'err'], ['#366', 'Page Comptes D', 'à faire', 'err'],
  ['#264', 'Carte de sous-agent', 'à faire', 'err'], ['#195', 'Asks adressés à un humain', 'à faire', 'err'], ['#260', 'Ledgers dans le bus', 'à trier', 'err'],
].map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td><span class="pill ${r[3]}">${r[2]}</span></td></tr>`).join('');

const bilan = `<style>
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--bloc-border,#d9dde3);margin-bottom:10px}
.tabs button{font:inherit;font-size:13px;padding:6px 12px;border:0;background:none;color:var(--bloc-muted,#5b6472);cursor:pointer;border-bottom:2px solid transparent}
.tabs button[aria-selected=true]{color:var(--bloc-fg,#16181d);border-bottom-color:var(--bloc-accent,#2563eb)}
table{border-collapse:collapse;width:100%;font-size:12.5px}
td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--bloc-border,#e6e9ee)}
th{color:var(--bloc-muted,#5b6472);font-weight:500}
.pill{display:inline-block;font-size:11px;padding:1px 8px;border-radius:99px;font-weight:600}
.ok{background:color-mix(in srgb,var(--bloc-ok,#1a7f4b) 18%,transparent);color:var(--bloc-ok,#1a7f4b)}
.warn{background:color-mix(in srgb,var(--bloc-warn,#a86400) 18%,transparent);color:var(--bloc-warn,#a86400)}
.err{background:color-mix(in srgb,var(--bloc-err,#c62828) 18%,transparent);color:var(--bloc-err,#c62828)}
section[hidden]{display:none}
</style>
<div class="tabs" role="tablist">
  <button role="tab" aria-selected="true" data-t="tous">Tous les tickets (18)</button>
  <button role="tab" aria-selected="false" data-t="risques">Risques (2)</button>
</div>
<section id="tous"><table><tr><th>Ticket</th><th>Sujet</th><th>État</th></tr>${rows}</table></section>
<section id="risques" hidden><table><tr><th>Risque</th><th>Conséquence</th></tr>
  <tr><td>Le filet tue encore sans avis</td><td>Un membre disparaît sans que le coordinateur le sache</td></tr>
  <tr><td>Deux tickets en revue depuis 4 jours</td><td>La vague ne peut pas être clôturée</td></tr></table></section>
<script>
document.querySelectorAll('[role=tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[role=tab]').forEach(x=>x.setAttribute('aria-selected',x===b));
  for(const s of document.querySelectorAll('section'))s.hidden=s.id!==b.dataset.t});
</script>`;

const fence = (title: string, html: string) => '```html-render title="' + title + '"\n' + html + '\n```';

export interface SampleMessage { id: string; role: 'user' | 'assistant'; text: string; streaming?: boolean }

export const CONVERSATION: SampleMessage[] = [
  { id: 'u1', role: 'user', text: 'Compare les trois façons d\'afficher du HTML dans la conversation et dis-moi laquelle prendre.' },
  { id: 'a1', role: 'assistant', text: `**Prends le bloc dans la réponse.** Les deux autres perdent soit le streaming, soit la lecture au fil de l'eau.\n\n${fence('Comparatif des trois options', comparatif)}\n\nLe panneau Browser reste utile pour une vraie page à part, mais ce n'est pas le même besoin.` },
  { id: 'u2', role: 'user', text: 'Et la mémoire par espace de travail en ce moment ?' },
  { id: 'a2', role: 'assistant', text: `La flotte tient dans **8,2 Go**, et \`h3-canary\` en prend plus d'un quart.\n\n${fence('Mémoire par espace de travail', memoire)}\n\nRien n'approche le plafond de 4 Go par membre.` },
  { id: 'u3', role: 'user', text: 'Fais-moi le bilan de la vague.' },
  { id: 'a3', role: 'assistant', text: `**11 tickets fusionnés sur 18**, 2 en revue, 5 pas commencés.\n\n${fence('Bilan de la vague H', bilan)}\n\nLes deux tickets en revue bloquent la clôture.` },
  { id: 'u4', role: 'user', text: 'Donne-moi le calendrier de livraison.' },
  { id: 'a4', role: 'assistant', streaming: true, text: 'Trois livraisons, la première jeudi.\n\n```html-render title="Calendrier de livraison"\n<style>.t{display:grid' },
];

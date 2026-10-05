// PROTOTYPE — throwaway, never merge. Wayfinder #251 (map #243).
// Plan: three structurally different Accounts pages, switchable via ?variant=A|B|C and the
// floating bar (←/→). Sub-shape B (standalone page) on purpose: booting the real app would hand
// it live config dirs (boot inheritance sync). App tokens come from src/renderer/styles.css.
// All data is stubbed; every button is local state only.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/renderer/styles.css';
import './proto.css';

type ConnKind = 'ok' | 'soon' | 'ended';
interface Compte {
  id: string;
  label: string;
  email: string;
  plan: 'Max' | 'Pro' | 'Team';
  conn: ConnKind;
  daysLeft: number;
  usage: { fiveH: number; week: number } | null;
  stale?: string; // "en veille" since
  workspaces: number;
  scratchDefault?: boolean;
  identityChange?: { from: string; to: string };
  repos: string[];
}

const SEED: Compte[] = [
  { id: 'mc', label: 'mc', email: 'claude03@exemple.fr', plan: 'Max', conn: 'soon', daysLeft: 2,
    usage: { fiveH: 62, week: 41 }, workspaces: 32, scratchDefault: true,
    identityChange: { from: 'claude02@exemple.fr', to: 'claude03@exemple.fr' },
    repos: ['orchestra', 'metarepo', 'next-api'] },
  { id: 'perso', label: 'perso', email: 'perso@exemple.fr', plan: 'Pro', conn: 'ok', daysLeft: 24,
    usage: { fiveH: 12, week: 30 }, stale: 'il y a 3 h', workspaces: 3, repos: ['dotfiles'] },
  { id: 'test', label: 'test', email: 'test@exemple.fr', plan: 'Max', conn: 'ended', daysLeft: 0,
    usage: null, workspaces: 0, repos: [] },
];
const SOURCE = { path: '~/.claude', skills: 12, mcp: 8, settings: true };

// ---------- shared stub behaviour ----------
type AddStep = 'idle' | 'window' | 'cli-old';
function useComptes(cliOld: boolean) {
  const [comptes, setComptes] = useState(SEED);
  const [add, setAdd] = useState<AddStep>('idle');
  const [signing, setSigning] = useState<string | null>(null);
  const startAdd = () => setAdd(cliOld ? 'cli-old' : 'window');
  const finishAdd = () => {
    setComptes((c) => [...c, { id: `n${c.length}`, label: 'nouveau', email: 'nouveau@exemple.fr', plan: 'Pro',
      conn: 'ok', daysLeft: 27, usage: { fiveH: 0, week: 0 }, workspaces: 0, repos: [] }]);
    setAdd('idle');
  };
  const resign = (id: string) => {
    if (cliOld) return setAdd('cli-old');
    setSigning(id);
  };
  const finishResign = () => {
    setComptes((c) => c.map((x) => (x.id === signing ? { ...x, conn: 'ok', daysLeft: 27, stale: undefined,
      usage: x.usage ?? { fiveH: 0, week: 0 } } : x)));
    setSigning(null);
  };
  const rename = (id: string, label: string) => setComptes((c) => c.map((x) => (x.id === id ? { ...x, label } : x)));
  const setScratch = (id: string) => setComptes((c) => c.map((x) => ({ ...x, scratchDefault: x.id === id })));
  return { comptes, add, setAdd, startAdd, finishAdd, signing, setSigning, resign, finishResign, rename, setScratch };
}
type Model = ReturnType<typeof useComptes>;

const connText = (c: Compte) =>
  c.conn === 'ended' ? 'Connexion expirée' : c.conn === 'soon' ? `Expire dans ${c.daysLeft} j` : `Connecté · ${c.daysLeft} j restants`;

function ConnChip({ c }: { c: Compte }) {
  return <span className={`p-chip p-chip-${c.conn}`}>{connText(c)}</span>;
}
function Bar({ label, pct, stale }: { label: string; pct: number; stale?: boolean }) {
  const tone = pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'ok';
  return (
    <div className={`p-bar ${stale ? 'p-stale' : ''}`}>
      <span className="p-bar-label">{label}</span>
      <span className="p-bar-track"><span className={`p-bar-fill p-tone-${tone}`} style={{ width: `${pct}%` }} /></span>
      <span className="p-bar-pct">{pct}%</span>
    </div>
  );
}
function Usage({ c }: { c: Compte }) {
  if (!c.usage) return <span className="p-dim">Usage indisponible — reconnecte-toi</span>;
  return (
    <div className="p-usage">
      <Bar label="5 h" pct={c.usage.fiveH} stale={!!c.stale} />
      <Bar label="7 j" pct={c.usage.week} stale={!!c.stale} />
      {c.stale && <span className="p-dim p-small">En veille · relevé {c.stale}</span>}
    </div>
  );
}
function ResignButton({ c, m, compact }: { c: Compte; m: Model; compact?: boolean }) {
  if (c.conn === 'ok') return compact ? null : <button className="p-btn p-ghost" onClick={() => m.resign(c.id)}>Se reconnecter</button>;
  return <button className={`p-btn ${c.conn === 'ended' ? 'p-danger' : 'p-warn'}`} onClick={() => m.resign(c.id)}>Se reconnecter</button>;
}
function IdentityNotice({ c }: { c: Compte }) {
  if (!c.identityChange) return null;
  return <div className="p-notice">Compte {c.label} : {c.identityChange.from} → {c.identityChange.to}</div>;
}
function Avatar({ c }: { c: Compte }) {
  return <span className={`p-avatar p-av-${c.conn}`}>{c.label[0].toUpperCase()}</span>;
}

// Toast for the D-3 notification (decided in #249) — shown once, top-right.
function Toast({ m }: { m: Model }) {
  const [open, setOpen] = useState(true);
  const soon = m.comptes.find((c) => c.conn === 'soon');
  if (!open || !soon) return null;
  return (
    <div className="p-toast">
      <strong>Connexion du Compte {soon.label}</strong>
      <span>Expire dans {soon.daysLeft} jours.</span>
      <div className="p-row">
        <button className="p-btn p-warn" onClick={() => { m.resign(soon.id); setOpen(false); }}>Se reconnecter</button>
        <button className="p-btn p-ghost" onClick={() => setOpen(false)}>Plus tard</button>
      </div>
    </div>
  );
}

// The embedded claude.ai sign-in window (decided in #247/#248), mocked.
function SignInWindow({ m }: { m: Model }) {
  if (m.add === 'cli-old') {
    return (
      <div className="p-overlay"><div className="p-window">
        <h3>Claude Code est trop ancien</h3>
        <p className="p-dim">Version installée 2.1.100. La connexion demande 2.1.126 ou plus récent.</p>
        <div className="p-row"><button className="p-btn p-primary">Mettre à jour Claude Code</button>
          <button className="p-btn p-ghost" onClick={() => m.setAdd('idle')}>Fermer</button></div>
      </div></div>
    );
  }
  const target = m.signing ? m.comptes.find((c) => c.id === m.signing) : null;
  if (m.add !== 'window' && !target) return null;
  const done = () => (target ? m.finishResign() : m.finishAdd());
  const cancel = () => (target ? m.setSigning(null) : m.setAdd('idle'));
  return (
    <div className="p-overlay"><div className="p-window p-claude">
      <div className="p-window-bar"><span>claude.ai — {target ? `Reconnexion de ${target.label}` : 'Nouveau Compte'}</span>
        <button className="p-x" onClick={cancel}>✕</button></div>
      <div className="p-claude-page">
        <div className="p-claude-logo">✳ Claude</div>
        <div className="p-claude-title">Log in</div>
        <button className="p-claude-btn">Continue with Google</button>
        <button className="p-claude-btn">Continue with Apple</button>
        <input className="p-claude-input" placeholder="Enter your email" />
        <button className="p-claude-btn p-claude-dark" onClick={done}>Continue with email (simule le succès)</button>
      </div>
      <div className="p-window-foot p-dim">Session isolée · Orchestra récupère la connexion automatiquement</div>
    </div></div>
  );
}

// ---------- Variant A — Cartes ----------
function VariantA({ m }: { m: Model }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="modal accounts-settings p-modal">
      <div className="modal-header"><div><h2>Comptes</h2><div className="modal-sub">Chaque Compte a sa connexion, son historique et son usage</div></div>
        <button className="p-btn p-primary" onClick={m.startAdd}>+ Ajouter un compte</button></div>
      <div className="modal-body p-a-body">
        {m.comptes.map((c) => (
          <div key={c.id} className={`p-a-card p-a-${c.conn}`}>
            <div className="p-a-head">
              <Avatar c={c} />
              <div className="p-a-id">
                {editing === c.id
                  ? <input autoFocus className="accounts-input" defaultValue={c.label} onBlur={(e) => { m.rename(c.id, e.target.value); setEditing(null); }} />
                  : <span className="p-a-label" onDoubleClick={() => setEditing(c.id)} title="Double-clic pour renommer">{c.label}</span>}
                <span className="p-dim">{c.email} · {c.plan}</span>
              </div>
              <ConnChip c={c} />
            </div>
            <IdentityNotice c={c} />
            <Usage c={c} />
            <div className="p-a-foot">
              <span className="p-dim p-small">{c.workspaces} espaces · {c.repos.length ? `dépôts : ${c.repos.join(', ')}` : 'aucun dépôt'}{c.scratchDefault ? ' · Compte des sessions scratch' : ''}</span>
              <span className="p-row"><ResignButton c={c} m={m} />
                <button className="p-btn p-ghost">Héritage…</button><button className="p-btn p-ghost">⋯</button></span>
            </div>
          </div>
        ))}
        <div className="p-source">
          <span className="p-source-icon">⌂</span>
          <div><strong>Configuration source</strong> <code>{SOURCE.path}</code>
            <div className="p-dim p-small">{SOURCE.skills} skills · {SOURCE.mcp} serveurs MCP · settings — chaque Compte en hérite ce que tu choisis. Pas un Compte : aucun agent n'y tourne.</div></div>
          <button className="p-btn p-ghost">Gérer l'héritage</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Variant B — Liste + détail ----------
function VariantB({ m }: { m: Model }) {
  const [sel, setSel] = useState<string>('mc');
  const [tab, setTab] = useState<'conn' | 'inherit' | 'adv'>('conn');
  const c = m.comptes.find((x) => x.id === sel);
  return (
    <div className="modal accounts-settings p-modal p-b">
      <div className="p-b-list">
        <div className="p-b-list-title">Comptes</div>
        {m.comptes.map((x) => (
          <button key={x.id} className={`p-b-item ${sel === x.id ? 'on' : ''}`} onClick={() => setSel(x.id)}>
            <Avatar c={x} /><span className="p-b-item-text"><span>{x.label}</span><span className="p-dim p-small">{x.email}</span></span>
            <span className={`p-dot p-dot-${x.conn}`} />
          </button>
        ))}
        <button className="p-b-item p-b-add" onClick={m.startAdd}>+ Ajouter un compte</button>
        <div className="p-b-sep" />
        <button className={`p-b-item p-b-source ${sel === 'source' ? 'on' : ''}`} onClick={() => setSel('source')}>
          <span className="p-source-icon">⌂</span><span className="p-b-item-text"><span>Configuration source</span><span className="p-dim p-small">{SOURCE.path}</span></span></button>
      </div>
      <div className="p-b-detail">
        {sel === 'source' || !c ? (
          <>
            <h2>Configuration source <code>{SOURCE.path}</code></h2>
            <p className="p-dim">Ce que les Comptes héritent. Ce n'est pas un Compte : aucun agent n'y tourne et sa connexion est ignorée.</p>
            <table className="p-matrix"><thead><tr><th /> {m.comptes.map((x) => <th key={x.id}>{x.label}</th>)}</tr></thead>
              <tbody>{['settings.json', 'statusline', `skills (${SOURCE.skills})`, `MCP (${SOURCE.mcp})`].map((r, i) => (
                <tr key={r}><td>{r}</td>{m.comptes.map((x) => <td key={x.id}><input type="checkbox" defaultChecked={x.id !== 'test' && i < 3} /></td>)}</tr>))}</tbody></table>
          </>
        ) : (
          <>
            <div className="p-b-head"><Avatar c={c} /><div><h2>{c.label}</h2><span className="p-dim">{c.email} · {c.plan}</span></div><ConnChip c={c} /></div>
            <div className="p-tabs">
              {(['conn', 'inherit', 'adv'] as const).map((t) => (
                <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'conn' ? 'Connexion & usage' : t === 'inherit' ? 'Héritage' : 'Avancé'}</button>))}
            </div>
            {tab === 'conn' && (
              <div className="p-b-section">
                <IdentityNotice c={c} />
                <div className="p-b-conn">
                  <div><div className="p-dim p-small">Connexion</div><div>{connText(c)}</div>
                    <div className="p-conn-track"><span className={`p-conn-fill p-conn-${c.conn}`} style={{ width: `${(c.daysLeft / 27) * 100}%` }} /></div></div>
                  <ResignButton c={c} m={m} />
                </div>
                <Usage c={c} />
                <div className="p-dim p-small">Utilisé par {c.workspaces} espaces · {c.repos.length ? `dépôts : ${c.repos.join(', ')}` : 'aucun dépôt'}</div>
                <label className="account-inherit-check"><input type="radio" checked={!!c.scratchDefault} onChange={() => m.setScratch(c.id)} /> Compte des sessions scratch et orchestrateur</label>
              </div>
            )}
            {tab === 'inherit' && <div className="p-b-section p-dim">Choix des skills / MCP / settings hérités de la Configuration source (inchangé par rapport à aujourd'hui).</div>}
            {tab === 'adv' && <div className="p-b-section p-dim">Dossier de config (généré : ~/.orchestra/comptes/{c.id}), variables d'env, renommer, supprimer.</div>}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Variant C — Tableau de bord ----------
function VariantC({ m }: { m: Model }) {
  const repos = ['orchestra', 'metarepo', 'next-api', 'dotfiles'];
  const owner = (r: string) => m.comptes.find((c) => c.repos.includes(r))?.id;
  return (
    <div className="modal accounts-settings p-modal p-c">
      <div className="modal-header"><div><h2>Comptes</h2></div>
        <button className="p-btn p-primary" onClick={m.startAdd}>+ Ajouter un compte</button></div>
      <div className="p-c-source"><span className="p-source-icon">⌂</span> Configuration source <code>{SOURCE.path}</code>
        <span className="p-dim"> — {SOURCE.skills} skills, {SOURCE.mcp} MCP, settings hérités par les Comptes</span><button className="p-btn p-ghost">Héritage…</button></div>
      <table className="p-table">
        <thead><tr><th>Compte</th><th>Identité</th><th>Connexion</th><th>5 h</th><th>7 j</th><th>Espaces</th><th /></tr></thead>
        <tbody>{m.comptes.map((c) => (
          <tr key={c.id} className={`p-tr-${c.conn}`}>
            <td><Avatar c={c} /> <strong>{c.label}</strong></td>
            <td>{c.email}<div className="p-dim p-small">{c.plan}{c.identityChange ? ` · était ${c.identityChange.from}` : ''}</div></td>
            <td><ConnChip c={c} /></td>
            <td className={c.stale ? 'p-stale' : ''}>{c.usage ? `${c.usage.fiveH}%` : '—'}</td>
            <td className={c.stale ? 'p-stale' : ''}>{c.usage ? `${c.usage.week}%` : '—'}{c.stale && <div className="p-dim p-small">en veille</div>}</td>
            <td>{c.workspaces}</td>
            <td><ResignButton c={c} m={m} compact /></td>
          </tr>))}</tbody>
      </table>
      <div className="p-c-who">
        <div className="p-b-list-title">Qui utilise quel Compte</div>
        <table className="p-matrix"><thead><tr><th /> {m.comptes.map((c) => <th key={c.id}>{c.label}</th>)}</tr></thead>
          <tbody>
            {repos.map((r) => (<tr key={r}><td>dépôt {r}</td>{m.comptes.map((c) => <td key={c.id}><input type="radio" name={r} defaultChecked={owner(r) === c.id} /></td>)}</tr>))}
            <tr><td>sessions scratch / orchestrateur</td>{m.comptes.map((c) => <td key={c.id}><input type="radio" name="scratch" checked={!!c.scratchDefault} onChange={() => m.setScratch(c.id)} /></td>)}</tr>
          </tbody></table>
        <div className="p-dim p-small">Un agent lancé par un autre agent prend toujours le Compte de son créateur.</div>
      </div>
    </div>
  );
}

// ---------- switcher ----------
const VARIANTS = { A: 'Cartes', B: 'Liste + détail', C: 'Tableau de bord' } as const;
type V = keyof typeof VARIANTS;
function App() {
  const initial = (new URLSearchParams(location.search).get('variant') ?? 'A') as V;
  const [v, setV] = useState<V>(initial in VARIANTS ? initial : 'A');
  const [cliOld, setCliOld] = useState(false);
  const m = useComptes(cliOld);
  const keys = Object.keys(VARIANTS) as V[];
  const go = (d: number) => setV((cur) => keys[(keys.indexOf(cur) + d + keys.length) % keys.length]);
  useEffect(() => { history.replaceState(null, '', `?variant=${v}`); }, [v]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,[contenteditable]')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="p-stage">
      {v === 'A' && <VariantA m={m} />}
      {v === 'B' && <VariantB m={m} />}
      {v === 'C' && <VariantC m={m} />}
      <Toast m={m} />
      <SignInWindow m={m} />
      <div className="p-switcher">
        <button onClick={() => go(-1)}>←</button>
        <span>{v} ({VARIANTS[v]})</span>
        <button onClick={() => go(1)}>→</button>
        <label className="p-switcher-opt"><input type="checkbox" checked={cliOld} onChange={(e) => setCliOld(e.target.checked)} /> simuler CLI trop ancienne</label>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

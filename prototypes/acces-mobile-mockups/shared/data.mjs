// Fake data shared by the three variants — same story everywhere so the
// variants differ in layout/density, never in content.
// status: running | waiting (en attente) | idle | error | stopped
// unread: true = turn finished while the human was away (non lu)

export const WS = [
  { id: 'w1', name: 'ask-timeout-retry', repo: 'orchestra', branch: 'fix/ask-timeout-retry', account: 'perso', status: 'waiting', kind: 'ask', ago: '3 min',
    preview: 'Quelle stratégie de retry pour le réarmement du timeout ?' },
  { id: 'w10', name: 'invoice-export', repo: 'api-v2', branch: 'feat/invoice-export-csv', account: 'mc', status: 'waiting', kind: 'elicitation', ago: '12 min',
    preview: 'Le serveur MCP « linear » demande une autorisation.' },
  { id: 'w18', name: 'cohort-pilot-ui', repo: 'vecna-front', branch: 'feat/cohort-pilot', account: 'mc', status: 'idle', unread: true, ago: '27 min',
    preview: '4 fichiers modifiés, tests verts. Reste la relecture du tableau.' },
  { id: 'w2', name: 'bus-wal-watch', repo: 'orchestra', branch: 'bus-wal-watch-h2', account: 'perso', status: 'idle', unread: true, ago: '1 h',
    preview: 'Le watcher survit au rename du WAL. 3 mutants rouges, PR prête.' },

  { id: 'w3', name: 'plafond-memoire', repo: 'orchestra', branch: 'memory-cap-h1-320', account: 'perso', status: 'running', midTurn: true, ago: 'maintenant', tool: 'Bash · pnpm test' },
  { id: 'w9', name: 'acces-mobile-mockups', repo: 'orchestra', branch: 'acces-mobile-mockups', account: 'perso', status: 'running', midTurn: true, ago: 'maintenant', tool: 'Write · v2-messages/style.css' },
  { id: 'w4', name: 'session-keeper-linger', repo: 'orchestra', branch: 'keeper-linger-fu', account: 'perso', status: 'running', midTurn: true, ago: '1 min', tool: 'Read · session-keeper.md' },
  { id: 'w5', name: 'reliquats-h3', repo: 'orchestra', branch: 'reliquats-h3-325', account: 'perso', status: 'idle', ago: '2 h', failedSend: true },
  { id: 'w6', name: 'pause-canary', repo: 'orchestra', branch: 'pause-canary-f2-258', account: 'perso', status: 'idle', ago: '4 h' },
  { id: 'w7', name: 'docker-hold', repo: 'orchestra', branch: 'docker-hold-h3-321', account: 'perso', status: 'idle', ago: '5 h' },
  { id: 'w8', name: 'old-spike', repo: 'orchestra', branch: 'spike/sqlite-bus', account: 'perso', status: 'stopped', ago: '3 j' },

  { id: 'w11', name: 'export-cron', repo: 'api-v2', branch: 'fix/export-cron-session', account: 'mc', status: 'error', ago: '40 min', preview: 'La session n’a pas pu démarrer.' },
  { id: 'w12', name: 'hasura-perms', repo: 'api-v2', branch: 'chore/hasura-perms', account: 'mc', status: 'running', midTurn: true, ago: 'maintenant', tool: 'Grep · "select_permissions"' },
  { id: 'w14', name: 'stripe-webhook-retry', repo: 'api-v2', branch: 'fix/stripe-webhook-retry', account: 'mc', status: 'running', midTurn: true, ago: '2 min', tool: 'Edit · webhooks.ts' },
  { id: 'w13', name: 'loop-diag-form', repo: 'api-v2', branch: 'feat/diag-form-v2', account: 'mc', status: 'idle', ago: '3 h' },

  { id: 'w15', name: 'next-diag-pics', repo: 'next-api', branch: 'feat/diag-pictures', account: 'mc', status: 'running', midTurn: true, ago: '1 min', tool: 'Bash · composer test' },
  { id: 'w16', name: 'ydu-migrate-mc', repo: 'next-api', branch: 'migrate/mc-clients', account: 'mc', status: 'idle', ago: '1 j' },
  { id: 'w17', name: 'wp-sandbox-sync', repo: 'next-api', branch: 'chore/wp-sandbox-sync', account: 'mc', status: 'stopped', ago: '2 j' },

  { id: 'w19', name: 'espace-client-nav', repo: 'vecna-front', branch: 'feat/espace-client-nav', account: 'mc', status: 'running', midTurn: true, ago: 'maintenant', tool: 'Read · Nav.tsx' },
  { id: 'w20', name: 'a11y-pass', repo: 'vecna-front', branch: 'chore/a11y-pass', account: 'mc', status: 'idle', ago: '6 h' },

  { id: 'w21', name: 'dotfiles-sway', repo: 'dotfiles', branch: 'sway-headless-fix', account: 'perso', status: 'idle', ago: '1 j' },
  { id: 'w22', name: 'nvim-lsp', repo: 'dotfiles', branch: 'nvim-lsp-attach', account: 'perso', status: 'idle', ago: '2 j' },
];

export const REPO_ORDER = ['orchestra', 'api-v2', 'vecna-front', 'next-api', 'dotfiles'];

export const STATUS_LABEL = {
  waiting: 'en attente', unread: 'non lu', running: 'en cours',
  idle: 'inactif', error: 'erreur', stopped: 'arrêté',
};

// Display status: "non lu" is a flag on an idle workspace, shown as its own state.
export const dstatus = (w) => (w.status === 'idle' && w.unread ? 'unread' : w.status);
export const needsMe = (w) => dstatus(w) === 'waiting' || dstatus(w) === 'unread';
// Urgency rank: en attente, non lu, erreur, en cours, inactif, arrêté.
const RANK = { waiting: 0, unread: 1, error: 2, running: 3, idle: 4, stopped: 5 };
export const byUrgency = (a, b) => RANK[dstatus(a)] - RANK[dstatus(b)];

export const counts = () => {
  const c = { waiting: 0, unread: 0, running: 0, idle: 0, error: 0, stopped: 0 };
  for (const w of WS) c[dstatus(w)]++;
  return { ...c, total: WS.length, needs: c.waiting + c.unread };
};

export const byRepo = () => REPO_ORDER.map((repo) => ({ repo, items: WS.filter((w) => w.repo === repo).sort(byUrgency) }));

// ── Conversations ─────────────────────────────────────────────────────────
export const CONVO_ASK = {
  ws: 'w1',
  turns: [
    { role: 'user', t: '14:02', text: 'Le timeout de l’ask gate ne se réarme pas après un restart du keeper. Tu peux regarder et corriger ?' },
    { role: 'tool', kind: 'search', verb: 'Grep', arg: '"armAskTimeout" src/main' },
    { role: 'tool', kind: 'file', verb: 'Read', arg: 'src/main/bus-gates.ts' },
    { role: 'tool', kind: 'file', verb: 'Read', arg: 'src/main/bus-wake.ts' },
    { role: 'assistant', t: '14:05', text: 'Trouvé : `armAskTimeout()` n’est appelé qu’à l’`openGate`, jamais au rechargement des gates ouvertes. Après un restart les timers sont perdus et l’ask reste ouvert pour toujours.' },
    { role: 'tool', kind: 'edit', verb: 'Edit', arg: 'src/main/bus-gates.ts', note: '+14 −2' },
    { role: 'tool', kind: 'bash', verb: 'Bash', arg: 'pnpm test -- bus-gates', note: '12 pass' },
    { role: 'assistant', t: '14:09', text: 'Le réarmement fonctionne. Il me faut ton avis sur la stratégie de retry quand le timer expire : elle change le comportement côté LEAD.' },
  ],
  ask: {
    header: 'Stratégie de retry',
    question: 'Quelle stratégie de retry pour le réarmement du timeout ?',
    options: [
      { label: 'Backoff exponentiel', desc: '1 s → 30 s, 5 essais max' },
      { label: 'Délai fixe 5 s', desc: 'Plus simple, charge constante' },
      { label: 'Pas de retry', desc: 'Échec immédiat, remonté au LEAD' },
    ],
  },
};

export const CONVO_ELICIT = {
  ws: 'w10',
  turns: [
    { role: 'user', t: '13:41', text: 'Prépare l’export CSV des factures et relie-le au ticket NMC-412.' },
    { role: 'tool', kind: 'file', verb: 'Read', arg: 'src/invoices/export.ts' },
    { role: 'tool', kind: 'edit', verb: 'Write', arg: 'src/invoices/export-csv.ts', note: '+88' },
    { role: 'tool', kind: 'bash', verb: 'Bash', arg: 'pnpm test invoices', note: '31 pass' },
    { role: 'assistant', t: '13:58', text: 'L’export est prêt et testé. Pour lire `NMC-412` j’ai besoin du serveur MCP Linear — il demande une autorisation.' },
  ],
  elicitation: { server: 'linear', message: 'Autoriser l’accès en lecture au ticket NMC-412 ?' },
};

export const CONVO_RUNNING = {
  ws: 'w3',
  turns: [
    { role: 'user', t: '14:21', text: 'Lance la suite de tests et liste les rouges.' },
    { role: 'tool', kind: 'bash', verb: 'Bash', arg: 'pnpm test', running: true },
    { role: 'assistant', t: '14:23', streaming: true, text: 'Les tests tournent — 1 812 sur ~4 100 passés, aucun rouge pour l’instant. Je regroupe les résultats par fichier dès que' },
    { role: 'user', t: '14:24', queued: true, text: 'Quand c’est fini, rebase sur master.' },
  ],
  draft: 'Et mets à jour la codebase-map si besoin',
};

export const CONVO_FAILED = {
  ws: 'w5',
  turns: [
    { role: 'user', t: '17:50', text: 'Reprends #331 là où tu t’étais arrêté et dis-moi ce qui bloque.' },
    { role: 'tool', kind: 'file', verb: 'Read', arg: 'docs/codebase-map/pause-trap.md' },
    { role: 'tool', kind: 'bash', verb: 'Bash', arg: 'pnpm run test:reliquats', note: '41 pass' },
    { role: 'user', t: '18:12', text: 'Où en est #331 ?' },
    { role: 'assistant', t: '18:40', text: '#331 est prêt : les mutants unitaires sont verts, il ne manque que ton jeton heavy pour lancer le run Docker.' },
    { role: 'user', t: '19:02', failed: true, text: 'Go pour le run heavy.' },
  ],
  error: 'La session n’a pas démarré (mémoire insuffisante).',
};

export const SYNC = '14:02';

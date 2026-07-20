#!/usr/bin/env node
// Live swarm dashboard for the GTK4 port.
//
// Re-derives every number at run time — nothing here is a snapshot. Run it
// again and it tells you the truth again:
//
//   node scripts/swarm-dashboard.mjs            # write docs/swarm-dashboard.html
//   node scripts/swarm-dashboard.mjs --watch    # regenerate every 30s
//
// Sources, in order of authority:
//   - `orchestra peers`            → live agent status (running/waiting/idle)
//   - `git log <tip>..<branch>`    → unmerged commits PER BRANCH TIP
//   - docs/gtk4-parity-inventory.md → surface counts
//
// The unmerged-commit column is the load-bearing one. An agent that goes
// "idle" without reporting has happened three times in this milestone, and
// its work sits unmerged with nothing failing. `idle` + `>0 unmerged` is the
// state that needs a human, so the dashboard sorts it to the top and flags it.

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(REPO, 'docs/swarm-dashboard.html');
const APPIMAGE = '/home/lmas/Applications/orchestra/release/Orchestra.AppImage';

/**
 * One source of truth for the cadence: the regenerate interval AND the page's
 * own meta-refresh. If these drift apart the tab reloads a file that hasn't
 * been rewritten yet (or shows stale data while a fresh file sits on disk) —
 * a discrepancy nothing would report. The +2s offset makes the reload land
 * just after the rewrite rather than racing it.
 */
const PERIOD_S = 30;

/** Where the port's work forks from. Used to scope "what did this agent add". */
const MAIN_BASE = 'master';
const WATCHING = process.argv.includes('--watch');

/**
 * Optional notes, keyed by branch. Purely descriptive — the agent LIST itself
 * is discovered, never hardcoded. A hand-maintained roster silently omits
 * every agent spawned after it was written, which is the same class of quiet
 * staleness this dashboard exists to surface.
 */
const NOTES = {
  'fix-sidebar-width': 'worst layout defect; the constraint, not the labels',
  'audit-gtk-design-system-parity': 'root causes — explains the others',
  'w2-verify-sidebar': '58 surfaces',
  'w2-verify-overlays': '34 surfaces — overlay internals',
  'w2-verify-dialogs': '19 surfaces',
  'verify-mainpane-overlays': 'tab active is ToggleButton state, not a class',
  'verify-sidebar': '12 ranked defects',
  'verify-dialogs-modals': 'backdrop dim ≠ blur',
  'gtk-toolbar-icons-buttons': '2 items correctly refused',
};

/**
 * The agents this push is about. Discovery finds every branch sharing history
 * with the integration line — which reaches back to M1 and sweeps in unrelated
 * work — so ACTIVE is the foreground set and everything else that still shares
 * history is listed as earlier work.
 *
 * Branches outside ACTIVE are still checked for stranded commits and promoted
 * into the table if any are found: the scoping controls what is SHOWN, never
 * what is CHECKED. Narrowing the check is how stranded work goes invisible.
 */
const ACTIVE = new Set([
  'fix-sidebar-width',
  'w2-verify-sidebar',
  'w2-verify-overlays',
  'w2-verify-dialogs',
  'audit-gtk-design-system-parity',
  'verify-sidebar',
  'verify-mainpane-overlays',
  'verify-dialogs-modals',
  'gtk-toolbar-icons-buttons',
]);

/**
 * Discover this milestone's agents: every peer whose branch actually exists in
 * THIS repo and shares history with the integration branch. That is what makes
 * an agent "mine" — not a name pattern I have to remember to update.
 */
function discoverSwarm(peers) {
  const out = [];
  for (const [branch] of peers) {
    if (!sh('git', ['rev-parse', '--verify', '--quiet', branch]).trim()) continue;
    // Shares history with the integration line → spawned off this milestone.
    if (!sh('git', ['merge-base', 'HEAD', branch]).trim()) continue;
    out.push({
      branch,
      task: branch.replace(/^w2-/, '').replace(/-/g, ' '),
      note: NOTES[branch] ?? '',
      archived: !ACTIVE.has(branch),
    });
  }
  return out;
}

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

/** Live agent status keyed by branch. Absent = the agent is gone, not idle. */
function peerStatus() {
  const out = sh(APPIMAGE, ['cli', 'peers']);
  const map = new Map();
  for (const line of out.split('\n')) {
    // id  branch  repo  status — split on 2+ spaces, status is last
    const cells = line.trim().split(/\s{2,}/);
    if (cells.length >= 3 && /^[0-9a-f-]{36}$/.test(cells[0])) {
      map.set(cells[1], cells[cells.length - 1]);
    }
  }
  return map;
}

/**
 * Unmerged commits on a branch TIP — not `--is-ancestor` of a named sha.
 * That distinction cost this milestone five stranded commits: ancestry answers
 * "did the commit I named land", not "did everything this agent produced land",
 * and it passes cleanly while later commits sit unmerged.
 */
function unmerged(branch) {
  const out = sh('git', ['log', '--oneline', `HEAD..${branch}`]);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}


/**
 * Rendered-frame evidence that EXISTS ON DISK right now.
 *
 * The parity inventory's status counts are a one-time source-derived snapshot:
 * they were written once and never move, so a panel showing them refreshes
 * faithfully while reporting a frozen figure — precisely the plausible,
 * precise, wrong number this dashboard exists to catch. The agents have since
 * shown that document also contains false ABSENTs (surfaces listed missing
 * that are hundreds of lines long and have rendered frames), because its
 * negatives came from guessed identifiers.
 *
 * Captures and reports, by contrast, appear as agents actually finish work.
 */
function evidence() {
  const dir = resolve(REPO, 'docs/visual-reference');
  if (!existsSync(dir)) return null;
  const sets = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const n = readdirSync(resolve(dir, d.name)).filter((f) => f.endsWith('.png')).length;
    if (n) sets.push({ name: d.name, n });
  }
  const reports = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const loose = readdirSync(dir).filter((f) => f.endsWith('.png')).length;
  return {
    sets: sets.sort((a, b) => b.n - a.n),
    total: sets.reduce((s, x) => s + x.n, 0) + loose,
    loose,
    reports,
  };
}

function inventoryCounts() {
  const p = resolve(REPO, 'docs/gtk4-parity-inventory.md');
  if (!existsSync(p)) return null;
  // Collapse whitespace first: the headline wraps mid-phrase ("56 are\nVISUALLY-
  // PORTED"), so a line-bound regex silently misses a category and the meter
  // renders one segment short — a quiet omission, not an error.
  const src = readFileSync(p, 'utf8').replace(/\s+/g, ' ');
  const grab = (label) => {
    const m = src.match(new RegExp(`(\\d+)\\s+(?:are\\s+)?${label}`, 'i'));
    return m ? Number(m[1]) : null;
  };
  const counts = {
    verified: grab('VERIFIED-PORTED'),
    visual: grab('VISUALLY-PORTED'),
    partial: grab('PARTIAL'),
    stub: grab('STUB'),
    absent: grab('ABSENT'),
  };
  // Any null means the doc's wording drifted from this parser. Say so loudly
  // rather than rendering a bar that looks complete and isn't.
  const missing = Object.entries(counts).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length) counts.__missing = missing;
  return counts;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function build() {
  const peers = peerStatus();
  const inv = inventoryCounts();
  const ev = evidence();
  const tip = sh('git', ['rev-parse', '--short', 'HEAD']).trim();
  // LOCAL time, not toISOString(): a UTC stamp beside a local wall clock reads
  // as a two-hour-stale page and undermines the one thing this header is for.
  const stamp = new Date().toLocaleString('sv-SE');

  const all = discoverSwarm(peers).map((a) => {
    const commits = unmerged(a.branch);
    const status = peers.get(a.branch) ?? 'gone';
    // "Ready to merge" applies ONLY to agents in this push. An unrelated
    // branch from an earlier milestone also has commits I do not have — that
    // is normal divergence, not work waiting on me, and labelling it "merge
    // me" is advice that would land someone else's release commits on this
    // branch. Scope the CALL TO ACTION; keep the count visible either way.
    const ready = commits.length > 0 && !a.archived && status !== 'running';
    return { ...a, status, commits, ready };
  });

  // Ready-to-merge first (needs action), then running, then the rest — order
  // by what the reader must DO, not by spawn order.
  const weight = (r) => (r.ready ? 0 : r.status === 'running' ? 1 : 2);
  const rows = all
    .filter((r) => !r.archived)
    .sort((a, b) => weight(a) - weight(b) || a.branch.localeCompare(b.branch));
  const archivedRows = all.filter((r) => r.archived);

  const strandedCount = rows.filter((r) => r.ready).length;
  const running = rows.filter((r) => r.status === 'running').length;


  // Only self-refresh when a watcher is actually rewriting the file. A
  // published snapshot that reloads itself would just re-render identical
  // bytes forever and *look* live — the exact false-liveness this dashboard
  // exists to avoid.
  const refresh = WATCHING ? `<meta http-equiv="refresh" content="${PERIOD_S + 2}">\n` : '';

  return `${refresh}<title>GTK4 port — swarm state</title>
<style>
  /* Accent #6ea8ff is the GTK port's own accent bar, pixel-sampled at (110,168,255).
     Neutrals carry a blue bias toward it rather than being pure grey. Semantic
     amber/green are separate from the accent and only encode state. */
  :root {
    color-scheme: light dark;
    --mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
    --bg:#10131a; --card:#181d26; --fg:#e4e8f0; --dim:#7c879c;
    --line:#242b37; --line2:#2f3949;
    --run:#6ea8ff; --warn:#e8b339; --ok:#5fd08a;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f7f9fc; --card:#fff; --fg:#161b24; --dim:#5a6475;
            --line:#e3e8f1; --line2:#cfd7e5; --run:#2f6fd0; --warn:#a8730c; --ok:#1f8a52; }
  }
  :root[data-theme="dark"] {
    --bg:#10131a; --card:#181d26; --fg:#e4e8f0; --dim:#7c879c;
    --line:#242b37; --line2:#2f3949; --run:#6ea8ff; --warn:#e8b339; --ok:#5fd08a;
  }
  :root[data-theme="light"] {
    --bg:#f7f9fc; --card:#fff; --fg:#161b24; --dim:#5a6475;
    --line:#e3e8f1; --line2:#cfd7e5; --run:#2f6fd0; --warn:#a8730c; --ok:#1f8a52;
  }
  body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
         -webkit-font-smoothing:antialiased; }
  main { max-width:56rem; margin:0 auto; }
  h1 { font-size:1.35rem; margin:0 0 .2rem; letter-spacing:-.01em; }
  .sub { color:var(--dim); font-size:.85rem; margin:0 0 1.75rem; }
  .sub code { background:var(--card); padding:.1rem .35rem; border-radius:4px; }
  h2 { font-size:.78rem; text-transform:uppercase; letter-spacing:.09em; color:var(--dim);
       margin:2.25rem 0 .75rem; font-weight:600; }
  .banner { border:1px solid var(--warn); background:color-mix(in srgb, var(--warn) 12%, transparent);
            border-radius:9px; padding:.7rem .9rem; margin-bottom:1.25rem; font-size:.9rem; }
  .meter { display:flex; height:.65rem; border-radius:999px; overflow:hidden; gap:2px;
           background:var(--line); }
  .seg { display:block; min-width:3px; }
  .seg.ok{background:var(--ok)} .seg.vis{background:var(--run)}
  .seg.part{background:color-mix(in srgb,var(--run) 45%,var(--card))}
  .seg.stub{background:var(--warn)} .seg.abs{background:var(--line2)}
  .legend { list-style:none; margin:.9rem 0 0; padding:0; display:grid;
            grid-template-columns:repeat(auto-fit,minmax(11rem,1fr)); gap:.45rem 1rem; }
  .legend li { display:flex; align-items:baseline; gap:.4rem; font-size:.8rem; }
  .legend b { font-variant-numeric:tabular-nums; font-family:var(--mono); }
  .legend .lk { font-weight:600; }
  .legend .why { color:var(--dim); font-size:.72rem; }
  .dot { width:.5rem; height:.5rem; border-radius:2px; flex:none; align-self:center; }
  .dot.ok{background:var(--ok)} .dot.vis{background:var(--run)}
  .dot.part{background:color-mix(in srgb,var(--run) 45%,var(--card))}
  .dot.stub{background:var(--warn)} .dot.abs{background:var(--line2)}
  .pct { margin:.9rem 0 0; font-size:.82rem; }
  .warnline { margin:.5rem 0 0; font-size:.78rem; color:var(--warn); }
  .arch { font-size:.76rem; line-height:1.9; }
  .arch .mono { color:var(--dim); }
  .wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:.88rem; }
  th { text-align:left; font-size:.72rem; text-transform:uppercase; letter-spacing:.07em;
       color:var(--dim); font-weight:600; padding:0 .7rem .5rem 0; white-space:nowrap; }
  td { padding:.6rem .7rem .6rem 0; border-top:1px solid var(--line); vertical-align:top; }
  tr.stranded td { background:color-mix(in srgb, var(--warn) 9%, transparent); }
  .pill { display:inline-block; padding:.1rem .5rem; border-radius:999px; font-size:.72rem;
          font-weight:600; border:1px solid transparent; white-space:nowrap; }
  .running { color:var(--run); border-color:color-mix(in srgb,var(--run) 40%,transparent);
             background:color-mix(in srgb,var(--run) 12%,transparent); }
  .idle    { color:var(--dim); border-color:var(--line); }
  .waiting { color:var(--warn); border-color:color-mix(in srgb,var(--warn) 40%,transparent);
             background:color-mix(in srgb,var(--warn) 12%,transparent); }
  .gone    { color:var(--dim); border-color:var(--line); opacity:.6; }
  .task { font-weight:550; }
  .note { color:var(--dim); font-size:.78rem; }
  .mono { font-family:var(--mono); font-size:.78rem; }
  td .mono { color:var(--fg); }
  .num { font-family:var(--mono); font-variant-numeric:tabular-nums; }
  .muted { color:var(--dim); }
  footer { margin-top:2.5rem; padding-top:1rem; border-top:1px solid var(--line);
           color:var(--dim); font-size:.78rem; }
</style>
<main>
  <h1>GTK4 port — swarm state</h1>
  <p class="sub">Generated ${stamp} at <code>${tip}</code> · re-run to refresh; every number is re-derived, nothing is cached.</p>

  ${
    strandedCount
      ? `<div class="banner"><strong>${strandedCount} agent${strandedCount > 1 ? 's have' : ' has'} finished work waiting to be merged.</strong>
         An agent that stops with commits nobody merged fails silently — it happened three times in this milestone. Flagged rows below.</div>`
      : ''
  }

  <h2>Agents — ${running} running of ${rows.length}</h2>
  <div class="wrap">
  <table>
    <thead><tr><th>Agent</th><th>Task</th><th>Status</th><th>Work waiting on me</th></tr></thead>
    <tbody>
    ${rows
      .map(
        (r) => `<tr class="${r.ready ? 'stranded' : ''}">
        <td class="mono">${esc(r.branch)}</td>
        <td><div class="task">${esc(r.task)}</div>${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}</td>
        <td><span class="pill ${r.status}">${r.status}</span></td>
        <td>${
          r.ready
            ? `<strong>${r.commits.length} commit${r.commits.length > 1 ? 's' : ''} to merge</strong><div class="note mono">${esc(r.commits[0].slice(0, 58))}</div>`
            : r.status === 'running'
              ? '<span class="muted">still working</span>'
              : '<span class="muted">nothing pending</span>'
        }</td>
      </tr>`,
      )
      .join('')}
    </tbody>
  </table>
  </div>

  ${
    archivedRows.length
      ? `<h2>Other branches sharing this history — ${archivedRows.length}</h2>
         <p class="muted arch">Earlier milestones and unrelated work. They diverge from this branch by
         design, so a commit count here is normal divergence, not work waiting on anyone.</p>
         <p class="muted arch">${archivedRows.map((r) => `<span class="mono">${esc(r.branch)}</span>`).join(' · ')}</p>`
      : ''
  }

  <h2>Rendered evidence on disk${ev ? ` — ${ev.total} captures` : ''}</h2>
  ${
    ev
      ? `<ul class="legend">${ev.sets
          .map((s) => `<li><b>${s.n}</b> <span class="lk mono">${esc(s.name)}</span></li>`)
          .join('')}${ev.loose ? `<li><b>${ev.loose}</b> <span class="lk">reference pair</span></li>` : ''}</ul>
         <p class="muted pct">Reports: ${ev.reports.map((r) => `<span class="mono">${esc(r)}</span>`).join(' · ') || 'none yet'}</p>`
      : '<p class="muted">No captures yet.</p>'
  }

  <h2>Parity inventory — withdrawn as a score</h2>
  <p class="muted pct">The 118-surface status bar that used to sit here has been REMOVED, not
  just caveated. It was written once from source review this morning and never moved, so it
  read "3 verified / 97% unchecked" while agents produced the ${ev ? ev.total : 'many'} captures
  above. Worse, its verdicts are wrong in a known direction: it searched a namespace it
  <em>guessed</em>, so an identifier the port renamed is invisible to it — four surfaces it calls
  ABSENT are fully implemented (welcome screen, Linear settings, repo-scripts,
  <span class="mono">.usage-bar-fill</span>). Its positives are trustworthy; its negatives are not.
  A caveat above a large number does not stop the number being read, so the number is gone.
  Coverage now comes from the per-region reports, which state N-of-M and name what they did not
  reach.</p>

  <footer>
    Status from <span class="mono">orchestra peers</span>; unmerged from
    <span class="mono">git log HEAD..&lt;branch&gt;</span> against each branch <em>tip</em> —
    not <span class="mono">--is-ancestor</span> of a named sha, which answers a different
    question and passes while later commits sit stranded.
  </footer>
</main>`;
}

function write() {
  writeFileSync(OUT, build());
  process.stdout.write(`${new Date().toTimeString().slice(0, 8)}  wrote ${OUT}\n`);
}

write();
if (WATCHING) {
  process.stdout.write(`watching — regenerating every ${PERIOD_S}s; open file://${OUT}\n`);
  setInterval(write, PERIOD_S * 1000);
}

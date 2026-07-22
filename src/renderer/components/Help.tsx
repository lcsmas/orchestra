import { useStore } from '../store';

// Help / feature guide — the in-app answer to "what can Orchestra do?".
// `HelpView` is a main-pane overlay (same contract as InsightsView: absolute
// over the pane row so the kept-alive terminals never unmount), opened from
// the sidebar header's "?" button or the welcome screen. Content is static
// data below — one section per feature area, one line per feature — kept
// deliberately terse: this is a map of the app, not a manual. The full
// walkthrough lives in docs/guide/ in the repo (linked in the footer).

const GUIDE_URL = 'https://github.com/lcsmas/orchestra/tree/master/docs/guide';

export function HelpIcon({ size = 15 }: { size?: number }) {
  // Lucide `circle-help`.
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

type HelpItem = { name: string; desc: string };
type HelpSection = { title: string; intro?: string; items: HelpItem[] };

const SECTIONS: HelpSection[] = [
  {
    title: 'The core loop',
    intro:
      'Register a git repo, then spawn workspaces off it. Each workspace is a real git worktree on its own branch with its own Claude Code agent — agents never clobber each other, and you watch them all from one sidebar.',
    items: [
      { name: 'Workspace', desc: 'Branch + isolated worktree + live agent, cut from the repo’s base branch. Archive removes worktree and branch in one step.' },
      { name: 'Scratch session', desc: 'A throwaway agent with no repo and no git — for quick questions and experiments. One click, zero setup.' },
      { name: 'Orchestrator', desc: 'A coordinator agent that delegates instead of coding: it spawns child agents and the sidebar nests them beneath it. A guard hook blocks it from editing children’s files.' },
      { name: 'Setup scripts', desc: 'Per-repo setup / run / archive scripts (gear icon on the repo header) run automatically at workspace creation, in the Run tab, and at archive time.' },
    ],
  },
  {
    title: 'Agents that spawn agents',
    intro:
      'Every agent is told it can delegate: one CLI call creates a sibling workspace whose agent starts working immediately. Ask one agent to parallelize a refactor and watch the sidebar fill up.',
    items: [
      { name: 'Spawn', desc: '`orchestra spawn --task "…"` — new branch, new worktree, new agent, nested under the spawner. Spawned agents can spawn too.' },
      { name: 'Peer comms', desc: 'Agents list siblings (`orchestra peers`), read each other’s transcripts, and message each other — messages queue in an inbox if the peer is stopped.' },
      { name: 'Self-naming branches', desc: 'Fresh branches get a placeholder name; the agent renames its branch once it understands the task.' },
      { name: 'Attach / detach', desc: 'Re-parent any existing workspace under an orchestrator (or pop it back out) to organize a fleet after the fact.' },
    ],
  },
  {
    title: 'Review & ship',
    intro: 'Track changes and go straight to a PR — without leaving the dashboard.',
    items: [
      { name: 'Change counts', desc: '+/− line counts on every sidebar row show how much each workspace has changed vs. its base, refreshed live while the agent works.' },
      { name: 'One-click PR', desc: 'Commit → push → `gh pr create`, from the toolbar. The sidebar then tracks the PR’s state.' },
      { name: 'Merge & release pills', desc: 'Sidebar pills show merged / diverged / unpushed work, and the earliest release that contains the branch’s commits.' },
      { name: 'Base sync', desc: 'Behind/ahead counts vs. origin’s base branch, refreshed on focus — stale branches are visible at a glance.' },
    ],
  },
  {
    title: 'Terminals & status',
    items: [
      { name: 'Live terminal', desc: 'A real TTY per agent — full color, resize, scrollback, image paste.' },
      { name: 'Run tab', desc: 'A second terminal per workspace running the repo’s configured run script (dev server, tests) with Start/Stop.' },
      { name: 'Nvim pane', desc: 'Split the main pane with a Neovim editor opened on the worktree.' },
      { name: 'Status dots', desc: 'Idle / running / waiting / error per workspace, driven by Claude Code’s own lifecycle hooks — no polling, no terminal scraping. Plus a live context-size badge per agent.' },
      { name: 'Chime', desc: 'A notification sound when an agent finishes while the window is unfocused — pick from ~20 synthesized sounds (bell icon).' },
    ],
  },
  {
    title: 'Accounts & usage',
    intro: 'Run different workspaces under different Claude logins, and see how much headroom each has.',
    items: [
      { name: 'Multi-account', desc: 'Add extra Claude logins (users icon); pin any workspace to any account, or migrate one mid-conversation — the session resumes under the new login.' },
      { name: 'Usage bars', desc: '5-hour and weekly utilization per account at the bottom of the sidebar, hottest first.' },
      { name: 'Prompt queue', desc: 'Hit a usage limit and prompts park in a queue, then auto-submit when the window resets.' },
    ],
  },
  {
    title: 'Remote sandbox agents',
    intro: 'Move a workspace into an always-on Docker sandbox: the agent, checkout, and session live in the container, and Orchestra becomes a thin client.',
    items: [
      { name: 'Import / eject', desc: '☁ buttons on a workspace row move it into the sandbox and back out — agents keep working with the laptop closed.' },
      { name: 'Multi-machine', desc: 'Open the same sandbox workspace from several machines; an ownership lock makes one the driver and the others read-only viewers.' },
      { name: 'Auto-backups', desc: 'The sandbox snapshots workspace state every 30 minutes.' },
    ],
  },
  {
    title: 'Integrations & extras',
    items: [
      { name: 'Linear', desc: 'Branches named like TEAM-123-… get a live Linear issue badge (title, state) in the sidebar.' },
      { name: 'Insights & Improvements', desc: 'A monthly self-tune pass: regenerates each login’s Claude Code insights report and distills new lessons into ~/.claude/LESSONS.md — so your agents get a little better every month.' },
      { name: 'CLI', desc: 'The `orchestra` command drives everything over the app’s local socket — spawn, peers, read, message, rename, promote, attach, add-repo, accounts, migrate-account, delete. Run `orchestra --help`.' },
    ],
  },
  {
    title: 'Orchestra can improve itself',
    intro:
      'Orchestra is developed inside Orchestra — and your copy can do the same. Register Orchestra’s own repo as a spawn target and point agents at it: "add a keyboard shortcut for the diff tab", "make the chime configurable per repo", "fix that sidebar glitch".',
    items: [
      { name: 'Self-aware agents', desc: 'An agent spawned on the Orchestra repo is told it is modifying the app that runs it — including that changes only take effect after a release, and where the generated hooks come from.' },
      { name: 'Ship from within', desc: 'The repo’s ship skill lets the agent release and install its own change: the app you’re using gets better because you asked it to.' },
      { name: 'Architecture map', desc: 'docs/codebase-map/ gives agents (and you) a per-subsystem reference with file:line anchors, so improvements start from real context.' },
    ],
  },
];

export function HelpView() {
  const setHelpOpen = useStore((s) => s.setHelpOpen);

  return (
    <div className="help-view">
      <div className="help-view-header">
        <span className="help-view-icon" aria-hidden="true">
          <HelpIcon size={16} />
        </span>
        <div className="help-view-titles">
          <h2>What Orchestra can do</h2>
          <div className="help-view-sub">
            Parallel Claude Code agents in isolated git worktrees — spawn, watch, review, ship.
          </div>
        </div>
        <button
          className="help-close"
          onClick={() => setHelpOpen(false)}
          title="Close"
          aria-label="Close help"
        >
          ×
        </button>
      </div>

      <div className="help-view-body">
        {SECTIONS.map((section) => (
          <section className="help-panel" key={section.title}>
            <div className="help-panel-title">{section.title}</div>
            {section.intro && <div className="help-panel-intro">{section.intro}</div>}
            <div className="help-items">
              {section.items.map((item) => (
                <div className="help-item" key={item.name}>
                  <span className="help-item-name">{item.name}</span>
                  <span className="help-item-desc">{item.desc}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
        <div className="help-footer">
          Want the full walkthrough?{' '}
          <button
            className="help-link"
            onClick={() => void window.orchestra.openExternal(GUIDE_URL)}
            title={GUIDE_URL}
          >
            Read the user guide ↗
          </button>
        </div>
      </div>
    </div>
  );
}

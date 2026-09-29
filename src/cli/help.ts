// CLI help registry: one entry per top-level verb dispatched in index.ts main().
// help.test.ts fails if a `case` in main() has no entry here (or vice versa).

export interface CommandHelp {
  name: string;
  group: string;
  /** One line for the `orchestra --help` overview. */
  summary: string;
  /** Full text for `orchestra help <name>` / `orchestra <name> --help`. */
  detail: string;
}

const GROUPS = [
  'Workspaces',
  'Fleet bus',
  'Legacy messaging',
  'Structure',
  'Links & tickets',
  'Accounts',
  'Internal',
] as const;

const BUS_IDENTITY = `
Identity flags (every bus verb):
  --run <id>      run to act on (default: $ORCHESTRA_RUN_ID, else 'default')
  --as <handle>   who you are on the bus (default: $ORCHESTRA_WS_ID)`;

export const COMMANDS: CommandHelp[] = [
  // ── Workspaces ────────────────────────────────────────────────────────
  {
    name: 'peers',
    group: 'Workspaces',
    summary: 'List the other agent workspaces',
    detail: `usage: orchestra peers [--stats]

List the other agent workspaces (never includes yourself — see 'whoami').
  --stats   also show each peer's committed diff vs its base`,
  },
  {
    name: 'read',
    group: 'Workspaces',
    summary: "Print a workspace's transcript",
    detail: `usage: orchestra read <id> [--lines N]

Print a workspace's transcript (last N lines with --lines).`,
  },
  {
    name: 'whoami',
    group: 'Workspaces',
    summary: "Print THIS workspace's own record",
    detail: `usage: orchestra whoami

Print THIS workspace's own record: id, branch, kind, orchestrator role,
parent, repo, base.`,
  },
  {
    name: 'status',
    group: 'Workspaces',
    summary: "Set/clear THIS workspace's one-line status note",
    detail: `usage: orchestra status <text...>
       orchestra status --clear

Set THIS workspace's one-line status note — shown under its sidebar row and
in 'peers'. --clear removes it.`,
  },
  {
    name: 'spawn',
    group: 'Workspaces',
    summary: 'Spawn a new worktree + agent',
    detail: `usage: orchestra spawn --task <text> [--repo <path>] [--base <branch>] [--model <model>] [--effort <level>] [--detached]

Spawn a new worktree + agent, nested under the caller by default.
  --task <text>     the agent's brief (required)
  --repo <path>     repo to branch from (default: the caller's)
  --base <branch>   base branch
  --model <model>   pin the agent's model (full wire id); omitted = the user's
                    spawned-agent default from Settings
  --effort <level>  reasoning effort: low|medium|high|xhigh|max; omitted = the
                    spawned-agent default from Settings
  --detached        top-level, not nested under the caller`,
  },
  {
    name: 'rename',
    group: 'Workspaces',
    summary: "Rename a workspace's branch",
    detail: `usage: orchestra rename <id> <branch>

Rename a workspace's git branch (do not also run 'git branch -m').`,
  },
  {
    name: 'set-base',
    group: 'Workspaces',
    summary: 'Retarget the base branch (Diff/merge target)',
    detail: `usage: orchestra set-base <id> <branch>

Retarget a workspace's base branch — the Diff/merge target.`,
  },
  {
    name: 'restart',
    group: 'Workspaces',
    summary: "Relaunch a workspace's claude process (re-reads CLAUDE.md/settings)",
    detail: `usage: orchestra restart [<id>] [--fresh]

Relaunch a workspace's claude process so it re-reads CLAUDE.md/settings,
WITHOUT touching worktree/branch/commits. Default: THIS workspace; handles
terminal + structured sessions.
  --fresh   start a new conversation (default keeps the conversation)`,
  },
  {
    name: 'reload-skills',
    group: 'Workspaces',
    summary: 'Make out-of-band skill/plugin installs visible to running sessions',
    detail: `usage: orchestra reload-skills [<id>|--all] [--plugins]

Make out-of-band skill/plugin installs visible to ALREADY-RUNNING sessions,
without restarting them. Default: THIS workspace.
  --all       every live session
  --plugins   also reload plugins (unlike ~/.claude/skills, NOT watched)`,
  },
  {
    name: 'delete',
    group: 'Workspaces',
    summary: 'Delete a workspace (worktree + branch)',
    detail: `usage: orchestra delete <id> [--yes]

Delete a workspace: its worktree and branch. Destructive, so --yes (or -y)
is REQUIRED — without it the command refuses.`,
  },

  // ── Fleet bus ─────────────────────────────────────────────────────────
  {
    name: 'send',
    group: 'Fleet bus',
    summary: 'Append a message to the fleet bus',
    detail: `usage: orchestra send --type <kind> [--to <handle>] [--thread <id>] [--cap <token>] <body...>

Append a message to the FLEET BUS. Writes SQLite directly, so it lands even
while the app is down. Prints the message's sequence.
  --type <kind>      status dispatch worker_done escalation handoff
                     decision_gate question heartbeat
  --to <handle>      recipient (omitted = broadcast to the run)
  --thread <id>      thread id
  --cap <token>      a worker_done carries the token from its dispatch; a
                     missing or superseded one is rejected once the capability
                     switch is ON. A status may carry it but never requires it.
  --generation <n>   coordinator generation to fence the write on (#128); a
                     stale one is rejected
  --request-id <id>  idempotency key for receipts
--type dispatch also mints a capability token (printed on a 2nd line) — hand
it to the worker (who can re-fetch it with 'orchestra token').
${BUS_IDENTITY}`,
  },
  {
    name: 'check',
    group: 'Fleet bus',
    summary: 'Print YOUR pending lot (never acks)',
    detail: `usage: orchestra check [--ack-previous] [--markdown] [--limit N]

Relève: print YOUR pending lot as JSON. NEVER acks — the same lot replays
until you 'ack' it, so a crash between check and ack loses nothing.
  --ack-previous   ack the outstanding lot first, then take the next one
  --markdown       human render instead of JSON
  --limit N        cap the lot size (default 100)
${BUS_IDENTITY}`,
  },
  {
    name: 'ack',
    group: 'Fleet bus',
    summary: "Close the lot 'check' handed you",
    detail: `usage: orchestra ack <lot-id>

Accusé: close the lot 'check' handed you and advance your cursor past it.
Use the same --run/--as identity you checked with.
${BUS_IDENTITY}`,
  },
  {
    name: 'ask',
    group: 'Fleet bus',
    summary: 'Park a question for a handle and exit (never waits)',
    detail: `usage: orchestra ask --to <handle> <question...>

Park a question on the bus for <handle>, print its id and EXIT — never waits
(the answer comes back as an ordinary bus message).
${BUS_IDENTITY}`,
  },
  {
    name: 'token',
    group: 'Fleet bus',
    summary: 'Print YOUR current dispatch capability token',
    detail: `usage: orchestra token

Print YOUR current active dispatch capability token — carry it as --cap on
your worker_done (#167). Retrieve it AFTER any re-dispatch: a re-dispatch
supersedes your old token. Fails if nothing is dispatched to you.
${BUS_IDENTITY}`,
  },
  {
    name: 'gate',
    group: 'Fleet bus',
    summary: 'Open / resolve / list decision gates',
    detail: `usage: orchestra gate open [--to <handle>] <question...>
       orchestra gate resolve <id> --resolution <r>
       orchestra gate list

  open      open a decision gate awaiting a Ruling; --to addresses (and wakes)
            that reader until resolved, and surfaces it in their 'check'
  resolve   record the Ruling (refuses to overwrite one)
  list      open gates addressed to you (also shown by 'check')
  --generation <n>   coordinator generation fence (#128)
${BUS_IDENTITY}`,
  },
  {
    name: 'bus-status',
    group: 'Fleet bus',
    summary: "Print the bus's divergence counters for the current run (read-only)",
    detail: `usage: orchestra bus-status [--run <id>]

Print the shadow mirror's divergence counters for the current run (missed /
duplicate / lost-wake per mechanism), and whether the bus is reachable at
all. Read-only.`,
  },
  {
    name: 'run',
    group: 'Fleet bus',
    summary: "Admin: re-freeze a mission run's switches; hold / resume a run's liveness",
    detail: `usage: orchestra run refreeze [--run <id>]
       orchestra run hold [--run <id>] [--as <handle>]
       orchestra run resume [--run <id>] [--as <handle>]

  refreeze  Re-freeze a MISSION run's bus switches to the current live switches.
            For a FLAT orchestrator whose mission never picks up a switch flip.
            Refused on a non-mission run, or while any child is live mid-turn.
            Never creates a run row.
  hold      Put the run on HOLD: liveness stops escalating every member of it
            (workers AND its orchestrator). Durable in the bus, so it survives
            an app relaunch and works while the app is down. Idempotent.
            Only the run's coordinator or a coordinator of an ANCESTOR run may
            hold/resume it (caller = --as, else $ORCHESTRA_WS_ID); anyone else
            is refused. Fenced like send/ack (--generation). The holder is
            recorded and 'orchestra bus-status' shows a held run.
  resume    Clear the hold; escalation is re-enabled on the next sweep.
Default run: $ORCHESTRA_RUN_ID or 'default'. hold/resume refuse a run with no row.`,
  },

  // ── Legacy messaging ──────────────────────────────────────────────────
  {
    name: 'message',
    group: 'Legacy messaging',
    summary: "Send a prompt to a workspace (legacy; prefer 'send' on a bus run)",
    detail: `usage: orchestra message [--emergency] <id> <text...>
       orchestra message [--emergency] --children <text...>
       orchestra message [--emergency] --to <id,id,...> <text...>

Send a prompt straight into a workspace's session. LEGACY channel: for fleet
coordination on a bus run use 'orchestra send'. Refused toward a delivery-ON
target unless --emergency is the leading token.
  --children   broadcast to your DIRECT children (not the whole subtree)
  --to <ids>   broadcast to an explicit list
Broadcast forms print one delivery line PER TARGET and exit non-zero if ANY
target failed.`,
  },

  // ── Structure ─────────────────────────────────────────────────────────
  {
    name: 'promote',
    group: 'Structure',
    summary: 'Promote a scratch session into an orchestrator',
    detail: `usage: orchestra promote <id>

Promote a scratch session into an orchestrator.`,
  },
  {
    name: 'attach',
    group: 'Structure',
    summary: 'Nest an existing workspace under an orchestrator',
    detail: `usage: orchestra attach <id> <parentId> [--no-restart]

Nest an existing workspace under an orchestrator. By default the session is
restarted (conversation kept) so it re-derives its bus run.
  --no-restart   re-parent without restarting; the workspace is marked
                 'stale run' and its bus sends are refused until it restarts`,
  },
  {
    name: 'detach',
    group: 'Structure',
    summary: 'Pop a workspace back out to its own section',
    detail: `usage: orchestra detach <id> [--no-restart]

Pop a workspace back out to its own sidebar section. --no-restart: as for
'attach'.`,
  },
  {
    name: 'set-repo',
    group: 'Structure',
    summary: "Group an orchestrator under a repo's sidebar section (display only)",
    detail: `usage: orchestra set-repo <id> [<path>]

Group an ORCHESTRATOR (with its children) under a repo's sidebar section;
omit the path to clear. Display only — grants no repo/branch/diff and is never
inherited by spawn. To give it a real checkout, see 'adopt-repo'.`,
  },
  {
    name: 'adopt-repo',
    group: 'Structure',
    summary: 'Give a repo-less orchestrator a real checkout of a repo',
    detail: `usage: orchestra adopt-repo <id> <repoPath> [--base <branch>] [--no-restart]

Give a repo-LESS orchestrator a real worktree of <repoPath>, so its agent can
read the repo's docs/scripts and git-tracked project skills. Unlike 'set-repo'
this creates a worktree. The previous scratch dir is left in place.
  --base <branch>   base branch for the new worktree
  --no-restart      do not restart the session`,
  },
  {
    name: 'add-repo',
    group: 'Structure',
    summary: 'Register a repo by path',
    detail: `usage: orchestra add-repo <path>

Register a git repo with Orchestra.`,
  },
  {
    name: 'verify-landed',
    group: 'Structure',
    summary: "Check a workspace's branch tip landed on a target",
    detail: `usage: orchestra verify-landed <id> [--into <branch>]

Check every commit on a workspace's branch tip landed on the target
(default: YOUR branch).
Exit codes: 0 = landed, 2 = unmerged commits remain,
            1 = could not check (unknown id, no branch, …)`,
  },

  // ── Links & tickets ───────────────────────────────────────────────────
  {
    name: 'link',
    group: 'Links & tickets',
    summary: 'Report the PR(s) / Linear issue this workspace works on',
    detail: `usage: orchestra link [--pr <url>]... [--linear <KEY>] [id]
       orchestra link --clear [--pr [<url>]] [--linear]

Report the PR(s) / Linear issue THIS workspace is working on — the only
source for the sidebar badges. --pr repeats and ADDS (link every PR when work
spans several repos).
  --clear --pr <url>   remove one PR; a bare --pr removes them all
  --clear --linear     remove the Linear link`,
  },
  {
    name: 'linear',
    group: 'Links & tickets',
    summary: 'Pin / list / unpin Linear tickets in the sidebar',
    detail: `usage: orchestra linear add <url|TEAM-123> [--repo <path>] [--spawn] [--model <m>]
       orchestra linear list [--mine]
       orchestra linear rm <url|TEAM-123>
       orchestra linear pin <url|TEAM-123> [--workspace <id>]

  add    pin a ticket into the sidebar; --spawn also creates a worktree + agent
         for it, nested under you (like 'spawn')
  list   list pinned tickets; --mine: your open Linear issues
  rm     un-pin a ticket (never touches Linear)
  pin    attach a ticket to an existing workspace`,
  },

  // ── Accounts ──────────────────────────────────────────────────────────
  {
    name: 'accounts',
    group: 'Accounts',
    summary: 'List configured Claude accounts',
    detail: `usage: orchestra accounts

List configured Claude accounts (id + label).`,
  },
  {
    name: 'migrate-account',
    group: 'Accounts',
    summary: 'Move a workspace to another Claude account',
    detail: `usage: orchestra migrate-account <id> <accountId>
       orchestra migrate-account <id> --default

Migrate a workspace to another account, or back to the default login.`,
  },

  // ── Internal ──────────────────────────────────────────────────────────
  {
    name: 'login-url',
    group: 'Internal',
    summary: "(internal) route an account-login browser-open to the app",
    detail: `usage: orchestra login-url <url>

Internal: invoked by the browser-open shim inside an account-login PTY.`,
  },
];

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

export function findCommand(name: string): CommandHelp | undefined {
  return byName.get(name);
}

export function isHelpFlag(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h';
}

/** True when `orchestra <command> <args>` asks for help instead of acting:
 *  `--help`/`-h` as the first arg, or right after a subcommand
 *  (`gate open --help`). Never deeper — free text may contain "--help". */
const SUBCOMMAND_VERBS = new Set(['open', 'resolve', 'list', 'refreeze', 'add', 'rm', 'pin']);

/** `hold`/`resume` are `run` subcommands only — scoped so `orchestra status hold
 *  --help` (free text) is never read as a help request. */
const RUN_SUBCOMMANDS = new Set(['hold', 'resume']);

export function wantsCommandHelp(args: string[], command?: string): boolean {
  if (isHelpFlag(args[0])) return true;
  if (!isHelpFlag(args[1])) return false;
  return (
    SUBCOMMAND_VERBS.has(args[0] ?? '') || (command === 'run' && RUN_SUBCOMMANDS.has(args[0] ?? ''))
  );
}

export function commandHelp(name: string): string | undefined {
  const c = byName.get(name);
  return c && `${c.detail}\n`;
}

export function overview(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  const sections = GROUPS.map((g) => {
    const rows = COMMANDS.filter((c) => c.group === g).map(
      (c) => `  ${c.name.padEnd(width)}${c.summary}`,
    );
    return `${g}:\n${rows.join('\n')}`;
  });
  return `Orchestra CLI — talk to a running Orchestra app over its Unix socket.

usage: orchestra <command> [args...]

${sections.join('\n\n')}

Run 'orchestra help <command>' or 'orchestra <command> --help' for details.

Socket discovery (in order):
  1. the ORCHESTRA_SOCK environment variable, if set;
  2. else the contents of ~/.orchestra/sock (the absolute socket path);
  3. else the command fails — Orchestra is not running.
`;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length][b.length];
}

/** Closest known command names for a typo (distance ≤ 2, or a prefix match). */
export function suggest(name: string): string[] {
  return COMMANDS.map((c) => ({ n: c.name, d: editDistance(name, c.name) }))
    .filter(({ n, d }) => d <= 2 || (name.length >= 3 && n.startsWith(name)))
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
    .map(({ n }) => n);
}

export function unknownCommandMessage(name: string): string {
  const s = suggest(name);
  return (
    `unknown command: ${name}` +
    (s.length ? `\ndid you mean: ${s.join(', ')}?` : '') +
    `\nrun 'orchestra --help' for the list of commands`
  );
}

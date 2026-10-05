// Pause canary (#258) — the SCRIPTED MODELS of the dummy fleet (the fake API's `decide`). Zero tokens: each member's "model" is this function of
// (its role, its message history). Members behave like real agents where the Pause cares: they ack every lot they read (an unacked lot keeps the wake latch
// 'already-woken'), they run the REAL `orchestra run confirm pause|reprise` / `run release` verbs from THEIR OWN Bash tool (so the packaged `orchestra` shim is exercised).
import { textOf, TOKENS, ACCT_A } from './lib.mjs';
import { branchOf } from './ids.mjs';

const bash = (command, description, extra = {}) => ({ tool: { name: 'Bash', input: { command, description: `pc ${description}`, ...extra } } });
const LIMIT = (resetS) => ({ http: { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(resetS), 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': String(resetS), 'anthropic-ratelimit-unified-5h-utilization': '1.0', 'retry-after': '3600' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'limit' } } } });

const userTexts = (messages) => messages.filter((m) => m.role === 'user' && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some((b) => b.type === 'text')))).map((m) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')));
const commandsAfter = (messages, from) => messages.slice(from + 1).filter((m) => m.role === 'assistant' && Array.isArray(m.content)).flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => String(b.input?.command ?? '')));
const allCommands = (messages) => commandsAfter(messages, -1);
const count = (cmds, re) => cmds.filter((c) => re.test(c)).length;
const cnt = (messages, re, role) => messages.filter((m) => (role ? m.role === role : true) && re.test(JSON.stringify(m.content))).length;

/** what a cycle's work leaves in a member's worktree — shared with the drive's lost-work reader so both agree on the markers */
export function markersOf(role, n) {
  return [
    { name: `commit-${role}-c${n}.txt`, file: `commit-${role}-c${n}.txt`, needle: `COMMITTED ${role} c${n}`, shape: 'committed' },
    { name: `a.txt edit`, file: 'a.txt', needle: `edit ${role} c${n}`, shape: 'tracked-edit' },
    { name: `staged-${role}-c${n}.txt`, file: `staged-${role}-c${n}.txt`, needle: `STAGED ${role} c${n}`, shape: 'staged' },
    { name: `mark-${role}-c${n}.txt`, file: `mark-${role}-c${n}.txt`, needle: `MARK ${role} c${n}`, shape: 'untracked' },
  ];
}
const setupCmd = (r, n) => ['set -e',
  `echo "COMMITTED ${r} c${n}" > commit-${r}-c${n}.txt`, `git add commit-${r}-c${n}.txt`, `git commit -q -m "work ${r} c${n}"`,   // a commit on the member's branch
  `echo "edit ${r} c${n}" >> a.txt`,                                                                                        // a tracked, uncommitted edit
  `echo "STAGED ${r} c${n}" > staged-${r}-c${n}.txt`, `git add staged-${r}-c${n}.txt`,                                      // staged, uncommitted
  `echo "MARK ${r} c${n}" > mark-${r}-c${n}.txt`,                                                                           // untracked
  'echo SETUP-OK'].join('; ');

/** `plan.release`: 'all' (the OPS releases everyone as soon as its own Consigne arrives) | 'manual' (the harness prompts the OPS `SCN:release-first` / `SCN:release-rest`).
 *  `plan.first`: ids released by `SCN:release-first`. `limited`: Set of roles whose requests on account A are answered with the unified usage-limit 429. */
export function makeModel({ kindOfRole, plan, limited, resetS }) {
  return ({ role, messages, cred }) => {
    if (!role) return null;
    const coord = role === 'lead' || role === 'ops';
    const kind = coord ? 'coord' : kindOfRole[role];
    if (!kind) return null;
    if (limited.has(role) && cred === TOKENS[ACCT_A]) return LIMIT(resetS);   // the limited account answers EVERY request of the limited member with the unified 429
    const ut = userTexts(messages).map((t) => JSON.stringify(t));
    const lastUser = ut[ut.length - 1] ?? '';
    const cmds = allCommands(messages);
    // ── mail: read it when woken, ack every lot (like a real agent) ──
    const wakes = ut.filter((t) => /lot pending/.test(t)).length;
    if (wakes > count(cmds, /orchestra check/)) return bash(([...lastUser.matchAll(/orchestra check --run ([0-9a-f-]{36})/g)].map((x) => x[1]).filter((v, i, a) => a.indexOf(v) === i).map((r) => `orchestra check --run ${r}`).join('; ') || 'orchestra check --run "$ORCHESTRA_RUN_ID"'), 'read my mail');
    {
      const toolResults = JSON.stringify(messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')));
      const pairs = [...new Set([...toolResults.matchAll(/\\"run\\":\\"([0-9a-f-]{36})\\",\\"reader\\":\\"[0-9a-f-]*\\",\\"lot\\":(\d+)/g)].map((x) => `${x[1]} ${x[2]}`))];
      const unacked = pairs.find((pr) => count(cmds, new RegExp(`orchestra ack --run ${pr}\\b`)) === 0);
      if (unacked) return bash(`orchestra ack --run ${unacked}; echo ACK_RC=$?`, 'ack the lot I read');
    }
    // ── Reprise: the OPS dispatches (--all, or the harness's two batches), every member accuses ──
    const consignes = cnt(messages, /consigne de reprise|\\"kind\\":\\"reprise\\"/i, 'user');
    const confirms = count(cmds, /run confirm reprise/);
    if (role === 'ops') {
      if (plan.release === 'all' && consignes > count(cmds, /run release/)) return bash('orchestra run release --all; echo REL_RC=$?', 'ops dispatches its workers (--all = its own run)');
      if (plan.release === 'manual') {
        if (/SCN:release-first/.test(lastUser) && count(cmds, /# first/) < ut.filter((t) => /SCN:release-first/.test(t)).length) return bash(`orchestra run release ${plan.first.join(' ')}; echo REL_RC=$? # first`, 'ops dispatches the first batch');
        if (/SCN:release-rest/.test(lastUser) && count(cmds, /# rest/) < ut.filter((t) => /SCN:release-rest/.test(t)).length) return bash('orchestra run release --all; echo REL_RC=$? # rest', 'ops dispatches the rest (--all = its own run)');
      }
    }
    if (consignes > confirms) return bash('orchestra run confirm reprise; echo CONFIRM_RC=$?', 'reprise accusé');
    if (coord) return { text: 'ok' };
    // the harness's `--inject late-request` prompt: ONE plain reply, never the old work scenario still in the history (it would loop for ever)
    if (/SCN:late/.test(lastUser)) return { text: 'late ok' };
    // ── work (a worker's scenario, one cycle) ──
    let from = -1, n = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue;
      const hit = /SCN:work c(\d+)/.exec(textOf(messages[i].content));
      if (hit) { from = i; n = Number(hit[1]); break; }
    }
    if (from < 0) return { text: 'ok' };
    const mine = commandsAfter(messages, from);
    const order = messages.slice(messages.map((m) => m.role).lastIndexOf('assistant') + 1).some((m) => /PAUSE DOUCE — run /.test(textOf(m.content)));
    if (count(mine, /run confirm reprise/) > 0) return { text: 'resumed' };   // released + accused: the turn is over (nothing re-runs what the pause killed)
    if (mine.length === 0) return bash(setupCmd(role, n), 'setup: commit + tracked edit + staged + untracked');
    if (kind === 'idle' || kind === 'quota') return { text: 'ready' };
    if (kind === 'blocked') return mine.length === 1 ? bash('sleep 7400', 'one long foreground command', { timeout: 600000 }) : { text: 'done' };
    // obey / bg: command-by-command, a tool-result boundary every ~1 s; the Pause douce order is obeyed at the first boundary that carries it
    const saved = count(mine, /douce-save/) > 0;
    if (!saved && order) return bash(`git add -A; git commit -q -m douce-save-${role}-c${n}; git push -q origin HEAD:refs/heads/${branchOf(role)}; echo SAVED_RC=$?; # douce-save`, 'Pause douce: commit + push my work');
    if (saved) return count(mine, /run confirm pause/) === 0 ? bash('orchestra run confirm pause; echo CONFIRM_PAUSE_RC=$?', 'Pause douce accusé') : { text: 'paused' };
    if (kind === 'bg' && count(mine, /sleep 7402/) === 0) return bash('sleep 7402', 'a background task', { run_in_background: true });
    return bash(`echo L${mine.length} >> loop-${role}.txt; sleep 1`, 'work');
  };
}

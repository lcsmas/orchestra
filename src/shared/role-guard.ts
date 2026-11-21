// Role guard (#468, verified-fanout v2 lever 4): a PreToolUse hook that DENIES (exit 2 + stderr) what a fleet role may not do.
// The roles are the `--name` prefixes of fleet-roles.ts (#465); the deny table is generated FROM `roleSpec()` so the script and the
// table cannot drift. INERT without `.orchestra/role` (human sessions, the LEAD, role-less agents). Pure bash + grep/sed, no jq.
// Lives in shared/ so the test runs THIS string through bash (like home-root-guard.ts).
import { FLEET_ROLES, roleSpec, type FleetRole } from './fleet-roles.ts';
import { AWK_WRITES } from './role-guard-writes.ts';

/** Sentinel the hook installer writes in `.orchestra/` (the role word, from `roleOfName(ws.name)`). Absent ⇒ guard inert. */
export const ROLE_SENTINEL_FILE = 'role';

/** Tools the guard intercepts (AskUserQuestion is denied to every role, D6). */
export const ROLE_GUARD_MATCHER = 'Bash|Edit|MultiEdit|Write|NotebookEdit|AskUserQuestion';

/** The INSTALLED command. NO `|| true`: it turns the script's exit 2 into 0 and the deny never lands (#446). */
export const HOOK_ROLE_GUARD_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/role-guard.sh"; [ -f "$f" ] || exit 0; bash "$f"';

/** Tools that mutate a file; their target path is judged against the role's edit scope. */
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

// ERE building blocks. A command boundary precedes a verb so a quoted MENTION mid-sentence (a ticket comment) is not a call.
// A boundary is a command start: `; & | ( {` / `$(` / then|do|else|elif / `-c "` (bash -c "gh pr merge"), then env assignments and wrappers.
const B = '(^|[;&|({]|\\$\\(|(^|[[:space:]])(then|do|else|elif)[[:space:]]|(-c|eval)[[:space:]]+\\\\?["\']|ssh[[:space:]]+[^[:space:]]+[[:space:]]+\\\\?["\'])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*((sudo|command|exec|time|nohup|env)[[:space:]]+(-[a-zA-Z-]+[[:space:]]+)*|timeout[[:space:]]+(-[a-zA-Z-]+[[:space:]]+)*[0-9.]+[smhd]?[[:space:]]+)*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*';
// Absolute-path binaries, `git -c k=v`, `gh -R owner/repo` (pre-review m2).
const GIT = '(/[^[:space:]]*/)?git';
const GH = '(/[^[:space:]]*/)?gh';
const GHR = `${GH}[[:space:]]+((-R|--repo)[[:space:]]+[^[:space:]]+[[:space:]]+)?`;
const G = '((-C|-c)[[:space:]]+[^[:space:]]+[[:space:]]+)*';
const PUSH = `${B}${GIT}[[:space:]]+${G}push([[:space:]]|$)`;
const GH_MERGE = `${B}${GHR}pr[[:space:]]+merge([[:space:]]|$)|${B}${GH}[[:space:]]+api[[:space:]][^;&|]*pulls/[0-9]+/merge`;
const ORCH_DELETE = `${B}orchestra[[:space:]]+(delete|archive)([[:space:]]|$)`;
// #473: `fanout deliver` merges a PR through gh internally (invisible to GH_MERGE); `fanout state init|set` writes the coordinator's state file.
const FANOUT_DELIVER = `${B}orchestra[[:space:]]+fanout[[:space:]]+deliver([[:space:];&|)"'\\]|$)`;
// #479: `fanout open` opens the PR at nomination (the flag form `deliver --open-only` is already FANOUT_DELIVER's).
const FANOUT_OPEN = `${B}orchestra[[:space:]]+fanout[[:space:]]+open([[:space:];&|)"'\\]|$)`;
const FANOUT_STATE_WRITE = `${B}orchestra[[:space:]]+fanout[[:space:]]+state[[:space:]]+(init|set)([[:space:];&|)"'\\]|$)`;
const FANOUT_STATE_INIT = `${B}orchestra[[:space:]]+fanout[[:space:]]+state[[:space:]]+init([[:space:];&|)"'\\]|$)`;
// #476: a scribe's `state set` may not override a merge claim: `--accept-merged`, or `--json` (any payload can carry `mergedAccepted`, even piped in) — `.*`, not `[^;&|]*`, so `--note "a; b"` cannot hide the flag.
const FANOUT_ACCEPT_MERGED = `${B}orchestra[[:space:]]+fanout[[:space:]]+state[[:space:]]+set[[:space:]].*(--accept-merged|--json|mergedAccepted)`;
// #498: a host-wide kill by name/pattern reaches OTHER agents' processes (a verifier's `pkill -f jest` did). Own pid / pgid (`kill 123`, `kill -- -123`) pass.
// Denied: pkill/killall/skill/`fuser -k` behind a LISTED wrapper + its options (the verb is the first non-option word: `timeout 9 pnpm test skill` passes),
// `kill -1` (broadcast), and `kill` fed by a pgrep/pidof/ps-pattern/lsof-port selection (`$(…)`, backticks, `| xargs kill`, a loop or variable hop).
// Heuristic (not a sandbox): unlisted wrappers (doas, flock, ssh…), `./pkill`, `eval` are not seen. Judged on `cmdk` (quoted multi-line bodies dropped, AWK_QBODY).
// A `|` is a boundary only when a space follows (a regex alternation `grep -E "a|pkill"` is a mention, `x | pkill` is a call).
const BSTART = B.slice(0, B.indexOf(')[[:space:]]*([A-Za-z_]') + ')[[:space:]]*'.length).replace('[;&|({]', '[;&({]|\\|[[:space:]]');
const KB = `${BSTART}([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*`;
const KILL_END = `([[:space:];&|)"'\\\\]|$)`;
const KILL_OPT = `(-[ug][[:space:]]+[^[:space:]]+[[:space:]]+|-s[[:space:]]+[A-Za-z0-9]+[[:space:]]+|-[a-zA-Z]+[[:space:]]+[0-9.]+[smhd]?[[:space:]]+|-[^[:space:]]+[[:space:]]+)`;
const KILL_WRAP = `((/[^[:space:]]*/)?(sudo|timeout|nice|setsid|ionice|stdbuf|nohup|env|exec|time|busybox)[[:space:]]+${KILL_OPT}*([0-9.]+[smhd]?[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*|command[[:space:]]+)*`;
const KILL_BIN = `\\\\*["']?(/[^[:space:]]*/)?(pkill|killall5?|skill)`; // `\pkill`, `"pkill"` (the payload carries quotes/backslashes escaped)
const XOPT = `(-[nPIdLsEa][[:space:]]+[^[:space:]]+[[:space:]]+|-[^[:space:]]+[[:space:]]+)`; // xargs options (with a value / bare)
const GAP = `([^;&]|\\\\;)*`; // a literal `\n` in the command is turned into `;` by the hook: `tr '\n' ' ' | xargs kill`
const KILL = `(/[^[:space:]]*/)?kill[[:space:]]+`;
// a selection BY NAME / PATTERN / PORT; `ps -p N` (one pid) is not
const KILL_SEL = `((pgrep|pidof)[[:space:]]|ps[[:space:]]+([^)\`;&]*[[:space:]])?(aux|ax|auxww|-e|-ef|-A|-C)([[:space:]]|$)|ps[[:space:]][^)\`;&]*\\|[[:space:]]*(grep|egrep|awk|rg)|lsof[[:space:]]+([^)\`;&|]*[[:space:]])?(-[a-zA-Z]*i|:[0-9]))`;
/** The host-kill alternatives, exported so the probe can mutate each one. */
export const HOST_KILL_CLAUSES = [
  `${KB}${KILL_WRAP}${KILL_BIN}${KILL_END}`,
  `${BSTART}xargs[[:space:]]+${XOPT}*(pkill|killall5?|skill)${KILL_END}`,
  `${KB}${KILL_WRAP}fuser[[:space:]]+([^;&|]*[[:space:]])?-[a-zA-Z]*k`,
  `${KB}${KILL_WRAP}${KILL}(-[^[:space:]]+[[:space:]]+([A-Z0-9]+[[:space:]]+)?)*-1[[:space:]]*([;&|)"'\\\\]|$)`,
  `${KB}${KILL_WRAP}${KILL}[^;&|]*(\\$\\(|\`)[[:space:]]*(sudo[[:space:]]+)?${KILL_SEL}`,
  `(\\$\\(|\`)[[:space:]]*(sudo[[:space:]]+)?${KILL_SEL}.*${KB}${KILL_WRAP}${KILL}[^;&|]*\\$`,
  `${KB}(sudo[[:space:]]+)?${KILL_SEL}${GAP}\\|[[:space:]]*(sudo[[:space:]]+)?xargs[[:space:]]+(([^;&|]|\\\\;)*[[:space:]])?kill${KILL_END}`,
  `${KB}(sudo[[:space:]]+)?${KILL_SEL}${GAP}\\|[[:space:]]*while[^;]*;.*${KB}${KILL_WRAP}${KILL}[^;&|]*\\$`,
];
const HOST_KILL = HOST_KILL_CLAUSES.join('|');
const HOST_KILL_WHY = "a host-wide kill by name/pattern (pkill / killall / kill $(pgrep …) / ps|grep|xargs kill) can hit OTHER agents' processes — kill only your own: `kill <pid>` of a pid you started (record it with `$!`), or your own process group `kill -- -<pgid>` (start it under `setsid`)";
/** awk: drops ONLY the lines strictly inside an open double-quoted body that a PROSE flag opened (`--body "…`, `-m "…`, `--message`, `--notes`, `--title`, `--description`, `-b`) and that holds no `$(`/backtick (one anywhere ends the dropping); the opening line, and the closing line's TAIL after its quote (a kill can follow it), and every other quoted body — `bash -lc "…"`, `node -e "…"`, any unknown carrier — are KEPT (fail closed on kills). Quotes arrive as `\"` in the payload. */
const AWK_QBODY = String.raw`BEGIN{q=0;pr=0} { line=$0; s=line; n=gsub(/\\"/, "", s); c=(line ~ /[$][(]|\140/); if (q) { if (n % 2 == 1) { if (pr && !c) { i=index(line, "\\\""); print substr(line, i + 2) } else print line; q=0; pr=0 } else if (pr && !c) { } else { print line; if (c) pr=0 } } else { print line; if (n % 2 == 1) { q=1; pr=(!c && line ~ /(--body|--message|--notes|--title|--description|-b|-m)[ \t=]+\\"[^"]*$/) } } }`;
const FORCE_PUSH = `${B}${GIT}[[:space:]]+${G}push[[:space:]][^;&|]*(--force|--delete|[[:space:]]-f([[:space:]]|$)|[[:space:]]\\+[^[:space:]]+)`;
const BRANCH_D = `${B}${GIT}[[:space:]]+${G}branch[[:space:]]+([^;&|]*[[:space:]])?-D([[:space:]]|$)`;
const WT_REMOVE = `${B}${GIT}[[:space:]]+${G}worktree[[:space:]]+remove([[:space:]]|$)`;
const DESTRUCTIVE = [GH_MERGE, ORCH_DELETE, FORCE_PUSH, BRANCH_D, WT_REMOVE].join('|');
const CHECK = [
  `${B}orchestra[[:space:]]+verify-landed`,
  `${B}${GHR}pr[[:space:]]+(checks|view|status)([[:space:]]|$)`,
  `${B}${GHR}run[[:space:]]+(view|watch|list)([[:space:]]|$)`,
  `${B}${GIT}[[:space:]]+${G}(ls-remote|rev-list|cherry)([[:space:]]|$)`,
  `${B}${GIT}[[:space:]]+${G}merge-base[[:space:]]+--is-ancestor`,
  `${B}${GIT}[[:space:]]+${G}branch[[:space:]][^;&|]*--contains`,
].join('|');

/** Translate a fleet-roles `bashDeny` regex SOURCE (JS flavour) to ERE for grep -E: `\s`→[[:space:]], `[^\n]`→`[^;&|]` (the
 *  hook flattens newlines to `;`, so "same command" = no `;`/`&`/`|` between). `\b` is kept (GNU grep). */
export function toEre(src: string): string {
  return src
    .replace(/\[\^\\n\]/g, '[^;&|]')
    // the branch NAME (after a space, `:`, a quote or `refs/heads/`; also right after the verb: `git push master`), never `impl-main-fix`
    .replace(/\[\^;&\|\]\*\\b\(master\|main\)\\b/g, '(([^;&|]*[[:space:]:"\'\\\\]|[^;&|]*refs/heads/)?)(master|main)([[:space:]"\'\\\;&|)]|$)')
    .replace(/^\\b/, B) // a verb at a command boundary, not a quoted mention
    .replace(/\\b/g, '([[:space:]]|$)') // a trailing `\b` (`merge\b`) must not match `merge-base`
    .replace(/git\\s\+/g, `${GIT}[[:space:]]+${G}`)
    .replace(/\\s/g, '[[:space:]]');
}

/** awk program dropping HEREDOC BODIES from a newline-split command: a body line is text, not a command (pre-review m3). The payload
 *  carries quotes as `\"`, hence the optional backslash before the delimiter's quote. */
const AWK_HEREDOC = String.raw`BEGIN{h=""} { if (h != "") { l=$0; sub(/^[ \t]+/, "", l); if (l == h) h=""; next } print; c=$0; gsub(/<<</, "", c); gsub(/\(\([^)]*\)\)/, "", c); if (match(c, /<<-?[ \t]*\\*["']?[A-Za-z_][A-Za-z0-9_]*/)) { t=substr(c, RSTART, RLENGTH); sub(/<<-?[ \t]*\\*["']?/, "", t); h=t } }`;

/** The guard's own wiring (sentinel, script, hook settings) is never written by the role it constrains (pre-review m4). */
const PROTECT_RE = `([0-9]?>>?|${B}(tee|rm|mv|cp|ln|truncate|chmod|dd|install|rsync)[[:space:]]|[[:space:]](tee|rm|mv|cp|ln|truncate|chmod|dd|install|rsync)[[:space:]]|${B}sed[[:space:]]+-[a-zA-Z]*i|[[:space:]]sed[[:space:]]+-[a-zA-Z]*i)[^;&|]*(\\.orchestra/(role|role-guard\\.sh)|\\.claude/settings(\\.local)?\\.json)`;
/** Cheap Bash write heuristics (pre-review m1): the edit tools are only one door; these close the obvious others for the read-only
 *  roles. Redirect/`tee` TARGETS are judged in bash (scratch allowed); `sed -i` and in-place git acts are denied outright. */
const GIT_WRITE = `${B}${GIT}[[:space:]]+${G}(apply|am|cherry-pick|revert|pull|restore|update-ref|checkout[[:space:]][^;&|]*[[:space:]]--([[:space:]]|$)|clean[[:space:]]+[^;&|]*-[a-zA-Z]*f|branch[[:space:]]+([^;&|]*[[:space:]])?(-f|--force)([[:space:]]|$))`;

interface Rule { re: string; why: string }

const NO_MERGE: Rule = { re: GH_MERGE, why: 'merging a PR belongs to the coordinator — report the branch ref instead (ledger comment + one ping)' };
const NO_DELIVER: Rule = { re: FANOUT_DELIVER, why: 'orchestra fanout deliver opens and MERGES a PR — that belongs to the coordinator; report the branch ref instead (ledger comment + one ping)' };
const NO_OPEN: Rule = { re: FANOUT_OPEN, why: 'orchestra fanout open opens the PR at nomination — that belongs to the coordinator; report the branch ref instead (ledger comment + one ping)' };
const NO_STATE_WRITE: Rule = { re: FANOUT_STATE_WRITE, why: "orchestra fanout state init|set writes the coordinator's state file (one writer) — report the fact to the coordinator; state show / resume stay allowed" };
const NO_STATE_INIT: Rule = { re: FANOUT_STATE_INIT, why: "orchestra fanout state init creates the coordinator's state file — report to the coordinator; a scribe may relay state set only" };
const NO_ACCEPT_MERGED: Rule = { re: FANOUT_ACCEPT_MERGED, why: "a scribe's state set carries no --accept-merged / --json / mergedAccepted (they override a merge claim) — pass plain flags (--status --branch --pr --head), or report to the coordinator" };
const NO_PROTECT: Rule = { re: PROTECT_RE, why: "the role guard's own wiring (.orchestra/role, role-guard.sh, .claude/settings*.json) is never written by a fleet role" };
const NO_DELETE: Rule = { re: ORCH_DELETE, why: 'deleting/archiving a workspace belongs to the coordinator that owns it' };

/** Rules this module adds on top of the role table's `bashDeny` (the table is the frozen #465 interface; the ticket's classes are ours). */
function extraRules(role: FleetRole): Rule[] {
  if (role === 'coordinator') return [NO_PROTECT];
  if (role === 'scribe') return [NO_MERGE, NO_DELIVER, NO_OPEN, NO_STATE_INIT, NO_ACCEPT_MERGED, NO_DELETE, NO_PROTECT]; // #476: a scribe relays the coordinator's `state set` lines
  return [NO_MERGE, NO_DELIVER, NO_OPEN, NO_STATE_WRITE, NO_DELETE, NO_PROTECT];
}

const WHY_TABLE = 'a command the fleet-roles table denies this role (push of the target branch / commit-class git act)';

const sq = (s: string): string => s.replace(/'/g, `'\\''`);

/** `files` = redirect / tee / sed -i heuristics; `git` adds the in-place git acts; `none` = an implementer (edits its own worktree). */
function writeGuard(role: FleetRole): 'none' | 'files' | 'git' {
  if (role === 'implementer') return 'none';
  return role === 'coordinator' ? 'files' : 'git'; // the coordinator integrates (merge/cherry-pick are its job): no git heuristics
}

function perRole(role: FleetRole): string {
  const spec = roleSpec(role);
  const denyTools = spec.tools.denyTools.filter((t) => !EDIT_TOOLS.includes(t)).join(' ');
  const rules: Rule[] = [...spec.tools.bashDeny.map((s) => ({ re: toEre(s), why: WHY_TABLE })), ...extraRules(role)];
  const lines = [
    `  ${role})`,
    `    deny_tools=" ${denyTools} "; edit_mode=${spec.tools.edit}; n_table=${spec.tools.bashDeny.length}; write_guard=${writeGuard(role)}`,
    ...rules.map((r) => `    rules_re+=('${sq(r.re)}'); rules_why+=('${sq(r.why)}')`),
    '    ;;',
  ];
  return lines.join('\n');
}

/** The script body for the given roles (default: every role). Exported so a test can drive a MUTATED copy. */
export function buildRoleGuardScript(roles: readonly FleetRole[] = FLEET_ROLES): string {
  return `#!/usr/bin/env bash
# Auto-installed by orchestra (#468). Role guard: DENIES (exit 2 + stderr) what this workspace's fleet role may not do.
# INERT unless .orchestra/role exists beside this script (human sessions, the LEAD, role-less agents). Fail-open on any parse miss.
export LC_ALL=C
case "$0" in */*) here="\${0%/*}" ;; *) here=. ;; esac
[ -f "$here/${ROLE_SENTINEL_FILE}" ] || exit 0
role="$(head -c 32 "$here/${ROLE_SENTINEL_FILE}" 2>/dev/null | tr -d '[:space:]')"
rules_re=(); rules_why=(); deny_tools=""; edit_mode=""; n_table=0; write_guard=none
case "$role" in
${roles.map(perRole).join('\n')}
  *) exit 0 ;;
esac
command -v grep >/dev/null 2>&1 || exit 0
input="$(cat 2>/dev/null || true)"
[ -n "$input" ] || exit 0
tool="$(printf '%s' "$input" | grep -oE '"tool_name": *"[^"]*"' | head -1 | sed -E 's/^"tool_name": *"([^"]*)"$/\\1/')"
[ -n "$tool" ] || exit 0
deny() { echo "[orchestra] BLOCKED (role: $role): $1" >&2; exit 2; }

case "$deny_tools" in
  *" $tool "*)
    if [ "$tool" = AskUserQuestion ]; then deny "AskUserQuestion is not available to a fleet member — never ask the human. Take the reversible default, apply it, and write it in your report (ledger §Decisions)."; fi
    deny "the $tool tool is not available to the $role role."
    ;;
esac

# --- file-editing tools: judged by their target path (never the Write content) --------------------------------------------
case "$tool" in
  ${EDIT_TOOLS.join('|')})
    fp="$(printf '%s' "$input" | grep -oE '"(file_path|notebook_path)": *"([^"\\\\]|\\\\.)*"' | head -1 | sed -E 's/^"[a-z_]+": *"(.*)"$/\\1/')"
    case "$fp" in
      */.orchestra/role|*/.orchestra/role-guard.sh|*/.claude/settings.json|*/.claude/settings.local.json)
        deny "'$fp' is the role guard's own wiring — a fleet role never edits it." ;;
    esac
    scratch=0
    case "$fp" in
      */../*|*/..) scratch=0 ;;
      "$HOME"/.orchestra/agent-tmp/*|"$HOME"/.orchestra-dev/agent-tmp/*|"\${ORCHESTRA_HOME:-/nonexistent}"/agent-tmp/*) scratch=1 ;;
      /tmp/*|/var/tmp/*|"\${TMPDIR:-/nonexistent}"/*) scratch=1 ;;
      "$HOME"/.claude*/projects/*/memory/*) scratch=1 ;;
    esac
    [ "$scratch" = 1 ] && exit 0
    case "$edit_mode" in
      own-worktree)
        case "$fp" in */../*|*/..) deny "'$fp' climbs out of its directory with .. — use the real path." ;; esac
        # An implementer edits its own worktree; another workspace's files are off limits (the orchestrator-guard rule).
        case "$fp" in
          "$HOME"/.orchestra/worktrees/*|"$HOME"/.orchestra/scratch/*|"$HOME"/.orchestra-dev/worktrees/*|"$HOME"/.orchestra-dev/scratch/*)
            own="\${ORCHESTRA_WORKTREE:-/nonexistent}"
            case "$fp" in "$own"|"$own"/*) exit 0 ;; esac
            deny "'$fp' belongs to another workspace — an implementer edits its own worktree only. Send the change to its owner."
            ;;
        esac
        exit 0
        ;;
      none)
        deny "the $role role never edits files (only scratch under ~/.orchestra/agent-tmp/<wsid>/ or /tmp). Delegate the change to an implementer."
        ;;
      scratch)
        deny "the $role role edits only scratch (~/.orchestra/agent-tmp/<wsid>/ or /tmp), never '$fp' — a verifier gates a candidate, it does not change it."
        ;;
    esac
    exit 0
    ;;
esac

# --- Bash: the role's denied commands, then the check-then-destroy chain --------------------------------------------------
[ "$tool" = Bash ] || exit 0
awk_prog="$(cat <<'AWK'
${AWK_HEREDOC}
AWK
)"
awk_qbody="$(cat <<'AWK3'
${AWK_QBODY}
AWK3
)"
cmd="$(printf '%s' "$input" | sed -E 's/"(transcript_path|cwd)": *"[^"]*"//g' | grep -oE '"command": *"([^"\\\\]|\\\\.)*"' | head -1 | sed -E 's/^"command": *"//; s/"$//; s/\\\\[rt]/ /g' | sed 's/\\\\n/\\n/g' | awk "$awk_prog" | tr '\\n' ';')"
cmdk="$(printf '%s' "$input" | sed -E 's/"(transcript_path|cwd)": *"[^"]*"//g' | grep -oE '"command": *"([^"\\\\]|\\\\.)*"' | head -1 | sed -E 's/^"command": *"//; s/"$//; s/\\\\[rt]/ /g' | sed 's/\\\\n/\\n/g' | awk "$awk_prog" | awk "$awk_qbody" | tr '\\n' ';')"
[ -n "$cmd" ] || exit 0
if printf '%s' "$cmdk" | grep -qE -- '${sq(HOST_KILL)}'; then deny "${HOST_KILL_WHY.replace(/["$`\\]/g, '\\$&')}"; fi
cwd="$(printf '%s' "$input" | grep -oE '"cwd": *"[^"]*"' | head -1 | sed -E 's/^"cwd": *"//; s/"$//')"
awk_writes="$(cat <<'AWK2'
${AWK_WRITES}
AWK2
)"
chk() { printf '%s' "$cmd" | grep -qE -- "$1"; }
# A command that works INSIDE a scratch clone (cd/-C into scratch) may rebase/merge/reset/commit there — a verifier gates a combined
# tip in one. Never a push: the clone's origin is the real remote. Only the TABLE's rules (the first n_table) are lifted; this
# module's own rules (gh pr merge, orchestra delete, the chain rule) always apply.
in_scratch=0
if [ "$edit_mode" != own-worktree ] && chk '(cd|-C)[[:space:]]+\\\\?["'"'"']?(/tmp/|/var/tmp/|~/\\.orchestra(-dev)?/agent-tmp/|\\$HOME/\\.orchestra(-dev)?/agent-tmp/|\\$\\{?TMPDIR\\}?|'"$(printf '%s' "$HOME" | sed 's/[][\\.*^$+?(){}|]/\\\\&/g')"'/\\.orchestra(-dev)?/agent-tmp/)' && ! chk '${sq(PUSH)}'; then in_scratch=1; fi
i=0
while [ "$i" -lt "\${#rules_re[@]}" ]; do
  if ! { [ "$in_scratch" = 1 ] && [ "$i" -lt "$n_table" ]; } && chk "\${rules_re[$i]}"; then deny "\${rules_why[$i]}"; fi
  i=$((i + 1))
done
if [ "$write_guard" != none ] && [ "$in_scratch" != 1 ]; then
  # Heuristic, not a sandbox: a redirect / tee target outside scratch, sed -i, in-place git acts. Write into $TMPDIR instead.
  # Write targets (redirect / tee / sed -i): ONE quote-aware scan (role-guard-writes.ts); every target not provably scratch is listed.
  # Size cap BEFORE the scanner (mawk's string handling is quadratic: 3 MB took 109 s, past the hook timeout = fail-open). Real max over 92,913 commands: 12.5 KB; cap 32 KB.
  if [ "\${#cmd}" -gt 32768 ]; then deny "the command is too large (\${#cmd} chars > 32768) for the write scanner — this guard fails closed; put the long text in a scratch file and pass it by reference."; fi
  wout="$(printf '%s' "$cmd" | RG_CWD="$cwd" awk "$awk_writes" 2>&1)"; wrc=$?
  if [ "$wrc" != 0 ]; then deny "the write scanner could not run (awk exit $wrc: $(printf '%s' "$wout" | head -c 120)) — this guard fails closed on its own errors; tell the human/coordinator, do not retry around it."; fi
  if printf '%s\n' "$wout" | grep -q '^SEDI'; then deny "sed -i edits files in place — the $role role writes only scratch (\\$TMPDIR, ~/.orchestra/agent-tmp/<wsid>/). Copy the file there, or delegate the change to an implementer. (This guard is a heuristic: it cannot see every shell write.)"; fi
  if [ "$write_guard" = git ] && chk '${sq(GIT_WRITE)}' && ! chk '${sq(`${GIT}[[:space:]]+${G}apply[[:space:]]+([^;&|]*[[:space:]])?--check`)}'; then deny "a git command that rewrites the working tree (apply/am/cherry-pick/revert/pull/restore/clean -f/checkout -- /branch -f/update-ref) — the $role role does not change the tree; do it in a scratch clone (cd into \$TMPDIR/…). (Heuristic: not every shell write is visible.)"; fi
  t="$(printf '%s\n' "$wout" | sed -n 's/^W\t//p' | head -1)"
  if [ -n "$t" ]; then deny "a shell write to '$t' — the $role role writes only scratch (\\$TMPDIR, ~/.orchestra/agent-tmp/<wsid>/); redirect there, or delegate the change to an implementer. (This guard is a heuristic: it cannot see every shell write.)"; fi
  # A scratch-judged target that resolves THROUGH an existing symlink to outside scratch is not scratch (a link created in this same command is not seen).
  oks="$(printf '%s\n' "$wout" | sed -n 's/^OK\t//p' | sort -u)"
  if [ -n "$oks" ] && [ "$(printf '%s\n' "$oks" | wc -l)" -gt 100 ]; then deny "more than 100 distinct write targets in one command — too many to check against symlinks; split the command (the guard fails closed here)."; fi
  if [ -n "$oks" ] && command -v realpath >/dev/null 2>&1; then
    tmproot=""; case "$TMPDIR" in /?*/?*) tmproot="$TMPDIR" ;; esac
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      rp="$(realpath -m -- "$p" 2>/dev/null)"
      { [ -n "$rp" ] && [ "$rp" != "$p" ]; } || continue
      okp=0
      case "$rp" in "$HOME"/.claude*/projects/*/memory/*) okp=1 ;; esac
      for root in /tmp /var/tmp "$HOME/.orchestra/agent-tmp" "$HOME/.orchestra-dev/agent-tmp" "\${ORCHESTRA_HOME:+$ORCHESTRA_HOME/agent-tmp}" "$tmproot"; do
        [ -n "$root" ] || continue
        for rr in "$root" "$(realpath -m -- "$root" 2>/dev/null)"; do
          [ -n "$rr" ] || continue
          case "$rp" in "$rr"/*) okp=1 ;; esac
        done
      done
      [ "$okp" = 1 ] || deny "a shell write to '$p' resolves through a symlink to '$rp', outside scratch — the $role role writes only scratch (\\$TMPDIR, ~/.orchestra/agent-tmp/<wsid>/). (This guard is a heuristic: it cannot see every shell write.)"
    done <<< "$oks"
  fi
fi
if chk '${sq(CHECK)}' && chk '${sq(DESTRUCTIVE)}'; then
  deny "a check (verify-landed / gh pr checks / CI / rev-list) chained with a destructive act (delete, force-push, merge, branch -D, worktree remove) in ONE command. Run the check as its own call, read the result, THEN act in a second call."
fi
exit 0
`;
}

export const ROLE_GUARD_SCRIPT = buildRoleGuardScript();

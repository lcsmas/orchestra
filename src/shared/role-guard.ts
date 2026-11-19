// Role guard (#468, verified-fanout v2 lever 4): a PreToolUse hook that DENIES (exit 2 + stderr) what a fleet role may not do.
// The roles are the `--name` prefixes of fleet-roles.ts (#465); the deny table is generated FROM `roleSpec()` so the script and the
// table cannot drift. INERT without `.orchestra/role` (human sessions, the LEAD, role-less agents). Pure bash + grep/sed, no jq.
// Lives in shared/ so the test runs THIS string through bash (like home-root-guard.ts).
import { FLEET_ROLES, roleSpec, type FleetRole } from './fleet-roles.ts';

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
const FANOUT_STATE_WRITE = `${B}orchestra[[:space:]]+fanout[[:space:]]+state[[:space:]]+(init|set)([[:space:];&|)"'\\]|$)`;
const FANOUT_STATE_INIT = `${B}orchestra[[:space:]]+fanout[[:space:]]+state[[:space:]]+init([[:space:];&|)"'\\]|$)`;
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
const SED_I = `${B}sed[[:space:]]+([^;&|]*[[:space:]])?(-[a-zA-Z]*i[a-zA-Z]*|--in-place)([[:space:]=]|$)`;
const GIT_WRITE = `${B}${GIT}[[:space:]]+${G}(apply|am|cherry-pick|revert|pull|restore|update-ref|checkout[[:space:]][^;&|]*[[:space:]]--([[:space:]]|$)|clean[[:space:]]+[^;&|]*-[a-zA-Z]*f|branch[[:space:]]+([^;&|]*[[:space:]])?(-f|--force)([[:space:]]|$))`;

interface Rule { re: string; why: string }

const NO_MERGE: Rule = { re: GH_MERGE, why: 'merging a PR belongs to the coordinator — report the branch ref instead (ledger comment + one ping)' };
const NO_DELIVER: Rule = { re: FANOUT_DELIVER, why: 'orchestra fanout deliver opens and MERGES a PR — that belongs to the coordinator; report the branch ref instead (ledger comment + one ping)' };
const NO_STATE_WRITE: Rule = { re: FANOUT_STATE_WRITE, why: "orchestra fanout state init|set writes the coordinator's state file (one writer) — report the fact to the coordinator; state show / resume stay allowed" };
const NO_STATE_INIT: Rule = { re: FANOUT_STATE_INIT, why: "orchestra fanout state init creates the coordinator's state file — report to the coordinator; a scribe may relay state set only" };
const NO_PROTECT: Rule = { re: PROTECT_RE, why: "the role guard's own wiring (.orchestra/role, role-guard.sh, .claude/settings*.json) is never written by a fleet role" };
const NO_DELETE: Rule = { re: ORCH_DELETE, why: 'deleting/archiving a workspace belongs to the coordinator that owns it' };

/** Rules this module adds on top of the role table's `bashDeny` (the table is the frozen #465 interface; the ticket's classes are ours). */
function extraRules(role: FleetRole): Rule[] {
  if (role === 'coordinator') return [NO_PROTECT];
  if (role === 'scribe') return [NO_MERGE, NO_DELIVER, NO_STATE_INIT, NO_DELETE, NO_PROTECT]; // #476: a scribe relays the coordinator's `state set` lines
  return [NO_MERGE, NO_DELIVER, NO_STATE_WRITE, NO_DELETE, NO_PROTECT];
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
cmd="$(printf '%s' "$input" | sed -E 's/"(transcript_path|cwd)": *"[^"]*"//g' | grep -oE '"command": *"([^"\\\\]|\\\\.)*"' | head -1 | sed -E 's/^"command": *"//; s/"$//; s/\\\\[rt]/ /g' | sed 's/\\\\n/\\n/g' | awk "$awk_prog" | tr '\\n' ';')"
[ -n "$cmd" ] || exit 0
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
  if chk '${sq(SED_I)}'; then deny "sed -i edits files in place — the $role role writes only scratch (\$TMPDIR, ~/.orchestra/agent-tmp/<wsid>/). Copy the file there, or delegate the change to an implementer. (This guard is a heuristic: it cannot see every shell write.)"; fi
  if [ "$write_guard" = git ] && chk '${sq(GIT_WRITE)}' && ! chk '${sq(`${GIT}[[:space:]]+${G}apply[[:space:]]+([^;&|]*[[:space:]])?--check`)}'; then deny "a git command that rewrites the working tree (apply/am/cherry-pick/revert/pull/restore/clean -f/checkout -- /branch -f/update-ref) — the $role role does not change the tree; do it in a scratch clone (cd into \$TMPDIR/…). (Heuristic: not every shell write is visible.)"; fi
  # Blank what is not a redirect: arrows (->, =>), [[ a > b ]], quoted strings (gh --body "a -> b", awk '$1>5'); a quoted TARGET is unquoted first.
  wcmd="$(printf '%s' "$cmd" | sed -E 's/[[:space:]][-=]>/ /g; s/\\$?\\(\\([^)]*\\)\\)/ /g; s/>\\|?[[:space:]]*\\\\"([^"\\\\]+)\\\\"/> \\1/g; s/>\\|?[[:space:]]*\\x27([^\\x27]+)\\x27/> \\1/g; s/(tee[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*)\\\\"([^"\\\\]+)\\\\"/\\1\\3/g; s/(tee[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*)\\x27([^\\x27]+)\\x27/\\1\\3/g; s/((^|[[:space:];&|(/])(bash|sh|zsh|dash|ksh)([[:space:]]+-[-a-zA-Z]+)*[[:space:]]+-[a-zA-Z]*c|(^|[;&|(])[[:space:]]*((sudo|command|exec|time|nohup|env)[[:space:]]+)*(eval|ssh[[:space:]]+[^;&|"\\x27\\\\]*))[[:space:]]+\\\\"([^"]*)\\\\"/\\1 \\9/g; s/((^|[[:space:];&|(/])(bash|sh|zsh|dash|ksh)([[:space:]]+-[-a-zA-Z]+)*[[:space:]]+-[a-zA-Z]*c|(^|[;&|(])[[:space:]]*((sudo|command|exec|time|nohup|env)[[:space:]]+)*(eval|ssh[[:space:]]+[^;&|"\\x27\\\\]*))[[:space:]]+\\x27([^\\x27]*)\\x27/\\1 \\9/g; s/\\[\\[[^]]*\\]\\]/ /g; s/\\\\"/\\x01/g; s/\\x01[^\\x01]*\\x01/""/g; s/\\x27[^\\x27]*\\x27/\\x27\\x27/g')"
  targets="$(printf '%s' "$wcmd" | grep -oE '[0-9]?>(>|\\|)?[[:space:]]*[^[:space:]&;|><()]+|(^|[;&|])[[:space:]]*(sudo[[:space:]]+)?tee[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*[^[:space:]&;|><()]+' | sed -E 's/^[;&|]?[[:space:]]*(sudo[[:space:]]+)?tee[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*//; s/^[0-9]?>(>|\\|)?[[:space:]]*//; s/^\\\\?["'"'"']//; s/\\\\?["'"'"']$//')"
  for t in $targets; do
    case "$t" in
      /dev/null|/dev/stderr|/dev/stdout|/dev/fd/*|/tmp/*|/var/tmp/*|\\$TMPDIR/*|\\$\\{TMPDIR\\}/*|"~"/.orchestra/agent-tmp/*|"~"/.orchestra-dev/agent-tmp/*|"$HOME"/.claude*/projects/*/memory/*|\\$HOME/.claude*/projects/*/memory/*|"~"/.claude*/projects/*/memory/*|\\$HOME/.orchestra/agent-tmp/*|"$HOME"/.orchestra/agent-tmp/*|"$HOME"/.orchestra-dev/agent-tmp/*|"\${TMPDIR:-/nonexistent}"/*|"\${ORCHESTRA_HOME:-/nonexistent}"/agent-tmp/*) ;;
      *) deny "a shell write to '$t' — the $role role writes only scratch (\$TMPDIR, ~/.orchestra/agent-tmp/<wsid>/); redirect there, or delegate the change to an implementer. (This guard is a heuristic: it cannot see every shell write.)" ;;
    esac
  done
fi
if chk '${sq(CHECK)}' && chk '${sq(DESTRUCTIVE)}'; then
  deny "a check (verify-landed / gh pr checks / CI / rev-list) chained with a destructive act (delete, force-push, merge, branch -D, worktree remove) in ONE command. Run the check as its own call, read the result, THEN act in a second call."
fi
exit 0
`;
}

export const ROLE_GUARD_SCRIPT = buildRoleGuardScript();

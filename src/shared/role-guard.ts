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
// A boundary is a command start: `; & | ( { \`` / `$(` / then|do|else|elif / `-c "` (bash -c "gh pr merge"), then env assignments and wrappers.
const B = '(^|[;&|({`]|\\$\\(|(^|[[:space:]])(then|do|else|elif)[[:space:]]|-c[[:space:]]+\\\\?["\'])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*((sudo|command|exec|time|nohup|env)[[:space:]]+)*';
const G = '(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?';
const PUSH = `${B}git[[:space:]]+${G}push([[:space:]]|$)`;
const GH_MERGE = `${B}gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)`;
const ORCH_DELETE = `${B}orchestra[[:space:]]+(delete|archive)([[:space:]]|$)`;
const FORCE_PUSH = `${B}git[[:space:]]+${G}push[[:space:]][^;&|]*(--force|--delete|[[:space:]]-f([[:space:]]|$)|[[:space:]]\\+[^[:space:]]+)`;
const BRANCH_D = `${B}git[[:space:]]+${G}branch[[:space:]]+([^;&|]*[[:space:]])?-D([[:space:]]|$)`;
const WT_REMOVE = `${B}git[[:space:]]+${G}worktree[[:space:]]+remove([[:space:]]|$)`;
const DESTRUCTIVE = [GH_MERGE, ORCH_DELETE, FORCE_PUSH, BRANCH_D, WT_REMOVE].join('|');
const CHECK = [
  `${B}orchestra[[:space:]]+verify-landed`,
  `${B}gh[[:space:]]+pr[[:space:]]+(checks|view|status)([[:space:]]|$)`,
  `${B}gh[[:space:]]+run[[:space:]]+(view|watch|list)([[:space:]]|$)`,
  `${B}git[[:space:]]+${G}(ls-remote|rev-list|cherry)([[:space:]]|$)`,
  `${B}git[[:space:]]+${G}merge-base[[:space:]]+--is-ancestor`,
  `${B}git[[:space:]]+${G}branch[[:space:]][^;&|]*--contains`,
].join('|');

/** Translate a fleet-roles `bashDeny` regex SOURCE (JS flavour) to ERE for grep -E: `\s`→[[:space:]], `[^\n]`→`[^;&|]` (the
 *  hook flattens newlines to `;`, so "same command" = no `;`/`&`/`|` between). `\b` is kept (GNU grep). */
export function toEre(src: string): string {
  return src
    .replace(/\[\^\\n\]/g, '[^;&|]')
    .replace(/\\b\(master\|main\)\\b/g, '([[:space:]:]|refs/heads/)(master|main)([[:space:]"\']|$)') // the branch NAME, not `impl-main-fix`
    .replace(/^\\b/, B) // a verb at a command boundary, not a quoted mention
    .replace(/\\b/g, '([[:space:]]|$)') // a trailing `\b` (`merge\b`) must not match `merge-base`
    .replace(/git\\s\+/g, `git[[:space:]]+${G}`)
    .replace(/\\s/g, '[[:space:]]');
}

interface Rule { re: string; why: string }

const NO_MERGE: Rule = { re: GH_MERGE, why: 'merging a PR belongs to the coordinator — report the branch ref instead (ledger comment + one ping)' };
const NO_DELETE: Rule = { re: ORCH_DELETE, why: 'deleting/archiving a workspace belongs to the coordinator that owns it' };

/** Rules this module adds on top of the role table's `bashDeny` (the table is the frozen #465 interface; the ticket's classes are ours). */
function extraRules(role: FleetRole): Rule[] {
  if (role === 'coordinator') return [];
  return [NO_MERGE, NO_DELETE];
}

const WHY_TABLE = 'a command the fleet-roles table denies this role (push of the target branch / commit-class git act)';

const sq = (s: string): string => s.replace(/'/g, `'\\''`);

function perRole(role: FleetRole): string {
  const spec = roleSpec(role);
  const denyTools = spec.tools.denyTools.filter((t) => !EDIT_TOOLS.includes(t)).join(' ');
  const rules: Rule[] = [...spec.tools.bashDeny.map((s) => ({ re: toEre(s), why: WHY_TABLE })), ...extraRules(role)];
  const lines = [
    `  ${role})`,
    `    deny_tools=" ${denyTools} "; edit_mode=${spec.tools.edit}; n_table=${spec.tools.bashDeny.length}`,
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
rules_re=(); rules_why=(); deny_tools=""; edit_mode=""; n_table=0
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
    scratch=0
    case "$fp" in
      *..*) scratch=0 ;;
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
cmd="$(printf '%s' "$input" | sed -E 's/"(transcript_path|cwd)": *"[^"]*"//g' | grep -oE '"command": *"([^"\\\\]|\\\\.)*"' | head -1 | sed -E 's/^"command": *"//; s/"$//; s/\\\\[nrt]/ ; /g')"
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
if chk '${sq(CHECK)}' && chk '${sq(DESTRUCTIVE)}'; then
  deny "a check (verify-landed / gh pr checks / CI / rev-list) chained with a destructive act (delete, force-push, merge, branch -D, worktree remove) in ONE command. Run the check as its own call, read the result, THEN act in a second call."
fi
exit 0
`;
}

export const ROLE_GUARD_SCRIPT = buildRoleGuardScript();

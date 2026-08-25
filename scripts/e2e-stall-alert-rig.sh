#!/usr/bin/env bash
# E2E rig for #88 -- the queue-stall badge.
#
# Usage (from the repo root):
#   scripts/e2e-stall-alert-rig.sh selftest   # pre-flight arms only, no app boot
#   scripts/e2e-stall-alert-rig.sh truepos    # TRUE POSITIVE: waits the 15min
#                                             # threshold out in REAL time, then
#                                             # drives queuedPrompts + a real turn
#   scripts/e2e-stall-alert-rig.sh r1         # cold boot with pre-quit stamps:
#                                             # must NOT badge (review-88 R1)
#   scripts/e2e-stall-alert-rig.sh narrow     # control at default width, then 240px
#
# READ docs/research/issue-88-stall-rig-findings.md FIRST. Three of the traps
# it records produced a green run that measured NOTHING:
#   * a stall cannot be SEEDED any more (the age is floored at app start), so
#     `truepos` really does have to wait ~16 minutes;
#   * seeding parkedInboxCount is useless -- reconcileParkedCounts re-derives it
#     from disk, so the rig writes real inbox FILES;
#   * `Page.reload` resets OBSERVABLE_SINCE and silently destroys the badge you
#     were about to measure, which is why `narrow` takes a control reading first.
#
# Containment follows ~/.claude/skills/headless-sway-e2e: own SWAYSOCK, a
# per-rig pid-derived marker colour (#FF00FF is a SHARED namespace), `env -i`
# allowlist, and abort-on-two-sockets-match. #88-SPECIFIC: INBOX_ROOT keys off
# os.homedir(), NOT ORCHESTRA_HOME, so this overrides HOME -- without that it
# reads and WRITES the real user's ~/.orchestra/inbox. Self-test arm4 proves
# that clause can fire.
# E2E rig for issue #88 (queue-stall badge). Follows ~/.claude/skills/headless-sway-e2e
# VERBATIM: own SWAYSOCK, pid-derived unique marker colour, env -i allowlist
# containment, abort-on-two-sockets-match.
#
# #88-SPECIFIC HAZARD: INBOX_ROOT keys off os.homedir(), NOT ORCHESTRA_HOME.
# So this rig overrides HOME. Without that it would read (and WRITE) the real
# user's ~/.orchestra/inbox.
set -uo pipefail
MODE="${1:-selftest}"

RIG_ID="stall88-$$"
RIG_DIR="/tmp/${RIG_ID}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
FAKE_HOME="${RIG_DIR}/home"
ORCH_HOME="${RIG_DIR}/orch"
PORT="${RIG_PORT:-9388}"
CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
WS_ID="${WS_ID:-rig}"
# The human's real home — arm4 of the self-test forces it to prove the
# REFUSED[real-home] clause can fire. INBOX_ROOT keys off os.homedir(), NOT
# ORCHESTRA_HOME, so a rig that does not override HOME reads and WRITES the
# real user's ~/.orchestra/inbox.
REAL_HOME="${REAL_HOME:-$HOME}"
# Where drive.mjs / hook.mjs live (checked in beside this script).
RIG_SRC="${RIG_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/stall-alert-rig" && pwd)}"

mkdir -p "$RIG_DIR" "$FAKE_HOME" "$ORCH_HOME"

die() { echo "ABORT[$1]: $2" >&2; exit 1; }

# ── 1. compositor ──────────────────────────────────────────────────────────
CFG_FILE="${RIG_DIR}/sway.cfg"
echo 'output HEADLESS-1 resolution 1600x1000' > "$CFG_FILE"
MY_SWAYSOCK="${RIG_DIR}/sway.sock"
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= \
  SWAYSOCK="$MY_SWAYSOCK" sway -c "$CFG_FILE" >"${RIG_DIR}/sway.log" 2>&1 &
SWAY_PID=$!
echo "SWAY_PID=$SWAY_PID"
for i in $(seq 1 40); do [ -S "$MY_SWAYSOCK" ] && break; sleep 0.25; done
[ -S "$MY_SWAYSOCK" ] || die sway "socket never appeared"

# ── 2. UNIQUE marker colour derived from pid (shared-namespace trap) ────────
MARK_G=$(printf '%02X' $(( ($$ / 251) % 256 )))
MARK_B=$(printf '%02X' $(( $$ % 251 + 5 )))
MARK="FF${MARK_G}${MARK_B}"
MG=$((16#$MARK_G)); MB=$((16#$MARK_B))
echo "MARKER=#${MARK} rgb(255,$MG,$MB)"
SWAYSOCK="$MY_SWAYSOCK" swaymsg -- "output HEADLESS-1 background #${MARK} solid_color" >/dev/null
sleep 1

MATCHES=""
for n in 1 2 3 4 5 6 7 8; do
  sock="/run/user/1000/wayland-$n"
  [ -S "$sock" ] || continue
  WAYLAND_DISPLAY="wayland-$n" grim -o HEADLESS-1 "${RIG_DIR}/m-$n.png" 2>/dev/null || continue
  pct=$(python3 -c "
import sys
try:
    from PIL import Image
    im=Image.open('${RIG_DIR}/m-$n.png').convert('RGB')
    px=list(im.getdata()); n=len(px)
    hit=sum(1 for p in px if p==(255,$MG,$MB))
    print(round(100*hit/n,1))
except Exception as e:
    print(-1)
")
  echo "  wayland-$n -> ${pct}% marker"
  [ "$pct" = "100.0" ] && MATCHES="$MATCHES wayland-$n"
done
N_MATCH=$(echo $MATCHES | wc -w)
[ "$N_MATCH" -eq 1 ] || die marker "expected exactly ONE socket at 100% marker, got $N_MATCH ($MATCHES) — refusing to guess"
MY_SWAY_DISPLAY=$(echo $MATCHES | awk '{print $1}')
echo "MY_SWAY_DISPLAY=$MY_SWAY_DISPLAY"
SWAYSOCK="$MY_SWAYSOCK" swaymsg -- "output HEADLESS-1 background #000000 solid_color" >/dev/null

# ── 3. PRE-FLIGHT on the CHILD ENV ARRAY (not on my own env) ───────────────
# Build the allowlist FIRST, then assert the value read back OUT of it.
build_child_env() {
  CHILD_ENV=(
    "HOME=${FAKE_HOME}"                       # #88 hazard: inbox keys off homedir
    "PATH=/usr/bin:/bin:/usr/local/bin"
    "XDG_RUNTIME_DIR=/run/user/1000"
    "WAYLAND_DISPLAY=${1}"
    "ELECTRON_OZONE_PLATFORM_HINT=wayland"
    "ORCHESTRA_OZONE=wayland"
    "ORCHESTRA_OZONE_RELAUNCHED=1"
    "ORCHESTRA_HOME=${ORCH_HOME}"
    "ORCHESTRA_DEBUG_PORT=${PORT}"
  )
}

preflight() {
  local forced="${1:-$MY_SWAY_DISPLAY}"
  build_child_env "$forced"
  # read the value BACK OUT of the array — never from my own env
  local child_wd="" child_display="unset" child_home=""
  for kv in "${CHILD_ENV[@]}"; do
    case "$kv" in
      WAYLAND_DISPLAY=*) child_wd="${kv#WAYLAND_DISPLAY=}" ;;
      DISPLAY=*)         child_display="${kv#DISPLAY=}" ;;
      HOME=*)            child_home="${kv#HOME=}" ;;
    esac
  done
  # (a) refuse the human's socket FIRST — after the equality check it could never fire
  [ "$child_wd" != "wayland-1" ] || { echo "REFUSED[human-display]: child WAYLAND_DISPLAY=wayland-1 is the human's screen"; return 1; }
  # (b) must equal the display MY sway produced and painted
  [ "$child_wd" = "$MY_SWAY_DISPLAY" ] || { echo "REFUSED[wrong-display]: child WAYLAND_DISPLAY=$child_wd != my marker-verified $MY_SWAY_DISPLAY"; return 1; }
  # (c) X11 must not leak
  [ "$child_display" = "unset" ] || { echo "REFUSED[x11-leak]: child DISPLAY=$child_display"; return 1; }
  # (d) #88: HOME must be the fake one, or the rig reads the real user's inbox
  [ "$child_home" = "$FAKE_HOME" ] || { echo "REFUSED[real-home]: child HOME=$child_home != $FAKE_HOME"; return 1; }
  echo "PREFLIGHT OK: wd=$child_wd home=$child_home display=unset"
  return 0
}

# ── 3b. SELF-TEST of the pre-flight (the mandatory negative arm) ───────────
# Each arm must REFUSE **and name the clause that fired** — an arm that aborts
# for an incidental reason protects nothing. Plus a positive-control arm that
# must PASS, or a guard that refuses unconditionally scores a perfect record.
selftest() {
  local fails=0
  echo "=== PRE-FLIGHT SELF-TEST ==="

  # arm 1: forced to the human's screen
  out=$(preflight "wayland-1" 2>&1); rc=$?
  echo "  arm1 forced=wayland-1 rc=$rc :: $out"
  [ $rc -ne 0 ] && [[ "$out" == *"REFUSED[human-display]"* ]] || { echo "  arm1 FAILED to refuse with the right clause"; fails=$((fails+1)); }

  # arm 2: a sibling / bogus socket
  out=$(preflight "wayland-7" 2>&1); rc=$?
  echo "  arm2 forced=wayland-7 rc=$rc :: $out"
  [ $rc -ne 0 ] && [[ "$out" == *"REFUSED[wrong-display]"* ]] || { echo "  arm2 FAILED to refuse with the right clause"; fails=$((fails+1)); }

  # arm 3: X11 leak injected into the child array
  build_child_env "$MY_SWAY_DISPLAY"; CHILD_ENV+=("DISPLAY=:0")
  child_display=""; for kv in "${CHILD_ENV[@]}"; do case "$kv" in DISPLAY=*) child_display="${kv#DISPLAY=}";; esac; done
  if [ "$child_display" = ":0" ]; then echo "  arm3 injected DISPLAY=:0 -> REFUSED[x11-leak] (clause reachable)"; else echo "  arm3 FAILED"; fails=$((fails+1)); fi

  # arm 4: #88's own hazard — the REAL home
  build_child_env "$MY_SWAY_DISPLAY"
  CHILD_ENV=("${CHILD_ENV[@]/HOME=${FAKE_HOME}/HOME=${REAL_HOME}}")
  child_home=""; for kv in "${CHILD_ENV[@]}"; do case "$kv" in HOME=*) child_home="${kv#HOME=}";; esac; done
  if [ "$child_home" = "$REAL_HOME" ]; then echo "  arm4 forced HOME=$REAL_HOME -> REFUSED[real-home] (clause reachable; this is the inbox hazard)"; else echo "  arm4 FAILED"; fails=$((fails+1)); fi

  # arm 5: POSITIVE CONTROL — must PASS
  out=$(preflight 2>&1); rc=$?
  echo "  arm5 POSITIVE CONTROL rc=$rc :: $out"
  [ $rc -eq 0 ] || { echo "  arm5 the guard refuses even the correct env — it protects nothing"; fails=$((fails+1)); }

  echo "=== SELF-TEST fails=$fails ==="
  return $fails
}

# ── 4. seed the store, with the account PINNED ────────────────────────────
seed() {
  # STALL_MIN = how many minutes ago the stalled workspace last started a turn.
  # Passed in so the two arms (under / over threshold) differ by ONE variable.
  local stall_min="${1:-40}"
  local parked="${2:-2}"
  mkdir -p "${ORCH_HOME}/userData/orchestra"
  # Seed REAL inbox FILES, not just the count. `reconcileParkedCounts()` at
  # boot re-derives every count from disk (that is the whole point of it — a
  # shell hook drains these files while the app is closed), so a seeded COUNT
  # with no file is correctly zeroed and the arm would pass for the wrong
  # reason. This drives the real producer instead: inbox file -> main's count
  # -> broadcast -> badge. Written under the FAKE home, per the #88 hazard.
  local inbox="${FAKE_HOME}/.orchestra/inbox"
  mkdir -p "$inbox"
  local D; D=$(printf '=%.0s' $(seq 1 40))
  for wsid in aaaa-stalled bbbb-running cccc-maxturns; do
    : > "${inbox}/${wsid}.txt"
    for k in $(seq 1 "$parked"); do
      printf '\n%s\n[message from agent '"'"'peer-%s'"'"' (peer-%s)]\nping %s\n%s\n' "$D" "$k" "$k" "$k" "$D" >> "${inbox}/${wsid}.txt"
    done
  done
  # delta deliberately gets NO inbox file: it is the "nothing parked" control.
  rm -f "${inbox}/dddd-empty.txt"
  echo "SEEDED INBOX FILES: $(ls -1 "$inbox" | tr '\n' ' ')"
  STALL_MIN="$stall_min" PARKED="$parked" ORCH_HOME="$ORCH_HOME" CFG_DIR="$CFG_DIR" \
  node -e '
    const fs=require("fs"), path=require("path");
    const dir=path.join(process.env.ORCH_HOME,"userData","orchestra");
    fs.mkdirSync(dir,{recursive:true});
    const now=Date.now();
    const mins=Number(process.env.STALL_MIN);
    const parked=Number(process.env.PARKED);
    const account={id:"rig-stall88",label:"rig",configDir:process.env.CFG_DIR};
    // No repoPath (see LAUNCH-TRAPS): pruneOrphanedWorkspaces buckets by it.
    const base=(id,name,over)=>({
      id,name,branch:name,baseBranch:"master",worktreePath:"/tmp/"+id,
      createdAt: now-1000*60*60*24, status:"idle", agent:"claude",
      accountId: account.id, kind:"scratch",
      ...over,
    });
    const workspaces=[
      // A: THE SUBJECT — parked work, no turn start for `mins` minutes.
      base("aaaa-stalled","alpha-stalled",{
        lastTurnStartAt: now-1000*60*mins,
        parkedInboxCount: parked,
      }),
      // B: NEGATIVE ARM — same parked work, but it IS consuming turns.
      base("bbbb-running","bravo-consuming",{
        status:"running",
        lastTurnStartAt: now-1000*60*mins,
        parkedInboxCount: parked,
      }),
      // C: SUPPRESSION ARM — same stall, but #69 already explains the cause.
      base("cccc-maxturns","charlie-maxturns",{
        lastTurnStartAt: now-1000*60*mins,
        parkedInboxCount: parked,
        lastStopReason:"max_turns", lastStopReasonAt: now-1000*60*mins,
      }),
      // D: CONTROL — idle just as long, but NOTHING parked. Must not badge.
      base("dddd-empty","delta-nothing-parked",{
        lastTurnStartAt: now-1000*60*mins,
      }),
    ];
    fs.writeFileSync(path.join(dir,"store.json"),
      JSON.stringify({repos:[],workspaces,accounts:[account],selfTuneRuns:[]},null,2));
    console.log("SEED stall_min="+mins+" parked="+parked+" configDir="+account.configDir);
  '
}

# ── 5. launch, contained ─────────────────────────────────────────────────
launch() {
  preflight || die preflight "refused to launch"
  ( cd "$REPO" && env -i "${CHILD_ENV[@]}" \
      ./node_modules/electron/dist/electron . --ozone-platform=wayland \
      >"${RIG_DIR}/app.log" 2>&1 & echo $! > "${RIG_DIR}/app.pid" )
  APP_PID=$(cat "${RIG_DIR}/app.pid")
  echo "APP_PID=$APP_PID"
  for i in $(seq 1 60); do
    curl -s --max-time 1 "http://127.0.0.1:${PORT}/json" >/dev/null 2>&1 && break
    sleep 0.5
  done
}

# ── main ──────────────────────────────────────────────────────────────────
teardown() {
  local pid; pid=$(cat "${RIG_DIR}/app.pid" 2>/dev/null || echo "")
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  kill "$SWAY_PID" 2>/dev/null
  echo "TEARDOWN issued app=$pid sway=$SWAY_PID (re-verify in the NEXT call)"
}

drive() {
  local label="$1" shot="$2"
  PORT="$PORT" LABEL="$label" SHOT="$shot" NARROW="${NARROW:-0}" REPO="$REPO" node "${RIG_SRC}/drive.mjs"
}

# Fire a REAL lifecycle event through the app's own socket route.
hook() { node ${RIG_SRC}/hook.mjs "$ORCH_HOME" "$1" "$2"; }

case "$MODE" in
  selftest) selftest; exit $? ;;
  full)
    selftest || die selftest "the rig guard is not trustworthy"
    # ARM 1 — the UNFIXED-BUILD equivalent and the sub-threshold arm in one:
    # 5 minutes since the last turn start, i.e. UNDER the 15min threshold.
    # Nothing must badge. This is the arm that proves the badge is not simply
    # always-on, which one screenshot of a badge cannot distinguish.
    seed 5 2
    launch
    sleep 6
    drive "ARM1 under-threshold (5min elapsed, 2 parked) -> expect NO badge" "${RIG_DIR}/arm1-under.png"
    teardown; sleep 2
    ;;
  over)
    # ARM 2 — 40 minutes since the last turn start, OVER the threshold.
    seed 40 2
    launch
    sleep 6
    # The negative arm must be a workspace that is REALLY running. The boot
    # reconcile floors nonterminal statuses to idle (types.ts documents this),
    # so seeding status:'running' is impossible — drive it instead, through the
    # real producer. This also exercises the exact seam the source check cannot.
    hook bbbb-running submit
    sleep 3
    drive "ARM2 over-threshold (40min elapsed, 2 parked) -> BADGE on alpha+charlie?, NOT bravo (driven running), NOT delta" "${RIG_DIR}/arm2-over.png"
    echo "--- now START A TURN on alpha: the badge must CLEAR ---"
    hook aaaa-stalled submit
    sleep 3
    drive "ARM3 after a REAL turn start on alpha -> expect alpha badge CLEARED" "${RIG_DIR}/arm3-cleared.png"
    teardown; sleep 2
    ;;
  narrow)
    # #35-lineage arm: the badge at the NARROWEST sidebar (240px, App.tsx:55).
    # A `flex-shrink: 0` pill inside `ws-pills` is the exact shape that
    # overflowed in #35, and the previous drive measured ONE viewport.
    # Waits out the threshold so there is a real badge to measure.
    seed 1 2
    launch
    START=$(date +%s)
    sleep 6
    echo "--- waiting out the threshold so a REAL badge exists to measure ---"
    sleep 960
    # Measure at the DEFAULT width first: that reading is the control proving a
    # badge actually exists to be measured. Then narrow WITHOUT reloading.
    drive "NARROW-control t=$(( $(date +%s) - START ))s, default width -> expect BADGE (else the narrow arm measures nothing)" "${RIG_DIR}/narrow-control.png"
    NARROW=1 drive "NARROW t=$(( $(date +%s) - START ))s, sidebar forced to 240px -> badge must not overflow" "${RIG_DIR}/narrow.png"
    teardown; sleep 2
    ;;
  truepos)
    # TRUE-POSITIVE arm, post-R1. The R1 fix floors the age at app start, so a
    # stall can no longer be SEEDED -- the app must actually OBSERVE the
    # silence. That is the honest shape, and it is why the old ARM2 stopped
    # badging: it was itself a restart scenario.
    #
    # So: shrink the threshold via a build-time override is NOT available, and
    # waiting 15 real minutes per arm is the cost of honesty here. We wait it
    # out ONCE, with the elapsed time printed beside every reading, and take a
    # reading before and after the crossing so the transition is observed
    # rather than assumed.
    seed 1 2
    launch
    START=$(date +%s)
    sleep 6
    drive "TP t=$(( $(date +%s) - START ))s after app start (2 parked) -> expect NO badge yet" "${RIG_DIR}/tp-before.png"
    echo "--- waiting out the 15min threshold; app stays up, nothing consumes ---"
    sleep 960
    drive "TP t=$(( $(date +%s) - START ))s after app start (2 parked, NOTHING consumed) -> expect BADGE" "${RIG_DIR}/tp-after.png"
    # Close the queuedPrompts gap on the SAME live app: drive the real IPC and
    # watch the badge's count MOVE (inbox 2 -> 2+1).
    QUEUE=aaaa-stalled QUEUE_BRANCH=alpha-stalled drive "TP queuedPrompts over the real wire -> badge count must rise" ""
    echo "--- now start a REAL turn on alpha: must CLEAR ---"
    hook aaaa-stalled submit
    sleep 4
    drive "TP after a REAL turn start on alpha -> expect alpha CLEARED, others still badged" "${RIG_DIR}/tp-cleared.png"
    teardown; sleep 2
    ;;
  r1)
    # REVIEW-88 R1 ARM. Every workspace's lastTurnStartAt is 14 HOURS old --
    # i.e. it last took a turn before a quit -- and mail is parked. On the
    # UNFIXED build all three of alpha/bravo/charlie badge "stalled 840min" on
    # a cold boot despite being perfectly healthy. On the fixed build the age
    # is floored at app start, so NOTHING badges: the app has been up seconds.
    seed 840 2
    launch
    sleep 6
    drive "R1 ARM: cold boot, stamps 840min old (pre-quit), 2 parked -> expect NO badge (age floored at app start)" "${RIG_DIR}/r1-restart.png"
    teardown; sleep 2
    ;;
  *) echo "unknown mode $MODE"; exit 9 ;;
esac

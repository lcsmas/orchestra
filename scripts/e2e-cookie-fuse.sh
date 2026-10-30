#!/usr/bin/env bash
# #407 — Electron's EnableCookieEncryption fuse on the PACKAGED app: what it does to an upgraded install and to a locked / absent keyring.
# Builds TWO scratch copies of <unpacked-dir> (release/linux-arm64-unpacked of `pnpm run build`, which the caller builds under the pkg lock),
# flips the fuse in the ON copy ONLY (@electron/fuses), proves the copies differ in exactly that byte, then runs scripts/e2e-cookie-fuse.mjs through
# the contained rig (own headless sway, private runtime) in the HIDDEN WORLD (RIG_HIDE_REAL_RUNTIME=1: the human's keyring and bus are unreachable)
# behind the fleet GUI semaphore. The source tree and the source unpacked dir are never written.
#
# Usage: scripts/e2e-cookie-fuse.sh <unpacked-dir> [--runs 3] [--arms w,a,d,c,c2,gnome] [--jsonl <file>] [--label <name>]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SRC="${1:-}"
[[ -n "${SRC}" && "${SRC}" != --* ]] || { echo "usage: $0 <unpacked-dir> [--runs N] [--arms a,b] [--jsonl file] [--label name]" >&2; exit 2; }
shift
SRC="$(cd "${SRC}" 2>/dev/null && pwd)" || { echo "ABORT: unpacked dir does not exist" >&2; exit 2; }
[[ -x "${SRC}/orchestra" && -f "${SRC}/resources/app.asar" ]] || { echo "ABORT: ${SRC} is not a packaged app (orchestra + resources/app.asar) — pnpm run build (under the pkg lock) first" >&2; exit 2; }
for t in dbus-run-session gnome-keyring-daemon gdbus sway grim swaymsg bwrap python3 cmp ss; do
  command -v "${t}" >/dev/null || { echo "ABORT: ${t} not installed (this rig installs nothing)" >&2; exit 2; }
done
awk '/MemAvailable/{exit !($2 >= 8*1048576)}' /proc/meminfo || { echo "ABORT: MemAvailable < 8 GB — the wave rule for starting a rig" >&2; exit 2; }

export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/c407-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is not a directory owned by me (or is a symlink)" >&2; exit 2; }
FSTYPE="$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")"
[[ "${FSTYPE}" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs" >&2; exit 2; }

APPS="$(mktemp -d "${E2E_RIG_BASE}/apps-XXXXXX")"
echo "[wrapper] copying ${SRC} → ${APPS}/{off,on} (reflink)"
cp -a --reflink=auto "${SRC}" "${APPS}/off"
cp -a --reflink=auto "${SRC}" "${APPS}/on"
cmp -s "${SRC}/orchestra" "${APPS}/off/orchestra" || { echo "ABORT: the OFF copy differs from the source binary" >&2; exit 2; }
OFF_JSON="$(node "${HERE}/lib/flip-cookie-fuse.cjs" "${APPS}/off/orchestra" --off)"
# COOKIE_FUSE_MUTANT=on-is-off is the MUST-FAIL build of this rig: the "ON" copy is NOT flipped, so arm (a) must read RED (its new cookies stay plain) and the
# byte-diff control must turn the verdict UNVERIFIED. Never set in a measurement.
if [[ "${COOKIE_FUSE_MUTANT:-}" == "on-is-off" ]]; then
  echo "[wrapper] MUTANT on-is-off: the ON copy keeps the fuse OFF (this run must NOT produce a GO)"
  ON_JSON="$(node "${HERE}/lib/flip-cookie-fuse.cjs" "${APPS}/on/orchestra" --off)"
else
  ON_JSON="$(node "${HERE}/lib/flip-cookie-fuse.cjs" "${APPS}/on/orchestra")"
fi
BYTEDIFF="$(cmp -l "${APPS}/off/orchestra" "${APPS}/on/orchestra" | wc -l)"
ASAR_SAME="$(cmp -s "${APPS}/off/resources/app.asar" "${APPS}/on/resources/app.asar" && echo true || echo false)"
node -e '
const [off, on, bytediff, asarSame, src, apps] = process.argv.slice(1);
const o = JSON.parse(off), n = JSON.parse(on);
const meta = { schema: 1, fuseWire: { off: o.after, on: n.after, offLibrary: o.library, onLibrary: n.library, byteDiff: Number(bytediff) }, appAsarIdentical: asarSame === "true", source: src, apps,
  sha256: Object.fromEntries(["off", "on"].map((k) => [k, require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(apps + "/" + k + "/orchestra")).digest("hex")])), wireOn: n.wire, wireOff: o.wire,
  appVersion: JSON.parse(require("node:fs").readFileSync(process.cwd() + "/package.json", "utf8")).version };
process.stdout.write(JSON.stringify(meta));
' "${OFF_JSON}" "${ON_JSON}" "${BYTEDIFF}" "${ASAR_SAME}" "${SRC}" "${APPS}" > "${APPS}/meta.json"
echo "[wrapper] fuse wires: $(node -e 'const m=require(process.argv[1]);console.log("off="+m.fuseWire.off+" (lib "+m.fuseWire.offLibrary+")  on="+m.fuseWire.on+" (lib "+m.fuseWire.onLibrary+")  byte-diff="+m.fuseWire.byteDiff+"  app.asar identical="+m.appAsarIdentical+"  version="+m.appVersion)' "${APPS}/meta.json")"
[[ -n "${COOKIE_FUSE_MUTANT:-}" || ( "${BYTEDIFF}" == "1" && "${ASAR_SAME}" == "true" ) ]] || { echo "ABORT: the two copies must differ in exactly the fuse byte (byte-diff ${BYTEDIFF}, asar identical ${ASAR_SAME})" >&2; exit 2; }

# the app's CLAUDE_CONFIG_DIR is a SCRATCH dir — never a live ~/.claude* (app boot's account-inherit sync strips whatever dir it is handed)
SCRATCH_CFG="$(mktemp -d "${E2E_RIG_BASE}/cfg-XXXXXX")"
export CLAUDE_CONFIG_DIR_PIN="${SCRATCH_CFG}"
# not optional: this rig starts keyring daemons, so the real runtime dir is hidden in a mount namespace on every run
export RIG_HIDE_REAL_RUNTIME=1
GUI=()
[[ -x /var/tmp/orch-1000-b17728/gui-slot.sh && -z "${NO_GUI_SLOT:-}" ]] && GUI=(/var/tmp/orch-1000-b17728/gui-slot.sh)

# ONE planned run per rig invocation (a fresh sway, a fresh GUI-slot hold, ~3-5 min): a kill from outside (the host runs ~20 other agents) loses one part, not the whole measurement.
# Parts are written next to the final file and concatenated in order; a part without its `end` record was killed and is run again (≤ 3 tries).
JSONL=""; RUNS=3; ARMS="w,a,d,c,c2"; LABEL="run"; PASS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jsonl) JSONL="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --arms) ARMS="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    *) PASS+=("$1"); shift ;;
  esac
done
[[ -n "${JSONL}" ]] || JSONL="${APPS}/cookie-fuse.jsonl"
PARTS=()
for ((i = 0; i < RUNS; i++)); do
  PART="${JSONL}.part$((i + 1))"
  for try in 1 2 3; do
    rm -f "${PART}"
    echo "[wrapper] planned run $((i + 1))/${RUNS} (try ${try}) → ${PART}"
    nice -n 10 "${GUI[@]}" "${HERE}/e2e-contained-rig.sh" node --no-warnings --experimental-strip-types "${HERE}/e2e-cookie-fuse.mjs" "${APPS}/off" "${APPS}/on" --meta "${APPS}/meta.json" --live-home "${HOME}" \
      --runs 1 --run-offset "$((i * 10))" --arms "${ARMS}" --label "${LABEL}-$((i + 1))" --jsonl "${PART}" "${PASS[@]}" || true
    grep -q '"kind":"end"' "${PART}" 2>/dev/null && break
    echo "[wrapper] part $((i + 1)) has no end record (killed from outside?) — again" >&2
  done
  grep -q '"kind":"end"' "${PART}" 2>/dev/null || { echo "[wrapper] ABORT: part $((i + 1)) never finished in 3 tries" >&2; exit 4; }
  PARTS+=("${PART}")
done
cat "${PARTS[@]}" > "${JSONL}"
echo "[wrapper] ${#PARTS[@]} part(s) → ${JSONL} ($(wc -l < "${JSONL}") records)"
node --no-warnings --experimental-strip-types "${HERE}/cookie-fuse-verdict.mjs" "${JSONL}" | head -12 || true

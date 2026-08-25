#!/usr/bin/env node
// Evidence rig for the disk-space guard (issue #87).
//
// WHAT THIS PROVES, and why it is not a fixture that confirms my own
// assumptions: it fills a REAL filesystem until a REAL write fails, then shows
// the two arms side by side on THE SAME mount at THE SAME moment:
//
//   UNFIXED arm  — write without a preflight → the kernel's ENOSPC shape.
//                  This is the failure the ticket describes: a verifier died on
//                  ENOSPC "before writing a byte" and it was indistinguishable
//                  from "the feature does not trigger".
//   FIXED arm    — scripts/disk-guard.cjs preflight → exit 17 and a message
//                  carrying ORCHESTRA_DISK_FULL, the mount, the free bytes and
//                  the required bytes.
//
// THE MOUNT IS OURS. It is a 16 MiB tmpfs that this rig mounts inside a
// PRIVATE user+mount namespace (`unshare -rm`), onto a directory this process
// created. Nothing on the host is touched, the mount is invisible to the host
// mount table, and it evaporates with the namespace when the child exits.
//
// tmpfs is deliberate, not a fallback: `/tmp` on the machine in the incident is
// itself a tmpfs (`findmnt -no FSTYPE /tmp` → tmpfs, 16 GiB), so this rig fills
// THE SAME FILESYSTEM TYPE that actually failed — at 1/1000th the size.
//
// THE HOST'S /tmp IS NEVER FILLED. Filling it is precisely the incident this
// ticket describes and would break every sibling agent on this machine.
//
// It deletes ONLY the directory it created in this same process (recorded in
// `created`), never anything it found. See the scope limit in
// src/shared/disk-space.ts.
//
// Usage: node scripts/verify-disk-guard.mjs
// Exit: 0 = both arms observed as expected; non-zero = a claim failed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'disk-guard.cjs');

const created = [];
let failures = 0;

function log(...a) {
  console.log('[disk-guard-rig]', ...a);
}
function claim(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── build the rig payload that runs INSIDE the private mount namespace ─────
// Everything that touches the loopback mount happens in the child, because the
// mount only exists in that namespace.
function rigScript(mnt, guard, controlPath) {
  return `
set -u
mount -t tmpfs -o size=16m tmpfs "${mnt}" 2>&1 || { echo "RIG_MOUNT_FAILED"; exit 91; }
echo "RIG_MOUNTED"
echo "RIG_FSTYPE=$(findmnt -no FSTYPE "${mnt}")"
df -B1 --output=target,size,avail "${mnt}" | tail -1

# Fill the volume until the kernel refuses. dd's own ENOSPC is expected and is
# the POINT — it is how we reach the state under test.
dd if=/dev/zero of="${mnt}/filler" bs=64k 2>/dev/null
echo "RIG_FILLED avail_bytes=$(df -B1 --output=avail "${mnt}" | tail -1 | tr -d ' ')"

# ── ARM A (UNFIXED): a plain write with no preflight ────────────────────────
echo "RIG_ARM_UNFIXED_BEGIN"
node -e '
  const fs = require("node:fs");
  try {
    fs.writeFileSync(process.argv[1], Buffer.alloc(8 * 1024 * 1024));
    console.log("UNFIXED_WROTE_OK");
  } catch (e) {
    console.log("UNFIXED_ERR code=" + e.code + " errno=" + e.errno + " msg=" + e.message);
  }
' "${mnt}/payload.bin"
echo "RIG_ARM_UNFIXED_END"

# ── ARM B (FIXED): the same write, behind the preflight guard ──────────────
echo "RIG_ARM_FIXED_BEGIN"
node "${guard}" --path "${mnt}" --required-bytes 8388608 --op "write payload.bin" 2>&1
echo "RIG_ARM_FIXED_RC=$?"

# ── CONTROL: the same guard, same required size, on a mount that HAS room. If
#    this also failed, the guard would be a constant, not a gate. ────────────
echo "RIG_CONTROL_BEGIN"
node "${guard}" --path "${controlPath}" --required-bytes 8388608 --op "write payload.bin" 2>&1
echo "RIG_CONTROL_RC=$?"

umount "${mnt}" 2>/dev/null || true
`;
}

function main() {
  // 1. our own directory + image file. Recorded so teardown only removes what
  //    this process made.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'diskguard-rig-'));
  created.push(base);
  const mnt = path.join(base, 'mnt');
  fs.mkdirSync(mnt);
  log('rig dir (ours, created this process):', base);

  // 2. run the arms inside a PRIVATE user+mount namespace. `unshare -rm` maps
  //    our uid to root inside the namespace, so mounting a tmpfs needs no sudo
  //    and the mount is invisible to the host mount table.
  // The control probes the REPO's filesystem, which has hundreds of GiB free —
  // an explicit path, not $HOME, so the arm cannot be silently redirected by
  // the environment.
  const controlPath = ROOT;
  const r = spawnSync('unshare', ['-rm', 'bash', '-c', rigScript(mnt, GUARD, controlPath)], {
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  console.log('--- rig output ---');
  console.log(out);
  console.log('--- end rig output ---');

  if (!out.includes('RIG_MOUNTED')) {
    claim('rig could mount its own loopback volume', false, 'see output above');
    return;
  }

  // ── the claims ───────────────────────────────────────────────────────────
  // (a0) the rig filesystem is the SAME TYPE as the one from the incident.
  claim(
    'the rig volume is a tmpfs — the filesystem type that actually failed',
    /RIG_FSTYPE=tmpfs/.test(out),
    out.match(/RIG_FSTYPE=(\S+)/)?.[1] ?? 'no RIG_FSTYPE line',
  );

  // (a) the volume really was full — otherwise both arms are vacuous.
  const availM = out.match(/RIG_FILLED avail_bytes=(\d+)/);
  const avail = availM ? Number(availM[1]) : NaN;
  claim(
    'PRECONDITION: the rig volume is actually out of space',
    Number.isFinite(avail) && avail < 8 * 1024 * 1024,
    `avail=${avail} bytes (must be < 8 MiB, the amount both arms ask for)`,
  );

  // (b) UNFIXED arm produces the ENOSPC shape — the failure being eliminated.
  const unfixed = out.match(/UNFIXED_ERR code=(\S+) errno=(\S+)/);
  claim(
    'UNFIXED arm produces the downstream ENOSPC shape',
    !!unfixed && unfixed[1] === 'ENOSPC',
    unfixed ? `code=${unfixed[1]} errno=${unfixed[2]}` : 'no UNFIXED_ERR line — did the write succeed?',
  );
  claim(
    'UNFIXED arm names NO mount and NO required size (why it was unactionable)',
    !!unfixed && !/required/.test(out.split('RIG_ARM_UNFIXED_BEGIN')[1]?.split('RIG_ARM_UNFIXED_END')[0] ?? ''),
    'the ENOSPC message carries neither the mount nor how much was needed',
  );

  // (c) FIXED arm produces the NAMED error with all three numbers.
  const fixedRc = out.match(/RIG_ARM_FIXED_RC=(\d+)/);
  claim('FIXED arm exits 17 (the named disk-full code)', fixedRc?.[1] === '17', `rc=${fixedRc?.[1]}`);
  claim('FIXED arm message carries ORCHESTRA_DISK_FULL', out.includes('ORCHESTRA_DISK_FULL'));
  claim('FIXED arm message names the MOUNT', out.includes(`on ${mnt} `), `expected mount ${mnt}`);
  claim('FIXED arm message names the FREE bytes', /free \S+ [KMGT]?B of /.test(out));
  claim('FIXED arm message names the REQUIRED bytes', /required 8\.00 MB/.test(out));
  claim(
    'FIXED arm does NOT emit an ENOSPC shape',
    !/ORCHESTRA_DISK_FULL[\s\S]*?ENOSPC/.test(
      out.split('RIG_ARM_FIXED_BEGIN')[1]?.split('RIG_CONTROL_BEGIN')[0] ?? '',
    ),
  );

  // (d) CONTROL: the same guard on a roomy mount must PASS. Without this, a
  //     guard hard-wired to always fail would score identically above.
  const ctlRc = out.match(/RIG_CONTROL_RC=(\d+)/);
  claim(
    'CONTROL: the same guard PASSES on a mount with room (it is a gate, not a constant)',
    ctlRc?.[1] === '0',
    `rc=${ctlRc?.[1]}`,
  );

  // (e) scope: the rig must not have deleted anything it did not create.
  claim(
    'SCOPE: the rig deletes only paths it created this process',
    created.every((p) => p.startsWith(path.join(os.tmpdir(), 'diskguard-rig-'))),
    created.join(', '),
  );
}

try {
  main();
} catch (e) {
  console.error('[disk-guard-rig] rig error:', e);
  failures += 1;
} finally {
  // Teardown removes ONLY what `created` records — paths this process made.
  for (const p of created) {
    if (!p.startsWith(path.join(os.tmpdir(), 'diskguard-rig-'))) {
      console.error('[disk-guard-rig] refusing to remove unexpected path:', p);
      continue;
    }
    fs.rmSync(p, { recursive: true, force: true });
    log('removed our own rig dir:', p);
  }
}

console.log(failures === 0 ? '\nALL CLAIMS PASSED' : `\n${failures} CLAIM(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

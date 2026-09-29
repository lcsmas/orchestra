#!/usr/bin/env python3
"""Reviewer mutation harness: in-place mutant of a file in MY worktree copy of the candidate,
byte-exact backup + cmp restore, run the suites that can reach the clause, print per-suite red names."""
import os, re, shutil, subprocess, sys, filecmp, time, json

REPO = '/home/lmas/a2r-cand'
MUTANTS = {
  'R1_drop_tracked_stat': ('src/main/resource-monitor.ts',
      "(d.readProcStat(tracked) !== null && isKeeperCmdline(d.readCmdline(tracked), ws))",
      "(isKeeperCmdline(d.readCmdline(tracked), ws))"),
  'R2_drop_tracked_cmdline': ('src/main/resource-monitor.ts',
      "(d.readProcStat(tracked) !== null && isKeeperCmdline(d.readCmdline(tracked), ws))",
      "(d.readProcStat(tracked) !== null)"),
  'R2b_drop_both_tracked_reverify': ('src/main/resource-monitor.ts',
      "(tracked === null ||\n          (d.readProcStat(tracked) !== null && isKeeperCmdline(d.readCmdline(tracked), ws)))",
      "(true)"),
  'R3_drop_now_ne_victim': ('src/main/resource-monitor.ts',
      "now !== target.keeperPid &&\n", ""),
  'R4_orphan_untracked_no_live_recheck': ('src/main/resource-monitor.ts',
      "(kind !== 'duplicate' && d.liveWorkspaceIds().has(ws))",
      "(kind === 'orphan' && d.liveWorkspaceIds().has(ws))"),
  'R5_drop_killtime_storeloaded': ('src/main/resource-monitor.ts',
      "if (!d.storeLoadedFromDisk() || (kind",
      "if ((kind"),
  'R6_classify_dup_ignores_storeloaded': ('src/main/resource-monitor.ts',
      "decideDuplicateReap(keeperRoots, d.keeperProcs(), table, liveWorkspaceIds, loaded)",
      "decideDuplicateReap(keeperRoots, d.keeperProcs(), table, liveWorkspaceIds, true)"),
  'R56_both_storeloaded_copies': ('src/main/resource-monitor.ts',
      ["if (!d.storeLoadedFromDisk() || (kind", "decideDuplicateReap(keeperRoots, d.keeperProcs(), table, liveWorkspaceIds, loaded)"],
      ["if ((kind", "decideDuplicateReap(keeperRoots, d.keeperProcs(), table, liveWorkspaceIds, true)"]),
  'K1_daemon_probe_noreply_is_stale': ('src/keeper/index.ts',
      "        s.destroy();\n        resolve('live');\n      }, 1500);",
      "        s.destroy();\n        resolve('stale');\n      }, 1500);"),
  'K2_daemon_no_retry_gap': ('src/keeper/index.ts',
      "for (let i = 0; i < 3; i++) {", "for (let i = 0; i < 1; i++) {"),
  'C0_known_caught_drop_tracked_moved': ('src/main/resource-monitor.ts',
      "now === tracked &&\n", ""),
  'S1_wrapper_victim_contains_tracked_ok': ('src/shared/resource-monitor.ts',
      "if (v.pid === tracked) continue;", "if (v.pid === tracked) continue;  /* noop mutant marker */"),
}

def sh(cmd, timeout=1500):
    return subprocess.run(cmd, shell=True, cwd=REPO, capture_output=True, text=True, timeout=timeout,
                          env={**os.environ, 'A2_HOME': '/home/lmas/a2r-attack/mut-arms'})

def run_suites(suites):
    out = {}
    for name, files in suites:
        r = sh(f"node --test --experimental-strip-types {files} 2>&1", timeout=1500)
        txt = r.stdout + r.stderr
        m = {k: re.search(rf'^# {k} (\d+)', txt, re.M) for k in ('tests', 'pass', 'fail', 'skipped')}
        red = re.findall(r'^not ok \d+ - (.*)$', txt, re.M)
        out[name] = {k: (int(v.group(1)) if v else None) for k, v in m.items()}
        out[name]['red'] = red
    return out

def main():
    import fcntl
    lock = open('/home/lmas/a2r-attack/mutate.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print(json.dumps({'error': 'another mutate.py holds the lock — refusing (one harness at a time)'})); sys.exit(3)
    st = subprocess.run('git status --short', shell=True, cwd=REPO, capture_output=True, text=True).stdout.strip()
    if st:
        print(json.dumps({'error': 'tree not clean at start: ' + st})); sys.exit(4)
    mid = sys.argv[1]
    suites = [('unit+lifecycle+keeper', 'src/shared/resource-monitor.test.ts src/main/keeper-lifecycle.test.ts src/keeper/keeper.test.ts')]
    path, olds, news = MUTANTS[mid]
    if isinstance(olds, str): olds, news = [olds], [news]
    f = os.path.join(REPO, path)
    bak = f + '.mutbak'
    shutil.copyfile(f, bak)
    src = open(f, encoding='utf8').read()
    for o, n in zip(olds, news):
        assert src.count(o) == 1, f'{mid}: pattern count {src.count(o)} != 1: {o[:60]!r}'
        src = src.replace(o, n)
    try:
        open(f, 'w', encoding='utf8').write(src)
        assert open(f, encoding='utf8').read() != open(bak, encoding='utf8').read(), 'mutation is a no-op'
        t0 = time.time()
        res = run_suites(suites)
    finally:
        shutil.copyfile(bak, f)
        same = filecmp.cmp(f, bak, shallow=False)
        os.remove(bak)
    head = sh(f"git diff --stat -- {path} | wc -l").stdout.strip()
    print(json.dumps({'mutant': mid, 'result': res, 'restored_cmp_equal': same, 'git_diff_lines_after_restore': head,
                      'secs': round(time.time() - t0)}))

main()

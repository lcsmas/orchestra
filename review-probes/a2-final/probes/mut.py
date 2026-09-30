#!/usr/bin/env python3
"""In-place mutants on /home/lmas/a2f-mut (byte-exact backup from `git show e3983174:<path>` + cmp restore).
usage: mut.py apply <M> | restore <M> | list"""
import subprocess, sys, os
TREE = '/home/lmas/a2f-mut'
SHA = 'e3983174'
KC = 'src/main/keeper-client.ts'
WS = 'src/main/workspaces.ts'
KD = 'src/keeper/index.ts'
RM = 'src/shared/resource-monitor.ts'
M = {
    'R1_K4d_unconditional_sweep': (KC, "  if (escalated) await killSurvivingDescendants(wsId, tree, reason);", "  await killSurvivingDescendants(wsId, tree, reason);"),
    'R2_never_sweep_after_sigkill': (KC, "      escalated = true;\n", ""),
    'R3_snapshot_after_kill': (WS, "  const tree = snapshotKeeperTree(id); // BEFORE the stop", "  let tree: ReturnType<typeof snapshotKeeperTree> = []; // MUTANT: snapshot taken AFTER the kill (below)"),
    'R4_unlink_by_path_break': (KD, None, None),
    'R5_live_claimfile_swept': (KC, "if (!owner || !Number.isInteger(owner) || owner <= 0 || isAlive(owner)) continue;", "if (!owner || !Number.isInteger(owner) || owner <= 0 || (name !== prefix && isAlive(owner))) continue;"),
    'R11_no_identity_gate_at_kill': (KC, "    if (!descendantAlive(d)) continue; // gone, recycled, or already dead\n", ""),
    'R12a_snapshot_unverified_pid': (KC, "  return pid && keeperPidState(pid, wsId) === 'keeper' ? snapshotDescendants(pid) : [];", "  return pid ? snapshotDescendants(pid) : [];"),
    'K4a_no_starttime': (RM, "if (!p || p.startTicks !== expectedStartTicks) return false;", "if (!p) return false;"),
    'K4b_no_zombie': (RM, "  return !/\\) Z /.test(statText);", "  return true;"),
    'M44_no_giveback': (KD, "      try {\n        fs.linkSync(aside, claimPath); // not stale after all: give the live claim back\n      } catch {\n        /* path already re-taken */\n      }\n", "      /* MUTANT: no give-back */\n"),
    'M43_no_utimes': (KD, "        fs.utimesSync(tmp, now, now);\n", ""),
}


def show(path):
    return subprocess.check_output(['git', '-C', TREE, 'show', f'{SHA}:{path}'])


def cur(path):
    return open(os.path.join(TREE, path), 'rb').read()


def apply(name):
    path, old, new = M[name]
    assert cur(path) == show(path), f'{path} is not pristine before applying {name}'
    s = cur(path).decode()
    if name == 'R3_snapshot_after_kill':
        assert s.count(old) == 1
        s = s.replace(old, new)
        s = s.replace("  await killKeeperTree(id, tree, 'workspace-deleted')", "  tree = snapshotKeeperTree(id);\n  await killKeeperTree(id, tree, 'workspace-deleted')")
        assert s.count("tree = snapshotKeeperTree(id);") == 1
    elif name == 'R4_unlink_by_path_break':
        a = s.index('function breakStaleClaim(): void {')
        b = s.index('function releaseClaim')
        s = s[:a] + "function breakStaleClaim(): void {\n  if (!claimIsStale(claimPath)) return;\n  try {\n    fs.unlinkSync(claimPath);\n  } catch {\n    /* raced */\n  }\n}\n\n" + s[b:]
    else:
        assert s.count(old) == 1, f'{name}: old string occurs {s.count(old)}x'
        s = s.replace(old, new)
    open(os.path.join(TREE, path), 'w').write(s)
    d = subprocess.run(['git', '-C', TREE, 'diff', '--stat', path], capture_output=True, text=True).stdout.strip().splitlines()[-1]
    print(f'APPLIED {name}: {d}')


def restore(name):
    path = M[name][0]
    open(os.path.join(TREE, path), 'wb').write(show(path))
    assert cur(path) == show(path)
    os.utime(os.path.join(TREE, path))  # newer than dist-electron/keeper.js => the rig rebuilds the daemon
    print(f'RESTORED {name}: byte-identical to {SHA}:{path}')


if __name__ == '__main__':
    if sys.argv[1] == 'list':
        print('\n'.join(M))
    elif sys.argv[1] == 'apply':
        apply(sys.argv[2])
    elif sys.argv[1] == 'restore':
        restore(sys.argv[2])

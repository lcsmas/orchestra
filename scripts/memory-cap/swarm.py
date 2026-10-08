# A swarm of medium processes (the 56-Chromium shape): fork N children, each touching MB megabytes, holding S seconds; the parent reports each child's fate.
# No single big hog — the biggest process in the scope is the CLI, so only the oom_score_adj of the tool tree decides who the kernel kills.
# argv: <N> <MB each> <hold-seconds> <marker>
import os, sys, time, signal
n, mb, hold = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
kids = []
for i in range(n):
    pid = os.fork()
    if pid == 0:
        chunks = []
        for _ in range(max(1, mb // 10)):
            chunks.append(bytearray(b'\xa5') * (10 * 1024 * 1024))
            time.sleep(0.1)  # a runaway takes TIME to grow: slow enough for the keeper's 100-250 ms snapshot to see it by name
        time.sleep(hold)
        os._exit(0)
    kids.append(pid)
    time.sleep(0.15)
survived = killed = 0
for pid in kids:
    _, st = os.waitpid(pid, 0)
    if os.WIFSIGNALED(st) and os.WTERMSIG(st) == signal.SIGKILL:
        killed += 1
    else:
        survived += 1
print(f"swarm: children={n} survived={survived} killed={killed}", flush=True)

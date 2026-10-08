# Crosses the WARNING level `rounds` times: each round a child touches <MB> at once, holds <hold> s and exits normally (memory falls back below the level), then <gap> s of quiet so the watch re-arms.
# argv: <MB> <hold-seconds> <gap-seconds> <rounds> <marker>
import subprocess, sys, time
mb, hold, gap, rounds = int(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
for i in range(rounds):
    p = subprocess.Popen([sys.executable, '-c', f'import time; b = bytearray(b"\\xa5") * ({mb} * 1024 * 1024); time.sleep({hold})'])
    rc = p.wait()
    print(f"soft-cross: round {i + 1} rc={rc}", flush=True)
    time.sleep(gap)
print("soft-cross: done", flush=True)

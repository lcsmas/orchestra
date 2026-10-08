# The #322 m2 race, deterministic: a BIG command A exits normally at ~1.3 s while, at the same moment, a smaller C touches 900 MB at once and is OOM-killed before the keeper's
# 100-500 ms snapshot ever saw it. Inference by badness names A (it vanished in the same window); only the kernel's own record names C.
import subprocess, sys, time
a = subprocess.Popen([sys.executable, '-c', 'import time; b = bytearray(b"\\xa5") * (90 * 1024 * 1024); time.sleep(1.3)'])  # A: 90 MB, exits NORMALLY
time.sleep(1.25)
c = subprocess.Popen([sys.executable, '-c', 'b = bytearray(b"\\xa5") * (900 * 1024 * 1024)'])  # C: killed at the cap
cpid = c.pid
rc = c.wait()
a.wait()
print(f"m2: victim_pid={cpid} victim_rc={rc} a_rc={a.returncode}", flush=True)

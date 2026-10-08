# The #322 m2 race, repeated: in each round a BIGGER command A (60 MB, seen by every snapshot) exits NORMALLY, and in the same instant a SMALLER one C (40 MB, also seen) touches 300 MB more and is OOM-killed
# at the cap. Both vanish inside one watch window and A's last-seen size is larger — inference by badness names A; only the kernel's own record names C.
# argv: <rounds>   prints `m2: victims=<pid>,<pid>,…` (the real victims, in order)
import os, subprocess, sys, time
py = sys.executable
rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 6
victims = []
for r in range(rounds):
    a = subprocess.Popen([py, '-c', 'import time; b = bytearray(b"\\xa5") * (60 * 1024 * 1024); time.sleep(1.0)'])  # A: exits normally (rc 0) after 1.0 s
    c_src = (
        'import os, time\n'
        'b = bytearray(b"\\xa5") * (40 * 1024 * 1024)\n'
        'while True:\n'
        f'    try: os.kill({a.pid}, 0)\n'
        '    except OSError: break\n'
        '    time.sleep(0.001)\n'
        'd = bytearray(b"\\xa5") * (300 * 1024 * 1024)\n'  # the instant A is gone: grow and hit the cap
    )
    c = subprocess.Popen([py, '-c', c_src])
    victims.append(c.pid)
    a.wait()   # reaps A: C's poll sees it vanish
    rc = c.wait()
    print(f"m2: round {r + 1} a_rc={a.returncode} c_rc={rc}", flush=True)
    time.sleep(0.4)
print("m2: victims=" + ",".join(str(v) for v in victims), flush=True)

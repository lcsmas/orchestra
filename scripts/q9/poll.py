# Q9 (research): a high-rate poller OUTSIDE the scope. argv: <cgroup dir> <seconds> <out file>. Logs a line whenever memory.events oom_kill changes and the memory.current trace (t_ns, bytes) every sample.
import sys, time
d, secs, outp = sys.argv[1], float(sys.argv[2]), sys.argv[3]
import os
t_wait = time.monotonic() + 8
while not os.path.exists(d + '/memory.events') and time.monotonic() < t_wait: time.sleep(0.001)
fc = open(d + '/memory.current', 'rb', buffering=0); fe = open(d + '/memory.events', 'rb', buffering=0)
t_end = time.monotonic() + secs
rows = []; last_kill = -1; last_cur = None
def rd(f):
    f.seek(0); return f.read()
while time.monotonic() < t_end:
    t = time.monotonic_ns()
    try:
        cur = int(rd(fc)); ev = rd(fe)
    except OSError:
        break
    k = int(ev.split(b'oom_kill ')[1].split(b'\n')[0])
    if k != last_kill or last_cur is None or abs(cur - last_cur) > 4 * 1024 * 1024:
        rows.append((t, cur, k)); last_kill = k; last_cur = cur
    time.sleep(0.00002)
with open(outp, 'w') as o:
    for r in rows: o.write('%d %d %d\n' % r)

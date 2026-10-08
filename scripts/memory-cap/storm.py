# A kill STORM (review-2 F2): <n> children, each touching 400 MB in a scope that cannot hold it, one after the other 50 ms apart. The kernel rate-limits its `oom-kill:` dump (measured: 30 kills -> 10 journal lines),
# so a lookup finds FEWER lines than kills - the case where a stale line must never be labelled kernel.  argv: <n>
import subprocess, sys, time
n = int(sys.argv[1])
procs = []
t0 = time.time()
for i in range(n):
    p = subprocess.Popen([sys.executable, '-c', 'b = bytearray(b"\\xa5") * (400 * 1024 * 1024)'])
    p.wait()
    time.sleep(0.05)
print(f"storm done {n} children in {time.time()-t0:.1f}s", flush=True)

cg = open('/proc/self/cgroup').read().strip().split('::')[1]
ev = open('/sys/fs/cgroup' + cg + '/memory.events').read().split()
print('memory.events', dict(zip(ev[0::2], ev[1::2])), flush=True)

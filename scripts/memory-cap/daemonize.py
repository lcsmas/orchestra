# A Reliquat: double-fork + setsid, detached from the tool tree, then sleep S seconds. argv: <seconds> <marker>
import os, sys, time
if os.fork() > 0:
    os._exit(0)
os.setsid()
_null = os.open(os.devnull, os.O_RDWR)
for _fd in (0, 1, 2):
    os.dup2(_null, _fd)  # a real daemon lets go of the tool's pipes, or the tool never sees its stdout close
if os.fork() > 0:
    os._exit(0)
time.sleep(float(sys.argv[1]))

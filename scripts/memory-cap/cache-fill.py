# Fills the page cache of the CALLING scope: writes <MB> to <path> (no fsync — the pages stay cached and charged to the scope's memory.current), holds <hold> s, removes the file.
# argv: <path> <MB> <hold-seconds>
import os, sys, time
path, mb, hold = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
chunk = b"\xa5" * (1024 * 1024)
with open(path, "wb") as f:
    for _ in range(mb):
        f.write(chunk)
print(f"cache-fill: wrote {mb} MB", flush=True)
time.sleep(hold)
os.unlink(path)
print("cache-fill: done", flush=True)

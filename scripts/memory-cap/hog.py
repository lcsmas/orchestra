# Memory hog for the memory-cap rig: touch N MB (10 MB steps, 5 ms apart so the keeper's snapshot can see it), hold S seconds.
# argv: <MB> <hold-seconds> <marker>   (the marker only makes the cmdline recognisable)
import sys, time
mb, hold = int(sys.argv[1]), float(sys.argv[2])
chunks = []
for _ in range(max(1, mb // 10)):
    chunks.append(bytearray(b'\xa5') * (10 * 1024 * 1024))
    time.sleep(0.005)
print(f"hog: touched {len(chunks) * 10} MB", flush=True)
time.sleep(hold)
print("hog: survived", flush=True)

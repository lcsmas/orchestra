# Verifier (seat 1, #389): REAL kernel replay of the "stranger row" interleaving. usage: ss-strange.py <base>
# Creates: listener HUMAN (stand-in for the human's bus), OUR client C connected to it (unnamed), a stranger listener L2, and a stranger socket S bound to "<base>/x <C_ino> /y" and connected to L2.
# Prints a JSON line {c, s, human, l2}; then waits for the line "close-stranger" on stdin: closes S (the stranger's local inode vanishes between two snapshots), then prints "closed".
import socket, os, sys, json
base = sys.argv[1]
H = os.path.join(base, 'human bus'); hl = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); hl.bind(H); hl.listen(8)
c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); c.connect(H); ha, _ = hl.accept()
cino = os.fstat(c.fileno()).st_ino
L2 = os.path.join(base, 'stranger listener'); l2 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); l2.bind(L2); l2.listen(8)
os.makedirs(os.path.join(base, 'x %d ' % cino), exist_ok=True)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(os.path.join(base, 'x %d ' % cino, 'y')); s.connect(L2); l2a, _ = l2.accept()
print(json.dumps({'c': cino, 's': os.fstat(s.fileno()).st_ino, 'human': os.fstat(ha.fileno()).st_ino, 'l2a': os.fstat(l2a.fileno()).st_ino}), flush=True)
for line in sys.stdin:
    if line.strip() == 'close-stranger':
        s.close(); print('closed', flush=True)

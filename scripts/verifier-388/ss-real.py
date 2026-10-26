# Verifier (seat 1, #389): create REAL unix sockets with hostile names in a scratch dir, all connected to one listener; print {name: socket inode}. Holds them open until stdin closes.
import socket, os, sys, json
base = sys.argv[1]
L = os.path.join(base, 'listener sock')
ls = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); ls.bind(L); ls.listen(64)
names = json.loads(sys.argv[2])
keep, inos = [ls], {'__listener__': os.fstat(ls.fileno()).st_ino}
for n in names:
    c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        os.makedirs(os.path.dirname(os.path.join(base, n)), exist_ok=True); c.bind(os.path.join(base, n)); c.connect(L)
    except OSError as e:
        inos[n] = 'ERR ' + str(e); continue
    keep.append(c); inos[n] = os.fstat(c.fileno()).st_ino
    a, _ = ls.accept(); keep.append(a)
print(json.dumps(inos), flush=True)
sys.stdin.read()

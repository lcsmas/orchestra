#!/usr/bin/env python3
"""Seat 3 — REAL compositor pointer input for the contained rig's own headless sway: a minimal Wayland client speaking zwlr_virtual_pointer_v1 over the raw socket
(no libraries; the rig's headless sway has no input device, so `swaymsg seat cursor` reaches no client). Line protocol on stdin: `move X Y` / `press` / `release` / `quit`;
one `ok ...` (or `err ...`) line on stdout per command. Needs XDG_RUNTIME_DIR + WAYLAND_DISPLAY of the rig and OUT_W OUT_H (output extent) in the environment. Refuses X11 / the human's display."""
import os, socket, struct, sys, time

def die(m):
    print('err ' + m, flush=True); sys.exit(2)

xdg = os.environ.get('XDG_RUNTIME_DIR'); wd = os.environ.get('WAYLAND_DISPLAY')
ok = bool(xdg and wd and wd != 'wayland-1' and os.path.isabs(xdg) and (xdg.startswith('/var/tmp/p396s3-') or os.environ.get('V3_VPTR_ANY_RIG') == '1'))
if not ok: die(f'refusing: XDG_RUNTIME_DIR={xdg!r} WAYLAND_DISPLAY={wd!r} is not the rig private runtime')
OUT_W = int(os.environ['OUT_W']); OUT_H = int(os.environ['OUT_H'])
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(os.path.join(xdg, wd))

def pad(n): return (n + 3) & ~3
def msg(obj, op, payload=b''): return struct.pack('<II', obj, ((8 + len(payload)) << 16) | op) + payload
def string(v):
    b = v.encode() + b'\0'; return struct.pack('<I', len(b)) + b + b'\0' * (pad(len(b)) - len(b))
buf = b''
def read_events():
    global buf
    s.settimeout(3.0)
    d = s.recv(65536)
    if not d: die('compositor closed the socket')
    buf += d
    out = []
    while len(buf) >= 8:
        obj, sizeop = struct.unpack('<II', buf[:8]); size = sizeop >> 16; op = sizeop & 0xffff
        if len(buf) < size: break
        out.append((obj, op, buf[8:size])); buf = buf[size:]
    return out
def roundtrip(cb_id):
    s.sendall(msg(1, 0, struct.pack('<I', cb_id)))  # wl_display.sync
    evs = []
    while True:
        for e in read_events():
            if e[0] == 1 and e[1] == 0:
                oid, code = struct.unpack('<II', e[2][:8]); die(f'wl_display.error object {oid} code {code}: {e[2][12:].decode(errors="replace")[:120]}')
            evs.append(e)
            if e[0] == cb_id and e[1] == 0: return evs

s.sendall(msg(1, 1, struct.pack('<I', 2)))  # get_registry -> id 2
evs = roundtrip(3)
mgr_name = None
for obj, op, p in evs:
    if obj == 2 and op == 0:
        name, ln = struct.unpack('<II', p[:8]); iface = p[8:8 + ln - 1].decode(); ver = struct.unpack('<I', p[8 + pad(ln):12 + pad(ln)])[0]
        if iface == 'zwlr_virtual_pointer_manager_v1': mgr_name, mgr_ver = name, ver
if mgr_name is None: die('the compositor does not offer zwlr_virtual_pointer_manager_v1')
s.sendall(msg(2, 0, struct.pack('<I', mgr_name) + string('zwlr_virtual_pointer_manager_v1') + struct.pack('<II', 1, 4)))  # bind -> id 4
s.sendall(msg(4, 0, struct.pack('<II', 0, 5)))  # create_virtual_pointer(seat=null) -> id 5
roundtrip(6)
t0 = time.monotonic()
def now(): return int((time.monotonic() - t0) * 1000) & 0xffffffff
cbn = [6]  # object ids must be allocated without gaps: 2 registry, 3/6 syncs, 4 manager, 5 pointer, then 7, 8, ...
def flush():
    s.sendall(msg(5, 4)); cbn[0] += 1; roundtrip(cbn[0])
print('ok ready', flush=True)
for line in sys.stdin:
    a = line.split()
    if not a: continue
    try:
        if a[0] == 'move':
            x, y = int(a[1]), int(a[2]); s.sendall(msg(5, 1, struct.pack('<IIIII', now(), x, y, OUT_W, OUT_H))); flush(); print(f'ok move {x} {y}', flush=True)
        elif a[0] in ('press', 'release'):
            s.sendall(msg(5, 2, struct.pack('<III', now(), 0x110, 1 if a[0] == 'press' else 0))); flush(); print(f'ok {a[0]}', flush=True)
        elif a[0] == 'quit':
            s.sendall(msg(5, 8)); cbn[0] += 1; roundtrip(cbn[0]); print('ok quit', flush=True); break
        else: print('err unknown ' + a[0], flush=True)
    except SystemExit: raise
    except Exception as e: print('err ' + repr(e), flush=True)

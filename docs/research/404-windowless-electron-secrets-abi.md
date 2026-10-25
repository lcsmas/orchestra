# #404: can a windowless Electron host decrypt safeStorage secrets and load the ABI-130 bus native?

**Verdict: the facts favour a windowless Electron daemon.** It is the only runtime that runs both
Electron-bound deps through the code that ships today: `safeStorage.decryptString` and the shipped
ABI-130 better-sqlite3 binding. I proved it in a real `systemd-run --user` unit with no
`DISPLAY` or `WAYLAND_DISPLAY`. Three conditions apply:

- **`--ozone-platform=headless`.** Without it, Electron with no display dies with SIGSEGV.
- **The app's `app.setName`.** The keyring item is keyed by the app name.
- **The app's `--password-store`.** On this sway host the default is `basic_text`, which refuses
  to encrypt.

Electron-as-node is a cheaper runner-up (70 MB PSS against 168 MB). It loads the bus as-is, but it
has **no `safeStorage`**. It can decrypt only through a reimplemented Chromium OSCrypt v11 reader
plus `secret-tool`, which I measured working. Plain Node fails the bus without a second ABI-127
build.

**A host fact that changes the stakes.** The real app on this machine never encrypts anything.
sway is not a desktop environment Chromium recognises, so `safeStorage` selects `basic_text` with
`isEncryptionAvailable() === false`. `secrets.ts` then stores plaintext (`enc: false`). The
keyring has no Orchestra item at all.

Compiled 2026-10-25 for [#404](https://github.com/lcsmas/orchestra/issues/404). It feeds
[#140](https://github.com/lcsmas/orchestra/issues/140) (Electron daemon vs Node daemon) and builds on
[#137's seam list, constraint 3](https://github.com/lcsmas/orchestra/blob/d497046b8fba321d8125c4b4a68a4952c1554ae9/docs/research/137-host-seam-list.md).

**Test setup:**

- Host: Fedora Asahi aarch64, kernel 6.19, sway, gnome-keyring-daemon `--components=secrets` with
  the login collection unlocked.
- Electron 33.4.11 (ABI 130, node 20.18.3). System node 22.22.0 (ABI 127).
- Base `origin/master` 7d760353 (rebased onto 4429c195 before commit). The 3 commits in between touch no secrets, platform or
  bus source. Their `package.json` change prunes better-sqlite3's `deps/`, `src/`, `obj/` and
  `test_extension.node` from the AppImage but keeps `better_sqlite3.node`. A4 ran against the
  AppImage installed before that change.

## Verdict table: arm × dep

Every row comes from [`404-rig/run-matrix.sh`](404-rig/run-matrix.sh). Its output is in
[`404-rig/matrix-output.txt`](404-rig/matrix-output.txt): 36/36 arms matched their expected outcome,
`MATRIX CLEAN`, on 3 consecutive runs.

Each arm runs under `env -i` with an allowlisted environment, with a scratch userData under
`$TMPDIR` and a fresh keyring item `application=orchestra-r404-probe-<pid>`, which is cleared on exit.
The table cell names the arm id in the matrix.

| Arm | (1) `safeStorage` decrypt of a v11 (keyring) blob | (2) open + WAL + write + read on the ABI-130 bus binding |
|---|---|---|
| **Control**: windowless Electron, full session env (`WAYLAND_DISPLAY`, `DISPLAY`, `XDG_CURRENT_DESKTOP=sway`), `--password-store=gnome-libsecret` | **works**: K1 encrypt `backend=gnome_libsecret prefix=v11`; K2 decrypts the same blob in a new process | **works**: K2 `bus=ok(wal)` |
| **A** `ELECTRON_RUN_AS_NODE=1 electron script.js` | **fails**: A1 `require('electron')` is the npm path string, `safeStorage=undefined`. A3: the internal `process._linkedBinding('electron_browser_safe_storage')` **SIGSEGVs** (rc 139). A4: same on the **shipped AppImage binary** | **works**: A1 (dev binding); A4 the **shipped binary + shipped `app.asar.unpacked` binding** |
| **A + keyring reader** (`node-keyring-decrypt.mjs` under `ELECTRON_RUN_AS_NODE`) | **works**: A5 `decrypt=SECRET` via `secret-tool` | (as A) |
| **B** windowless Electron, **no `WAYLAND_DISPLAY`/`DISPLAY`**, `--ozone-platform=headless --password-store=gnome-libsecret` | **works**: B2 `windows=0`, `DISPLAY=null`, `decrypt=SECRET`. B4e encrypts there, and B4d decrypts that blob in a session-env process (both directions) | **works**: B2 `bus=ok(wal)` |
| **B in a real systemd user unit** (`systemd-run --user -p "UnsetEnvironment=DISPLAY WAYLAND_DISPLAY ELECTRON_OZONE_PLATFORM_HINT"`) | **works**: U1 | **works**: U1 |
| **C** plain system node | **fails**: C1 `safeStorage=undefined`. **Works** only through the reimplemented reader: C3 `secret-tool`, `decrypt=SECRET`; also C6 inside a systemd unit | **fails**: C1 `NODE_MODULE_VERSION 130 … requires 127`. **Works** only with the second, ABI-127 build: C2 |

## Must-FAIL arms: one per claim

| Claim | Must-FAIL arm | Observed |
|---|---|---|
| The control's decrypt really uses the keyring, not a basic_text fallback | **F1**: same session env, no `--password-store` | `backend=basic_text available=false`, decrypt throws |
| …and is not fooled by the explicit basic store | **F2**: `--password-store=basic` | `basic_text`, decrypt throws |
| …and needs the keyring reachable | **F3**: `gnome-libsecret` with `DBUS_SESSION_BUS_ADDRESS` pointing at no bus | `backend=gnome_libsecret available=false`, decrypt throws |
| …and is bound to the app-name keyring item | **F4**: `app.setName` to another name | `available=true` (a new item is created), decrypt throws |
| B's no-display success needs headless ozone | **B1**: no display, no `--ozone-platform` | `Missing X server or $DISPLAY`, **SIGSEGV**, no output |
| B in a real unit still needs the store switch | **B3** / **U2**: no switch | `basic_text`, decrypt throws |
| ABI is enforced (bus) | **C1**: node + ABI-130; **A2**: as-node + ABI-127; **B2m**: Electron main + ABI-127 | each refuses at `new Database()` |
| `require()` is not a gate | **C1** `require-trap` | `require` = ok, construct = throws (the trap documented in `bus.md` and `bus-binding.ts`) |
| The node reader truly needs the keyring password | **C4**: `peanuts` as the password; **C5**: no D-Bus; **A5m**: another item's password | `bad decrypt`; `secret-tool` fails; `BAD_DECRYPT` |
| **A basic_text "works" proves nothing** | **V1**: `setUsePlainTextEncryption(true)` encrypts a `v10` blob; **V2**: plain node decrypts it **with no D-Bus at all**, using the hard-coded password | `decrypt=SECRET`. v10 is obfuscation, not encryption |
| The judge can say DIRTY | Mutant copy with K2 flipped to `fails` and C1 bus flipped to `works` | `MATRIX DIRTY (2 unexpected)`, exactly those two. The original was restored byte-identical (`cmp`) |

## Findings that matter for #140

1. **On this host the app's secrets are plaintext, by Electron's choice and not Orchestra's.**
   - With `XDG_CURRENT_DESKTOP=sway` or unset, Electron selects `basic_text` and refuses to
     encrypt (F1e: `Encryption is not available`).
   - `secrets.ts:132-136` then writes `enc: false`.
   - `src/main/index.ts` sets no `password-store` switch (grep).
   - A `SearchItems` on the Secret Service for `application=Orchestra|orchestra|Electron|electron`
     returns 0 items. The positive control is a probe item, which the same call finds
     (`…/collection/login/8`) and then no longer finds after it is cleared.

   So the safeStorage coupling (#137 constraint 3) is **latent on sway hosts**. It bites on
   GNOME/KDE sessions, where the app does pick libsecret or kwallet. Electron's doc says the same:
   `basic_text` is used "when the desktop environment is not recognised", and then items are
   "encrypted via hardcoded plaintext password"
   ([safeStorage docs](https://www.electronjs.org/docs/latest/api/safe-storage)).
2. **A daemon can only decrypt the app's blobs if it is configured like the app.** It must use the
   same `app.getName()`, because the libsecret item is
   `{schema chrome_libsecret_os_crypt_password_v2, application=<app name>}` with the label
   `Chromium Safe Storage` (observed with `secret-tool search`). F4 shows that another name fails.
   It must also make the same `--password-store` choice. A mismatch fails as a throw from
   `decryptString`, which `secrets.ts:144-149` turns into a logged warning and an `undefined` key.
   That is quiet.
3. **A daemon under systemd needs `--ozone-platform=headless`.** On this host a user unit inherits
   `DISPLAY`, `WAYLAND_DISPLAY` and `XDG_CURRENT_DESKTOP=sway` while sway is up, because sway
   imports them. So the issue's premise that "a unit has none" holds only before login or after
   logout. In that window, Electron without the flag SIGSEGVs (B1). With the flag it starts
   windowless (EGL errors are logged, harmlessly) and both deps work (U1).
4. **Electron-as-node has no `safeStorage` path at all.** The public module is absent. The internal
   binding is linked but SIGSEGVs, because the browser process is not initialised. It does run
   both deps if the daemon carries a small OSCrypt v11 reader:
   - the key is `PBKDF2-HMAC-SHA1(secret-tool password, "saltysalt", 1 iteration, 16 bytes)`;
   - the cipher is AES-128-CBC with an IV of 16 spaces.

   The reader is [`404-rig/node-keyring-decrypt.mjs`](404-rig/node-keyring-decrypt.mjs), and C3
   and A5 show it decrypting what Electron wrote. It reimplements Chromium-private crypto plus a
   `secret-tool` dependency. INFERRED: it would break silently if Chromium changes the Linux
   format.
5. **Idle cost** ([`404-rig/idle-cost.sh`](404-rig/idle-cost.sh), the process tree 6 s after start,
   PSS):

   | Runtime | Processes | PSS |
   |---|---|---|
   | windowless Electron (headless) | 6 | 168 MB |
   | windowless Electron (headless, `--disable-gpu`) | 6 | 167 MB |
   | `ELECTRON_RUN_AS_NODE` | 1 | 70 MB |
   | system node | 1 | 11 MB |

## Reproduce

From a worktree:

```sh
pnpm install --frozen-lockfile && pnpm run build:bus-abi
R404_APPIMAGE_DIR=<mounted AppImage dir> bash docs/research/404-rig/run-matrix.sh   # → MATRIX CLEAN
bash docs/research/404-rig/idle-cost.sh
```

The rig refuses a userData outside its scratch root. It never reads `~/.orchestra*`, `~/.claude*`
or any `secrets.json`. It never creates a `BrowserWindow`. It leaves nothing under
`~/.config/<probe>` (checked at the end of every run).

## VERIFIED

- Windowless Electron decrypts a keyring blob and queries the ABI-130 bus with no display, inside
  a real systemd user unit: matrix U1 and B2.
- The control blob decrypts across processes (K2). Each of basic_text, no D-Bus, and a foreign item
  makes it fail (F1–F4).
- Electron-as-node: the bus works, including the shipped AppImage binary and shipped binding (A1,
  A4). `safeStorage` is absent and the internal binding SIGSEGVs (A1, A3, A4).
- Plain node: the ABI-130 build is refused at construct while `require` succeeds (C1). The ABI-127
  build works (C2). The keyring reader decrypts (C3, C6) and refuses a wrong key (C4, C5).
- This host's default backend is `basic_text`, with encryption unavailable (F1e). There is no
  Orchestra libsecret item, and the search was checked against a positive control.

## NOT VERIFIED

- **The real Orchestra main process's own backend.** Its `/proc/<pid>/environ` reads empty
  (Chromium reuses that memory), and I did not launch the real app. The claim rests on F1/F1e with
  the same env shape plus the absent keyring item.
- **The app name the packaged app passes to the keyring.** The shipped `app.asar` `package.json`
  has `"name": "orchestra"` and no `productName`, so INFERRED `application=orchestra`.
- **A GNOME or KDE session**, where the app would really encrypt, and kwallet6: only libsecret
  was exercised.
- **A locked keyring**, where gnome-keyring may raise a prompt window. It was unlocked here, so
  this was not tested. A daemon starting before login would hit it.
- **A window-bearing full app** as the control. The control and every arm are windowless by rule.
  INFERRED: `os_crypt` initialisation does not depend on a window.
- **The real `bus.ts` `open()` path and the bus schema.** The probe uses better-sqlite3 directly
  (WAL plus a write and a read), not Orchestra's migrations.

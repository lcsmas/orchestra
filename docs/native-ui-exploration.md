# Native UI Exploration — Migrating Orchestra off Electron to Embed a GPU-Native Terminal

*Feasibility study, 2026-07-18. Research task only — no production code changes.*

**Question:** Orchestra's owner finds Claude Code snappier and better-looking in native
Ghostty than in the app's xterm.js panes. Is it worth migrating Orchestra's UI shell to a
fully native toolkit so a real GPU-native terminal (ideally libghostty) can be embedded as
a first-class widget — and if not (yet), what are the incremental alternatives?

**TL;DR:** Not yet — and mostly because the prize doesn't exist to be claimed. As of
mid-2026, libghostty ships only its VT engine (libghostty-vt: parser/state, no renderer,
no widget, no tagged release); the official GTK4 terminal widget is "under consideration"
and the GPU-renderer library is announced but unshipped. A native rewrite today means
months rebuilding Orchestra's entire web renderer (Monaco diff viewer, 113K of CSS,
dashboards) plus losing the embedded multi-account OAuth browser and the CDP E2E harness —
to embed either VTE or a hand-rolled renderer, not Ghostty. The recommended move is the
**tmux session broker**: run agent PTYs inside tmux so the existing xterm.js pane and a
real external Ghostty can attach to the same live session ("Open in Ghostty" =
`ghostty -e tmux attach`). Days of work, delivers actual Ghostty rendering on demand, adds
session durability, and de-risks a future native migration — for which **GTK4 (+Relm4)**
is the designated target once libghostty's GTK widget actually ships. True in-window
embedding of an external Ghostty under Electron is infeasible on Wayland by design.

---

## 1. libghostty status (mid-2026)

### 1.1 What exists today

- **libghostty-vt** — a zero-dependency VT/terminal-state library (SIMD-optimized parsing,
  Unicode, Kitty graphics protocol, tmux control mode) extracted from Ghostty's core — is
  **real and consumable today** in Zig and C, with a Doxygen C API reference at
  [libghostty.tip.ghostty.org](https://libghostty.tip.ghostty.org), nine C examples in the
  repo's `example/` dir, and pkg-config support via `zig build -Demit-lib-vt`
  ([announcement](https://mitchellh.com/writing/libghostty-is-coming),
  [repo](https://github.com/ghostty-org/ghostty)).
- **No tagged release exists** of any libghostty artifact as of 2026-07-18. Mitchell
  Hashimoto's 2025-09-22 announcement targeted a tagged release "within the next 6 months"
  (≈March 2026); that slipped. The [Ghostty 1.3.0 release notes (2026-03-09)](https://ghostty.org/docs/install/release-notes/1-3-0)
  say tagging the first libghostty release is the top roadmap item but "we aren't sure yet
  when." The docs carry the warning: *"This library is currently in development and the API
  is not yet stable. Breaking changes are expected."*
- **Scope of libghostty-vt: VT state only.** Parsing, screen/grid state, input encoding
  (key/mouse/focus), OSC/SGR, paste validation, dirty-region render *state* helpers — but
  **no GPU rendering, no PTY management, no widget**. GPU output is the embedder's job.

### 1.2 The embedding (surface) API

Two distinct C APIs exist:

- `include/ghostty.h` — the legacy full-embedding API the **macOS app** consumes:
  `ghostty_app_t`/`ghostty_surface_t` lifecycle, `ghostty_surface_draw/set_size/key/text/
  mouse_button/mouse_pos/mouse_scroll`, config, clipboard callbacks. Rendering is done *by
  libghostty* given a platform surface — but the platform pieces are behind
  `#ifdef __APPLE__` (Metal layer/view). The header itself says it is *"not meant to be a
  general purpose embedding API (yet)"*
  ([header](https://raw.githubusercontent.com/ghostty-org/ghostty/main/include/ghostty.h)).
- `include/ghostty/vt.h` — the new public libghostty-vt API (terminal/screen/render-state/
  formatter/key/mouse/osc/sgr/unicode/kitty-graphics headers), marked WIP/unstable.

**Linux/GTK is not served by the embedding API.** Ghostty's Linux app consumes the shared
core in-process as a Zig module (post the 2025 [GTK rewrite](https://mitchellh.com/writing/ghostty-gtk-rewrite)),
not across the C ABI. [Discussion #11722](https://github.com/ghostty-org/ghostty/discussions/11722)
(closed ~2026-03-21) is decisive for this study: a PR adding `GHOSTTY_PLATFORM_LINUX` to the
embedded apprt was **declined** — the embedded-apprt path is "superseded by libghostty-vt
for the pure terminal emulation part," with a **libghostty-gtk4 widget library only "under
consideration."** So today, third parties on Linux get the VT engine, not a drop-in
rendering surface.

### 1.3 Roadmap and ecosystem

- Mitchell's stated longer-term plan: further `libghostty-<x>` libraries for input handling,
  **GPU rendering ("provide us with an OpenGL or Metal surface and we'll take care of the
  rest")**, **GTK widgets and Swift frameworks that handle the entire terminal view**
  ([announcement](https://mitchellh.com/writing/libghostty-is-coming)). None of these are
  shipped or dated.
- libghostty-vt compiles to **WebAssembly** (no emscripten) as of Oct 2025
  ([source](https://x.com/mitchellh/status/1981113067238048013)); platforms: macOS, Linux,
  Windows, Wasm.
- Third-party bindings/embedders exist and are growing ("dozens of projects" per the 1.3.0
  notes; two curated [awesome](https://github.com/lawrencecchen/awesome-libghostty)-[lists](https://github.com/Uzaaft/awesome-libghostty)):
  official-ish **Go bindings by Mitchell** (mitchellh/go-libghostty, unstable), **Rust**
  crates `libghostty-vt`/`-sys` v0.2.0 (2026-06-16, uzaaft/libghostty-rs), Dart, and —
  notably for us — **coder/ghostty-web**, an xterm.js-compatible web terminal over the Wasm
  build, plus `philipp-spiess/electron-libghostty` and `Xuanwo/gpui-ghostty`.

**Implication for Orchestra:** embedding "real Ghostty rendering" as a widget on
Linux/Wayland is **not consumable today**. What is consumable is the VT engine — meaning
any near-term "ghostty in Orchestra" is either (a) our own GPU renderer over
libghostty-vt state, (b) the Wasm build inside the existing web renderer
(ghostty-web path), or (c) compositing an actual external Ghostty process.

---

## 2. What Orchestra actually uses from Electron (repo audit)

Verified against source at the anchors below (repo `lcsmas/orchestra`, v0.5.84).

### 2.1 Main-process Electron surface — thin and concentrated

- **Windows: exactly two `BrowserWindow` constructors.** The main window
  (`src/main/index.ts:314-328` — preload + contextIsolation, no nodeIntegration, menu bar
  disabled, `will-navigate`/`setWindowOpenHandler` deny + reroute to external browser at
  :350-360), and the per-account **OAuth login windows**
  (`src/main/login-browser.ts:66-77`).
- **IPC: 83 invoke channels** (all `ipcMain.handle`, wrapped with logging at
  `src/main/index.ts:257-264`) + **22 main→renderer event channels** (~100
  `webContents.send` sites; hottest is `workspace:update` with 32 send sites). The preload
  bridge is the single file `src/preload/index.ts` (~105 `ipcRenderer` call sites). No
  `ipcMain.on` — the surface is uniformly promise-shaped, which makes it mechanically
  portable to any RPC transport.
- **Dialogs:** one native directory picker (`dialog.showOpenDialog`,
  `src/main/index.ts:709`), one startup `showMessageBox` (:1196).
- **Notifications:** `new Notification()` for "agent finished"/"needs input" with
  click-to-focus (`src/main/activity.ts:90-133`).
- **safeStorage** for the Linear API key at rest (`src/main/secrets.ts:67,81-82`), with
  plaintext fallback.
- **shell.openExternal / showItemInFolder / openPath** (`src/main/index.ts:426`,
  `src/main/logger.ts:122-124`, `src/main/self-tune.ts:142`).
- **clipboard.writeText** only (`src/main/login-browser.ts:49`); image paste deliberately
  reads bytes in the *renderer* via `navigator.clipboard` and spills to a temp file in main
  (`clipboard:saveImage`, `src/main/index.ts:900-915`) — a Wayland-focus-gating workaround.
- **App lifecycle/paths:** single-instance lock (`index.ts:1230-1246`), `app.getPath`
  (store/secrets/usage/self-tune/logs — all already overridable via `ORCHESTRA_HOME`),
  and the **Ozone platform relaunch dance** (`index.ts:36-90`) which exists *only because*
  of Electron/Chromium Wayland selection.
- **Not used at all** (grep-verified): Tray, nativeTheme, powerMonitor, globalShortcut,
  custom protocols, nativeImage, BrowserView/WebContentsView, autoUpdater (releases install
  via script), crashReporter, vibrancy.

### 2.2 The hard-to-replace pieces

1. **Embedded OAuth browser with per-account persistent session partitions + UA rewriting**
   (`src/main/login-browser.ts:35-38,64-77`: `session.fromPartition('persist:claude-login-<id>')`,
   UA stripped of `Electron/Orchestra` tokens so Google OAuth accepts the window). This is
   the backbone of multi-account login. Any native port needs an embedded browser engine
   with isolated cookie jars (WebKitGTK/QtWebEngine/CEF) — or a redesign around the system
   browser + loopback OAuth.
2. **`app.getAppMetrics()`** (`src/main/resources.ts:137`) — Chromium per-process metrics
   for the Resources page; a native port re-samples `/proc` (the file already does this for
   agent processes, so this is small).
3. **CDP remote debugging** (`index.ts:284-288`) — the project's whole E2E/verify tooling
   drives the app over CDP; a native port loses this harness and needs a replacement
   (toolkit-specific accessibility/automation APIs).

### 2.3 What survives any migration untouched

The heavy business logic is already Electron-free Node: the PTY layer over node-pty with a
transport abstraction (`src/main/pty.ts`, `src/main/transport/`), git operations
(`src/main/git.ts`, ~43K), the hooks/socket server (`src/main/hooks-server.ts`) and the
`orchestra` CLI (pure Node, built separately), the events spool, the JSON store, and the
136K `workspaces.ts` engine. `src/shared/` is deliberately Electron-free and tested with
`node --test`. **The migration cost is not the backend — it is the renderer (React 19 +
Zustand + xterm.js/WebGL + Monaco) and the 83+22-channel bridge.**

### 2.4 Renderer stack facts that price the migration

- xterm.js 5.5 with **webgl**, fit, unicode11, web-links addons
  (`src/renderer/components/Terminal.tsx:6`), plus app-level work already invested in it:
  RAF-batched writes (`src/renderer/term-write-queue.ts`), a bundled mono symbol-font
  subset, SIGWINCH repaint-bounce healing.
- **Monaco** (`@monaco-editor/react`) powers diff/code viewing — DOM-only; it does not
  exist outside a web view. A native port must replace it (GtkSourceView/QScintilla/custom),
  which is a real feature rebuild, not a swap.
- ~113K of hand-written CSS (`src/renderer/styles.css`) and a 30K `App.tsx` — the chrome UI
  is substantial and 100% web-tech.

---

## 3. Candidate native stacks

For each stack: how it would host a native terminal surface, how much of Orchestra's
React/web skill investment survives, Wayland maturity, and an effort estimate. (Research
snapshot 2026-07-18; last-commit/maintenance claims checked live against GitHub/GitLab.)

### 3.1 GTK4 (+ Relm4/Blueprint) — the strongest native host

**Terminal embedding path — three viable tiers:**

1. **VTE (vte-2.91-gtk4) today.** Actively maintained (GNOME GitLab activity 2026-07-17)
   and — the headline — **GPU-assisted since VTE 0.76** (GNOME 46, March 2024): drawing is
   delegated to GTK4's GSK GL/Vulkan scene-graph renderers, frame updates moved from a
   ~20-30 FPS cap to the GdkFrameClock, throughput roughly doubled
   ([maintainer announcement](https://discourse.gnome.org/t/terminal-and-vte-news/20030),
   [Phoronix](https://www.phoronix.com/news/GNOME-Terminal-GTK4-WIP)). GNOME's **Ptyxis**
   demonstrates vte4+GSK handling "massive amounts of text" smoothly. Not benchmark-equal
   to Ghostty's dedicated glyph-atlas renderer, but structurally it eliminates exactly
   Orchestra's known xterm.js pain (JS-heap renderer thread, RAF-batched `term.write`
   workarounds — see `src/renderer/term-write-queue.ts`).
2. **libghostty as a GTK widget, later.** Ghostty's own Linux app *is* a GTK4 app (Zig
   against the GTK4 C API) consuming the core in-process, with real custom GObject widgets
   since the 2025 [GTK rewrite](https://mitchellh.com/writing/ghostty-gtk-rewrite) — and
   Mitchell's roadmap explicitly promises future "GTK widgets… that handle the entire
   terminal view" ([Libghostty Is Coming](https://mitchellh.com/writing/libghostty-is-coming)).
   Not consumable today (§1), but GTK4 is the **only toolkit with an announced official
   libghostty widget target**. A GTK4 shell is the one bet that converges with Ghostty's
   own architecture.
3. **Custom widget over libghostty-vt now.** Adopt the VT engine (usable today, C API) and
   draw with GSK — the [ghostling](https://github.com/ghostty-org/ghostling) MVP terminal
   shows the shape of this. Real work (glyph atlas, IME, selection), but the hard 20% —
   VT correctness — is Ghostty's code.

**Foreign-GPU-surface compositing:** GTK4 has the best story of any toolkit here:
GtkGLArea (FBO into scene graph), `GdkGLTextureBuilder`/`GdkDmabufTextureBuilder`
(externally rendered texture/dmabuf as a paintable), and **GtkGraphicsOffload** (GTK 4.14+,
Wayland-only): child dmabuf content is placed on a **Wayland subsurface**, bypassing GSK
for compositor direct scanout ([Introducing graphics offload](https://blog.gtk.org/2023/11/15/introducing-graphics-offload/),
[revisited](https://blog.gtk.org/2024/04/17/graphics-offload-revisited/)). This is the
natural zero-copy path a libghostty GTK widget would use.

**Chrome UI:** GtkListView/GtkColumnView/GtkTreeListModel cover the virtualized custom-cell
sidebar; **GtkSourceView 5** (active, GTK4-native) covers syntax-highlighted diff viewing;
charts/dashboards are the gap (hand-rolled GSK/Cairo or [plotters-gtk4](https://lib.rs/crates/plotters-gtk4)).
**Relm4** is mature and active (0.11.0, 2026-04-08; repo pushed 2026-07-17) and accepts
Blueprint markup in its component templates.

**React reuse: none.** Full renderer rewrite (App.tsx 30K, styles.css 113K, Monaco diff
viewer replaced by GtkSourceView). Zustand-store *shape* and all main-process logic survive.

**Wayland: first-class** (this is GNOME's native toolkit; fractional scaling, dmabuf
offload). **macOS: the honest weak spot** — the Quartz backend works but maintainers have
discussed demoting macOS to "best effort" ([Phoronix forums](https://www.phoronix.com/forums/forum/software/bsd-mac-os-x-hurd-others/1398080-gtk-support-for-macos-potentially-moving-back-to-best-effort-approach/page4));
non-native feel, self-supported packaging. Ghostty's own answer to this is a *separate
Swift/AppKit frontend* on macOS — a native-Orchestra would eventually face the same fork.

**Effort estimate: a full UI rewrite** — roughly the entire renderer plus the preload
bridge re-plumbed onto GTK signals; main-process logic ports mostly intact (§2.3). Order
of months of focused work, not weeks; the OAuth embedded-browser feature additionally
needs WebKitGTK with per-account `WebKitWebsiteDataManager`s (feasible — WebKitGTK
supports isolated data managers — but new code).

### 3.2 Qt 6 / QML

**Terminal embedding:** the weak point — **no maintained GPU-native terminal widget exists
for Qt.** Options: `qtermwidget` (lxqt) is Qt6-ported and maintained (2.0.0 May 2024, repo
pushed 2026-07-16) but is the old Konsole-derived **CPU/raster-painted QWidget**;
QMLTermWidget is semi-maintained/niche; Konsole's KPart is maintained but drags in KDE
Frameworks and is GPL (embedding it likely GPLs the app). A GPU path means a from-scratch
**QQuickRhiItem** (Qt 6.7+; QQuickFramebufferObject is legacy GL-only) over
alacritty_terminal or libghostty-vt — entirely custom, and Ghostty has announced GTK
widgets and Swift frameworks, **no Qt target**.

**Foreign GPU surface:** QQuickRhiItem / `vulkantextureimport`-style external-texture
wrapping works, but there is no Wayland-subsurface zero-copy offload equivalent to
GtkGraphicsOffload — everything composites through Qt's render loop.

**Chrome UI:** excellent — QML ListView/TreeView delegates, KSyntaxHighlighting (LGPL,
tier-1 KF6) for diffs, KQuickCharts/QtGraphs for dashboards (better chart story than GTK).

**Platforms:** Qt is a first-class native Wayland client with true fractional scaling, and
**wins macOS decisively** (native-mimicking Quick Controls style, Metal-by-default RHI).
**Licensing:** LGPLv3 dynamic linking is workable for a distributed app but carries real
obligations (relink rights, notices). **Bindings:** C++ is the paved road; KDAB's cxx-qt
(active, pre-1.0) is the credible Rust path; PySide is wrong-shaped for this app.

**React reuse: none.** Effort: same order as GTK (full UI rewrite) *plus* building the
terminal widget yourself — the terminal is *more* work than GTK, the rest slightly less.

### 3.3 Tauri v2 — a dead end for this goal

Tauri deserves a precise burial since "lighter Electron" comes up naturally:

- **Same architecture, worse engine.** Every findable Tauri terminal (incl. post-2024:
  tauri-terminal, Terminon, maiterm, terax) is **xterm.js in the webview** — Tauri buys
  nothing for terminal rendering. On Linux the webview is **WebKitGTK**, with recurring
  performance/stability regressions ([tauri#7021](https://github.com/tauri-apps/tauri/issues/7021),
  ["Webkit is totally unstable"](https://github.com/tauri-apps/tauri/discussions/8524)) and
  WebGL landing on slow paths ([Tauri's own Linux-graphics debug page](https://v2.tauri.app/develop/debug/linux-graphics/)) —
  and xterm.js's fast path *is* WebGL. On Asahi (WebKitGTK + Mesa/AGX) this is the
  least-tested combination available.
- **Native-surface compositing inside the webview does not work on Linux.** The wanted
  pattern is tracked in [tauri#8246](https://github.com/tauri-apps/tauri/issues/8246) and
  [discussion #11944](https://github.com/tauri-apps/tauri/discussions/11944): solved-ish on
  macOS via Cocoa layer hacks, crashes on Windows, **no documented Linux solution**. Naive
  raw-handle sharing makes wry and wgpu fight for the surface
  ([tauri#9220](https://github.com/tauri-apps/tauri/issues/9220)). Structurally, WebKitGTK's
  web process renders to DMA-BUFs that the UI process draws as a GTK-widget texture
  ([Igalia](https://blogs.igalia.com/carlosgc/2023/04/03/webkitgtk-accelerated-compositing-rendering/)) —
  the webview is not a subsurface you can slide content under; there is no hole-punching
  primitive.
- **The GTK3 trap.** wry/Tauri on Linux is GTK3 (webkit2gtk-4.1). Ghostty's world —
  including any future libghostty GTK widget — is GTK4, and GTK3/GTK4 cannot coexist in one
  process. So even when the libghostty widget ships, a Tauri app *cannot host it*.
- Hand-rolled `wl_subsurface` under the GTK3 window: see §4.2 — no shipped prior art
  (mpv has wanted this for 12 years), and input routing must be rebuilt by hand.

**React reuse: full** — which is exactly why it solves nothing here: it's the same web
terminal in a worse engine. Not a candidate for the stated goal.

### 3.4 Flutter (Linux desktop)

- **Platform views on Linux: hard no** — [flutter#41724](https://github.com/flutter/flutter/issues/41724)
  open since 2019, community PR never merged.
- **The one real mechanism:** the Linux embedder's external-texture path
  (`FlTextureGL`/`FlTextureRegistrar` + the `Texture` widget) — a native renderer draws
  into a GL texture that Flutter composites ([embedder docs](https://api.flutter.dev/linux-embedder/fl__texture__gl_8cc.html),
  [working example](https://github.com/alnitak/flutter_opengl)). Credible *only after*
  libghostty ships its "give us a GL surface" renderer lib (§1.3, not shipped); and input,
  IME, scrollback interaction all must be rebuilt in Dart. Not zero-copy; GL-texture path
  has had breakage ([flutter#150668](https://github.com/flutter/flutter/issues/150668)).
- Flutter's ecosystem answer today is [xterm.dart](https://github.com/TerminalStudio/xterm.dart) —
  a pure-Dart terminal, i.e. the same "reimplement the terminal in the UI framework"
  pattern as xterm.js, Skia/Impeller-rendered.
- Stock Linux embedder is GTK3-based; Wayland only via GTK's backend; first-class Wayland
  embedders are third-party (Sony's embedded-Linux embedder). macOS platform views
  (`AppKitView`) officially exist but the docs say support "isn't fully functional" (no
  gestures).

**React reuse: none** (full Dart rewrite — and of the backend bridge too, since the Node
main process would have to become a sidecar). Weakest overall fit: rewrite everything *and*
still no native terminal.

### 3.5 Rust-native toolkits (egui, iced, Slint, gpui)

- **egui** — well-trodden for tool UIs; custom GPU content is first-class
  (`PaintCallback` + egui_wgpu). But IME is a known weak spot (long-running CJK/IME issues:
  [#248](https://github.com/emilk/egui/issues/248), [#3060](https://github.com/emilk/egui/issues/3060),
  fcitx5 [#2529](https://github.com/emilk/egui/issues/2529)) — disqualifying for an app
  whose core widget is a text input surface. [egui_term](https://github.com/Harzu/egui_term)
  (alacritty_terminal backend) exists but self-describes as under development.
- **iced** — 0.14 (Dec 2025), pre-1.0 but proven at scale by COSMIC; excellent Wayland;
  purpose-built `widget::shader` for custom GPU content;
  [iced_term](https://github.com/Harzu/iced_term) works (selection, hyperlinks). Biggest
  disqualifier: accessibility — [#552](https://github.com/iced-rs/iced/issues/552) open
  since 2020, effectively no screen-reader support.
- **Slint** — the most product-grade (stable 1.x, a11y on by default, correct IME), but
  **no terminal widget** and the weakest custom-GPU story (wgpu integration still a feature
  request, [#4499](https://github.com/slint-ui/slint/issues/4499)); the declarative DSL
  fights a cell-grid renderer.
- **gpui (Zed's toolkit)** — the surprise contender. Now published on
  [crates.io](https://crates.io/crates/gpui) with `gpui_platform` for standalone apps
  (pre-1.0, frequent breakage); the Linux renderer was reimplemented on **wgpu**
  (merged Feb 2026, [zed#46758](https://github.com/zed-industries/zed/pull/46758)),
  explicitly citing third-party-app needs; IME-correct per the 2025 survey that flunked
  egui. Terminal pedigree is the strongest of the four: Zed's own embedded terminal
  (alacritty_terminal + TerminalElement) is copyable, and there is **direct prior art for
  exactly this study's goal**: [gpui-ghostty](https://xuanwo.io/2026/01-gpui-ghostty/)
  (Xuanwo, Jan 2026) — an embedded terminal for gpui apps built on **libghostty-vt**, with
  working htop/codex, selection, scrollback. Rust throughout also means the Node main
  process must be ported or run as a sidecar.
- Skip: xilem (alpha), makepad (niche). Worth knowing: **wezterm-term** is a richer
  embeddable VT core than alacritty_terminal (sixel/iTerm2 images, OSC 8;
  [README](https://github.com/wezterm/wezterm/blob/main/term/README.md)) usable from any
  of these.

**React reuse: none for all four.** Effort: gpui is the shortest credible path to a
GPU-native terminal in a Rust shell (terminal element copyable from Zed / gpui-ghostty),
but the platform is pre-1.0 and the chrome UI (sidebar, diff viewer, dashboards, dialogs)
is all hand-rolled — no SourceView/Monaco equivalent exists; a diff viewer is a from-scratch
build. Same months-scale rewrite as GTK, on a less stable base, with a better terminal
story.

### 3.6 Summary table

| Stack | Terminal path | React reuse | Wayland | macOS | Rewrite scope |
|---|---|---|---|---|---|
| **GTK4 (+Relm4)** | vte4 now (GPU via GSK); official libghostty widget *promised* | none | first-class + dmabuf offload | weak ("best effort") | full UI, months |
| **Qt6/QML** | CPU qtermwidget or from-scratch RhiItem; no Ghostty intent | none | first-class | **best native** | full UI + terminal widget, months |
| **Tauri v2** | xterm.js again (WebKitGTK, worse); GTK3 blocks future libghostty widget | full | poor engine on Asahi | ok | pointless for goal |
| **Flutter** | external GL texture only, after unshipped libghostty renderer; else xterm.dart | none | via GTK3 backend | platform views half-broken | full UI + backend bridge |
| **gpui** | alacritty_terminal (Zed-proven) or **gpui-ghostty** (libghostty-vt) today | none | wgpu renderer since 02/2026 | home turf | full UI + Rust backend, months |
| **egui / iced / Slint** | egui_term/iced_term (WIP) / none | none | good | ok | disqualified: IME / a11y / no terminal |

---

## 4. Incremental paths short of a rewrite

### 4.1 Compositing an external Ghostty window "inside" Electron — infeasible

Every mechanism was checked; the verdicts are structural, not maturity-related:

- **xdg-foreign**: the only operation is `set_parent_of` — transient-for stacking for
  out-of-process *dialogs*. It cannot reparent, position, or clip a foreign toplevel inside
  another window ([protocol](https://wayland.app/protocols/xdg-foreign-unstable-v2)).
- **XEmbed equivalent**: deliberately rejected by Wayland — "write an embedded Wayland
  compositor" is the official answer ([wprs#54](https://github.com/wayland-transpositor/wprs/issues/54),
  [2012 wayland-devel thread](https://lists.freedesktop.org/archives/wayland-devel/2012-February/002030.html)).
  No embedding protocol exists in wayland-protocols as of 1.43.
- **Cross-client wl_subsurface**: impossible by construction — Wayland objects are scoped
  to one client connection; a `wl_surface` cannot be passed between processes
  ([wayland-book](https://wayland-book.com/surfaces-in-depth/subsurfaces.html)).
- **Nested compositor** (the sanctioned pattern): the app links a Wayland *server* library
  (Smithay), hands a socket to the child Ghostty, and composites its dmabuf buffers as GPU
  textures. Real and shipping elsewhere — gamescope, ChromeOS's Sommelier,
  [emskin](https://github.com/emskin/emskin) (Wayland apps inside Emacs). **But it requires
  the host to own a GL/Vulkan context.** Inside Electron it is effectively blocked:
  Chromium provides no way to import a foreign dmabuf into the page compositor —
  Greenfield's workaround (video-encode every frame) shows what that costs. A nested
  compositor is a *payoff of* a native migration, not an Electron option.
- **Poor man's embedding** (float a real Ghostty over the pane rect via `swaymsg move/resize`):
  scriptable on sway, janky (focus, z-order vs dialogs, no clipping, drag lag), and
  **impossible on GNOME** (no positioning IPC without a shell extension) — Asahi Fedora's
  default desktop. No established project does this; it's why wezterm/Zellij multiplex
  in-window instead.

### 4.2 Session broker (tmux) — buildable today, high leverage

**This is the one incremental path that fully works.** Run each agent's PTY inside a tmux
session; Orchestra's xterm.js pane attaches as one client; "Open in Ghostty" runs
`ghostty -e tmux attach -t <session>`. The user gets *actual native Ghostty rendering* of
the live agent session whenever they want it, while Orchestra keeps its chrome, status
dots, and hooks untouched.

- **Precedent:** this is exactly iTerm2's tmux integration — a GUI mirroring a tmux session
  via [control mode (`-CC`)](https://github.com/tmux/tmux/wiki/Control-Mode), built for
  precisely this purpose. (A plain second client over a PTY is simpler than control mode
  and sufficient for v1.)
- **The crux — resize semantics:** with two clients attached, the default
  `window-size smallest` letterboxes the larger client. `window-size latest` (whichever
  client the user last touched wins) is the sane policy for a Claude Code TUI; the app's
  inactive pane just re-renders at the new size, which xterm.js tolerates. A control-mode
  client can additionally pin its reported size (`refresh-client -C`) to mirror without
  influencing geometry.
- **Alternatives rejected:** abduco/dtach have no per-client size model (dual attachment
  garbles TUIs); wezterm's mux protocol is private to wezterm; Ghostty itself deliberately
  has no daemon/mux.
- **Side benefits:** agent sessions survive Orchestra restarts/crashes (today a restart
  kills the PTY); sessions become inspectable from any terminal for debugging; and it
  de-risks any future native migration by making terminal sessions app-independent first.
- **Costs/risks (honest):** one more layer in the byte path (tmux's own VT state);
  tmux passthrough quirks for advanced sequences (synchronized output, OSC passthrough
  need `set -g allow-passthrough on`); scrollback semantics change (tmux owns history);
  per-agent tmux processes; and Orchestra's existing repaint/SIGWINCH healing logic
  interacts with tmux's redraw model and needs re-verification.

### 4.3 Improving xterm.js in place

The status quo is not maxed out, and one 2026 development changes the calculus:

- Orchestra already uses the WebGL addon, RAF-batched writes, and a bundled symbol font —
  the classic wins are taken. Remaining knobs: xterm.js `fastScrollModifier`/scrollback
  tuning, `ELECTRON_OZONE_PLATFORM_HINT=wayland` correctness (already handled,
  `src/main/index.ts:36-90`), and profiling actual frame times vs Ghostty rather than
  trusting perceived snappiness.
- **[coder/ghostty-web](https://github.com/coder/ghostty-web)**: an xterm.js-*compatible*
  web terminal from Coder built on the libghostty-vt **Wasm** build (§1.3). If its
  compatibility surface covers Orchestra's usage (fit/webgl/unicode11/web-links addons,
  `term-write-queue` batching), this is a drop-in-shaped experiment that swaps the VT
  engine for Ghostty's actual parser while keeping Electron, React, and all app code.
  It would fix fidelity-class issues (parsing edge cases, unicode) though *not* the
  fundamental "JS renderer in a Chromium compositor" latency class.

---

## 5. Ranking: effort × risk × payoff

| # | Option | Effort | Risk | Payoff |
|---|---|---|---|---|
| 1 | **tmux session broker + "Open in Ghostty"** | days–2 weeks | low (additive; feature-flag per workspace) | high: real Ghostty on demand, session durability, migration de-risk |
| 2 | **xterm.js tuning + evaluate ghostty-web** | days | low | medium: fidelity wins; latency class unchanged |
| 3 | **GTK4 rewrite (vte4 now → libghostty widget when tagged)** | months | medium-high (OAuth rebuild on WebKitGTK, Monaco→SourceView, CDP E2E harness lost, macOS story bad) | high on Linux: truly native terminal + lighter footprint |
| 4 | **gpui rewrite (gpui-ghostty / alacritty_terminal)** | months | high (pre-1.0 toolkit, all chrome hand-rolled, Node backend ported/sidecar'd) | high: best terminal DNA, macOS strong |
| 5 | **Qt/QML rewrite** | months+ | medium | medium: best macOS/chrome, but the terminal itself is the part you'd build from scratch |
| 6 | **Tauri / Flutter** | — | — | ruled out for the stated goal (§3.3, §3.4) |
| 7 | **External-window compositing on Electron** | — | — | infeasible on Wayland by design (§4.1) |

## 6. Recommendation

**A full native migration is not worth starting today.** The premise — "embed libghostty
as a first-class widget" — is not yet purchasable: on Linux, libghostty exposes only the
VT engine (no renderer, no widget, no tagged release, unstable API), the official GTK4
widget is merely "under consideration," and the announced GPU-renderer library has no
date (§1). Meanwhile the migration cost is dominated not by Electron's main-process
surface (thin, §2.1) but by rebuilding the entire renderer — 113K of CSS, Monaco, the
sidebar/dashboards — plus two genuinely hard losses: the per-account embedded OAuth
browser (§2.2) and the CDP-driven E2E harness this project's whole verification culture
runs on. Betting months of rewrite on an unstable dependency to fix a terminal-feel
problem is bad sequencing.

**Do instead, in order:**

1. **Ship the tmux session broker (§4.2).** Smallest meaningful experiment: put *one*
   workspace's agent PTY inside `tmux new -s orch-<ws> -x… -y…` with
   `window-size latest` + `allow-passthrough on`, keep xterm.js attached through the
   existing pty.ts transport, and add an "Open in Ghostty" action that spawns
   `ghostty -e tmux attach -t orch-<ws>`. This delivers the actual desire — Claude Code in
   real Ghostty — in days, and every hour spent is also insurance (session durability,
   app-independence) rather than a bet.
2. **Benchmark honestly + trial ghostty-web (§4.3).** Measure xterm.js frame times/input
   latency against native Ghostty on the same TUI; separately, prototype
   coder/ghostty-web in one pane. This tells us whether the pain is parsing-fidelity
   (ghostty-web fixes it in place) or compositor latency (only native fixes it).
3. **Re-evaluate native when the ecosystem moves.** Concrete triggers worth a fresh look:
   a tagged libghostty release; the libghostty-gtk4 widget moving from "under
   consideration" to shipped; or the promised GPU-renderer lib landing. When that
   happens, **GTK4 + Relm4 is the recommended target** (converges with Ghostty's own
   Linux architecture, unique dmabuf/subsurface offload path, vte4 as interim), with
   gpui the runner-up if the Zed ecosystem stabilizes `gpui_platform` first — and with
   the explicit acceptance that macOS then means a second frontend (Qt being the only
   single-codebase macOS-strong option, at the price of building the terminal widget
   ourselves).

**Uncertainty flags:** libghostty timelines are the project's own statements and have
already slipped once (6-month tag target missed); the "GTK widget" is an intention, not a
commitment. ghostty-web's addon-compatibility depth is unverified — the trial in step 2
is cheap precisely to test it. Perceived snappiness differences between Ghostty and
xterm.js were not measured in this study; step 2 exists to replace impression with data.

---

*Method note: ecosystem claims above were gathered 2026-07-18 via web research with inline
citations; repo claims were verified against source at the cited `file:line` anchors
(v0.5.84, branch `native-ui-ghostty-feasibility`). Key primary sources: Mitchell
Hashimoto's [libghostty announcement](https://mitchellh.com/writing/libghostty-is-coming)
and [GTK-rewrite post](https://mitchellh.com/writing/ghostty-gtk-rewrite), the
[Ghostty 1.3.0 release notes](https://ghostty.org/docs/install/release-notes/1-3-0),
[ghostty-org/ghostty discussion #11722](https://github.com/ghostty-org/ghostty/discussions/11722),
the [libghostty C API docs](https://libghostty.tip.ghostty.org), GTK's
[graphics-offload posts](https://blog.gtk.org/2023/11/15/introducing-graphics-offload/),
the [tmux control-mode wiki](https://github.com/tmux/tmux/wiki/Control-Mode), and the
Wayland [xdg-foreign protocol](https://wayland.app/protocols/xdg-foreign-unstable-v2).*

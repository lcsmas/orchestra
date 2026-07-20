# UI-RPC Protocol v1 (frozen contract)

*The wire contract between an Orchestra backend (Electron app or daemon) and
UI frontends (the GTK app, tests). Changes to this document after M1 starts
require an orchestrator-approved contract PR that updates BOTH sides plus the
conformance fixtures atomically. See `docs/gtk4-port-plan.md` §2/§11.*

## 1. Transport & discovery

- Unix domain socket, mode 0600. Path: `$XDG_RUNTIME_DIR/orchestra-ui-<pid>.sock`.
- Pointer file `~/.orchestra/ui-sock` (respects `$ORCHESTRA_HOME`) contains the
  absolute socket path; env `ORCHESTRA_UI_SOCK` overrides discovery.
- The backend serves N concurrent clients. Disconnect is stateless for the
  backend (no session resume; the client re-hydrates via list/get methods,
  exactly like the Electron renderer does on reload).

## 2. Framing

Base: the `sandbox-protocol.ts` model — `[u32 BE length][payload]`, max frame
16 MiB. Payload discrimination by first byte:

- `0x7B` (`{`) → **JSON frame**, UTF-8, one JSON object.
- `0x01` → **ptyData** (S→C): `[0x01][u32 BE idLen][id UTF-8][raw bytes…]`
- `0x02` → **ptyWrite** (C→S): same layout. Equivalent to a `pty:write` req
  (no response); the JSON method also remains valid.

## 3. JSON frames

| `t` | Dir | Fields |
|---|---|---|
| `hello` | C→S | `proto: 1`, `appVersion: string`, `clientKind: 'gtk'\|'electron'\|'test'`, `focused: boolean` |
| `helloOk` | S→C | `proto: 1`, `appVersion`, `backendKind: 'electron'\|'daemon'` |
| `req` | C→S | `id: number` (client-scoped, monotonic), `method: string`, `params: unknown[]` |
| `res` | S→C | `id`, `ok: true`, `result: unknown` — or `ok: false`, `error: { message: string, name?: string }` |
| `event` | S→C | `channel: string`, `args: unknown[]` |
| `focus` | C→S | `focused: boolean` — backend's `focused` flags on notifications use OR over all clients |
| `ping` / `pong` | both | `{}` — either side may ping; reply within 5 s; 15 s idle triggers ping |

Version negotiation: `proto` mismatch → backend replies
`{t:'helloOk', proto: <its own>, …}` and the CLIENT decides to disconnect
with a user-facing error. `appVersion` mismatch is a warning, not fatal.

## 4. Methods

**The method set is `OrchestraAPI` in `src/shared/ipc.ts` — verbatim.** Method
name = the interface member name (NOT the internal ipcMain channel). `params`
is the positional argument list; `result` is the resolved return value; a
rejected promise maps to `ok:false` with the error message. Types are the
TypeScript shapes in `src/shared/types.ts` / `self-tune.ts` / `resources.ts` /
`worktree-sizes.ts`, serialized as their natural JSON.

Deviations from the interface (exhaustive):

| Member | Status over RPC |
|---|---|
| `pickDirectory` | NOT served — frontend-local (native file chooser) |
| `openExternal` | served, but frontends SHOULD open locally (gtk::show_uri) and may skip the call |
| `saveClipboardImage` | served; `bytes` param travels as base64 string in JSON (only large-payload req; ≤ 16 MiB frame cap applies) |
| all `on*` members | not methods — they are the event channels below |

### Tree-shape methods (promote / demote / re-parent)

Three members re-shape the workspace tree. They exist on the socket/CLI side as
`dispatchPromoteRequest` / `dispatchDemoteRequest` / `dispatchAttachRequest`,
which answer an `{ ok, error }` envelope — **that envelope does not reach the
wire.** The api-handler unwraps it: a failure becomes a rejected promise (so it
arrives as frame-level `ok:false` with the message), and success resolves the
freshly-read `Workspace`, letting a caller assert the transition it asked for.
A result carrying `{ ok: … }` would be a second, redundant error channel.

| Method | Params | Result | Rejects when |
|---|---|---|---|
| `promoteWorkspace` | `[id]` | updated `Workspace` | unknown id |
| `demoteWorkspace` | `[id]` | updated `Workspace` | unknown id; workspace is `kind:'orchestrator'` (repo-less by nature — delete it instead) |
| `setWorkspaceParent` | `[id, parentId \| null]` | updated `Workspace` | unknown id or parent; parent cannot orchestrate; self-parent or a cycle |

All three are idempotent. Promotion has two routes, and the distinction is
observable on the returned record: a `kind:'scratch'` workspace becomes
`kind:'orchestrator'`, while a git worktree KEEPS `kind:'worktree'` and gains
`canOrchestrate: true` — so it retains diff/merge/PR/branch handling while also
parenting children. Consumers deciding "can this parent others?" must therefore
check `kind === 'orchestrator' || canOrchestrate === true`, never the kind alone
(`Workspace::can_orchestrate()` in orchestra-rpc). `demoteWorkspace` clears only
the capability, and detaches any children first — a `parentId` pointing at a
non-orchestrator would render nowhere, since the sidebar walks trees from
orchestrator roots.

Added methods (not in OrchestraAPI yet; backend adds in M1):

| Method | Params | Result |
|---|---|---|
| `deps:status` | `[]` | `{ git: boolean, gh: boolean, claude: boolean, messages: string[] }` |
| `app:info` | `[]` | `{ version, backendKind, orchestraHome, logPath }` |

## 5. Event channels

Every `on<Name>` member of `OrchestraAPI` is an event channel; the wire
channel string is the member name without the `on` prefix, camelCase preserved
(e.g. `onWorkspaceUpdate` → `workspaceUpdate`), `args` = the callback's
positional args. All events broadcast to every connected client.

Added channels (M1):

| Channel | Args | Purpose |
|---|---|---|
| `uiNotify` | `[{ wsId, kind: 'finished'\|'needsInput', title, body }]` | native-notification data for non-Electron frontends; emitted alongside (not instead of) the existing Electron Notification when clientKind gtk is attached |
| `accountsLoginUrl` | `[{ accountId, url }]` | claude-auth URL for the frontend-side OAuth window (GTK). Backend still applies `isClaudeAuthUrl` gating; non-auth URLs never arrive here |

## 6. PTY streams

- Backend → client: every PTY output chunk (post-coalescing, same 8 ms/64 KiB
  cadence the Electron renderer sees) as `ptyData` binary frames. All PTY ids
  use today's scheme: `<wsId>`, `<wsId>:run`, `<wsId>:nvim`,
  `account-login:<accountId>`.
- No subscription model in v1: all clients receive all PTY data (same trust
  domain; bandwidth is trivial on a local socket). Revisit only if profiling
  says otherwise.
- `pty:exit`, `pty:restart`, `pty:stopped` remain JSON events (channels
  `ptyExit`/`ptyRestart`/`ptyStopped`, args per ipc.ts).
- Scrollback replay: client calls `readScrollback`… — NOTE: `OrchestraAPI`
  has no readScrollback member (the Electron renderer receives replay via its
  own channel path). M1 adds method `pty:scrollback` `[id] → string`
  (base64) mapping to `readScrollback` in `pty.ts`. Run-script scrollback
  already exists as `runScriptScrollback`.

## 7. Conformance fixtures

`scripts/dump-rpc-fixtures.ts` (M1, A1) produces
`native/orchestra-rpc/fixtures/*.json`: for each method a
`{method, params, result}` capture against the seeded test store, plus one
capture per event channel. `orchestra-rpc`'s tests deserialize every fixture
into the typed structs and re-serialize losslessly (unknown-field tolerance
on, missing-optional tolerance on). CI regenerates fixtures and fails on
uncommitted drift.

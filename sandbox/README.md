# Orchestra agent sandbox

A reproducible Docker image that serves as the **always-on execution
environment** for a Claude Code (`claude`) agent. The container boots straight
into the Orchestra shim (WS + admin HTTP on `:8787`); the Orchestra app then
**imports** a workspace into it once — shipping the git checkout to a
container-owned `/workspace` — and thin clients on any machine attach and
stream the terminal. Credentials are injected at runtime.

## What's inside

| Tool | Source | Notes |
|------|--------|-------|
| Node.js 22.x + npm | `node:22-bookworm` base | |
| bun | official `bun.com/install` script | static binary in `~/.bun/bin` |
| Python 3.13 | `uv python install 3.13` | `python` / `python3` symlinked on PATH |
| uv | official `astral.sh/uv` installer | in `/usr/local/bin` |
| git | Debian bookworm | |
| GitHub CLI (`gh`) | official `cli.github.com` apt repo | |
| PostgreSQL client (`psql`) | official PGDG apt repo (v17) | |
| neovim | Debian bookworm | set as `$EDITOR` |
| Claude Code (`claude`) | official `claude.ai/install.sh` native installer | in `~/.local/bin` |
| Orchestra shim | built from `shim/` (this dir) | compiled to `/opt/orchestra/shim/dist`, see below |

The image contains **no secrets**. All credentials are injected at container
start (see below).

## The shim

`shim/` holds the **Orchestra sandbox shim** — the sandbox-side terminator of
the single Orchestra↔sandbox connection (project phase P3). When the agent runs
remotely instead of on the user's machine, three things the Orchestra app used
to do locally have a network between them and the agent; the shim does all three
*inside* the container and relays them home over one WebSocket:

1. **Terminal** — on a `spawn` frame it starts `claude` as a PTY in `/workspace`
   and relays `data`/`exit`, applying `write`/`resize`/`kill`. (Mirrors the
   app's `pty.ts` + `local-pty.ts`.)
2. **Activity** — it tails `$ORCHESTRA_EVENTS_DIR/<wsid>.jsonl` (the agent's
   hooks append one event line per lifecycle event) and emits one `event` frame
   per line. (Mirrors `events-spool.ts`.)
3. **Hook control plane** — it serves the unix socket at `$ORCHESTRA_SOCK` that
   the agent POSTs to, forwarding the five routes (`rename` `spawn` `peers`
   `read` `message`) to the host as `rpc` frames and returning the host's
   `rpcReply` as the HTTP response. (Mirrors `hooks-server.ts`.)
4. **Provisioning (admin HTTP, same port)** — `GET /healthz` reports liveness +
   whether `/workspace` is provisioned; `POST /import` receives the one-way
   "import to sandbox" payload (a tgz of `meta.json` + `repo.bundle` +
   `worktree/` overlay), clones the bundle into `/workspace`, checks out the
   branch, repoints `origin`, and lays the overlay (uncommitted changes + the
   `.orchestra`/`.claude` hook dirs) on top. One container owns ONE workspace —
   a second import is refused with 409. (`shim/shim-import.ts`.)

The wire vocabulary and framing come from `src/shared/sandbox-protocol.ts`; a
byte-identical copy is **vendored** into `shim/sandbox-protocol.ts` so the shim
builds from this directory as a self-contained Docker context. Keep it in sync:

```bash
node sandbox/shim/sync-protocol.mjs          # regenerate the vendored copy
node sandbox/shim/sync-protocol.mjs --check  # CI gate: fail if it has drifted
```

The image builds the shim in-place (so `node-pty` compiles for the image's
platform) to `/opt/orchestra/shim/dist`. Build and run it standalone with:

```bash
cd sandbox/shim && npm install && npm run build && npm start
```

It listens on `ORCHESTRA_SHIM_PORT` (default `8787`); the host's transport
(Tailscale to a home server, direct TLS to a VPS) terminates the outer TLS and
connects to it. Local dev/test of the pure helpers: `npm run check-protocol` and
`node --test --experimental-strip-types sandbox/shim/shim-core.test.ts`.

## Build

```bash
docker build -t orchestra-sandbox sandbox/
```

The build is ordered least-changing-layer-first (OS packages → gh → psql →
python → user → bun → claude) so rebuilds cache well.

## Run

The image runs as a non-root user `agent` (UID 1001) with home `/home/agent`.
The working directory is `/workspace`. The **default command is the shim** —
an unadorned `docker run` gives you an always-on sandbox waiting for an
Orchestra client:

```bash
docker run -d --restart unless-stopped \
  -p 8787:8787 \
  -v sandbox-workspace:/workspace \
  -v sandbox-home:/home/agent \
  -e GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx \
  --name my-sandbox \
  orchestra-sandbox
```

**Use named volumes for `/workspace` and `/home/agent`** (as above). The
container-owned checkout and the agent's Claude state live there; without
volumes, *recreating the container — e.g. to upgrade the image — destroys the
checkout and any unpushed work*. With volumes, a new container picks up right
where the old one left off.

Then in Orchestra, use a workspace row's **Import to sandbox** action and give
it the endpoint (`ws://sandbox-host:8787`). The app ships the checkout to the
container (`POST /import`), **seeds the container's `~/.claude` with the
workspace's login/config** — the pinned account's OAuth credentials,
`.claude.json` (your MCP servers), `settings.json`, `CLAUDE.md`, skills,
agents and commands — retires the local worktree (moved to
`~/.orchestra/trash/`, not deleted), and streams the terminal from the sandbox
from then on. The manual credentials mount of older setups is no longer
required (it still works and takes precedence if you prefer it). Check a
sandbox from the shell with `curl http://sandbox-host:8787/healthz`.

> **Security:** the shim has **no authentication** — anyone who can reach the
> port can attach, take control, import, or **export** (the payloads carry your
> code and, for import, your Claude OAuth credentials in transit). Only expose
> it on a private network you trust end-to-end (Tailscale/WireGuard) or behind
> TLS with access control. Never publish the port to the open internet.

### Backups and returning work to a machine (fail-safe)

After import the container holds the only copy of unpushed work. Two safety
nets, both built on the shim's `GET /export` (the inverse of import — a bundle
+ dirty-file overlay of `/workspace`):

- **Automatic backups.** Orchestra snapshots each sandbox workspace to
  `~/.orchestra/backups/<workspace-id>/` right after import and every 30 min
  after (`ORCHESTRA_SANDBOX_BACKUP_MINUTES` to change), keeping the last 5. A
  lost sandbox costs at most one interval of work. The named `/workspace`
  volume above is the first line of defense; these backups are the second, and
  live on your own machine.
- **Return to this machine (eject).** A sandbox workspace's **⬇ Return to this
  machine** action pulls a live export, saves it as a backup, and restores the
  workspace to a local worktree (history + uncommitted changes + hooks) — the
  import is fully reversible. The container keeps its copy; its agent is
  stopped.

You can also `curl http://sandbox-host:8787/export -o backup.tgz` for a manual
snapshot from any machine that can reach the shim.

### The `/workspace` cwd convention (important)

Claude Code keys its session state and conversation history by the **absolute
path of its current working directory**. The container-owned checkout therefore
always lives at the **same** path — `/workspace` (created by the import) — so
that session resumption (`claude --continue` / `--resume`) finds prior
sessions started in the container. In the legacy manual flow you can instead
mount a host worktree there (`-v /host/path/to/worktree:/workspace`), but never
change the in-container path between runs.

### Authentication: two mutually-exclusive options

Claude Code can authenticate either with an Anthropic API key **or** with
claude.ai OAuth credentials. Pick one:

**Option A — `ANTHROPIC_API_KEY` (Console/API billing).**

```bash
-e ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx
```

**Option B — mount claude.ai OAuth credentials (Pro/Max plan).** Mount your
host `~/.claude/.credentials.json` into the agent's home:

```bash
-v "$HOME/.claude/.credentials.json:/home/agent/.claude/.credentials.json:ro"
```

> **MCP / claude.ai connectors:** setting `ANTHROPIC_API_KEY` **disables**
> claude.ai MCP connectors. If you need MCP connectors, use **Option B**
> (mount the OAuth creds) and do **NOT** set `ANTHROPIC_API_KEY`.

### Git / GitHub credentials (runtime-injected)

`gh` reads `GH_TOKEN` (or `GITHUB_TOKEN`); git operations over HTTPS can reuse
it via `gh auth setup-git`, or you can mount an SSH key / `.gitconfig`:

```bash
-e GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx \
-v "$HOME/.gitconfig:/home/agent/.gitconfig:ro" \
-v "$HOME/.ssh:/home/agent/.ssh:ro"
```

### Full example invocation

Using **Option A** (API key) plus a worktree mount:

```bash
docker run --rm -it \
  -v /host/path/to/worktree:/workspace \
  -e ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx \
  -e GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx \
  -v "$HOME/.gitconfig:/home/agent/.gitconfig:ro" \
  orchestra-sandbox \
  claude
```

Using **Option B** (claude.ai OAuth, MCP connectors enabled) — note the absence
of `ANTHROPIC_API_KEY`:

```bash
docker run --rm -it \
  -v /host/path/to/worktree:/workspace \
  -v "$HOME/.claude/.credentials.json:/home/agent/.claude/.credentials.json:ro" \
  -e GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx \
  -v "$HOME/.gitconfig:/home/agent/.gitconfig:ro" \
  orchestra-sandbox \
  claude
```

You can also keep all the env vars in a file and pass `--env-file`:

```bash
docker run --rm -it \
  --env-file ./secrets.env \
  -v /host/path/to/worktree:/workspace \
  orchestra-sandbox \
  claude
```

> All secret values above are **placeholders**. Never bake real keys into the
> image or commit them to a file that ends up in the build context (the
> `.dockerignore` restricts the context to the `Dockerfile` and the shim
> source — no host files or secrets).

### Persisting Claude state across runs

To keep Claude's settings, project history and (when using Option B) credentials
between containers, mount a persistent host directory at the agent's `~/.claude`:

```bash
-v /host/path/to/claude-home:/home/agent/.claude
```

## Smoke test

```bash
docker run --rm orchestra-sandbox bash -lc \
  'node --version; bun --version; python3 --version; uv --version; \
   git --version; gh --version; psql --version; \
   nvim --version | head -1; claude --version'
```

`claude --version` works without any auth.

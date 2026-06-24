# Orchestra agent sandbox

A reproducible Docker image that serves as the execution environment for a
Claude Code (`claude`) agent running inside a git worktree. The Orchestra
Electron app `docker run`s this image, mounts a worktree at `/workspace`,
injects credentials at runtime, and streams the container's terminal.

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
The working directory is `/workspace`.

### The `/workspace` cwd convention (important)

Claude Code keys its session state and conversation history by the **absolute
path of its current working directory**. The host must therefore always mount
the worktree at the **same** path inside the container — `/workspace` — so that
session resumption (`claude --continue` / `--resume`) finds the prior session.
If you mount the worktree at a different path between runs, Claude treats it as
a brand-new project and you lose continuity. Always:

```
-v /host/path/to/worktree:/workspace
```

and let the container's `WORKDIR /workspace` stand.

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

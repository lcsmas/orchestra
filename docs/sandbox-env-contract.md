# Sandbox Environment & Secrets Contract

How a Claude Code agent's ambient environment and secrets are injected into an
Orchestra Docker sandbox at container start.

## Scope

Orchestra runs each Claude Code agent inside a Docker container and streams its
terminal to thin clients on Linux, macOS, and Windows. A Claude Code agent
depends on ambient environment that today lives implicitly on the user's local
machine. That environment splits into three buckets:

1. **Secrets** — must be injected at runtime, never baked into the image. The
   complete sensitive set is three things:
   - `ANTHROPIC_API_KEY`
   - a GitHub personal access token (today living in `~/.git-credentials`)
   - Claude's claude.ai OAuth credentials (`~/.claude/.credentials.json`)
2. **Config** — declarative, not sensitive. May be baked into the image or
   mounted: `~/.claude/settings.json`, project-level
   `.claude/settings.local.json`, the `.orchestra/` hook scripts, and MCP
   server definitions.
3. **Toolchain** — the image itself (node, bun, python+uv, git, gh, psql,
   nvim). Already handled by the Dockerfile. **Out of scope for this document.**

This document specifies buckets 1 and 2: the injection contract for secrets and
the placement rules for config. The container runs as an unprivileged user
`agent` with home `/home/agent`, and the project worktree is mounted at
`/workspace` (the agent's working directory).

---

## 1. The injection contract

Each secret has a different natural shape (an env var, a single-line token, a
JSON file), so each gets a mechanism that fits it. The rule for choosing:
**file-shaped secrets are mounted read-only; value-shaped secrets are passed via
an env-file.** Avoid inline `-e KEY=value` for real secrets — the value lands in
the host shell history and in `docker inspect`.

### 1.1 `ANTHROPIC_API_KEY` — via `--env-file`

The API key is a plain value. Put it in a host-side env-file and pass that file.
Do **not** use `-e ANTHROPIC_API_KEY=sk-...` directly (shell history / process
listing leak).

```sh
# host: ~/.config/orchestra/secrets.env  (chmod 600)
ANTHROPIC_API_KEY=sk-ant-PLACEHOLDER
```

```sh
docker run --env-file "$HOME/.config/orchestra/secrets.env" ...
```

> Only set this key when you intend **plain API auth**. See §3 — it overrides
> claude.ai OAuth and disables MCP connectors.

### 1.2 GitHub token — via `--env-file` as `GH_TOKEN`/`GITHUB_TOKEN`

The token currently lives in `~/.git-credentials` as a URL line
(`https://x-access-token:TOKEN@github.com`). Inside the sandbox we don't want to
reconstruct that file shape; instead expose the token as an environment variable
that both `git` (via a credential helper) and `gh` understand natively.

```sh
# host: appended to ~/.config/orchestra/secrets.env
GH_TOKEN=ghp_PLACEHOLDER
GITHUB_TOKEN=ghp_PLACEHOLDER
```

`gh` reads `GH_TOKEN` directly. For `git`, configure a credential helper in the
image (config, not a secret — safe to bake) so HTTPS pushes use the env var:

```sh
# baked into the image (Dockerfile), no secret value present:
git config --system credential.https://github.com.helper \
  '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'
```

This keeps the token out of any on-disk file inside the container.

### 1.3 claude.ai OAuth credentials — via read-only bind mount

These are a JSON file, not a value. Mount the host file read-only into the
agent's home so Claude Code finds it at the path it already expects.

```sh
docker run \
  -v "$HOME/.claude/.credentials.json:/home/agent/.claude/.credentials.json:ro" \
  ...
```

`:ro` prevents the container (or a compromised agent) from rewriting or
deleting the host credentials. Only mount this when using the **OAuth auth
path** (§3) — i.e. when `ANTHROPIC_API_KEY` is **not** set.

---

## 2. Where secrets live on the host

### Location and permissions

- **Value secrets** (`ANTHROPIC_API_KEY`, `GH_TOKEN`) live in a single
  host-side env-file: `~/.config/orchestra/secrets.env`.
- **File secrets** (`.credentials.json`) stay at their existing path
  `~/.claude/.credentials.json` and are bind-mounted; they are not copied.

Lock down the env-file and its directory:

```sh
mkdir -p "$HOME/.config/orchestra"
chmod 700 "$HOME/.config/orchestra"
touch "$HOME/.config/orchestra/secrets.env"
chmod 600 "$HOME/.config/orchestra/secrets.env"
```

`chmod 600` (owner read/write only) ensures the file is never world- or
group-readable.

### Never commit, never COPY into the image

Two hard rules:

1. **Never commit.** Add the secrets path to the repo `.gitignore`. The
   canonical Orchestra secrets file lives outside the repo
   (`~/.config/orchestra/`), but guard against accidental in-repo copies:

   ```gitignore
   # secrets — never commit
   secrets.env
   *.secrets.env
   .claude/.credentials.json
   .git-credentials
   ```

2. **Never `COPY` into the image.** Secrets are injected only at `docker run`
   via `--env-file` and `-v ...:ro`. There must be **no** `COPY`/`ADD` of any
   secret into a layer, and **no** `ARG`/`ENV` carrying a secret value in the
   Dockerfile. A baked secret is permanent in the image history and ships to
   every machine that pulls the image.

### Day-one approach and upgrade path

The env-file + read-only mount approach above is the **day-one** posture: simple,
auditable, no extra infrastructure. It is deliberately not the end state. When
Orchestra needs multi-user, rotation, or audit, upgrade to a real secrets
manager without changing the in-container contract (the agent still sees the
same env vars / files — only the source changes):

- **Secrets vault** (HashiCorp Vault, cloud Secrets Manager): fetch at launch,
  render the same env-file/mount, support rotation and per-agent scoping.
- **OS keychain** (macOS Keychain, libsecret, Windows Credential Manager): for
  the single-user desktop case, read secrets from the keychain at launch instead
  of a plaintext file on disk.

Do not build this now. The contract below is what an engineer implements today.

---

## 3. The auth-path decision (either/or)

**Key fact:** setting `ANTHROPIC_API_KEY` **overrides** claude.ai OAuth login and
**disables MCP connectors** (Claude Code warns about this). You cannot have both
the API key and working connectors. So pick one path per sandbox:

### Path A — API key (simplest)

- Set `ANTHROPIC_API_KEY` via `--env-file`.
- Do **not** mount `.credentials.json`.
- **Trade-off:** simplest setup, no OAuth file to manage — but **no claude.ai
  connectors and no MCP**.

### Path B — OAuth mount (enables MCP/connectors)

- Mount `~/.claude/.credentials.json` read-only.
- Do **not** set `ANTHROPIC_API_KEY`.
- **Trade-off:** keeps claude.ai connectors and MCP working — at the cost of
  managing the OAuth credential file and its refresh lifecycle.

### Recommendation

**Default to Path B (OAuth mount) if the user wants MCP** — e.g. a future SQL MCP
server (§5). MCP is the whole reason Orchestra would care about connectors, and
Path A silently disables it. **Otherwise default to Path A (API key)** for its
simplicity. The launcher should treat this as a single explicit toggle
("API key" vs "OAuth + MCP") and refuse to set both at once, so the override
behavior never surprises a user.

---

## 4. How config (bucket 2) is provided

Config is not sensitive, so the question is purely "bake vs mount," decided by
**where the file naturally lives and how often it changes per-agent.**

| Config | Where it lives | Mechanism | Why |
|---|---|---|---|
| Project worktree | the repo | **mount at `/workspace`** | This is the agent's cwd and the unit of work; it differs per agent and changes constantly. |
| `.claude/settings.local.json` | inside the worktree | **travels with the `/workspace` mount** | It is a file in the repo/worktree — mounting the worktree brings it along automatically. No separate flag. |
| `.orchestra/` hook scripts | inside the worktree | **travels with the `/workspace` mount** | Same as above — they live in the repo, so the worktree mount provides them. |
| Global `~/.claude/settings.json` | user home | **bake into the image** (or mount) | Stable across agents and non-sensitive. Baking gives every sandbox a consistent baseline. Mount read-only instead if the user edits it often and wants live edits. |
| MCP server definitions | global or project config | bake (global defaults) or travels with worktree (project-level) | See §5. |

Key consequence: **anything inside the worktree needs no extra flag** — the
single `-v <worktree>:/workspace` mount delivers `.claude/settings.local.json`
and `.orchestra/` hooks for free. Only the *global* `~/.claude/settings.json` is
a separate decision, and the recommended default is to **bake** it so sandboxes
are reproducible, mounting it read-only only when the user wants to iterate on it
live.

---

## 5. MCP servers (e.g. a future SQL MCP)

An MCP server has two halves that map cleanly onto two buckets:

- **Its definition** (which command/server, args, transport) is **config →
  bucket 2.** It goes in `~/.claude/settings.json` (global) or in the project's
  `.claude/settings.local.json` (per-project, travels with the worktree). No
  secret here.
- **Its connection string / credentials** (e.g. a Postgres DSN with a password)
  is a **secret → bucket 1.** It is injected via the env-file and referenced by
  the MCP definition through an environment variable, never written literally
  into the JSON config.

Example — a SQL MCP defined in config, reading its DSN from the environment:

```json
// .claude/settings.local.json  (config, in the worktree — safe to commit
//                                because it references an env var, not a secret)
{
  "mcpServers": {
    "sql": {
      "command": "mcp-server-postgres",
      "args": ["--dsn", "$DATABASE_URL"]
    }
  }
}
```

```sh
# host: ~/.config/orchestra/secrets.env  (the actual secret)
DATABASE_URL=postgres://user:PLACEHOLDER@db.internal:5432/app
```

**The MCP server runs inside the sandbox, alongside the agent** — it is launched
by Claude Code within the container, so the connection only needs to be reachable
from the container, and no MCP process or credential ever runs on the thin
client. Because MCP requires connectors, **MCP only works on auth Path B** (§3):
the OAuth credentials must be mounted and `ANTHROPIC_API_KEY` must be unset.

---

## 6. Full example

One complete, annotated `docker run` for the **MCP-enabled (Path B)** case:
worktree mounted at `/workspace`, the three secrets injected via the recommended
mechanisms, and config mounted. All values are placeholders.

```sh
docker run --rm -it \
  `# --- config: project worktree is the agent cwd; carries` \
  `#     .claude/settings.local.json and .orchestra/ hooks ---` \
  -v "$HOME/code/myproject:/workspace" \
  -w /workspace \
  \
  `# --- config: global Claude settings, read-only (alt: bake into image) ---` \
  -v "$HOME/.claude/settings.json:/home/agent/.claude/settings.json:ro" \
  \
  `# --- secrets (1 & 2): GH token + DATABASE_URL for the SQL MCP, from the` \
  `#     locked-down host env-file (chmod 600). NOTE: ANTHROPIC_API_KEY is` \
  `#     intentionally NOT in this file for Path B — it would disable MCP. ---` \
  --env-file "$HOME/.config/orchestra/secrets.env" \
  \
  `# --- secret (3): claude.ai OAuth creds, read-only bind mount (Path B) ---` \
  -v "$HOME/.claude/.credentials.json:/home/agent/.claude/.credentials.json:ro" \
  \
  `# --- run unprivileged as the agent user baked into the image ---` \
  --user agent \
  \
  orchestra/agent:latest
```

For the **API-key (Path A)** case, drop the `.credentials.json` mount and include
`ANTHROPIC_API_KEY=sk-ant-PLACEHOLDER` in `secrets.env`. Never do both.

---

## 7. Security checklist

Things that must **never** happen:

- **Never** `COPY`/`ADD` a secret into an image layer, or set a secret via
  Dockerfile `ARG`/`ENV` — it is permanent in the image and ships everywhere.
- **Never** commit a secret to git — gitignore `secrets.env`,
  `.git-credentials`, and `.claude/.credentials.json`.
- **Never** leave a secret file world- or group-readable — `chmod 600` the
  env-file, `chmod 700` its directory.
- **Never** pass a secret inline as `-e KEY=value` — it leaks into shell history
  and `docker inspect <container>`.
- **Never** bake a secret such that it appears in `docker history` — inspect
  built images to confirm no value leaked.
- **Never** set `ANTHROPIC_API_KEY` and mount OAuth creds at the same time —
  the key wins, silently disabling MCP/connectors.
- **Never** mount a secret file read-write — always append `:ro` so the agent
  cannot alter or exfiltrate the host copy in place.
- **Never** write a literal connection string into an MCP `settings*.json` —
  reference an env var injected from `secrets.env` instead.
- **Never** run the agent as root — run as the unprivileged `agent` user.

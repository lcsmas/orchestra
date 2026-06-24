# Orchestra agent sandbox
#
# Reproducible execution environment for running the Claude Code (`claude`) CLI
# inside a git worktree. The host (Orchestra Electron app) does `docker run` this
# image, mounts the worktree at /workspace, injects secrets at runtime, and streams
# the terminal.
#
# Contains NO secrets. ANTHROPIC_API_KEY / Claude OAuth creds / git+gh credentials
# are all injected at container start (see README.md).
#
# Base: node:22-bookworm gives us Node.js 22.x + npm on Debian bookworm.
FROM node:22-bookworm

# ---------------------------------------------------------------------------
# OS-level packages (least-changing layer first for good build caching).
# ---------------------------------------------------------------------------
#  - build basics: ca-certificates, curl, git, openssh-client, build-essential
#  - unzip: required by the bun install script
#  - gnupg + lsb-release: needed to add the pgdg and gh apt repos
#  - neovim: the user's $EDITOR
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        git \
        openssh-client \
        gnupg \
        lsb-release \
        unzip \
        xz-utils \
        build-essential \
        less \
        neovim \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# GitHub CLI (gh) — official apt repo.
# ---------------------------------------------------------------------------
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# PostgreSQL client (psql) — official PGDG apt repo (gets a modern psql 17).
# ---------------------------------------------------------------------------
RUN install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Python 3.13 + uv — uv installs and manages the interpreter, so no deadsnakes
# or distro python needed. uv lives in /usr/local/bin so it is on PATH for all
# users; the managed 3.13 toolchain is installed into a shared location.
# ---------------------------------------------------------------------------
ENV UV_INSTALL_DIR=/usr/local/bin \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_UNMANAGED_INSTALL=1
RUN curl -fsSL https://astral.sh/uv/install.sh | sh \
    && uv python install 3.13 \
    && ln -sf "$(uv python find 3.13)" /usr/local/bin/python3 \
    && ln -sf /usr/local/bin/python3 /usr/local/bin/python \
    && chmod -R a+rX /opt/uv

# ---------------------------------------------------------------------------
# Non-root user. The agent runs as this user; ~/.claude can be populated or
# mounted at runtime. UID/GID 1000 lines up with the node base image's `node`
# user, but we create our own `agent` user for a clean, predictable home.
# ---------------------------------------------------------------------------
RUN useradd --create-home --shell /bin/bash --uid 1001 agent

# Make the user-local tool dirs (bun, claude) discoverable in BOTH login and
# non-login shells. `ENV PATH` covers non-login/exec shells; a profile.d
# drop-in covers login shells (`bash -l`), which otherwise reset PATH via
# /etc/profile and drop these entries.
RUN printf '%s\n' 'export PATH="/home/agent/.bun/bin:/home/agent/.local/bin:$PATH"' \
        > /etc/profile.d/agent-tools.sh \
    && chmod 0644 /etc/profile.d/agent-tools.sh

# ---------------------------------------------------------------------------
# bun — installed per-user via the official script (single static binary).
# ---------------------------------------------------------------------------
USER agent
ENV BUN_INSTALL=/home/agent/.bun
RUN curl -fsSL https://bun.com/install | bash
ENV PATH=/home/agent/.bun/bin:/home/agent/.local/bin:$PATH

# ---------------------------------------------------------------------------
# Claude Code (`claude`) — official native installer. Lands in
# ~/.local/bin/claude (already on PATH above). No auth needed to install or to
# run `claude --version`; auth is injected at runtime.
# ---------------------------------------------------------------------------
RUN curl -fsSL https://claude.ai/install.sh | bash

# ---------------------------------------------------------------------------
# Working directory convention: /workspace is where the host mounts the git
# worktree. Claude Code keys its session/history by the absolute cwd path, so
# this MUST be stable across runs for session resumption to work.
# ---------------------------------------------------------------------------
USER root
RUN mkdir -p /workspace && chown agent:agent /workspace
USER agent
WORKDIR /workspace

# $EDITOR is nvim to match the user's local toolchain.
ENV EDITOR=nvim

# Default to an interactive login shell; the host typically overrides the
# command (e.g. to launch `claude`) at `docker run` time.
CMD ["bash", "-l"]

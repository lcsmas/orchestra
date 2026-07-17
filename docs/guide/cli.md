# CLI reference

The `orchestra` command talks to the running app over its local Unix socket. It's the same interface agents use — everything an agent can do, you can do from a shell, and vice versa.

## Getting the CLI

The CLI is bundled inside the app (the binary doubles as the CLI when invoked as `<app> cli …`):

- **Linux (AppImage):** first GUI launch writes a shim to `~/.local/bin/orchestra`. After launching the app once, just run `orchestra …`.
- **Windows:** the app writes `orchestra.cmd` to `%LOCALAPPDATA%\Orchestra\bin`; add that dir to `PATH`.
- **Dev:** `node dist-electron/cli.js …`.

## Commands

```bash
orchestra peers                                    # list the other agent workspaces (id, branch, repo, status)
orchestra read <id> [--lines N]                    # print a workspace's transcript (default 80, max 400 lines)
orchestra message <id> <text...>                   # send a prompt to a workspace (queues if it's stopped)
orchestra spawn --task <text>                      # spawn a new worktree + agent
         [--repo <path>] [--base <branch>] [--detached]
orchestra rename <id> <branch>                     # rename a workspace's branch (drives the real git branch)
orchestra promote <id>                             # promote a scratch session into an orchestrator
orchestra attach <id> <parentId>                   # nest an existing workspace under an orchestrator
orchestra detach <id>                              # pop a workspace back out to its own section
orchestra add-repo <path>                          # register a repo (becomes a spawn target)
orchestra delete <id> --yes                        # delete a workspace (worktree + branch; --yes required)
orchestra accounts                                 # list configured Claude accounts (id, label, configDir)
orchestra migrate-account <id> <accountId>         # move a workspace to another account
orchestra migrate-account <id> --default           # …or back to the default login
orchestra --help                                   # usage for all commands
```

Every response is JSON of shape `{ ok: true, ... }` or `{ ok: false, error }`; the CLI exits 0 on success and 1 (with the error on stderr) otherwise — safe to script against.

## Socket discovery

1. `$ORCHESTRA_SOCK`, if set (Orchestra sets it in every agent's environment);
2. else the pointer file `~/.orchestra/sock` (its body is the absolute socket path);
3. else: `Orchestra does not appear to be running (no socket found)`, exit 1.

## Identity

Inside an agent's shell, `$ORCHESTRA_WS_ID` identifies the calling workspace — `peers` excludes you, `message` attributes the sender, `spawn` nests the child under you. From a plain human shell there's no identity, which simply means no exclusion/attribution/nesting.

# CLI reference

The `orchestra` command talks to the running app over its local Unix socket. It's the same interface agents use — everything an agent can do, you can do from a shell, and vice versa.

## Getting the CLI

The CLI is bundled inside the app (the binary doubles as the CLI when invoked as `<app> cli …`):

- **Linux (AppImage):** first GUI launch writes a shim to `~/.local/bin/orchestra`. After launching the app once, just run `orchestra …`.
- **Windows:** the app writes `orchestra.cmd` to `%LOCALAPPDATA%\Orchestra\bin`; add that dir to `PATH`.
- **Dev:** `node dist-electron/cli.js …`.

## Commands

```bash
orchestra peers                                    # list the other agent workspaces (id, branch, repo, status; `ex-<old name>` beside a renamed one)
orchestra message <id> <text...>                   # LEGACY peer channel; refused on a delivery-ON bus run
         [--emergency]                             #   (--emergency, leading token: out-of-band liveness poke)
orchestra spawn --name <name> --task <text>        # spawn a new worktree + agent; --name is REQUIRED (convention below)
         [--repo <path>] [--base <branch>] [--detached]
orchestra rename <id> <branch>                     # rename a workspace's branch (drives the real git branch)
                                                   #   a spawned agent can't rename itself (its parent named it): ask the parent;
                                                   #   the parent can, any time; a name the human typed in the sidebar is final
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

**`spawn --name`** (required, checked by the CLI before it touches the socket and again by the app): `<rôle>-<objet en mots humains>[-<ticket>] — rôle ∈ ops | impl | verif | review | explo (ex. impl-politique-nommage-381)`. The name becomes the child's git branch and its sidebar name — the object in the human's own words, no wave codes (`h1`, `q9`, `fu`…). A missing name, or one that does not start with a rôle, is refused and nothing is created. Quote any value that contains spaces: a stray word after the options, or an option with no value, is refused too (never silently dropped from the name, the task or the target repo). A name already taken is suffixed (`-2`, `-3`…); the CLI prints the final branch. The spawner names the child, and the child is never asked to rename itself (the spawner can still change the name with `orchestra rename`).


Every response is JSON of shape `{ ok: true, ... }` or `{ ok: false, error }`; the CLI exits 0 on success and 1 (with the error on stderr) otherwise — safe to script against.

## Socket discovery

1. `$ORCHESTRA_SOCK`, if set (Orchestra sets it in every agent's environment);
2. else the pointer file `~/.orchestra/sock` (its body is the absolute socket path);
3. else: `Orchestra does not appear to be running (no socket found)`, exit 1.

## Identity

Inside an agent's shell, `$ORCHESTRA_WS_ID` identifies the calling workspace — `peers` excludes you, `message` attributes the sender, `spawn` nests the child under you. From a plain human shell there's no identity, which simply means no exclusion/attribution/nesting.

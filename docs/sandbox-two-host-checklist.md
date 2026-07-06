# Two-host manual test checklist — multi-machine sandbox

The one thing the automated suites cannot prove: two physical machines, a real
network link (Tailscale/LAN), real latency and real link drops. Everything
below exercises paths that are loopback-tested but have never crossed a wire.

**Cast**
- **SANDBOX HOST** — always-on box with Docker (home server / VPS / spare laptop)
- **MACHINE A** — your main Orchestra (imports the workspace, first driver)
- **MACHINE B** — second Orchestra install (attaches read-only, takes over)

All three can reach each other over Tailscale or a trusted LAN. Never expose
port 8787 beyond that — the shim has no auth and payloads carry credentials.

> **Known gap (expected):** Machine B has no UI yet to attach to an existing
> sandbox workspace — the transport and ownership layers support it, but the
> "Attach to sandbox…" affordance was never built. Step 3.1 works around it by
> editing Machine B's `store.json` by hand. If that step feels wrong, that's
> the signal to build the attach flow before shipping the multi-machine story.

---

## 0 · Prerequisites

- [ ] Both machines run an Orchestra build from `multi-machine-sandbox` ≥ `4e1561b`
- [ ] Both machines have the demo repo cloned (any small repo you don't mind experimenting on)
- [ ] `tailscale ping <sandbox-host>` works from A and B (or LAN equivalent)

## 1 · Sandbox host up

- [ ] 1.1 Build or transfer the image: `docker build -t orchestra-sandbox sandbox/`
      (or `docker save | ssh … docker load` from a machine that built it)
- [ ] 1.2 Start it always-on, **with named volumes**:
      ```bash
      docker run -d --restart unless-stopped \
        -p 8787:8787 \
        -v sandbox-workspace:/workspace \
        -v sandbox-home:/home/agent \
        -e GH_TOKEN=<token with push rights> \
        --name orchestra-sandbox orchestra-sandbox
      ```
- [ ] 1.3 From **A**: `curl http://<sandbox-host>:8787/healthz` → `{"ok":true,"provisioned":false,…}`
- [ ] 1.4 From **B**: same check, same answer

## 2 · Machine A: import + real agent work

- [ ] 2.1 Create a workspace on the demo repo; make one uncommitted edit, one
      untracked file, and one gitignored file (e.g. `.env` with a dummy value)
- [ ] 2.2 Click the row's ☁↑ **Import to sandbox**, endpoint `ws://<sandbox-host>:8787`
- [ ] 2.3 Row regroups under a host node named after the endpoint; local
      worktree dir is gone; `~/.orchestra/trash/<name>-<ts>/` holds it **including `.env`**
- [ ] 2.4 `~/.orchestra/backups/<ws-id>/` holds one `backup-*.tgz` already
- [ ] 2.5 Open the workspace → terminal streams from the container (prompt appears)
- [ ] 2.6 **Login check:** agent runs as YOUR account — no login prompt.
      In the terminal: `/status` shows the expected account
- [ ] 2.7 **MCP check:** `/mcp` lists your user-scope MCP servers
- [ ] 2.8 Give the agent a small task (edit a file, commit). Status dot /
      activity events update in the sidebar while it works
- [ ] 2.9 Agent `git push` from inside the sandbox succeeds (GH_TOKEN / origin URL correct)

## 3 · Machine B: attach, watch, take over

- [ ] 3.1 **Manual attach (the known gap):** quit Orchestra on B, then add a
      record to B's `store.json` (`<userData>/orchestra/store.json`) under
      `workspaces`, copying **`id`, `branch`, `baseBranch` from A's record
      verbatim** (frames route by that id):
      ```json
      {
        "id": "<same id as machine A>",
        "name": "<same name>",
        "repoPath": "<B's local clone path of the same repo>",
        "worktreePath": "/nonexistent-sandbox-remote",
        "branch": "<same branch>",
        "baseBranch": "<same baseBranch>",
        "createdAt": 0,
        "status": "idle",
        "agent": "claude",
        "host": { "kind": "sandbox", "endpoint": "ws://<sandbox-host>:8787" }
      }
      ```
      Restart Orchestra on B.
- [ ] 3.2 B shows the workspace under the same host node; opening it streams
      the LIVE terminal (same content A sees, delayed only by the network)
- [ ] 3.3 B shows the amber bar: *"Read-only — `<A's hostname>` is driving this sandbox"*
- [ ] 3.4 Typing on B does nothing (keystrokes dropped at the shim)
- [ ] 3.5 Click **Take control** on B → bar disappears on B, appears on A
      naming B; typing works on B, is dropped on A
- [ ] 3.6 Output typed by B is visible on A's terminal (observers stream live)
- [ ] 3.7 Take control back on A → roles flip again cleanly

## 4 · Resilience: kill the link, kill the container

- [ ] 4.1 With the agent mid-task, cut A's network (Wi-Fi off / `tailscale down`)
- [ ] 4.2 A's terminal prints the yellow `[orchestra] sandbox link lost — reconnecting…`
- [ ] 4.3 Restore the network within ~2 min → green `link restored`, output
      resumes, **A still drives** (same clientId resumed the drive; B never
      stole it)
- [ ] 4.4 Cut the network again and leave it down > 3 min → red gave-up
      banner, session unwinds. Reopen the workspace after reconnecting →
      fresh attach streams again; the agent kept running the whole time
      (verify: work progressed in the container)
- [ ] 4.5 `docker restart orchestra-sandbox` on the host → sessions die
      (PTYs are container processes), but `/healthz` shows `provisioned: true`
      after restart (named volume held `/workspace`) and reopening the
      workspace starts a fresh agent in the same checkout
- [ ] 4.6 **Upgrade drill:** `docker rm -f` the container, `docker run` a new
      one with the SAME volumes → still provisioned, work intact

## 5 · Backups + eject (data-safety drill)

- [ ] 5.1 On A, set `ORCHESTRA_SANDBOX_BACKUP_MINUTES=1` (env) and relaunch;
      within a couple of minutes `~/.orchestra/backups/<ws-id>/` accumulates
      snapshots, pruned to the newest 5
- [ ] 5.2 Manual snapshot from anywhere:
      `curl http://<sandbox-host>:8787/export -o snap.tgz && tar -tzf snap.tgz`
      → `meta.json  repo.bundle  worktree/…`
- [ ] 5.3 **Disaster drill:** stop the container. Untar the newest backup,
      `git clone repo.bundle recovered && cp -a worktree/. recovered/` →
      the agent's latest committed AND uncommitted work is there
- [ ] 5.4 Start the container again. On A, click ☁↓ **Return to this
      machine** → local worktree restored at the original path with the
      container's commits + uncommitted changes + hooks; row leaves the host
      node; agent runs locally again
- [ ] 5.5 On B, delete the hand-added record (its sandbox workspace is over)

## 6 · Cleanup

- [ ] Remove the demo container + volumes if done: `docker rm -f orchestra-sandbox && docker volume rm sandbox-workspace sandbox-home`
- [ ] Clear `~/.orchestra/trash/` and `~/.orchestra/backups/<ws-id>/` once satisfied

---

**Sign-off:** every box above checked on real hardware = the multi-machine
story is verified end-to-end and the feature is fully shippable, including the
collaboration paths. If only sections 1–2 and 4–5 pass (single machine), the
core "work in a sandbox without losing work" feature is already safe to ship —
section 3's gap only blocks the second-machine story.

# #304: one cgroup v2 per workspace, killed with `cgroup.kill`

Research ticket [#304](https://github.com/lcsmas/orchestra/issues/304), part of the map
[#296](https://github.com/lcsmas/orchestra/issues/296). It feeds the decision ticket
[#313: GO/NO-GO, crash-only workspace lifecycle with one cgroup per workspace](https://github.com/lcsmas/orchestra/issues/313).
Background (not repeated here): lead 9 and the "Process lifecycle/orphans" row (5 issues) in
[distributed-systems-leads.md](distributed-systems-leads.md).

Date: 2026-10-07. Host: Fedora 42 Asahi, kernel `6.19.14-400.asahi.fc42.aarch64+16k`, systemd 257.13,
sway with `sway-systemd` 0.4.1. Code is read at `origin/master` = `743f9ab0`.

Tags: **VERIFIED** = read or measured in this session. **UNVERIFIED** = not checked.
**INFERRED** = my reasoning from verified facts.

## Answer

1. **It works on this host, and the packaged app has what it needs.** `systemd-run --user --scope`
   starts the command in place: the scope's process is the command itself, so the pid is the same
   (VERIFIED, arm A). That means the keeper's pid file and identity checks can stay as they are
   (INFERRED). A live packaged-app keeper has `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` in its
   environment (VERIFIED), which is all `systemd-run --user` needs. The wrapper adds about 4 ms per
   launch (VERIFIED, arm E: 10 scope-wrapped runs).
2. **`cgroup.kill` reaps the double-forked MCP of [#242](https://github.com/lcsmas/orchestra/issues/242)
   when it is in the scope.** A fake MCP double-forked a sleeper, and the sleeper was reparented to
   pid 1. A copy of `snapshotDescendants`'s ppid walk MISSED the sleeper, while the control (the MCP
   itself) was FOUND. The sleeper was still in the scope's `cgroup.procs`, and writing `1` to
   `cgroup.kill` killed every member within the poll window (VERIFIED, arm A).
3. **But the tree can leave the cgroup. Lead 9's "cannot leave its cgroup" is false for user
   processes.** Under `user@1000.service`, every cgroup is owned by the user. So a member can (a) run
   its own `systemd-run --user --scope`, or (b) write its pid into another cgroup's `cgroup.procs`.
   Both escapees survived the workspace's `cgroup.kill` (VERIFIED, arm B). This happens in the field
   too: Chromium moves its browser process into its own `app-org.chromium.Chromium-<pid>.scope`
   through D-Bus `StartTransientUnit`
   ([`components/dbus/xdg/systemd.cc`](https://chromium.googlesource.com/chromium/src/+/3c8287b1df953ece7fa2e94a5144ce13fc30e1ea/components/dbus/xdg/systemd.cc),
   lines 175-221, VERIFIED). On this host right now, 12 orphaned headless Chromium roots (ppid 1) sit
   in their own scopes. Their 84 child processes stayed in the dead app instance's
   `app-orchestra-2997.scope`. Together they hold about 2 GB (0.87 GB + 1.15 GB `memory.current`)
   (VERIFIED census). A cgroup kill of the old app scope would take the children but leave the 12
   roots (INFERRED). **So a cgroup is a strong net, not a complete one**, and browser MCPs are the
   known gap.
4. **Today all keepers share the app's single cgroup. This couples them to the app and to systemd-oomd.**
   `sway-systemd`'s `assign-cgroups.py` puts the window's process tree into
   `app-orchestra-<pid>.scope` when the window first appears (VERIFIED, source read). The keepers
   inherit that scope, because `detached: true` changes the session and process group, not the
   cgroup (VERIFIED: all 9 live keepers, by exact argv, sit in `app-orchestra-1847269.scope`; the 3 sampled have `sid=pgid=self`).
   That scope held about 11.3 GB and 814 tasks. `app.slice` and `app-orchestra.slice` are monitored
   by systemd-oomd with `ManagedOOMMemoryPressure=kill`, and oomd kills only **leaf** cgroups
   (man `systemd-oomd`, VERIFIED). So one oomd action, or one `systemctl --user stop` of the app
   scope, kills the app and every keeper at once. Arm C reproduced this: the setsid keeper died with
   the app scope, and the keeper in its own scope survived (VERIFIED).
5. **What breaks:**
   - **Rigs.** `systemd-run --user` fails under `env -i` with no `XDG_RUNTIME_DIR`. It also fails
     inside `bwrap --unshare-pid` (session-budget style) with "No data available" (VERIFIED, arm D).
     So the wrapper must fall back to an unwrapped launch with a WARN, and a pid-namespace rig cannot
     exercise it.
   - **Restart.** A healthy restart keeps background jobs on purpose
     ([`keeper-client.ts:506`](https://github.com/lcsmas/orchestra/blob/743f9ab0/src/main/keeper-client.ts#L506)).
     So use one slice per workspace, holding one scope per keeper launch. One `cgroup.kill` on the
     slice reaped two scopes (VERIFIED, arm F).
   - **Sandbox agents** run in a Docker container that Orchestra does not launch, so this does not
     apply to them (INFERRED).
   - **[#136: windowless fleet-host daemon](https://github.com/lcsmas/orchestra/issues/136).**
     Prefer transient scopes over a delegated subtree inside a `hostd.service`. With scopes, keepers
     outlive the host's own cgroup (arm C), so the same design works for the in-app host and for
     hostd (INFERRED).

## Ground truth on master (VERIFIED, `git show origin/master:…`)

| Fact | Anchor |
|---|---|
| Keeper launched `detached: true, stdio: 'ignore'`, no cgroup or scope | [`keeper-client.ts:649-662`](https://github.com/lcsmas/orchestra/blob/743f9ab0/src/main/keeper-client.ts#L649) |
| From the AppImage, the keeper runs on PATH `node` (env inherited) | [`keeper-client.ts:148-163`](https://github.com/lcsmas/orchestra/blob/743f9ab0/src/main/keeper-client.ts#L148) |
| Keeper spawns the CLI as a plain child (same pgid as the keeper); it signals only that child | [`keeper/index.ts:172`](https://github.com/lcsmas/orchestra/blob/743f9ab0/src/keeper/index.ts#L172), `:137-146` |
| Delete: snapshot by ppid BFS from the keeper pid, then SIGKILL the same-identity survivors | [`keeper-client.ts:329-358`](https://github.com/lcsmas/orchestra/blob/743f9ab0/src/main/keeper-client.ts#L329), `:392-410`, [`workspaces.ts:816-822`](https://github.com/lcsmas/orchestra/blob/743f9ab0/src/main/workspaces.ts#L816) |
| Reaper and pause kill also select by /proc lineage, never by cgroup | [`resource-monitor.ts:290-358`](https://github.com/lcsmas/orchestra/blob/743f9ab0/src/main/resource-monitor.ts#L290), [`pause-kill.ts:1-5`](https://github.com/lcsmas/orchestra/blob/743f9ab0/src/main/pause-kill.ts#L1) |
| No `cgroup`, `systemd-run` or `killpg` anywhere in `src/` | `git grep` on origin/master |

A process that double-forks before the delete-time snapshot is outside the BFS. That is #242.
The pause tool-tree kill has the same lineage blind spot (INFERRED from `pause-kill.ts:3-4`,
"lineage under the CLI").

## Primary sources (VERIFIED, read this session)

- Kernel cgroup v2 ([docs.kernel.org/admin-guide/cgroup-v2.html](https://docs.kernel.org/admin-guide/cgroup-v2.html)):
  - `cgroup.kill`: "all processes located in the affected cgroup tree will be killed via SIGKILL …
    will deal with concurrent forks appropriately and is protected against migrations." This is
    SIGKILL only, so the graceful EOF→SIGTERM path stays in the keeper.
  - Delegation containment: a migration needs write access to the `cgroup.procs` of the **common
    ancestor** of source and destination. Under `user@UID.service`, the user owns every ancestor, so
    same-uid processes can move freely. Arm B confirms this.
  - `cgroup.events` `populated` changes value (poll/inotify) when the subtree empties. This gives an
    event-driven "the workspace is dead" signal instead of polling /proc (INFERRED use).
  - No-internal-process rule: it applies only when domain controllers are enabled in
    `subtree_control`. It is irrelevant to `cgroup.kill`.
- `systemd-run(1)` (systemd 257 local man page): with `--scope`, the command "will be executed by
  systemd-run itself … and will thus inherit the execution environment of the caller". Arm A shows
  the scope's pid equals the `systemd-run` child pid.
- `systemd.resource-control(5)` / `systemd-oomd(8)` (local man pages): `ManagedOOMMemoryPressure=kill`
  makes oomd "select a descendant cgroup and send SIGKILL to all of the processes under it". Only
  leaf cgroups, or cgroups with `memory.oom.group=1`, are candidates. `ManagedOOMPreference=avoid|omit`
  is honoured under `user@` when the owners match. Fedora ships
  `/usr/lib/systemd/user/slice.d/10-oomd-per-slice-defaults.conf` (`kill`, 80%), so every user
  slice, including a new per-workspace slice, is monitored. `oomctl` lists `app.slice` and
  `app-orchestra.slice`.
- `/usr/libexec/sway-systemd/assign-cgroups.py` (sway-systemd 0.4.1-2.fc42), `assign_scope`: on
  `window:new` it calls `StartTransientUnit("app-{app_id}-{pid}.scope", PIDs=[pid + children],
  Slice="app-{app_id}.slice")`. This is how the app scope gets created. It depends on the desktop: an
  AppImage started from a terminal or another compositor lands in that launcher's cgroup (INFERRED).
- Chromium `components/dbus/xdg/systemd.cc` @ `3c8287b1`: `SetSystemdScopeUnitNameForXdgPortal`
  calls `StartTransientUnit("app-$1-$2.scope", PIDs={getpid()})`. It is skipped only when
  `FLATPAK_SANDBOX_DIR` or `SNAP` is set (lines 255-259), or when there is no systemd D-Bus name.
  The Fedora chromium binary contains `StartTransientUnit` (strings).

## Experiments (throwaway `systemd-run --user --scope` around `sleep` started by this session; all cleaned up)

| Arm | Setup | Observed |
|---|---|---|
| A, must-FAIL plus fix | fake MCP: `( setsid sleep & )`, then `exec sleep`. Bash copy of `snapshotDescendants` BFS, then `echo 1 > cgroup.kill` | `systemd-run pid == root pid`. Orphan ppid=1, in the scope's `cgroup.procs`. PPID sweep: orphan **MISSED**, MCP control **FOUND**. After `cgroup.kill`: orphan, MCP and root dead. `systemd-run` exit 137. Scope cgroup removed (`--collect`) |
| B, escape | member runs (B1) its own `systemd-run --user --scope sleep`, (B2) `echo $$ >` a sibling scope's `cgroup.procs` | B2 write accepted. Both B1 and B2 **survived** the workspace `cgroup.kill`. A non-escaping member was killed |
| C, keeper lifecycle | fake app scope launches K0 (`setsid`, like today) and K1 (`setsid systemd-run --user --scope`), then `cgroup.kill` of the app scope | app and K0 **died**. K1 survived |
| D, environments | `env -i` / `env -i XDG_RUNTIME_DIR=…` / `bwrap --unshare-pid` / plus `--unshare-user` | fail "XDG_RUNTIME_DIR not defined" / exit 0 / fail "No data available" / fail "No data available" |
| E, cost | 10× `/bin/true`, bare vs scope-wrapped | avg 0 ms vs **4 ms** |
| F, per-workspace slice | two scopes under `--slice=orch304ws-$(systemd-escape <uuid>).slice`, then `cgroup.kill` on the slice | both dead, `populated 0`. Dashes in a UUID must be escaped, otherwise they create nested slices. A slice name without an `app-` prefix lands under `user@1000.service/`, not `app.slice` |

Arm A's core (the must-FAIL shape for a real-path rig):

```bash
systemd-run --user --scope --collect --unit=ws-test -- bash -c 'echo $$ >root.pid; bash fake-mcp.sh & wait' &
# fake-mcp.sh:  ( setsid sleep 7304 </dev/null >/dev/null 2>&1 & echo $! >orphan.pid ); exec sleep 7305
# ppid BFS from root.pid  -> orphan MISSED     (today's delete sweep)
# echo 1 > /sys/fs/cgroup/<scope>/cgroup.kill -> orphan dead (the fix)
```

## Design implied (INFERRED, input for #313, not a spec)

- Launch the keeper as `systemd-run --user --scope --quiet --collect --slice=app-orchestra-ws-<esc>.slice
  --unit=orchestra-keeper-<esc>-<n> -- <node> keeper.js …`. With the `app-orchestra-` prefix, the
  slice nests under `app-orchestra.slice`, which oomd already monitors. Make the unit name unique for
  each launch. The single-flight launch (#202) keeps it to one live scope per keeper launch.
- Delete: graceful kill (today's path), then `cgroup.kill` on the workspace slice, then wait for
  `populated 0`. Keep the identity sweep for processes that escaped, such as Chromium roots. A second
  net for those is an environment tag (`ORCHESTRA_WORKSPACE_ID` inherited by descendants) matched on
  `/proc/*/environ` with a pid+start-time identity check. Not tested.
- Fail open. If systemd is missing or `systemd-run` fails (macOS, a non-systemd distro, pid-ns rigs,
  `env -i`), launch exactly as today and log one WARN. A failed wrapper must never stop a session
  from starting.
- Pause cannot use `cgroup.kill`, because that would kill the CLI and the keeper. `cgroup.freeze` on
  the workspace slice is a separate idea (UNVERIFIED).
- Bonus: `memory.current` for each workspace becomes free accounting for the resource monitor and the
  memory guard (ADR 0004). oomd's victim becomes one workspace instead of the whole fleet.
- PTY agents (`transport/local-pty.ts:71`) stay in the app scope. They are slated for removal by
  [#233: delete the agent-PTY launcher](https://github.com/lcsmas/orchestra/issues/233).

## VERIFIED

- Host: cgroup2fs; root controllers `cpuset cpu io memory pids rdma misc dmem`. `user@1000.service`
  has `Delegate=yes` with `cpu memory pids`. `cgroup.kill` exists. (`stat -f`, `/sys/fs/cgroup`,
  `systemctl show`)
- App scope `app-orchestra-1847269.scope` (transient, `Delegate=no`, `KillMode=control-group`):
  about 11.3 GB and 814 tasks, holding all 9 live keepers (exact `argv[1]` match).
  Keeper env has `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`.
- The scope is created by sway-systemd `assign-cgroups.py` (running pid 2414; source read).
- oomd: `app.slice` is `ManagedOOMMemoryPressure=kill`, the per-slice drop-in sets kill at 80%, and
  `oomctl` lists `app-orchestra.slice`.
- Arms A-F above, each printing its own verdict. Every scope I started was dead afterwards (cleanup
  lines printed ok).
- Census: 12 headless Chromium roots with ppid 1 in their own scopes, plus 84 children in the stale
  `app-orchestra-2997.scope` (pid 2997 gone). About 0.87 GB + 1.15 GB `memory.current`.
- Chromium source moves only `getpid()` into a new scope (`systemd.cc` @ `3c8287b1`).
- Master code anchors in the table above.

## NOT VERIFIED

- No real-path rig: neither the real `deleteWorkspace` nor the real keeper was run with a
  double-forking MCP. The must-FAIL result is on a bash copy of the BFS. #313's evidence rule needs
  the real path (e.g. extend `scripts/e2e-keeper-lifecycle.mjs`).
- Not run from the packaged AppImage itself. Only its live keeper's environment and cgroup were read.
- Who launched the 12 leaked headless Chromiums (chrome-devtools MCP, a rig, or an agent tool) is
  unknown. They were left alive (not my processes).
- Electron's own Chromium code calling `SetSystemdScopeUnitNameForXdgPortal` for the Orchestra main
  process was not checked.
- Not checked: whether the "No data available" failure in a pid namespace comes from pid/pidfd
  translation, and whether a newer systemd fixes it.
- `cgroup.freeze` for pause; the environment-tag net; `cgroup.events` inotify from Node; behaviour
  under a non-sway launcher (terminal, GNOME), macOS, or non-systemd distros.
- Sandbox containers' in-container cgroup writability (Docker cgroupns / read-only mount).
- Two empty transient slices from arm F (`orch304ws.slice` and its child) are still loaded and
  active with 0 processes. I did not stop them, because that is outside this session's allowed unit
  operations. They go away when the user manager restarts.

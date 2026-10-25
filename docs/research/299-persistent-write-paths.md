# #299 — Orchestra's persistent write paths: method, writers, identity, crash/torn consequence

Written 2026-10-07 for [#299](https://github.com/lcsmas/orchestra/issues/299) (map [#296](https://github.com/lcsmas/orchestra/issues/296)). Code anchors are `path:line` on **`origin/master` @ `743f9ab0`** (this branch is cut from it, 0 commits behind).

Builds on, does not repeat: [`distributed-systems-leads.md`](distributed-systems-leads.md) lead 2 (the atomic-write helper + `sameEntity` proposal, Pillai/rename(2) quotes) and [`orca-model-lineage.md`](orca-model-lineage.md) §5 (outbox / idempotency).

Tags: **VERIFIED** = read or run this session. **UNVERIFIED** = not read this session. **INFERRED** = my reasoning, never a citation.

## Question

For every file Orchestra persists: how it is written (in place / tmp+rename / fsync / dir fsync), who else writes it (app, CLI, keeper, hook scripts, the `claude` CLI), how identity is checked (string path vs dev+inode), and what a crash or a torn read mid-write does. Map each to the file/store issues and to Pillai et al.'s vulnerability classes.

## Short answer

1. **Durability: none.** In all of `src/` there is exactly one `fsync` (`account-inherit.ts:472`, the `.claude.json` tmp) and zero directory fsyncs. Every other crash guarantee depends on filesystem heuristics. The host is btrfs (`findmnt`: `btrfs … compress=zstd:1,ssd`); `/tmp` (keeper sockets) is tmpfs. VERIFIED.
2. **7 of the 9 filed issues are concurrency or aliasing bugs, not crash bugs.** Pillai's taxonomy only models crashes, so it covers #238 and the spool tears only by analogy. #205, #235, #239, #240 and #241 fall outside it. They are identity and lost-update defects. VERIFIED (paper read); the classification is INFERRED.
3. **New, measured: the inbox drain loses messages.** The real hook (`cat "$f"; rm -f "$f"`, `workspaces.ts:4944-4945`) races the real writer (`appendInboxBlock`). Under an adversarial rate it lost **433 / 490 / 507 of 3000** blocks in 3 runs. A rename-before-read control lost 1 / 1 / 0, so rename alone is not enough. VERIFIED (rig below); the field rate is UNVERIFIED.
4. **New, from code: four more files take the #238 shape** (an unreadable file becomes a default, then a rewrite drops data or opens a fence):
   - `.claude/settings.local.json`: on a parse failure it becomes `{}` and is rewritten (`workspaces.ts:5747-5749,5879`).
   - `secrets.json`: on a parse failure it becomes `{}` and is rewritten, with no write chain (`secrets.ts:58-61,66-74`).
   - The hook seq counter `<ws>.seq` is rewritten in place (`workspaces.ts:5068`). If it is emptied, seq restarts at 1 and the reader silently drops every later event (`events-spool.ts:262-263`).
   - The `bus-run-stale` fence marker is written in place. If the CLI reads it empty, the fence fails open (`cli/index.ts:284-289`).

   All code VERIFIED; the triggers are INFERRED.
5. **#240 is still live, and it has two more holes than its title.** The string compare is still there (`workspaces.ts:2847`). `rm(srcDir, {recursive, force})` (`:2877`) also deletes transcripts created after the `readdir`, despite the comment saying it leaves them. And the EXDEV fallback `copyFile`s session sub-directories, which throws `EISDIR` and leaves a half-move (`:2868`). The fix branch `migrate-transcripts-same-dir-c13` @`cba1416b` is still not an ancestor of master. VERIFIED (`EISDIR` measured, ancestry checked).

## Pillai et al. classes used below

Table 3(a) of [Pillai et al., OSDI 2014](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-pillai.pdf) (VERIFIED, PDF extracted with pypdf) groups vulnerabilities as follows:
- **Atomicity**: across-syscalls; appends and truncates; single-block overwrites; renames and unlinks.
- **Ordering**: safe file flush; safe renames; other.
- **Durability**: safe file flush; other.

Two points from the paper matter here. First, "Applications are extremely vulnerable to system calls being persisted out of order; we find 27 vulnerabilities". Second, under the paper's btrfs model (Table 3(d)), only "Safe rename, safe file flush" are ordered, i.e. data is persisted before a rename over it. Whether today's btrfs still does that, I did not verify (the btrfs admin docs fetched this session only document `flushoncommit`, default off). ext4's `auto_da_alloc` heuristic is documented: it "will detect the replace-via-rename and replace-via-truncate patterns" (VERIFIED, `Documentation/admin-guide/ext4.rst`).

Primitives (man7, VERIFIED):
- rename(2): newpath "will be atomically replaced". Also: "If oldpath and newpath are existing hard links referring to the same file, then rename() does nothing, and returns a success status". That is the exact #240 trap.
- fsync(2): fsync "does not necessarily ensure that the entry in the directory containing the file has also reached disk".
- write(2): O_APPEND offset and write are "an atomic step", but "write() may transfer fewer than count bytes".

Two labels in the table are mine, not Pillai's, for failures his crash model does not cover:
- **V** (visibility): a concurrent reader sees a partial file.
- **I** (identity): a decision keyed on a path string that names the same or a different object.

## Inventory

W = writers. "inplace" = `writeFile`/`O_TRUNC`, no tmp. Crash = process crash or power loss. Torn = a concurrent reader sees a partial file.

| File (path) | Method (anchor) | Writers | Readers | Identity | Crash / torn consequence | Pillai class | Issues |
|---|---|---|---|---|---|---|---|
| `store.json` (userData/orchestra) | one promise chain, `writeFile(tmp)` + `rename`, no fsync, no dir fsync (`store.ts:194-199`) | app main only; single-instance lock keyed by userData (`index.ts:904`) | app main at boot | string path | Torn: impossible (rename). Crash: needs the fs to order data before rename. If unparseable at load: renamed to `.corrupt-<ts>` and **EMPTY defaults** loaded (`store.ts:134-142`), so the user sees "lost everything". Lost update: 64 whole-record `upsertWorkspace(` call sites, with tombstones only for deletes, in memory, per run (`store.ts:263-273`) | Ordering: safe rename; Durability: other | #205 (resurrection fixed by tombstones; the field-level lost update from a stale whole record is INFERRED and still open) |
| login `.claude.json` (account configDir) | tmp `wx` + **fsync** + CLI's `<target>.lock` dir + re-read compare + `rename` (or `link` if fresh) (`account-inherit.ts:463-515`) | app; **the `claude` CLI** (lock + tmp+rename per the C11 review, UNVERIFIED this session) | CLI, app | resolves symlink to its target (`:439-452`); `sameDir` against global (`:559`) | Torn: closed by #238's fix. Crash: file data fsynced, dir entry not (fsync(2) quote) | Durability: safe file flush (dir) | #238, #239 |
| `.orchestra-inherited.json` manifest (each login dir) | **inplace** `writeFileSync` (`account-inherit.ts:118`) | any Orchestra instance syncing that login dir (dev + packaged + rigs share `~/.claude*` login dirs) | sync | — | A torn or empty read gives `{symlinks:[], source:undefined}` (`:111-113`). `builtFromElsewhere` then has no `source` and no links to inspect (`:233-240`), so **the #235/D10 "built from another source → no write" guard is bypassed** (INFERRED). Owned links are also forgotten, so they are never pruned (leak, the safe direction) | Atomicity: single-block/inplace; V | #235 |
| inherited symlinks (`settings.json`, `CLAUDE.md`, imports, `skills/*`) | repoint = `unlinkSync` then `symlinkSync`, two syscalls (`account-inherit.ts:317,341`); real file → `renameSync` to `.orchestra-bak` (`:323`) | app | **`claude` CLI at boot** | `slotOwner` via `sameDir` = path / realpath / dev+ino (`:362-373`, `same-dir.ts:9-23`) | Between unlink and symlink the slot is absent. A CLI booting in that window runs without the user's settings or hooks; a crash leaves it absent until the next sync (INFERRED) | Atomicity: across-syscalls | #241 (alias, fixed) |
| `.claude/settings.local.json` (each worktree) | read → on parse failure `{}` (`workspaces.ts:5745-5751`) → **inplace** `writeFile` (`:5879`); stamp `.hooks-version` written last (`:5883`) | app (on HOOKS_VERSION change); **the `claude` CLI** writes local settings: its 2.1.291 binary carries "one or more of your MCP server choices could not be saved (check permissions on .claude/settings.local.json)" (VERIFIED string; write method UNVERIFIED) | CLI (hot-reloads hooks), app | string | Torn read by the app → `{}` → rewrite keeps only Orchestra's hooks, **erasing the CLI's/user's local settings** (#238 shape). Torn read by a live CLI during an app upgrade → hooks briefly invalid (INFERRED) | V; Atomicity: inplace | none filed |
| hook scripts `.orchestra/*.sh` | `writeFile(tmp, 0755)` + `rename` (`workspaces.ts:5669-5674`), because a running hook keeps its inode (#198 T11 F2) | app | bash hooks | — | Safe for readers; a crash can leave a `*.tmp` | Ordering: safe rename | (#198 D20 F2) |
| `.orchestra/bus-switches` | **inplace** `writeFile` (`workspaces.ts:5622`) | app on spawn | SessionStart hook `[ -s ] && cat` (`:4732-4733`) | — | Torn → a partial notice; an empty file is a silent no-op by design | Atomicity: inplace | — |
| `.orchestra/bus-run-stale` (fence) | **inplace** `writeFile` (`workspaces.ts:1960`), then `upsertWorkspace` | app | store-less CLI `refuseIfStaleRun` (`cli/index.ts:282-290`) | cwd or `$ORCHESTRA_WORKSPACE_PATH` | Empty or torn first line → `if (firstLine)` is false → **send allowed into the stale run** (fail-open fence). A crash that leaves it zero-length keeps it open until removed (INFERRED) | Atomicity: inplace; Durability | #142 lineage |
| `.orchestra/.branch-renamed`, `.orchestrator` | inplace (`workspaces.ts:1426,1447`) | app | hooks | — | Best-effort nudges; empty = env fallback | inplace | — |
| events spool `<ws>.jsonl` (`$ORCHESTRA_HOME/events` or `~/.orchestra/events`, `events-spool.ts:52-54`) | hook `printf >>` under `flock -w 2` with the seq bump; unlocked fallback writes seq=0 (`workspaces.ts:5062-5079`); reader rotates by `rename` → `.old` when quiescent (`events-spool.ts:302-316`) | one hook process per event (pretool/posttool/stop… fire µs apart) | app tailer | per-ws string | Torn line: skipped and logged at debug (`events-spool.ts:246-251`). Crash: the appended tail may be garbage or zero (Pillai append content-atomicity) and is skipped as unparseable | Atomicity: appends | **#28, #37** (fixed: append inside the lock) |
| hook seq counter `<ws>.seq` | **inplace** `printf '%s' "$seq" >"$seqf"` under flock (`workspaces.ts:5068`) | hook processes | hook | — | If emptied (power loss before data, or SIGKILL between `O_TRUNC` and the write), `cur=0` → seq restarts at 1. The reader drops `seq <= cur.lastSeq` **silently** (`events-spool.ts:262-263`, no log). Every event after that, including the turn-ending `stop`, is skipped until seq passes the old mark, and the persisted mark survives for a live keeper (`:120-129,365-374`). The dot freezes (INFERRED trigger; code VERIFIED) | Atomicity: single-block overwrite; Durability | #28/#37 class (same symptom) |
| spool cursor `<ws>.cursor` | `writeFileSync(tmp)` + `renameSync` (`events-spool.ts:135-136`) | app | app at boot | — | A missing or corrupt cursor replays with dedup, which is safe by design (`:127`) | Ordering: safe rename | — |
| inbox `~/.orchestra/inbox/<ws>.txt` — **not** relocated by `ORCHESTRA_HOME` (`workspaces.ts:3034`, `inbox-tray.ts:65`) | `appendFile` serialized per path in-process (`inbox-write.ts:28-50`); tray read-modify-write sync `writeFileSync` inplace or `rmSync` (`inbox-tray.ts:91-104`) | app main (async append + sync tray); **hook drain `cat` + `rm -f`** on SessionStart **and** UserPromptSubmit (`workspaces.ts:4944-4945,5796,5862`) | hook, tray | string; the path is shared by every instance on the same HOME | **Drain race: a block appended between `cat` reaching EOF and `rm -f` is deleted unread, measured at 14-17% loss under stress** (rig below). The tray's sync read-modify-write can also drop an append in flight on the libuv threadpool, and its in-place `O_TRUNC` write can be torn-read then `rm`'d by the hook (both INFERRED) | V; Atomicity: across-syscalls (read+unlink) | **#93** (splice, fixed); drain loss **not filed** |
| `secrets.json` (userData/orchestra) | **inplace** `writeFile` then `chmod 0600` (`secrets.ts:66-74`); **no write chain** | app main; concurrent async mutators read the same cached object | app | — | Torn or crash-truncated → `JSON.parse` fails → `cached = {}` (`:58-61`). The next set persists `{}` + one key, **so every other stored secret is lost** (#238 shape). Two concurrent `writeFile`s on one path can interleave: the failure `store.ts:109-111` names for store.json before its chain (INFERRED here). A fresh file exists at default mode until the `chmod` | V; Atomicity: inplace; Durability | none filed |
| `usage.json`, `client-id`, `.hooks-version` | inplace (`usage.ts:96`, `sandbox-manager.ts:178`, `workspaces.ts:5883`) | app | app | — | Benign: corrupt → null / fresh id / reinstall | inplace | — |
| `~/.claude/CLAUDE.md`, `LESSONS.md` (live global config) | inplace `writeFileSync` when the `@LESSONS.md` import is missing (`self-tune.ts:161,173`) | app (self-tune); user; agents' Edit tool | **every `claude` boot** | `os.homedir()`, not `CLAUDE_CONFIG_DIR` | Torn → a CLI boots with truncated user instructions; a crash can truncate the user's global CLAUDE.md (INFERRED; rare, it only runs when the import is absent) | Atomicity: inplace; Durability | — |
| keeper pid `<pidPath>`, takeover claim | pid: tmp + `renameSync` (`keeper/index.ts:509-511`); claim: tmp + `linkSync` (EEXIST = held), break = rename aside + re-verify (`:394-467`) | keepers | keepers, app | owned socket by **ino+ctime** (`:106,505`); claim holder by pid + wall-clock age vs mtime (`:426-440`) | Sound for torn reads. Pid reuse and clock steps are the residual risks (clock: see leads doc lead 1) | Atomicity: renames/links | (#124, A2 lineage) |
| hooks socket + pointer `$ORCHESTRA_HOME/sock` | pointer inplace `writeFileSync 0600` (`hooks-server.ts:107`); socket **unlinked by string at start, no liveness probe** (`:132-136`) | app | CLI | string | A second instance on the same home is stopped earlier by the single-instance lock. Without it, it would unlink a live socket (INFERRED) | I | — |
| transcripts `projects/<mangled>/*.jsonl` + `<session>/` dirs (account configDir) | **the `claude` CLI appends** (UNVERIFIED method). Orchestra moves them: migrate `rename`, EXDEV → `copyFile`+`rm`, then `rm -rf srcDir` (`workspaces.ts:2842-2878`); fork `rename` (`agent-sdk.ts:5948`); adopt `cp` recursive (`workspaces.ts:2599`) | CLI (appender), app (mover) | CLI `--continue`/resume, app | **string `srcConfigDir === dstConfigDir`** (`:2847`); `sameDir` not used here | (a) An aliased same dir → rename is a no-op success (rename(2)) → `rm -rf srcDir` deletes everything (#240). (b) A file created after `readdir` is deleted by the recursive rm (VERIFIED code; the comment at `:2875-2876` says the opposite). (c) EXDEV on a session dir → `copyFile` throws `EISDIR` (measured) → half-move. (d) EXDEV `copyFile` with no fsync, then `rm` source → a crash can keep the unlink and lose the copy's data | I; Ordering (copy before unlink); Durability | **#240 OPEN** |
| `bus.sqlite` | SQLite WAL, `synchronous = NORMAL`, `busy_timeout` (`bus.ts:560-563`) | app, store-less CLI verbs | both | — | Per sqlite.org: "always consistent … might roll back following a power loss". The last committed messages can vanish on power loss, but never corrupt (VERIFIED doc) | Durability (by design) | — |
| logs (`logger.ts:108,188`; `resource-monitor.ts:188-198`; keeper log `keeper/index.ts:65-69`; pty scrollback `pty.ts:123` trims **inplace**) | append + rename rotation; pty trim rewrites inplace | app, keeper | humans | — | Benign: a torn or garbage tail | Atomicity: appends | — |
| pause orders `pause-orders/<ws>.json` | tmp + `renameSync` (`pause-douce.ts:53-54`); the hook claims it once with `mv` | app, hook | hook | — | Sound: rename both ways | renames | (#254) |

Not in the inventory: files written by the claude CLI that Orchestra never touches (`.credentials.json` is only read, `usage.ts:24-28`). Sandbox import/eject (`sandbox-import.ts`) uses stage dirs, `partial` + `rename` (`:347`) and copies a live config dir with `cp` (`:80,101`). Copying `.credentials.json` while the CLI refreshes it could tear the copy (INFERRED).

## Rig: inbox drain loses blocks (must-FAIL on master)

- **Subject.** The real hook body, extracted from `workspaces.ts:4937` at `743f9ab0` into `/tmp/r299scripts/inbox-hook.sh`, plus the real `appendInboxBlock` imported from `src/main/inbox-write.ts`.
- **Containment.** The rig ran on `HOME=/tmp/r299rig/home-<arm>` (it refuses any other prefix) with `env = {PATH, HOME, ORCHESTRA_WS_ID}`.
- **Procedure.** The writer awaited 3000 appends of `MSG-k\n`, sleeping 1 ms every 4 appends. A drainer re-ran the hook back to back and captured its stdout. One final drain ran after the writer stopped.
- **Metric.** Lost = sent − distinct `MSG-k` in the collected stdout. The rig prints CLEAN/DIRTY itself.

| run | arm `real` (master hook) | arm `rename` (control: `mv` aside, then `cat`, then `rm`) |
|---|---|---|
| 1 | lost 433 / 3000 — DIRTY | lost 1 — DIRTY |
| 2 | lost 490 / 3000 — DIRTY | lost 1 — DIRTY |
| 3 | lost 507 / 3000 — DIRTY | lost 0 — CLEAN |

How to read the rows:
- The `real` arm is the must-FAIL arm: it reproduces on master.
- The control shows the instrument can report CLEAN, and that renaming the file aside removes about 99.8% of the loss.
- The control's residual (an `appendFile` that opened the old inode before the `mv` but wrote after the `cat`) means a correct fix also needs the writer side: append under the same `flock` the drain takes, or have the drain wait for in-flight appends. That is INFERRED from the residual, not traced.
- The rate is adversarial. In the field, `queueInbox` only parks mail for a peer that is not running, and the drain fires as that peer starts or prompts, so the overlap window is real but rare (field frequency UNVERIFIED). `/tmp` is tmpfs; the race is in the VFS, not in a filesystem (INFERRED).

Command: `node --experimental-strip-types /tmp/r299scripts/inbox-race.mjs <repo> real|rename 3000`.

## Mapping to the 9 filed issues

| Issue | Shape | Pillai class | Still reachable on master? |
|---|---|---|---|
| [#28](https://github.com/lcsmas/orchestra/issues/28) / [#37](https://github.com/lcsmas/orchestra/issues/37) — spool flaky tests, torn lines | concurrent multi-`write()` appends | appends (by analogy: concurrency, not crash) | Fixed (append inside the lock). Same-symptom residual: an emptied `.seq` (above) |
| [#93](https://github.com/lcsmas/orchestra/issues/93) — inbox appends splice | concurrent multi-chunk `appendFile` | appends (analogy) | Fixed in-process. **The drain-side loss is a separate, unfiled defect (rig)** |
| [#205](https://github.com/lcsmas/orchestra/issues/205) — deleted workspace resurrected | stale whole-record read-modify-write | none (application lost update) | Delete fixed (per-run tombstone). Field-level lost update between 64 whole-record upserts: INFERRED open |
| [#235](https://github.com/lcsmas/orchestra/issues/235) — sync strips a live dir when the source is missing | "missing read as empty" | none (V/semantic) | Fixed; but a torn or empty **manifest** re-opens the D10 bypass (INFERRED) |
| [#238](https://github.com/lcsmas/orchestra/issues/238) — torn read rewrites `.claude.json` as `{}` | V + "unreadable → default → rewrite" | single-block/inplace (analogy) | Fixed for `.claude.json`. **Same shape live in `settings.local.json`, `secrets.json`, the manifest** |
| [#239](https://github.com/lcsmas/orchestra/issues/239) — settings self-loop when configDir is the source | identity | none (I) | Fixed (`sameDir`, `account-inherit.ts:635`) |
| [#240](https://github.com/lcsmas/orchestra/issues/240) — migration deletes transcripts on an aliased dir | identity + rename no-op + recursive rm | I; ordering (copy/unlink) | **OPEN** on master, plus holes (b)–(d) above |
| [#241](https://github.com/lcsmas/orchestra/issues/241) — unlink through an aliased entry | identity | renames and unlinks + I | Fixed (`slotOwner`) |

Recurrence: 9 filed issues in this class, 08-24 → 09-30. 1 is open. This session found 4 more sites of the #238 shape and 1 measured loss, none of them filed.

## What this implies for lead 2 (INFERRED, input to the GO/NO-GO)

- A crash-durability helper (fsync + dir fsync) would have prevented none of the 9 filed issues. Every one of them is visibility, identity or lost update. The durable variant is insurance for `store.json` and `secrets.json` only.
- The issues share three remedies:
  - Never map an unreadable file to a default that is then written back. Fail closed and keep the file.
  - Every reader-visible rewrite goes through tmp+rename.
  - Destructive path decisions use `sameDir`.
- The drain and `.seq` cases need protocol changes (claim by rename plus writer-side lock; seq written via tmp+rename, or the reader detecting a seq regression instead of skipping silently), not just a write helper.

## VERIFIED (this session)

- Every anchor in the inventory, read on `origin/master` @`743f9ab0` (`git fetch` and `git checkout -b … origin/master`; `git rev-list --count HEAD..origin/master` = 0).
- Exactly one `fsync` in non-test `src/` and no directory fsync: `grep -rn -E "fsync|fdatasync|O_SYNC|O_DSYNC" src` → `account-inherit.ts:472` only.
- `sameDir` is used only in `account-inherit.ts`; `moveWorkspaceTranscripts` compares strings (`workspaces.ts:2847`).
- `git merge-base --is-ancestor origin/migrate-transcripts-same-dir-c13 origin/master` → exit 1 (branch @`cba1416b`).
- Node `fs.promises.copyFile(<dir>, …)` → `EISDIR` (run in /tmp). A live project dir holds a `<session>/` sub-directory beside the `.jsonl` (`ls`, read-only).
- The inbox drain rig numbers above (3 runs × 2 arms).
- Inbox root is `os.homedir()/.orchestra/inbox` in both main modules and the hook; `ORCHESTRA_HOME` relocates userData, events and sock only (`index.ts:159-168`, `events-spool.ts:52-54`, `hooks-server.ts:99`).
- The single-instance lock is keyed by userData (`index.ts:886-911`).
- The `claude` 2.1.291 binary contains strings saying it saves to `.claude/settings.local.json` (`grep -a`).
- Filesystems: home is btrfs (no `flushoncommit`), `/tmp` is tmpfs (`findmnt`).
- Primary texts: Pillai OSDI'14 Table 3 and §4.4 (pypdf); man7 rename(2), fsync(2), write(2); ext4.rst `auto_da_alloc`; sqlite.org pragma `synchronous`; the btrfs admin docs (`flushoncommit` default off).
- Issue titles and states of the 9 issues (`gh issue list`).

## NOT VERIFIED

- Whether current btrfs persists data before a rename-over or truncate-rewrite. Pillai's 2014 btrfs model says yes for rename. No current btrfs doc found, so the crash outcome for `store.json`, `.seq` and the fence marker on this host is unproven.
- How the `claude` CLI writes `settings.local.json`, transcripts and `.claude.json`. The `.claude.json` lock + tmp+rename comes from the C11 review, not this session.
- Every trigger tagged INFERRED. None was reproduced except the inbox drain:
  - `.seq` emptied → silent event drop
  - manifest torn → D10 bypass
  - `secrets.json` interleave → `{}`
  - `settings.local.json` torn → local settings erased
  - fence marker read empty → send allowed
  - symlink repoint window
  - tray read-modify-write vs in-flight append
  - #240 holes (b) and (d)
- The field frequency of the inbox drain loss: the rig rate is adversarial, and no field log was searched.
- The field-level lost update across the 64 `upsertWorkspace` call sites: not traced call by call.
- Whether a hook process can actually be SIGKILLed between `O_TRUNC` and the write of `.seq` (CLI hook timeout or pause-trap kill scope).

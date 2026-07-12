---
name: map-codebase
description: (Re)generate the Orchestra codebase map — fan out parallel audit agents across every subsystem and (over)write the reference docs in docs/codebase-map/. Use when the architecture docs are stale, after a big refactor, or to bootstrap the map from scratch. This GENERATES the docs; CLAUDE.md's routing table is what points future work at them.
---

# Regenerate the codebase map

This skill rebuilds the per-subsystem reference docs under **`docs/codebase-map/`**.
It audits the **current** source, so run it whenever the map has drifted from
reality (after a refactor, a new subsystem, or moved files). It overwrites the
docs in place — the prior versions are in git if you need to diff.

The docs are consumed via the routing table in the project `CLAUDE.md`, which
points future work at the right doc. This skill is the *producer* of those docs.

## Procedure

1. **Re-scan the source layout** so the audit reflects today's tree, not a
   remembered one:

   ```bash
   find src -name '*.ts' -o -name '*.tsx' | sort
   wc -l src/main/*.ts src/renderer/*.tsx src/renderer/components/*.tsx
   ```

   Read `src/shared/types.ts` first — it's the documented domain backbone and
   the fastest orientation. Check whether the subsystem split below still holds
   (new big files may deserve their own doc; merged ones may collapse).

2. **Fan out one audit agent per subsystem, in parallel** (launch them in a
   single message — independent work). Use the `Explore` agent type (read-only;
   it locates and reads code). Each prompt should demand: what the subsystem
   does, how it's built, key functions/exports **with `file:line`**, data
   shapes, integration points, and non-obvious design decisions / past bug-fixes.
   The current subsystem → file mapping:

   | Doc | Cover these files |
   |---|---|
   | `workspaces.md` | `src/main/workspaces.ts`, `store.ts`, `scripts.ts`, `secrets.ts`, `repo-sync.ts` |
   | `git.md` | `src/main/git.ts`, `git-merge-state.test.ts` |
   | `hooks-cli-socket.md` | `src/main/hooks-server.ts`, `cli-shim.ts`, `env-status.ts`, `src/cli/index.ts`, `orchestra-hook.test.ts`, hook scripts in `workspaces.ts` |
   | `activity-pty-terminal.md` | `src/main/activity.ts`, `events-spool.ts`, `pty.ts`, `logger.ts`, `Terminal.tsx`, `RunTerminal.tsx` |
   | `accounts-usage.md` | `src/shared/accounts.ts`, `src/main/account-inherit.ts`, `account-usage.ts`, `usage.ts`, `prompt-queue.ts`, account/usage UI components |
   | `linear.md` | `src/main/linear.ts`, `src/shared/linear.ts` (+ `.test.ts`), `LinearSettings.tsx` |
   | `renderer-ipc-ui.md` | `src/main/index.ts`, `src/preload/index.ts`, `src/shared/ipc.ts`, `App.tsx`, `store.ts`, `chime.ts`, `Sidebar.tsx`, dialog/diff/branch components |
   | `build-release.md` | `package.json`, `vite.config.ts`, `vite.cli.config.ts`, `tsconfig.json`, `scripts/release.sh`, `.github/workflows/`, `.claude/skills/` |

3. **Distill each agent's report into its `docs/codebase-map/*.md`.** Keep it
   dense and navigational: tables of `function — file:line — purpose`, the data
   shapes, and the *why* behind tricky code (the merge-state 3-signal logic, the
   events-spool exactly-once guarantees, the terminal RAF-write latency fix,
   etc.). Strip the agents' "executive summary / conclusion" padding. Cross-link
   sibling docs with relative links (e.g. `[git.md](git.md)` — they share the
   folder). Match the existing docs' tone.

4. **Refresh CLAUDE.md if the subsystem set changed.** If you added or removed a
   doc, update the routing table in the project `CLAUDE.md` so every doc is
   listed (and the "Keep the map current" section if its wording references the
   set). Refreshing existing docs' *contents* needs no CLAUDE.md change.

5. **Report** which docs changed. Don't commit unless asked.

## Notes

- Line numbers drift — the docs are a fast index, not ground truth. Every doc
  says so; keep that caveat.
- This is read-only auditing plus doc writes — it never modifies `src/`.
- Scale agent count to the tree: one per subsystem above is the baseline; split a
  doc out if a file has grown large enough to deserve its own.

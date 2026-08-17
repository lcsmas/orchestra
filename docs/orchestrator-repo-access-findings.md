# Orchestrator repo access — investigation findings

Branch: `orchestrator-repo-file-access`. Date: 2026-08-17.

## Problem

A `kind: 'orchestrator'` workspace is repo-less by construction (`repoPath: ''`,
directory under `SCRATCH_ROOT`, no checkout). Its agent therefore cannot read the
repo's `knowledge/`, `learnings/`, `scripts/`, or its git-tracked project skills
(`.claude/skills/*`). User's coordinator (`bloc2-mc-next-migration-poc`)
coordinates 5 metarepo children but cannot see any metarepo file.

## Verified facts (each with the command/anchor that proves it)

- **Project skills are CWD-only.** `sdkListSkills` (`src/main/agent-sdk.ts:1220-1228`)
  pushes exactly two roots: `<ws.worktreePath>/.claude/skills` (source `project`)
  and `<configDir>/skills` (source `user`). Only 3 occurrences of a project-skills
  path repo-wide: `workspaces.ts:4126`, `:4128`, `agent-sdk.ts:1226`.
- **No redirect mechanism exists.** Orchestra passes NO skills flag to the CLI or
  SDK. Agent cwd is `ws.worktreePath` for both transports
  (`agent-sdk.ts:889`, `pty.ts:326` via `workspaces.ts:4013`). Account-inheritance
  symlinks (`account-inherit.ts:359-365`) are USER-scope only.
- **Generated skills are kind-agnostic**: `installOrchestraHooks(worktreePath)`
  writes to `<worktreePath>/.claude/skills` (`workspaces.ts:4126`) for all kinds.
- **`isScratchLike` is KIND-only** (`types.ts:440`) — it never reads `repoPath`.
  Its own docblock (`types.ts:435-439`) says it should answer "is this a real git
  worktree?". That mismatch is the design gap.
- **`pruneOrphanedWorkspaces` is SAFE** (`workspaces.ts:742`): `if (isScratchLike(ws)) continue;`
  precedes any `repoPath` read, so a repo-owning orchestrator cannot be pruned.
- **The `repoPath` hazard docblock (`workspaces.ts:1861-1881`) is NOT stale.** It and
  the prune fix shipped together in commit `5e12ed2` (2026-08-05), whose body carries
  a measured 3-arm test:
  `naive(repoPath filled) unguarded -> deleted: ['assoc-coordinator']`.
  Four other consumers were "inert only by accident of the empty repoPath".
- **`repoAssociation` is renderer-only** — every non-`types.ts` consumer is sidebar
  grouping (`orchestrator-repo-grouping.ts`, `Sidebar.tsx`). Display-only by contract.
- **Metarepo worktree cost = 3.0 MB** (`du -sh`), submodules unpopulated (0 entries;
  lazily loaded via `wt-load`). Shared knowledge dirs are small and submodule-free:
  knowledge 52 files/284K, learnings 12/280K, scripts 14/232K, index 26/108K, docs 3/12K.

## Breakage inventory if `repoPath` is set on a `kind:'orchestrator'` (audited)

Ranked by severity. All silent unless noted.

1. `workspaces.ts:638` **teardownWorkspace** — `if (isScratchLike(ws))` returns at
   `:648`, skipping `removeWorktree` (~`:678`) and the repo archive script (~`:661`).
   **Git worktree leaks.** `:641` also confines `rm -rf` to `SCRATCH_ROOT`, so a
   checkout under `ORCHESTRA_ROOT` is not even removed. Prune won't reap it (site is
   kind-gated), and a leaked record blocks `removeRepoByPath`.
2. `workspaces.ts:904` **renameWorkspaceBranch** — early-returns before
   `renameWorktreeBranch` (~`:943`): `git branch -m` never runs, so `ws.branch`
   becomes a label naming no real ref. Hardcodes `scratch · ${newBranch}`, clobbering
   an `orchestrator · ` prefix. Fires ROUTINELY (orchestrators ship
   `branchManuallySet: false`). `:985` also skips `freeBranchName` dedupe.
3. `App.tsx:426` — one `isScratch` feeds 7 conditionals (`:437,571,608,635,714,733,825`):
   no Diff tab, Run tab, merge button, or PR badge. Meanwhile `api-handlers.ts:992`
   still computes diff stats → sidebar shows "+120 −30" with no way to open it.
4. `activity.ts:228,313,354` — merge-state, out-of-band branch-rename reconciliation,
   release pills all dead. The rename one is corrosive: `ws.branch` drifts permanently.
5. `workspaces.ts:1977,1984` **dispatchVerifyLandedRequest** — refuses the
   orchestrator's own integration branch as subject AND as implicit `--into` target.
6. `Sidebar.tsx:1403` — excluded from its own repo section; falls to the pinned
   Orchestrators section. Renders once (no double-render) but in the wrong place,
   and `repoAssociation` becomes a competing grouping key.
7. `workspaces.ts:1730` **/demote** refuses ("repo-less by nature") → no clean exit
   from the role, and delete leaks (risk 1).
8. `workspaces.ts:1502` **spawn inheritance** reads `repoPath` directly (NOT
   `isScratchLike`) → bare `orchestra spawn` silently starts inheriting.
   `ORCHESTRATOR_BRIEF` (~`:460`) says "You have no repo of your own" — becomes false.
9. Loud/safe: `api-handlers.ts:1089` throws `'not a git workspace'`;
   `sandbox-import.ts:191` throws `'scratch sessions have no git checkout to import'`.
10. Already-inconsistent BARE-kind gates: `api-handlers.ts:983`, `:992`, `:1037`,
    `link-backfill.ts:57`, `StructuredView.tsx:954`.

## Candidate fix (hypothesis under test)

Redefine `isScratchLike` to match its own docblock — ask about repo ownership
rather than kind:

```ts
// types.ts:440
return !ws.repoPath;   // "is this a real git worktree?"
```

Rationale: every call site was written against the DOCUMENTED meaning, so this may
be correct-by-construction. MUST be verified per-site against 5 cases: plain
scratch, repo-less orchestrator, repo-owning orchestrator, plain worktree,
promoted worktree.

## Open questions

- Where does a repo-owning orchestrator's worktree live — `ORCHESTRA_ROOT` or
  `SCRATCH_ROOT`? Decides whether teardown leaks (see risk 1).
- Migration: an existing orchestrator has `repoPath:''`, `baseBranch:''`, a
  `SCRATCH_ROOT` dir, and `branch` = a `randomBranchName()` LABEL, not a real ref
  (`createScratchLikeWorkspace`, `workspaces.ts:474-501`). Materializing a real
  worktree in place, under a live agent, is the crux.
- Does `repoAssociation` become redundant, or stay as display-only grouping?

## NOT verified

- Whether the `claude` CLI honours any additional skills-search knob (Orchestra
  passes none, so this repo cannot answer it).
- Whether the one-line `isScratchLike` change is actually safe at all 39 sites.

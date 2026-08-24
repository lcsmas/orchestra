---
name: map-codebase
description: (Re)generate the Orchestra codebase map — fan out parallel audit agents across every subsystem and (over)write the reference docs in docs/codebase-map/. Use when the architecture docs are stale, after a big refactor, or to bootstrap the map from scratch. This GENERATES the docs; CLAUDE.md's routing table is what points future work at them.
---

# Regenerate the codebase map

This skill rebuilds the per-subsystem reference docs under **`docs/codebase-map/`** by auditing the
**current** source, so run it whenever the map has drifted from reality (after a refactor, a new
subsystem, or moved files). It overwrites the docs in place — prior versions stay in git to diff
against.

The docs are consumed via the routing table in the project `CLAUDE.md`, which points future work at
the right doc. This skill is the *producer* of those docs.

## Procedure

1. **Re-scan the source layout** so the audit reflects today's tree:

   ```bash
   find src -name '*.ts' -o -name '*.tsx' | sort
   find src -name '*.ts' -o -name '*.tsx' | wc -l
   wc -l src/main/*.ts src/renderer/*.tsx src/renderer/components/*.tsx
   ls docs/codebase-map/
   ```

   Read `src/shared/types.ts` first — it's the documented domain backbone and the fastest
   orientation. Also scan the build/config files the map covers (`package.json` scripts,
   `vite*.config.ts`, `tsconfig.json`, `scripts/`, `.github/workflows/`, `.claude/skills/`), since
   new bundles land there first.

   Done when you have the file list and its total count on screen.

2. **Derive the subsystem assignment from step 1's output.** Take `ls docs/codebase-map/` as the
   current partition and assign every file from step 1 to exactly one doc, by reading where the file
   is imported and what it does. Print the assignment as a `| Doc | Files |` table.

   Done when the assignment's file count equals step 1's total count, and each file appears once. A
   file that fits no existing doc is the signal that a doc is missing — add one (and add its row to
   `CLAUDE.md` in step 4). A doc that draws zero files is a candidate to merge into a sibling.

3. **Fan out one audit agent per doc, in parallel** — launch them in a single message, since the
   audits are independent. Use the `Explore` agent type (read-only; it locates and reads code). Give
   each agent its file list from step 2 and demand: what the subsystem does, how it's built, key
   functions/exports **with `file:line`**, data shapes, integration points, and non-obvious design
   decisions / past bug-fixes.

   Done when one agent has returned per row of the step-2 table.

4. **Distill each agent's report into its `docs/codebase-map/*.md`.** Write it navigational: tables
   of `function — file:line — purpose`, the data shapes, and the *why* behind tricky code (the
   merge-state 3-signal logic, the events-spool exactly-once guarantees, the terminal RAF-write
   latency fix). Drop the agents' "executive summary / conclusion" sections. Cross-link sibling docs
   with relative links (e.g. `[git.md](git.md)` — they share the folder).

   Done when every claim in the doc carries a `file:line` or a code/data shape, and each doc opens
   with the same line-numbers-drift caveat its siblings carry.

5. **Refresh CLAUDE.md if the subsystem set changed.** Adding or removing a doc means updating the
   routing table in the project `CLAUDE.md` (and the "Keep the map current" section, if its wording
   references the set).

   Done when `ls docs/codebase-map/` and the `CLAUDE.md` routing table list the same set of docs.
   Refreshing existing docs' *contents* needs no `CLAUDE.md` change.

6. **Report** which docs changed, and leave the changes uncommitted unless the user asks for a
   commit.

## Notes

- Line numbers drift — the docs are a fast index, not ground truth. Every doc says so; keep that
  caveat.
- This is read-only auditing plus doc writes: the audit agents are `Explore` (read-only), and the
  only writes go to `docs/codebase-map/` and `CLAUDE.md`.
- Agent count follows step 2's table, one per doc. Split a doc out when one file has grown big
  enough to carry its own.

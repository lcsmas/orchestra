# Structured agent view — performance trace (A5 acceptance gate)

The "beautiful, crisp, **snappy, max FPS**" requirement, measured against the
real integrated app (A1+A2+A3+A4 + A5 theme), not a mock.

## Method

A built Orchestra instance ran inside a **headless-sway** compositor on a visible
workspace (so rAF is NOT throttled — off-screen throttling would invalidate the
frame numbers). A dep-free CDP harness (`scripts/perf/agent-view-perf-trace.mjs`):

1. asserts the injection seam exists (`window.__injectAgentEvent`) — exits loud
   if absent, so it never "traces" an app that ignored every event;
2. opens the structured tab for a seeded `worktree` workspace;
3. injects a long synthetic session — real `AgentEvent`s (`session/init`,
   per-message `block-start` → 40 `text-delta`s → `block-stop`, a `tool-use` +
   `tool-result` every 3rd message, a `turn-end` every 10th) — through the SAME
   `enqueue → foldEvents → RAF-batched setState` path a real `agent:event` takes
   (not a state bypass, so the batching/virtualization gate is not vacuous);
4. captures a CDP `Tracing` timeline over the whole burst-backlog drain;
5. reads the folded session back (`__readAgentSession`) as a positive control
   that folding actually happened.

**Primary signal** = main-thread long-task budget + scripting time
(throttle-independent). Frame intervals corroborate (rAF confirmed un-throttled:
median pinned at 16.7 ms = the 60 Hz frame budget).

## Results (measured)

| Session | Events injected | Folded msgs | Burst drain | Frame median | Frame p95 | Frame max | Long tasks >50 ms | Scripting |
|--------:|----------------:|------------:|------------:|-------------:|----------:|----------:|------------------:|----------:|
| 400 msg | 17,109 | 534 | 1,681 ms | **16.7 ms (59.9 fps)** | 16.8 ms | 23.4 ms | 1 (worst 63 ms) | 439 ms |
| 600 msg | 25,661 | 800 | 2,325 ms | **16.7 ms (59.9 fps)** | 16.8 ms | 33.3 ms | **0** | 634 ms |

**Verdict: PASS.** Idle frame cadence is locked to ~60 fps regardless of session
length (the virtualized list windows to the viewport, so DOM node count stays
bounded ~viewport/row-height + overscan). During the worst case — draining a
17k–25k-event backlog injected as fast as the app accepts it — the 400-msg run
saw a single 63 ms long task (~4 frames, the initial virtualization measure) and
the 600-msg run saw **zero** long tasks over 50 ms. Real streaming (deltas
trickling over a socket) is strictly easier than this all-at-once burst.

What holds it (owned by A2/A3, confirmed here): windowed render (only visible
rows mount), RAF-coalesced delta application (one setState/frame, not one/token),
and per-bubble/per-card memoization (a token delta elsewhere doesn't re-render
the transcript). The A5 theme layer adds no per-frame cost — animations are
`opacity`/`transform` only and tool-card reveal doesn't measure layout.

## Themes (verified on the real app, pixel-ground-truthed)

Both themes render correctly on the real component DOM. Verified by decoding the
actual screenshot pixels (not the rendered preview — a downscaled preview can
wash a light pane toward the dark chrome around it):

- **Dark** (default, exact app match): pane `#12151a`, cards `#1a1f26`, text `#e6e9ef`.
- **Light** (best-effort, via `data-agent-theme="light"`): pane **`(255,255,255)`**,
  cards **`(246,247,249)`** = `#f6f7f9`, text ink **`(28,35,48)`** = `#1c2330`
  (dark-on-white, readable). App chrome around it stays dark (app is dark-only).

WCAG AA holds in both themes (body 15+:1, dim/tool-name ≥5.5:1, footer/faint
metadata ≥4.7:1). All motion is under `prefers-reduced-motion` guards.

## Reproduce

```bash
# 1. build:  pnpm run build
# 2. launch in headless-sway on a debug port with an isolated home (see the
#    verify / headless-sway-e2e skills); seed an ok self-tune run to stop the
#    scheduler spawning headless claude.
# 3. inject a worktree workspace via CDP __orchestraSetState, then:
node scripts/perf/agent-view-perf-trace.mjs --port <port> --ws <wsId> --messages 600
```

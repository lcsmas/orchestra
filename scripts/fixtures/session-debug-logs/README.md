Real `--debug-file` excerpts (#177 captures + C1's harness sessions) for the field budget alarms (#214). Only the lines the alarm
reads are kept, byte-for-byte (`[API:timing] dispatching to firstParty model=…`, `[API REQUEST]`, `first byte after`,
`API error x-client-request-id`); ids/timestamps only. Cut a few lines after the first main reply.

- real-title-and-opening-turn.txt — title (haiku) + opening turn dispatched in the SAME ms, answered in the other order (2026-09-29).
- real-one-count-tokens-before-reply.txt — ONE count_tokens before the opening turn's first byte, post-#176 build (2026-09-30).
- real-count-tokens-burst.txt — the #176 fan-out: 52 count_tokens before the first reply (2026-09-29).
- real-errored-opening-request.txt — an opening request that ended in `API error` (429).
- real-cli-fake-api-normal.txt / real-cli-fake-api-boot-context-read.txt — the debug log of C1's harness session (#208, production config:
  the real `claude` 2.1.284 against the local fake API, API-key auth, nothing disabled) — request lines carry NO `x-client-request-id=`;
  the normal session sends its haiku title call + the main turn, then ~57 count_tokens AFTER the reply (the turn-end gauge); the
  boot-context-read mutant (the #176 boot-time getContextUsage re-added) sends 57 count_tokens BEFORE the first reply.
- real-mcp-connect.txt — the `Successfully connected (transport: …)` lines of one real session: stdio servers are child processes, http ones are not.

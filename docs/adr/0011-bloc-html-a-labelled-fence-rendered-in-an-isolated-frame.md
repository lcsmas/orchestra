---
status: accepted
date: 2026-11-10
---

# A bloc HTML is a labelled code fence, rendered in an isolated frame with no network

Replies were markdown only, and `MarkdownView` drops raw HTML on purpose so model output cannot inject markup. The maintainer wants richer answers (layouts, charts, tabs), so the model may now write a **bloc HTML**: a ` ```html-render title="…" ` fence inside a markdown reply, rendered in place once the fence closes. It runs in a sandboxed frame with an opaque origin, its own scripts allowed, no network at all, and no channel back to the app or the conversation; any navigation it attempts is stopped and replaced by a confirmation showing the full URL. One setting (on by default) both tells every workspace session the surface exists and allows the rendering; off, a bloc HTML is a code block again. It is rendered in the agent's replies only, never in a tool output, a user message or a sub-agent card. On the phone, a bloc is served by a dedicated route under its own policy, guarded by the Tailscale identity plus a short-lived, unguessable id tied to the token. Decided with the maintainer in a grilling session (2026-11-10); the look is variant A of the prototype (in the flow, app theme, height of its content, clipped past a cap).

## Considered options

- **A dedicated tool or MCP server instead of a fence** — rejected: a tool card, a permission and a server for the same result, and the bloc would leave the reply text (transcript, replay, previews).
- **Plain ` ```html `** — rejected: in a coding app the model shows HTML as a sample all the time; that must stay a code block.
- **Raw HTML rendered in the renderer** — rejected: the main window has no CSP and the model's markup would reach `window.api`.
- **Allowing a CDN allowlist** — rejected: any reachable host is a leak channel (a page the agent read can make it write a bloc that sends a secret in an image URL).
- **Phone renders with scripts off only** — kept as the fallback if the route does not hold under Safari iOS (not measured).

## Consequences

- **The phone route serves conversation data without the bearer token**, because a frame navigation cannot carry a header. The id is minted through the authenticated API, expires in minutes and dies when the token is regenerated or Accès mobile is turned off.
- **`html-render` is frozen**: it lives in every transcript from now on.
- **Navigation is the one leak channel the frame's policy does not close**; the main-process guard is load-bearing, not polish.
- Measured on Electron 33.4.11 / Chromium 130 (prototype branch `prototype/bloc-html`, `probes/result-2026-11-10.json`): the frame cannot read its parent or `window.api`, its fetches and images are blocked (a frame without the policy reached the listener), an unguarded navigation reached an external server and a `will-frame-navigate` guard stopped it; under the phone page's current CSP an inline-scripted `srcdoc` frame is blocked while the dedicated route runs with an opaque origin and never reached the API; an infinite loop in a bloc leaves the host window responsive (separate process; a same-origin control froze it).
- **The app window has no network** (#415 B1, D3): a frame's CSP does not cover WebRTC `iceServers` (STUN/UDP, TURN/TCP, `turns:`, also from a nested `<iframe srcdoc>`, which `frame-src 'none'` does not stop — measured), so the app window's session sends every scheme to a closed port and WebRTC is limited to proxied UDP. Consequence outside blocs: **a remote image in a reply (`![](https://…)`) does not load** and fails quietly (alt text, no broken layout; measured). `dns-prefetch` is the one residual (next bullet).
- **A bloc has no network EXCEPT that it can make the app resolve a host name** (#424, D4): a `<link rel="dns-prefetch" href="//<chosen>.example">` — static, `createElement`+`rel`, `setAttribute`, `innerHTML`, DOMParser+`importNode`, and a no-CSP control — each emitted a Chromium resolver request for the chosen host (net-log `HOST_RESOLVER_*`, Electron 33.4.11; 2 events per vector, the instrument said YES on the control). The frame's CSP, the black-hole proxy, `x-dns-prefetch-control`, the NetworkPrediction/DNSPrefetch flags and a dedicated partition do not stop it; Trusted Types closes only the string sinks; a global `--host-resolver-rules` closes all 6 but breaks the browser panel and login (it would need a SOCKS5 relay for them). **Not closed, accepted by the maintainer:** a prompt-injected reply can leak a few bytes per resolution as DNS labels.
- A themed frame must not declare `color-scheme` (Chromium then paints it opaque), and its height can only be reported by a script inside it.

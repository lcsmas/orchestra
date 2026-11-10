---
status: accepted
date: 2026-11-10
---

# A bloc HTML is a labelled code fence, rendered in an isolated frame

Replies were markdown only, and `MarkdownView` drops raw HTML on purpose so model output cannot inject markup. The maintainer wants richer answers (layouts, charts, tabs), so the model may now write a **bloc HTML**: a ` ```html-render title="…" ` fence inside a markdown reply, rendered in place once the fence closes. It runs in a sandboxed frame with an opaque origin, its own scripts allowed, network over `https:` only (amended 2026-11-10, see below), and no channel back to the app or the conversation; any navigation it attempts is stopped and replaced by a confirmation showing the full URL. One setting (on by default) both tells every workspace session the surface exists and allows the rendering; off, a bloc HTML is a code block again. It is rendered in the agent's replies only, never in a tool output, a user message or a sub-agent card. On the phone, a bloc is served by a dedicated route under its own policy, guarded by the Tailscale identity plus a short-lived, unguessable id tied to the token. Decided with the maintainer in a grilling session (2026-11-10); the look is variant A of the prototype (in the flow, app theme, height of its content, clipped past a cap).

## Considered options

- **A dedicated tool or MCP server instead of a fence** — rejected: a tool card, a permission and a server for the same result, and the bloc would leave the reply text (transcript, replay, previews).
- **Plain ` ```html `** — rejected: in a coding app the model shows HTML as a sample all the time; that must stay a code block.
- **Raw HTML rendered in the renderer** — rejected: the main window has no CSP and the model's markup would reach `window.api`.
- **Allowing a CDN allowlist / any network** — first rejected as a leak channel (a page the agent read can make it write a bloc that sends a secret in an image URL); **reversed 2026-11-10 (D5)**: the maintainer's agents already have full network access through their tools, so a network-less bloc protected nothing and cost features. Plain `http:` stays refused.
- **Phone renders with scripts off only** — kept as the fallback if the route does not hold under Safari iOS (not measured).

## Consequences

- **The phone route serves conversation data without the bearer token**, because a frame navigation cannot carry a header. The id is minted through the authenticated API, expires in minutes and dies when the token is regenerated or Accès mobile is turned off.
- **`html-render` is frozen**: it lives in every transcript from now on.
- **Navigation of a frame is refused in main** (`will-frame-navigate`, #416 turns it into a confirmation showing the full URL). Since D5 it is a UX guard (the human sees a URL before anything opens), no longer the one leak guard.
- Measured on Electron 33.4.11 / Chromium 130 (prototype branch `prototype/bloc-html`, `probes/result-2026-11-10.json`): the frame cannot read its parent or `window.api`; an unguarded navigation reached an external server and a `will-frame-navigate` guard stopped it; under the phone page's current CSP an inline-scripted `srcdoc` frame is blocked while the dedicated route runs with an opaque origin and never reached the API; an infinite loop in a bloc leaves the host window responsive (separate process; a same-origin control froze it). (Its network measurements — fetches/images blocked, WebRTC, `dns-prefetch` — are superseded by the amendment below.)
- A themed frame must not declare `color-scheme` (Chromium then paints it opaque), and its height can only be reported by a script inside it.

## Amendment — 2026-11-10: the network axis is reversed (ledger #423 D5, maintainer ruling)

The maintainer's agents already reach the whole network through their tools, so a network-less bloc protected nothing and cost features (remote images in replies, the spellcheck dictionary, CDN chart libraries). This section supersedes every "no network" statement above and in the first version of this ADR (the title, "no network at all", the CDN-allowlist rejection, the `app window has no network` and `dns-prefetch` consequences, #424).

- **A bloc may use the network over `https:`**: script, style, image, font, `fetch`/XHR and `wss:`, plus `data:` and `blob:`; inline script and style stay. Plain `http:`/`ws:` is refused, as are frames, workers, media, forms and `<base>` (`default-src 'none'`). The policy is `BLOC_HTML_POLICY` in `src/shared/bloc-html-document.ts` (one string; #421's phone route reuses it as its response policy):
  `default-src 'none'; script-src 'unsafe-inline' https: blob:; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; connect-src https: wss: data: blob:; base-uri 'none'; form-action 'none'`.
- **The app window has its network back**: the black-hole proxy and the WebRTC IP policy added in #415 are removed. A remote image in a reply loads; the spellcheck dictionary downloads.
- **Unchanged, each with a must-FAIL arm in the rig** (`pnpm run test:bloc-html`): the sandbox with an opaque origin (the frame cannot read the parent document, the app's API object or any storage); a looping bloc leaves the window responsive; a bloc cannot send anything to the conversation; a frame cannot navigate (the confirmation of #416 is kept).
- **What the policy is, honestly**: it keeps a bloc to encrypted fetches and removes cleartext and nested frames; it is not a confinement of where data can go — an `https:` host chosen by the model is reachable by design, and WebRTC `iceServers`/`dns-prefetch` bypass a CSP and are no longer findings. The isolation that matters is from the app (origin, API, storage, conversation), not from the network.
- The phone route (#421) takes the same policy and must still not reach the Accès mobile API or the token (its refusal tests are unchanged by D5).
- Rig: arms that asserted "nothing reaches a listener" (policy, WebRTC UDP/TCP, S1) are removed; replaced by must-PASS `N1` (an https request from a bloc succeeds: script, style, img, fetch, XHR, `wss:`, blob, data — a local https listener with a rig-only SPKI pin), must-PASS `N2` (an http request is refused, an http listener sees nothing) with must-FAIL arms `policy`, `policy-http` (policy loosened to http:) and `policy-nohttps`, and S1 inverted (a remote image in a reply loads, pixel-checked).

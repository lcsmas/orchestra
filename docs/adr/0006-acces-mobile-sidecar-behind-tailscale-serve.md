---
status: accepted
date: 2026-10-11
---

# Accès mobile: a sidecar behind `tailscale serve`; only delivery stays in main

The human wants to talk to every workspace, whatever its Claude account, from
an iPhone. The agents run in `bypassPermissions`, so any network surface that
sends a message is remote code execution on the machine — and the machine's
tailnet is the company's, shared with ~20 colleagues' devices, so "tailnet only"
is not "the human only". We serve a PWA from a **separate process spawned by
main** that owns everything network-facing (HTTP, the token, the
`Tailscale-User-Login` identity check, static files) and talks to main only
through the existing `0600` Unix-socket hooks server. **Main opens no port.**
Delivery stays in main because a keeper accepts one client at a time and main
is that client. The process listens on `127.0.0.1` only; the human configures
`tailscale serve` once by hand — Orchestra never touches the Tailscale config.
Decided with the user on 2026-10-11 (grilling session).

## Considered options

- **HTTP server inside main** — rejected: a parser/auth defect or a slow client
  would hit the process driving 40+ agents and holding every capability.
- **Independent daemon (systemd unit) surviving app quit** — rejected: it could
  not deliver without main (keeper slot is exclusive), so it would only add an
  "Orchestra closed" page the PWA can render itself.
- **Bind on the Tailscale IP with a token only** — rejected: reachable by every
  device on the company tailnet; `serve` adds HTTPS (required by iOS PWAs) and
  an identity header tailnet clients cannot forge.

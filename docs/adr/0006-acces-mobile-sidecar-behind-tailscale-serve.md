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
over a **private channel main hands it at spawn: fd 3, a socketpair** (NDJSON
RPC). NOT the hooks socket: every local agent can reach that one, and the
phone's send speaks with the human's origin (allowed while a fleet run is
paused) — on the hooks socket any agent could have spoken as the human (review
of #338). **Main opens no port.**
Delivery stays in main because a keeper accepts one client at a time and main
is that client. The process listens on a **0600 Unix socket in a 0700 directory —
no TCP port at all** (`tailscale serve … unix:<path>`; tailscaled runs as root):
a free loopback port can be taken by any local process, which then receives the
phone's bearer token (found by the independent review of #334). The process is
exec'd after closing every inherited fd above 3, so it holds nothing of main's
but its channel (it had inherited main's DevTools LISTEN socket). The human configures `tailscale serve`
once by hand — Orchestra never touches the Tailscale config.
Decided with the user on 2026-10-11 (grilling session).

## Considered options

- **HTTP server inside main** — rejected: a parser/auth defect or a slow client
  would hit the process driving 40+ agents and holding every capability.
- **Independent daemon (systemd unit) surviving app quit** — rejected: it could
  not deliver without main (keeper slot is exclusive), so it would only add an
  "Orchestra closed" page the PWA can render itself.
- **TCP on 127.0.0.1 behind serve** — the first cut; rejected at review: port
  squatting while the app is off or restarting harvests the token.
- **Bind on the Tailscale IP with a token only** — rejected: reachable by every
  device on the company tailnet; `serve` adds HTTPS (required by iOS PWAs) and
  an identity header tailnet clients cannot forge.

## Trust boundary (final review of #338/#339, 2026-10-12)

The boundary this design defends is **the network**: a colleague's device, a
tagged device, the LAN, a web page in the owner's browser. Every one of those
needs the owner's Tailscale identity (set by `serve`, stripped from clients)
AND the token. **Processes running as the owner's Unix user — every agent —
are inside the boundary**: they can read the token file, connect to the 0600
socket and forge the identity header, and on this host (`ptrace_scope` 0)
take the server's fd 3. They can equally drive a keeper socket, edit the
store or kill a process; a Pause is fleet coordination, not a sandbox. The
private fd-3 channel removes the *documented, one-line* way for an agent to
speak as the human (a hooks-socket route), not a determined same-user
process. Raising that bar (token never on disk, a non-dumpable server, a
separate Unix user) is a separate decision.

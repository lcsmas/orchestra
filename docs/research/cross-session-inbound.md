# `crossSessionInbound` — measured policy support on the installed CLI

Spike for [#25](https://github.com/lcsmas/orchestra/issues/25) (defensive
`crossSessionInbound` policy). Extends the cross-session finding in
[#13](https://github.com/lcsmas/orchestra/issues/13) /
`docs/research/sdk-runtime-payloads.md` §5, which measured the defect but left
the policy question open ("or requires opting in via settings; **not probed
further**"). This doc probes it.

**Rig** (2026-08-24): installed CLI **2.1.241**, SDK
`@anthropic-ai/claude-agent-sdk` **0.3.241**, Node v22.22.0. Two concurrent
`query()` sessions on one machine, both `permissionMode: 'bypassPermissions'`,
model `haiku`, `pathToClaudeCodeExecutable` pinned to `~/.local/bin/claude`.
Receiver A idle (generator open, warmed with a zero-cost `/context`); sender B
drives `ListAgents` → `SendMessage` addressed by peer NAME. One arm per policy,
byte-identical except the `settings` value.

> **Version note.** #13's verdicts were pinned to CLI **2.1.234**; the binary
> auto-updated to **2.1.241** before this spike, so every ABSENT verdict there
> had already expired. The auto-run defect was re-measured here and still
> reproduces — see the control arm.

## Support matrix — all three policies exist and are honored

Observables on the RECEIVER after an unsolicited inbound peer message:

| arm (`settings.crossSessionInbound`) | assistant turns | cost (USD) | re-emitted `system/init` | `result.origin` | verdict |
|---|---|---|---|---|---|
| *(unset — control)* | 1 | **0.1316** | 1 | present | **auto-runs a paid turn** |
| `'accept'` | 1 | **0.1317** | 1 | present | auto-runs (same as unset) |
| `'hold'` | 0 | **0** | 0 | none | **turn suppressed** |
| `'refuse'` | 0 | **0** | 0 | none | turn suppressed |

The control arm reproduces #13's defect on CLI 2.1.241 — so the rig
**discriminates**, and the `hold`/`refuse` zeroes are a measurement rather than
a fixture artifact.

### Why the unset default auto-runs (the mechanism, from the vendor)

Not "moderation is off" — the SDK's own doc string on `Settings.crossSessionInbound`
(sdk.d.ts:7716) states the unset behaviour is **mode parity**: a message
auto-delivers when the sending session's permission-mode class matches the
receiver's (bypass↔bypass or prompting↔prompting), and a mismatched sender is
held. Orchestra runs its agents in `bypassPermissions` by design and so does
any other local agent, so parity is satisfied and the turn runs. This is why
the defect is structural for Orchestra rather than incidental.

## Adopted: `'hold'`

Both `hold` and `refuse` satisfy the requirement ("must NOT auto-run a paid
turn"). `hold` is adopted as the **least-destructive** of the two:

- Per the vendor's own words it "parks them for your review **without letting
  Claude act**" — the message survives for a human, where `refuse` "opts this
  session out" and discards it.
- The two are **indistinguishable from the sender's side** — measured: both
  still return `success:true` with a `msg_id` to the sending agent
  (`"ping-from-B-hold" → xsitarget-28`), neither surfaces an error. So `refuse`
  buys no extra signal to the sender; it only destroys more.

## Orchestra's own inter-agent messaging is unaffected — different channel

`orchestra message` never touches the CLI peer socket.
`dispatchMessageRequest` (`src/main/workspaces.ts`) delivers by one of three
Orchestra-owned paths: an enqueued turn on the live SDK session (`sdkDeliver`),
a PTY write for terminal-mode workspaces, or the durable per-workspace inbox
file drained by a SessionStart hook.

Measured as an absence claim at upstream `48bdbcb` (excluding this branch's own
additions, which necessarily mention the term):

```
$ git grep -c "SendMessage\|messaging_socket\|cc-socks" 48bdbcb -- src/
(no output — zero hits)
$ git grep -c "sdkDeliver" 48bdbcb -- src/        # positive control
48bdbcb:src/main/agent-sdk.ts:2
48bdbcb:src/main/sdk-delivery.ts:1
48bdbcb:src/main/workspaces.ts:4
48bdbcb:src/shared/diff-annotations.ts:1
```

So the policy gates only the unsolicited outside channel.

## Where the setting is applied, and why inline

Passed as an inline `settings` object on `query()`
(`src/main/agent-sdk.ts`, beside `permissionMode` /
`allowDangerouslySkipPermissions`). The SDK loads inline settings into the
**"flag settings" layer — the highest priority among user-controlled settings**
(sdk.d.ts:1962-1979). Two consequences, both wanted:

- a stale `crossSessionInbound` in the user's `~/.claude/settings.json` cannot
  silently override Orchestra's policy;
- `settingSources: ['user','project','local']` is untouched, so every Orchestra
  hook living in `.claude/settings.local.json` keeps loading.

Verified in the **emitted bundle**, not just the source
(`dist-electron/index-*.js`, the 440 kB main chunk — `main.js` is a 135-byte
loader stub):

```
settings:Vw(...)   →   function Vw(e){return{crossSessionInbound:Kw}   →   Kw="hold"
```

## Mutation test (the guard has been seen to fail)

Driving the real two-session probe while importing Orchestra's own
`withCrossSessionInboundPolicy()`:

| arm | turns after ping | cost | re-emitted init |
|---|---|---|---|
| SHIPPED (`withCrossSessionInboundPolicy()` → `hold`) | 0 | 0 | 0 |
| MUTATED (guard reverted to `accept`) | 1 | **0.1333** | 1 |

Reverting the guard reproduces the defect through the shipped code path;
restoring it suppresses the turn.

## NOT VERIFIED

- **Where a held message surfaces, and how a human reviews/releases it.** The
  probe measured only that no turn runs and nothing enters the receiver's
  stream; it did not find a queue, a notification, or a release mechanism. If
  a held message is silently unreachable in practice, `hold` and `refuse`
  differ only in name — this is the open question worth a follow-up.
- **Terminal (PTY) workspaces.** This setting is wired on the SDK launch path
  only. Terminal-mode agents spawn `claude` directly and are NOT covered; their
  exposure to the same peer channel is unmeasured.
- **Remote/sandbox sessions.** Same launch site, so they inherit the option,
  but no probe was run inside a container.
- **Real-app E2E** (built app, isolated `ORCHESTRA_HOME`, headless sway) — the
  verifier's gate 5; not driven here.
- All verdicts are pinned to **CLI 2.1.241** and expire on CLI auto-update.

## Repro

`/tmp/xsi-probe/probe.mjs <accept|hold|refuse|control>` (one arm per run) and
`/tmp/xsi-probe/mutation.mjs <shipped|mutated>`.

# Remote sandbox agents

A local workspace stops when your machine sleeps. The **sandbox** moves the whole workspace — agent, checkout, session — into an always-on Docker container, and Orchestra becomes a thin client streaming its terminal.

## Import & eject

- **Import (☁↑)** on a workspace row packs the worktree, the agent's session, and the login it runs under into the sandbox container. The agent resumes there and keeps working — laptop closed, machine off, doesn't matter.
- **Eject (☁↓)** brings it back: the checkout and session return to a local worktree and the agent resumes locally.
- **Auto-backups** — while remote, the sandbox snapshots workspace state periodically, so a container mishap doesn't lose work.

**Use cases:** kick off a long refactor before leaving; keep an orchestrator's fleet grinding overnight; run agents from a lightweight machine while the heavy lifting happens on a server.

## Multi-machine

The same sandbox workspace can be opened from several machines at once. An **ownership lock** makes exactly one machine the *driver* (its keystrokes go to the agent); the others attach read-only and can take over explicitly. Start work at the office, take over from home, nothing to hand off.

## Setup

The sandbox is a Docker image + shim shipped in the repo (`sandbox/`). Point Orchestra at a sandbox endpoint (a machine running the container), and the ☁ actions appear on workspace rows. Environment/secrets contracts and a two-host verification checklist live in [`docs/sandbox-env-contract.md`](../sandbox-env-contract.md) and [`docs/sandbox-two-host-checklist.md`](../sandbox-two-host-checklist.md).

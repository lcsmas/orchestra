---
status: accepted
date: 2026-11-22
---

# The vague loop runs as code, and a fresh-context Gestionnaire takes the exceptions

A verified-fanout vague (spawn, wait for a nomination, gate, review, deliver, next ticket) was led by a coordinator model that re-reads its whole history each turn: 303 M of the 907 M cache-read tokens of the v2 rehearsal, ~30 % of the cost of a model-driven swarm, and a coordinator that stalls without saying so (a Haiku coordinator twice, 46–68 min). The team's bench shows the two other shapes fail from the opposite side: the model-driven orchestrator delivers 7/7 at ~300 $ and decides product questions alone; the code loop with parking delivers 5/7 and waits up to 17 h for a person.

We decide: the vague is led by a **Boucle**, `orchestra fanout run`, in code, with its state on disk. When it cannot go on by rule it raises an **Exception** and spawns a single-use **Gestionnaire** with a fresh, small context (state, the one ticket, the ledger's decisions) that answers with a JSON decision the code validates and applies: a reversible default (traced as a *défaut à relire*), a fix round, or **parking** that one ticket. No human is ever waited on: a parked ticket is final for the run and parks only its transitive dependents; the run always ends with a report.

## Considered options

- **A model coordinator that decides everything on a ladder** (swarm-reclaim) — rejected: the cost and the history re-read are the problem, and product questions are decided with no trace.
- **A code loop that parks every question and waits for a person** (autonomous-swarm) — rejected: the lot waits on a human; its tooling faults became parkings that needed no model at all.
- **The skill keeps driving the verbs** — rejected: it keeps the model in the loop between every step.

## Consequences

- No counter, no throughput cap, no cost or time cap: the end comes from detecting a state already seen, a finite repair catalogue and a decision never rendered twice for the same situation. Termination is not proven if distinct new findings never stop; the only brakes are the human's Pause and `override`.
- The Gestionnaire never widens a spec-fixed interface, never relaxes `fanout deliver`, never merges what it refuses, never makes an irreversible external write.
- `state.json` needs a `parked` status and a reason (`STATE_VERSION` 2, v1 still read); the Gestionnaire is an `explo-` worker.
- The OPS that launches the Boucle only runs it as a background task and stays inert on a wake; the Boucle alone acknowledges bus lots.

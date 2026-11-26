// #609 (vague #601, ledger #613) — the help of the Boucle (`orchestra fanout loop-help`): the verbs #604/#605 ship and the state flags #603 ships, written against the FROZEN NAMES v1.
// Its own text, like SEAT_USAGE: the main `fanout` usage stays byte-identical. The skill's loop section (verified-fanout-skill.ts, seatRecords=on) names only what is here (loop-skill test).
export const LOOP_USAGE = `The Boucle (#601, slice 1) — no model leads a vague: \`fanout run\` takes it from its tickets to its closing report. seatRecords=on, verifier=off (the command inits its own run when none exists).
  orchestra fanout run [--run <id>] [--tickets a,b,c | --plan <plan.json>] [--start-check] [--minor-policy <v>]
        lead the run: plan → start every implementer at once on the frozen names → mail → nominations → open the PR → review → approvals → connect a dependent to its approved upstream → CI → corrections → deliver in readiness order → end.
        Prints the closing report (JSON on stdout, text on stderr): merged · parked (ticket, cause, reason) · choices the agents took · findings left · flaky checks · cost per ticket · the pause.
        Exit 0 every ticket merged · 3 the run ended with ≥1 parked ticket · 4 paused (lift it with \`orchestra fanout state set --run <id> --resume-run\`, then run again) · 2 refused ([run-…]) · 1 could not run.
        It is the ONLY reader of the run's mail and never waits for a person. Killed and started again it adopts every live agent and opens no second agent, pull request or merge.
        --start-check: before the start, open an EMPTY pull request into the target, await its checks, close it; a red check there = the run does not start.
  orchestra fanout loop-help                                     this text
  orchestra fanout plan --tickets <id,id,…> [--run <id>]       (coordinator) spawn the single-use plan agent (explo-plan-<run8>); returns when a plan is accepted
  orchestra fanout plan submit <plan.json>                      (the plan agent) check the plan and answer with the reasons; refused twice = plan-refused-twice, exit 2, the run does not start
        plan.json = {"version":1,"tickets":[{"id","title","spec","dependsOn":[…]}],"interfaces":{"<depended-on ticket>":"<text holding ≥1 exact name in backticks>"}} and nothing else (plan-free-text).
        Refused: plan-bad-json · plan-free-text · plan-ticket-missing · plan-ticket-unknown · plan-duplicate-ticket · plan-cycle · plan-interface-missing · plan-interface-no-name · plan-bad-dependency.
        After an accepted plan \`state set --run-decision\` is refused (decision-after-plan): an order to wait cannot exist.
  orchestra fanout state set <ticket> --park <cause> --park-reason <text>   set a ticket aside (cause: question | situation | ci; a dependent parks itself with cause upstream); its transitive dependents park with "blocked by <ticket>"
  orchestra fanout state set <ticket> --unpark                  put a parked ticket back to work (then run \`fanout run\` again)
  orchestra fanout state set --pause <reason> [--pause-check <name>]   pause the run (the loop does it when one check is red on several pull requests)
  orchestra fanout state set --run <id> --resume-run            lift the pause
  Refused: park-no-reason · park-bad-cause · park-merged · park-unknown-ticket · pause-no-reason · choice-bad. \`state show\` and \`closeout\` print the parked tickets (cause, reason), the choices and the pause.
  An agent's question gets a fixed answer (take the reversible option, record it with orchestra fanout choice <ticket> --question "<q>" --taken "<option>", continue); a body starting with the line "NO SAFE OPTION: <reason>" parks its ticket.`;

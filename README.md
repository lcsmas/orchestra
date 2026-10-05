# pause-ui-mockups-257 — NEVER MERGED

Mockups for #257 (Pause / Reprise in the UI), wave F ledger #281, D2. Rendered on the REAL packaged app (master f636a683, scratch ORCHESTRA_HOME, headless sway):
real sidebar + real Bus pane, real CSS; the Pause controls are DOM injected on top (`mockups/src/kit-*.js`), the state shown is read back with the SHIPPED readers
(`pauseStatusView`, `repriseStatusView`, `listBilan`) from a bus seeded with the SHIPPED writers (`seed-bus.mjs`).

- `A-*` discret — action au survol + badges · `B-*` bandeau permanent sous l'orchestrateur · `C-*` pastille + carte
- `*-1-sidebar` contrôle / badge / progression · `*-2-bus` page Bus (état + Bilan) · `*-3-refusals` refus expliqués

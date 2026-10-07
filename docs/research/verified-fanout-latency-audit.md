# Verified-fanout audits (2026-09-30 → 2026-10-07)

Chronological audits of fleet runs (where wall-clock goes, which rules were applied, what failed), from
several sessions. Each section is self-contained and dated; later sections measure the effect of the
rules the earlier ones led to. SOTA sources: `sota-multi-agent-orchestration.md`.

## 2026-09-30 — Où part le temps d'un verified-fanout (vagues 198, A, B, C)

Verdict : le chemin critique est le **nombre de tours review→fix→re-gate** (≈ 40–60 min chacun, médiane 3 par piste),
pas la build ni la suite. Viennent ensuite la **file du verifier unique**, les **harnais de mutation/rigs longs**
et les **dépendances sérielles entre pistes**.

Corpus : ledgers #198 #224 #234 #237 (commentaires horodatés), bus `~/.orchestra/bus.sqlite`, 96 transcripts
(>300 KB, 2026-09-29 20:00 → 09-30 21:00). Scripts : `verified-fanout-latency-audit/*.py` — they read ledger comments
fetched with `gh api repos/lcsmas/orchestra/issues/<N>/comments --paginate > /tmp/vfaudit/c<N>.json` and the transcripts under `~/.claude-mc/projects/`.

### Mesures

| Étape | Médiane | p75 | n |
|---|---|---|---|
| spawn → 1re nomination (implémentation) | ~45 min | — | 21 |
| nomination → review postée | 12 min | 18 | 55 |
| nomination → verdict verifier | 27 min | 52 (max 167) | 88 |
| review → re-nomination (fix) | 13 min | 18 | 29 |
| `pnpm test` complet (foreground) | 61 s | p90 82 s | 171 |

- Tours par piste : A2 6 nominations (352 min), B2 4 fix rounds (23:36→04:42), B0 5 reviews (137 min), C13 4, C1 5.
- 10 reviews sur 27 (vagues B+C, où la gravité est étiquetée) = **0 BLOCKING / 0 MAJOR** et ont quand même relancé un tour
  complet (ex. B2 r4 « 3 MINOR + 1 NIT » → 80 min jusqu'au merge ; C7b 7 MINOR → +30 min).
- Verifier wave C (siège unique) occupé 91–100 % de 05:00 à 07:30Z ; C12 : 2 h 47 entre nomination et verdict.
- Temps actif par rôle (modèle / attente de harnais / suite / rig) :
  implémenteurs 47 % / 24 % / 10 % / 8 % ; verifiers 42 % / 29 % / 8 % / 11 % ; reviewers 71 % modèle.
  Build + tsc + install < 1 %. `gh`/ledger ≈ 1 %.
- Attente (`until … sleep`) cumulée 18.7 h : harnais de mutation et rigs e2e de 10 à 47 min chacun.
- Dépendances : B5 234 min, C3 208 min, C4 236 min entre spawn et 1re nomination (attendaient B2 / C1).
- Churn rebase/pre-merge : 39 commentaires de re-gate après rebase sur les 4 ledgers.
- Chaque spawn démarre à ~62 k tokens de contexte (LESSONS.md 60 KB + skill 43 KB) ; 55 reviewers spawnés.

### Hors sujet (mesuré, écarté)
- Trou de 25 h dans #198 = HOLD LEAD (ordre humain) + limite d'usage, pas un sommeil de flotte.
- Trous de 12 h dans #234/#237 = pause humaine à 07:33Z.

### NON VÉRIFIÉ
- Classification des commentaires par regex sur la 1re ligne (quelques faux positifs, ex. « Verify B2 » compté en review).
- Les harnais de mutation sont-ils séquentiels (gain de parallélisation) : non mesuré.
- Gain de contexte réduit sur le temps modèle : non mesuré.

## 2026-09-30 — LEAD → OPS → workers vs état de l'art

Verdict : rigueur au-dessus du SOTA (auteur/juge séparés, ledger durable, bus ordonné + fencing) ;
débit sous-optimal — le chemin critique est la boucle review→fix→re-gate et un verifier LLM qui fait
le travail d'une merge queue.

### Mesures locales (reproductibles)
| Mesure | Valeur | Source |
|---|---|---|
| Trafic de vague reçu par le LEAD | 245 / 2 713 msgs (9 %) | bus.sqlite, missions 0524718f + 36773f53 |
| Lots livrés depuis 09-28 ne contenant QUE status/escalation | 1 979 / 2 136 (93 %) ; coord 776/833 | bus.sqlite deliveries×messages |
| Escalations liveness "no session activity" 09-28→30 | 361 (+22 "Bash hung") | bus.sqlite messages kind=escalation |
| status adressés vs worker_done, 09-28→30 | 1 510 vs 7 | bus.sqlite |
| Rounds review sans BLOCKING/MAJOR (B+C) | 10 / 27 | section 2026-09-30 latence ci-dessus |
| nomination → verdict verifier | médiane 27 min, max 167 | idem |
| Attente harnais (mutation/rigs) | 18,7 h cumulées | idem |
| Pistes bloquées sur une autre | B5 234, C3 208, C4 236 min | idem |
| Règles chargées | skill+refs 139 KB, LESSONS 60 KB, ~62 k tokens/spawn | wc -c |
Wake : tout lot non acké (tout kind) réveille — src/main/bus-wake.ts ~l.482 ; statut de phase = broadcast (bus-liveness.ts:538).

### SOTA (détail + URLs : `sota-multi-agent-orchestration.md`)
- Reviewer frais : Cognition ~2 bugs/PR, 58 % sévères, meilleur sans contexte partagé (cognition.com/blog/multi-agents-working).
- Ledger : Magentic-One −31 % sans task/progress ledgers.
- Profondeur : Claude Code agent teams « No nested teams » ; Codex/Jules/Agent HQ plats ; Google arXiv 2512.08296 : −70 % sur planif séquentielle, erreurs amplifiées moins en centralisé.
- Intégration : GitHub merge queue / bors / Gas Town Refinery = batch + spéculatif parallèle + bisect, en code. Cursor : « integrator … created more bottlenecks than it solved » (vérifié verbatim).
- Reviews : Anthropic best practices — un reviewer trouve toujours « des gaps » ; ne remonter que correctness/exigences.
- Règles : IFScale 68 % de conformité à 500 instructions ; Anthropic CLAUDE.md < 200 lignes, règles → hooks.
- Couplage de pistes : « Passes Alone, Fails Together » — broadcast "what changed" récupère 82 %.

### Recommandations (par gain attendu)
1. Shift-left review : l'implémenteur lance un reviewer frais (subagent) AVANT nomination ; le reviewer externe ne remonte que correctness/exigence.
2. Gate mécanique en code (queue tsc+test+build+mutants ciblés, parallèle, batch+bisect) ; verifier LLM gardé pour E2E et design de mutants ; deps installées par worktree.
3. Bus : status non-réveillant, audit des 361 escalations, supprimer le ping ledger quand delivery=ON.
4. Élagage : retirer le texte OFF des 7 switches, briefs par rôle, règles répétitives → hooks.
5. Dépendances : figer l'interface + stub au dispatch, broadcast "what changed" sur interface partagée.

### NON VÉRIFIÉ
- "lot" ≠ "tour" : un lot peut être pris pendant un tour déjà actif ; coût en tokens du bruit non mesuré.
- Chiffres 4.4×/17.2×, seuil 45 %, +285/+515 % : corps du papier Google via sous-agent, pas l'abstract.
- Papiers 2604.02460, 2607.16133, 2609.25396 : lus par le sous-agent (paraphrase), non relus.
- Aucun A/B 2 vs 3 niveaux pour le code n'existe : "3 niveaux OK" est un jugement, pas une mesure.

## 2026-10-01 — Re-audit after the 2026-09-30 changes (window 09-30 19:35Z → 10-01 20:10Z)
Runs: wave D (lcsmas/orchestra#261, closed 10-01 06:40Z) + bloc2 (mobile-club/metarepo#746, live).

| Measure | Before | After | Source |
|---|---|---|---|
| Nominations carrying a pre-review | — | D 7/7, bloc2 14/14 (after order 19:58Z) | ledger NOMINATION comments |
| External reviews with ≥1 in-diff BLOCKING/MAJOR | Orchestra B+C 17/27 (63 %); bloc2 2/6 (33 %) | D 2/5, bloc2 3/15 (+2 out-of-diff) → 5/20 (25 %) | review "Verdict" lines |
| Follow-up reviews finding ≥1 MINOR/NIT | — | 9/9 | follow-up reviews D + bloc2 |
| Lanes with a follow-up chain of ≥3 PRs | — | schema-heal (#1700→#1701→#1702), wp-accounts (#1705→#1710→#1712), importer (#1711→#1713→#1714), D1b (merge + 3 follow-up rounds) | ledgers |
| Nomination → verifier verdict, median | 27 min (waves 198/A/B/C) | 75 min (n=15; D alone 47) | ledger timestamps |
| Nomination → review, median | 12 min | ~20 min | ledger timestamps |
| Vague bus msgs / hour | 35 | 14 | bus.sqlite |
| `dispatch` sent by non-coordinators | 1 | 0 | bus.sqlite |
| Liveness "no session activity" escalations | 145 / 24 h | 104 / 24 h (72 to bloc2 OPS) — 25 % of lots escalation-only | bus.sqlite |

Pre-review catches real MAJORs (D1b r1: 3 MAJOR fixed before review; runwave: 2 MAJOR) but missed 5 MAJOR on D1b r1 (same model, author-written prompt).

NOT VERIFIED: causality (small n, follow-up diffs are smaller, different domains); whether the 104 escalations are false positives (members idle after nominating); use of the frozen-interface rule.

## 2026-10-01 — Bloc 2 fan-out (metarepo#746, 2026-09-28 → 10-01 21:05Z)
Data: ledger #746 (360 comments, body 84 KB), GitHub PR created/merged times (32 PRs), bus.sqlite (vague run ef9f84d0).

### Throughput
26 PRs merged in 3 days: 9 on 09-28 (wave 1), 2 on 09-29/30, 15 on 10-01 (wave 5 + billing lanes).

### Review rounds per PR (same mission, before vs after pre-review / follow-up rules)
| PR | Reviews | Day |
|---|---|---|
| wordpress-monorepo#1688 | 9 | 09-28 |
| workspace#12592 | 6 | 09-28 |
| api#1599 | 4 | 09-28 |
| wordpress-monorepo#1700 | 3 | 09-30 |
| workspace#12617 (+9,320 lines) | 3 (1 BLOCKING = CI) | 10-01 |
| wordpress-monorepo#1705 | 2 | 10-01 |
| #1710 #1711 #1712 #1713 #1714 #12619 | 1 each | 10-01 |

### Follow-up chains (rounds moved into new PRs)
- lane P importer: #1711 → #1713 → #1714 → #1715 (4 PRs, 18:11→21:03)
- lane A wp-accounts: #1705 → #1710 → #1712 (3 PRs, 10:18→19:42)
- schema-heal: #1700 → #1701 → #1702 (3 PRs, overnight 17:51→06:54)

### Verifier latency (nomination → gate verdict)
before the 2nd seat V2 (10-01 before 18:28): 79, 99, 150 min; overnight 175, 265 min — after V2: 17, 29, 37, 46 min.

### Waits outside the fleet
- lane C (W14): blocked from 09:03 on an IAM change only Gaëtan can apply (Q16 / D-I8); 18 "no session activity" escalations meanwhile.
- Q-W9-3 (prod signed push): 09-30 16:54 → reply 10-01 08:28 (15.5 h, overnight).
- Q18: defect in the base api#1592 under W17's stacked PR — open.

### Liveness noise
"no session activity" escalations to this OPS: 72 / 24 h; per member: W14 18, W12 16, W13 9 — members waiting on a review/gate or a human, not stalled.

### Rules applied
pre-review 14/14 nominations after 09-30 19:58; frozen interfaces (lane B built on an I-A stub; W15 seam spawned 18:24 → nominated 20:05 → merged 21:02); 2nd verifier seat (V2) since 18:28.

NOT VERIFIED: LEAD answer latency for Q1–Q20 (answers live in §Decisions without timestamps); per-PR token cost; whether wave-1's 9-round PRs were comparable in size/risk to today's.

## 2026-10-04 — Bloc 2 fan-out (metarepo#746, 10-01 21:05Z → 10-04 20:10Z)
Activity: 52 ledger comments (10-01 evening + 10-02 night/morning), then nothing 10-02 10:06Z → 10-04 16:33Z.
15 PRs opened, 15 merged (workspace ×8, wordpress-monorepo ×6, api ×1, terraform ×1).

| Rule (date) | Applied? | Evidence |
|---|---|---|
| no NIT from spawned reviewers (10-01 21:37Z) | yes | 6/6 reviews spawned after the order: 0 NIT; the 4 earlier ones still listed NITs |
| no spawned review on test/data-only diffs | yes | #1720 (test-only) and #12622 (re-pin) got a gate only |
| one follow-up per candidate | yes | #1716→#1717, #1719→#1720, #12620→#12623, #12617→#12618 — no 3rd link |
| pre-review | yes | every nomination |
| 2nd verifier seat | yes | nomination→gate median ~40 min (75 min on 10-01 before V2) |

Review value: the spawned reviews found a shell injection in two WordPress workflows reachable through the D-I5 PAT (Q21–Q23) and that the OIDC role split separates names, not data (Q26) — 7 LEAD questions in 12 h, mostly security.

Remaining costs: 43 "no session activity" escalations (18 + 25); #12624 open→merge 28 h 36 (waited on the terraform roles); 10-04 staging press #1 failed because WP staging is down (HTTP 5xx) — outside the fleet.

Incident 2026-10-04 19:56Z: LEAD 36773f53 ran `orchestra send … --file /tmp/w6b-tooltips.txt`; `send` has no `--file`, the unknown flag became the body, the CLI printed seq 4519 (success). Resent inline at 20:00Z (seq 4520) after W6b flagged it.

## 2026-10-04 23:41Z — Wave E start + bloc2 tail (runs not covered above)
Scope: wave E (lcsmas/orchestra#276, live since 21:48Z, 2 h) + bloc2 (metarepo#746) 20:10Z → 23:40Z + held waves B/C.

- Wave E rules applied: interface frozen + branch `pause-e-interface` before spawn (dispatch 21:48 → fleet 21:56); E3 spawned at dispatch on it;
  pre-review in both nominations; E1 review 0B/0M/2 MINOR (23:39) → follow-up, candidate not reopened.
- Wave E timings: verifier READY +19 min; E1 nominated +86 min, E2 +100 min; E1 nom → review 17 min; E1 gate still running at 23:41 (single seat, E2 queued "after E1").
- Frozen interface changed once (v2 by E2, 23:37) after E1 nominated on v1.
- 2/2 "no session activity" escalations hit members waiting by design (verifier before any nomination, E1 after nominating).
- Bloc2 W20 workspace#12628: nom 22:13 → review 22:41 → only BLOCKING = CI red caused by a time-of-day bug in develop, not the PR
  → 42 min round → V2 PASS 23:38 (85 min nom → PASS). V also spent a gate proving a develop bug (runWave.exit, from #12618).
- Held B/C (runs 07f665b1, 90819ba2 held since 09-30 07:33Z): master +72 commits since; every nominated B/C candidate's verdict is stale.
NOT VERIFIED: E1 gate duration (in progress); whether a 2nd seat at 2 queued would have helped E2.

## 2026-10-07 — Bloc 2 wave 6 « page Migration MC » (metarepo#906, run 866b89aa, 10-06 16:53Z → paused 10-07 07:51Z)
- 30 bus members, 11 tracks (NMC-1903…1913); 1 PR merged in 15 h (WP#1754, NMC-1903, 21:30Z); 6 others open.
- Host: 147 SIGBUS core dumps of `/tmp/.mount_Orches*/orchestra --type=zygote` inside the live app's scope (app-orchestra-669927) 18:13–20:38Z, unclean reboot 20:52Z.
  Then rtkit "canary thread starving" 23:52Z, chromium ANOM_ABEND ×4, kernel WARNING `btrfs_insert_delayed_dir_index` 00:02Z + I/O errors → host dead until 07:26Z reboot (7 h 24; NMC-1904 52-mutant sweep + #1764 gate lost, /tmp wiped).
- Stacking: 1906→1907→1909→{1911,1912}, 1908→1910 — 6 nominations "EARLY-REVIEW, not merge-eligible"; 1911 rebased 3× in 20 min as 1909 moved.
- Gate latency: 1903 nom 17:50 → PASS 21:29 (3 h 39). Bus readers: 2 OPS emergency wakes (verifier-w6b 20 min unread, verifier-w6c 30 min unread). OPS restarted at 17:01 (stale bus run after promotion).
- 45 "no session activity" escalations, mostly members waiting on a review/gate.
NOT VERIFIED: cause of the SIGBUS storm and of the btrfs fault (host load suspected, unmeasured — the resource monitor logged no load samples).

## 2026-10-07 18:40Z — Wave G memory guard (ledger #295, spec #284), launched 09:58Z under D1 resource constraints
- Constraints held: wave-G live sessions (LEAD excluded) ≤ 6 on all 516 monitor samples (dist 3–5 typical); min MemAvailable 7.5 GB (16:04Z), median 13.3 GB; MEMWATCH never left `ok`; no crash.
- Throughput: 5/10 tickets closed (#285 #291 #292 #286 #290) + 3 follow-ups in 8 h 30; releases v0.5.311, v0.5.312. ≤ 2 review rounds per track (waves A–C: 3–4).
- Latency: nom→review median 21 min (n=9), nom→gate median 51 min (n=9, max 124) — about 2× waves A–C; heavy-rig token serialization suspected, not measured.
- Critical path now: #289 waits on a human mockup pick (D5, 18:26Z) and blocks #293 → #294.
- Incident: v0.5.312's memory Pause + MEMWATCH would conflict (a coordinator re-pause clears `pause_auto` → no auto Reprise); timer disabled 18:4xZ.
- Admission + memory Pause shipped in v0.5.312 before the composed proof #294.

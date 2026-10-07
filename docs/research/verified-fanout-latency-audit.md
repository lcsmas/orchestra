# Audit — où part le temps d'un verified-fanout (2026-09-30)

Verdict : le chemin critique est le **nombre de tours review→fix→re-gate** (≈ 40–60 min chacun, médiane 3 par piste),
pas la build ni la suite. Viennent ensuite la **file du verifier unique**, les **harnais de mutation/rigs longs**
et les **dépendances sérielles entre pistes**.

Corpus : ledgers #198 #224 #234 #237 (commentaires horodatés), bus `~/.orchestra/bus.sqlite`, 96 transcripts
(>300 KB, 2026-09-29 20:00 → 09-30 21:00). Scripts : `verified-fanout-latency-audit/*.py` — they read ledger comments
fetched with `gh api repos/lcsmas/orchestra/issues/<N>/comments --paginate > /tmp/vfaudit/c<N>.json` and the transcripts under `~/.claude-mc/projects/`.

## Mesures

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

## Hors sujet (mesuré, écarté)
- Trou de 25 h dans #198 = HOLD LEAD (ordre humain) + limite d'usage, pas un sommeil de flotte.
- Trous de 12 h dans #234/#237 = pause humaine à 07:33Z.

## NON VÉRIFIÉ
- Classification des commentaires par regex sur la 1re ligne (quelques faux positifs, ex. « Verify B2 » compté en review).
- Les harnais de mutation sont-ils séquentiels (gain de parallélisation) : non mesuré.
- Gain de contexte réduit sur le temps modèle : non mesuré.

## Re-audit 2026-10-04 23:41Z — runs not covered by the 10-01 / 10-04 re-audits
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

## Audit 2026-10-07 — bloc2 wave 6 « page Migration MC » (metarepo#906, run 866b89aa, 10-06 16:53Z → paused 10-07 07:51Z)
- 30 bus members, 11 tracks (NMC-1903…1913); 1 PR merged in 15 h (WP#1754, NMC-1903, 21:30Z); 6 others open.
- Host: 147 SIGBUS core dumps of `/tmp/.mount_Orches*/orchestra --type=zygote` inside the live app's scope (app-orchestra-669927) 18:13–20:38Z, unclean reboot 20:52Z.
  Then rtkit "canary thread starving" 23:52Z, chromium ANOM_ABEND ×4, kernel WARNING `btrfs_insert_delayed_dir_index` 00:02Z + I/O errors → host dead until 07:26Z reboot (7 h 24; NMC-1904 52-mutant sweep + #1764 gate lost, /tmp wiped).
- Stacking: 1906→1907→1909→{1911,1912}, 1908→1910 — 6 nominations "EARLY-REVIEW, not merge-eligible"; 1911 rebased 3× in 20 min as 1909 moved.
- Gate latency: 1903 nom 17:50 → PASS 21:29 (3 h 39). Bus readers: 2 OPS emergency wakes (verifier-w6b 20 min unread, verifier-w6c 30 min unread). OPS restarted at 17:01 (stale bus run after promotion).
- 45 "no session activity" escalations, mostly members waiting on a review/gate.
NOT VERIFIED: cause of the SIGBUS storm and of the btrfs fault (host load suspected, unmeasured — the resource monitor logged no load samples).

## Audit 2026-10-07 18:40Z — wave G memory guard (ledger #295, spec #284), launched 09:58Z under D1 resource constraints
- Constraints held: wave-G live sessions (LEAD excluded) ≤ 6 on all 516 monitor samples (dist 3–5 typical); min MemAvailable 7.5 GB (16:04Z), median 13.3 GB; MEMWATCH never left `ok`; no crash.
- Throughput: 5/10 tickets closed (#285 #291 #292 #286 #290) + 3 follow-ups in 8 h 30; releases v0.5.311, v0.5.312. ≤ 2 review rounds per track (waves A–C: 3–4).
- Latency: nom→review median 21 min (n=9), nom→gate median 51 min (n=9, max 124) — about 2× waves A–C; heavy-rig token serialization suspected, not measured.
- Critical path now: #289 waits on a human mockup pick (D5, 18:26Z) and blocks #293 → #294.
- Incident: v0.5.312's memory Pause + MEMWATCH would conflict (a coordinator re-pause clears `pause_auto` → no auto Reprise); timer disabled 18:4xZ.
- Admission + memory Pause shipped in v0.5.312 before the composed proof #294.

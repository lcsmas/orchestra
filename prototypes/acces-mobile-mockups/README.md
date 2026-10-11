# Accès mobile — maquettes des trois écrans (#335)

Prototype jetable : branche **non destinée au merge**. Données fictives, aucun backend, aucun lancement d’Orchestra.

- 3 variantes × 7 écrans, 390×844 @3x (iPhone), FR.
- Reconstruire : `node build.mjs && node shoot.mjs` (Chromium headless piloté en CDP, aucune fenêtre).
- Polices : Geist / Inter / JetBrains Mono (OFL, copiées de `src/renderer/assets/fonts/`). Sur l’iPhone, Inter ≈ SF Pro.
- Tokens de départ : `docs/codebase-map/agent-view-design.md` (`--av-*`) ; V2 reprend l’accent clair `#2f6fe0`.

## V1 · Boîte de réception

dark, look du bureau. « À traiter » épinglé en tête (en attente puis non lu), le reste groupé par repo. Conversation = document (réponses pleine largeur, outils sur une ligne), question en carte dans le flux. Densité moyenne.

| Liste · tout | Liste · à traiter | Question | Élicitation | Composer | Envoi échoué | Injoignable |
|---|---|---|---|---|---|---|
| <img src="screenshots/v1-boite/01-liste-tout.png" width="120"> | <img src="screenshots/v1-boite/02-liste-a-traiter.png" width="120"> | <img src="screenshots/v1-boite/03-conversation-question.png" width="120"> | <img src="screenshots/v1-boite/04-conversation-elicitation.png" width="120"> | <img src="screenshots/v1-boite/05-composer.png" width="120"> | <img src="screenshots/v1-boite/06-envoi-echoue.png" width="120"> | <img src="screenshots/v1-boite/07-injoignable.png" width="120"> |

## V2 · Messages

clair, ressenti app iOS. Onglets À traiter / Tous ; les cartes en attente portent les boutons de réponse (réponse rapide sans ouvrir). Conversation en bulles, « injoignable » en plein écran. Aéré, gros doigts.

| Liste · tout | Liste · à traiter | Question | Élicitation | Composer | Envoi échoué | Injoignable |
|---|---|---|---|---|---|---|
| <img src="screenshots/v2-messages/01-liste-tout.png" width="120"> | <img src="screenshots/v2-messages/02-liste-a-traiter.png" width="120"> | <img src="screenshots/v2-messages/03-conversation-question.png" width="120"> | <img src="screenshots/v2-messages/04-conversation-elicitation.png" width="120"> | <img src="screenshots/v2-messages/05-composer.png" width="120"> | <img src="screenshots/v2-messages/06-envoi-echoue.png" width="120"> | <img src="screenshots/v2-messages/07-injoignable.png" width="120"> |

## V3 · Console

noir OLED, très dense, chrome mono. Arbre par repo avec compteurs : repos urgents ouverts, le reste replié en une ligne. Transcript à rail, question en bottom sheet sous le pouce. Plus d’info par écran, moins de confort.

| Liste · tout | Liste · à traiter | Question | Élicitation | Composer | Envoi échoué | Injoignable |
|---|---|---|---|---|---|---|
| <img src="screenshots/v3-console/01-liste-tout.png" width="120"> | <img src="screenshots/v3-console/02-liste-a-traiter.png" width="120"> | <img src="screenshots/v3-console/03-conversation-question.png" width="120"> | <img src="screenshots/v3-console/04-conversation-elicitation.png" width="120"> | <img src="screenshots/v3-console/05-composer.png" width="120"> | <img src="screenshots/v3-console/06-envoi-echoue.png" width="120"> | <img src="screenshots/v3-console/07-injoignable.png" width="120"> |

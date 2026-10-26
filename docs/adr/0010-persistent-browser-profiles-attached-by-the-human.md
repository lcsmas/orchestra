---
status: accepted
date: 2026-10-25
---

# Browser panels may use persistent profils navigateur, attached only by the human

The panel's storage was deliberately non-persistent and per workspace (`partitionFor`, `src/main/browser-panel.ts`): no signed-in session should outlive a workspace. The cost is that every panel starts signed out, also after each app restart, so agents do their Mobile Club admin/staging work in the human's own Chrome instead, with his personal session. We add **profils navigateur**: named `persist:` partitions the human creates in Settings and attaches to a workspace from the panel's URL bar; one profile covers all the workspace's tabs, and several workspaces may share one. **Navigation éphémère** stays the default. Only the human attaches, switches or creates a profile; a spawned agent starts ephemeral unless its spawn names a profile its parent already holds, so sign-ins never spread through a fleet silently. Deleting an attached profile returns its workspaces to navigation éphémère. Decided with the maintainer in a grilling session (2026-10-25).

## Considered options

- **One shared persistent profile for every workspace** — rejected: any agent would inherit every sign-in (a test agent getting the prod admin session).
- **Stay ephemeral and import cookies from Chrome/Firefox** — deferred: an extra, on demand.
- **Let the 1Password extension sign the panel in** — impossible: Electron 33 cannot run its MV3 service worker (`src/shared/login-chromium.ts`).

## Consequences

- **Profile cookies are stored UNENCRYPTED on disk, whatever the keyring says** (amended 2026-10-26, #400 review F1). Chromium encrypts cookies at rest only when Electron's `EnableCookieEncryption` fuse is on; it is OFF in the shipped build (the repo flips no fuse — measured: the profile's Cookies DB holds the `value` in clear and an empty `encrypted_value`). Creating a profile therefore ALWAYS shows a visible warning instead of refusing it, and the human chooses knowingly; the keyring work (#389) protects `secrets.json`, not the cookie jar. Flipping the fuse is a one-way change for existing persistent partitions (login partitions included) and is a separate decision.
- Tabs are restored at app restart (URL + active tab); a profile brings them back signed in.

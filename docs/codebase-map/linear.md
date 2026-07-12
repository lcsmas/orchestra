# Linear integration

Turns a branch name into a verified Linear issue badge in the sidebar. Files:
`src/main/linear.ts`, `src/shared/linear.ts` (+ `.test.ts`, pure logic). UI:
`LinearSettings.tsx`.

## Flow
- `parseLinearIssueCandidate(branch)` (`shared/linear.ts:28`) — extracts a
  `TEAM-NUMBER` token (whole-token regex; `nmc-261-…`→`NMC-261`; permissive, may
  yield false candidates like `POLL-429`).
- `verifyLinearIssue(branch)` (`main/linear.ts:112`) — queries Linear GraphQL
  (`https://api.linear.app/graphql`, `Authorization: <key>` no Bearer) and only
  returns a `LinearIssue` (`types.ts`) if the returned `identifier` matches.
  Caches hits *and* misses; `noApiKey` latch (`:32`) stops retrying after 401/403
  until the user saves a new key (`resetLinearAuthState` `:52`).
- Key resolution (`:37`): stored key → `LINEAR_API_KEY` env → none.
  `getLinearKeySource` `:46`. Stored via `secrets.ts` (encrypted). UI:
  `LinearSettings.tsx` (test/save/clear). IPC: `linear:keySource`/`checkKey`/
  `saveKey`/`clearKey`.

## Tests
`linear.test.ts` covers `parseLinearIssueCandidate` (normalization, path-style,
whole-token, permissiveness).

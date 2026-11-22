# Deploying Planning Poker to Jira Cloud

How to deploy the Forge app (`apps/jira-forge`) to development, staging and production, what it needs from Jira, and how to accept every milestone on a Jira development site.

Nothing here has been run against a real Jira site yet. Step 2 ("First deploy") is the first point where the Forge bundler, storage indexes and realtime tokens meet real Forge; read [Known risk: bundling workspace packages](#known-risk-bundling-workspace-packages) before you start.

## 1. Prerequisites

- **Node.js 22 or later** (CI uses Node 24; the Forge runtime is `nodejs24.x`).
- **Forge CLI:** `npm install -g @forge/cli`, then `forge login` with an Atlassian API token.
- **An Atlassian developer site** with Jira, where you are a site and Jira administrator. A free one is available from [go.atlassian.com/cloud-dev](https://go.atlassian.com/cloud-dev).
- **Test users:** at least four accounts on the site (an administrator, a moderator, two members). One member should be unable to browse one project, to check restricted tickets.
- **Jira data:** a project with a few issues, the **Story points** number field on their screens (and optionally a single-select field such as "T-shirt size").
- Locally: `npm install`, then `npm run check` and `npm run build` must pass.

## 2. First deploy (development)

All Forge commands run from `apps/jira-forge`.

```sh
npm install
npm run check
npm run build                 # Custom UI → apps/jira-forge/static/main/build
cd apps/jira-forge
forge register                # once: replaces the placeholder app.id in manifest.yml; commit it
forge deploy                  # default environment: development
forge install                 # choose Jira and your development site
```

- `forge register` writes the real app ID into `manifest.yml`. Do it once per app; re-registering later disconnects the app from its environments, variables and **storage**.
- After the first deploy, Forge builds the storage indexes. The app cannot be installed until they are active (usually about five minutes). Check with `forge storage entities indexes list -e development`.
- Open **Apps → Planning Poker** in Jira. The title shows "(DEVELOPMENT)".

### Upgrading an installed app

- **Code only:** `forge deploy` is enough; installations pick up minor versions automatically.
- **Scopes or storage changed** (new entity, attribute or index): `forge deploy`, then `forge install --upgrade` and approve the new scopes. In production, a scope change is a **major version** that each site administrator must approve before it applies.
- `forge lint` runs on every deploy; fix its findings rather than deploying with `--no-verify`.

## 3. Environments

| Environment     | Use                                         | Deploy / install                                                      | Notes                                                                                      |
| --------------- | ------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **development** | Your own testing; `forge tunnel` works here | `forge deploy` · `forge install`                                      | Title suffix "(DEVELOPMENT)". Create more with `forge environments create` (one per dev).  |
| **staging**     | A stable build for acceptance testing       | `forge deploy -e staging` · `forge install -e staging --site …`       | Title suffix "(STAGING)". No tunnel. **Storage schema becomes permanent here.**            |
| **production**  | Real use                                    | `forge deploy -e production` · `forge install -e production --site …` | No tunnel and no `forge logs`; users must download logs for you. Distribution starts here. |

Promote the same commit through the environments: run the checks, `npm run build`, deploy to staging, run the [acceptance checklist](#9-acceptance-checklist-jira-development-site), then deploy that commit to production.

## 4. Permissions (least privilege)

`manifest.yml` asks for four scopes. Each is required by a specific call; nothing broader (`manage:jira-configuration`, `manage:jira-project`, webhooks, egress) is requested.

| Scope             | Why it is needed                                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage:app`     | Forge Custom Entity Store (`@forge/kvs`): teams, sessions, votes, settings, audit log.                                                                                                                                                                                        |
| `read:jira-user`  | `GET /user/bulk` (names and avatars of participants) and `GET /user/search` (inviting people), both `asApp`.                                                                                                                                                                  |
| `read:jira-work`  | `GET /mypermissions?permissions=ADMINISTER` (who is a Jira administrator), `POST /issue/bulkfetch` (import by key, and checking which tickets each viewer may see), `POST /search/jql`, `/jql/autocompletedata`, `GET /field`, `GET /issue/{id}/editmeta`, `GET /issue/{id}`. |
| `write:jira-work` | `PUT /issue/{id}` to write the final estimate to one allowlisted field. This classic scope also allows creating and deleting issues; the app never does either. Atlassian recommends classic scopes, so no granular scope is used.                                            |

Notes:

- Every issue read and write runs **as the calling user** (`asUser`), so Jira's own permissions apply on top of the scopes. Only user directory lookups run as the app.
- Forge Realtime (`@forge/realtime`, `signRealtimeToken`, bridge `realtime.subscribe`) needs no scope or manifest entry.
- The app makes no external (non-Atlassian) calls, so it declares no `permissions.external` egress.
- After changing scopes: `forge lint --fix`, deploy, `forge install --upgrade`.

## 5. Storage: entities and indexes are permanent

The Custom Entity Store schema lives in `manifest.yml` under `app.storage.entities` and must match `packages/persistence/forge/src/schema.ts`:

| Entity          | Indexes                                    | Holds                                                                  |
| --------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `team`          | `by-tenant` (tenantId; range name)         | Teams and members                                                      |
| `appsettings`   | —                                          | App moderators, writable-field allowlist                               |
| `auditevent`    | `by-team`, `by-session` (range occurredAt) | Audit log of privileged actions                                        |
| `session`       | `by-team` (range updatedAt)                | The whole session aggregate (roster, tickets, rounds, decisions, sync) |
| `sessionmember` | `by-user`, `by-session`                    | Derived roster index ("my sessions and invitations")                   |
| `vote`          | `by-round`                                 | Private votes, one per voter per round                                 |

**Once deployed to staging or production, entities and attributes can never be deleted, and indexes can no longer be deleted in any environment.** New attributes can still be added. Therefore:

- Review any `storage` change in `manifest.yml` before it reaches staging; experiment only in development or a custom development environment.
- Prefer storing new data inside the existing `data` attribute (type `any`) over adding attributes or indexes.
- Add an index only for a query you actually run (see "Reports" in [ARCHITECTURE.md](ARCHITECTURE.md)).
- Storage changes cannot be backported to older major versions.

## 6. Logs and troubleshooting

```sh
forge logs                         # development, recent lines
forge logs -e staging --since 1h   # staging, last hour
forge logs -n 200 --since 2026-11-22
forge tunnel                       # development only: run resolvers locally against your site
```

- Resolver failures are logged as `Resolver <key> failed: <ErrorName>: <message>`. The logger writes only an error's name and message, never response bodies, headers or tokens (`apps/jira-forge/src/logger.ts`, covered by `tests/security/privacy.test.ts`).
- Users see `Something went wrong. Try again.` for internal errors and a specific message for validation, permission and state errors.
- Realtime problems only cost freshness: rooms keep refreshing every two minutes and when the tab becomes visible. Look for `Realtime publish failed` or `rejected` lines.
- In production `forge logs` is not available; ask the site administrator to download the app logs.

## 7. Rollback

Forge has no single rollback command. In order of preference:

1. **Redeploy the previous commit.** `git checkout <last good tag>`, `npm run build`, `forge deploy -e production`. If it is the same major version (no scope or storage change), sites get it automatically.
2. **Revert in code** and deploy forward, when the bad release also changed data. Stored records are versioned JSON; code must keep reading records written by the newer release.
3. **Previous major version:** if a release raised the major version (scope change), sites that have not approved it keep the old version. To pin a development site to an older major version: `forge uninstall`, then `forge install --major-version <n>`. `forge version list` and `forge install list` show what is where.

Storage additions (entities, attributes, indexes) are **not** rolled back by any of these; that is why §5 matters. Tag every production deploy (`git tag prod-YYYYMMDD`) so step 1 is always possible.

## 8. Data and privacy

- **Where data lives:** only in Forge storage of the installation (hosted by Atlassian, isolated per installation). No external services. Each record also carries the installation ID and reads check it.
- **What is stored:** Atlassian account IDs (as `atlassian:<accountId>`), team and session names, ticket snapshots taken at import (key, summary, plain-text description, type, status, chosen display fields, the destination field's value at import), votes, decisions with override reasons, sync results, and the audit log. Display names and avatars are fetched from Jira when shown, not stored. No email addresses.
- **Votes** are stored per voter and round and are never returned to anyone else; results are anonymous counts (see [PRODUCT_RULES.md](PRODUCT_RULES.md)).
- **Restricted tickets:** ticket content is shown only to people who can browse the issue in Jira themselves (checked with `POST /issue/bulkfetch` as each viewer, cached for 30 seconds). An invitation never reveals issue content.
- **Retention:** sessions and audit entries are kept until the app is uninstalled; there is no deletion feature yet. Uninstalling removes access to the data; check Atlassian's current Forge data-retention policy for how long storage is kept afterwards.
- **Before Marketplace distribution (owner decision):** review Atlassian's personal-data reporting requirements for apps that store account IDs (the `report:personal-data` scope is not requested today), and add a privacy policy.

## Known risk: bundling workspace packages

The resolver (`apps/jira-forge/src/index.ts`) imports the workspace packages (`@planning-poker/*`), which are symlinked by npm workspaces and export **TypeScript source**. Forge's default bundler (Webpack, with TypeScript support) may not compile TypeScript that lives outside the app directory or behind symlinks. This is unverified until the first `forge deploy`.

**Symptom:** `forge deploy` (or `forge lint`) fails with "Module parse failed", "Cannot find module '@planning-poker/…'", or the resolver throws `SyntaxError: Unexpected token` at runtime.

**Fallback: pre-bundle with esbuild and upload it as-is.**

1. Add esbuild and a script to `apps/jira-forge/package.json`:

   ```sh
   npm install -D -E esbuild --workspace @planning-poker/jira-forge
   ```

   ```json
   "bundle:resolver": "esbuild src/index.ts --bundle --platform=node --target=node24 --format=cjs --outfile=dist/index.js"
   ```

   This inlines the workspace packages and npm dependencies (including `@forge/*`) into one file, so the uploaded directory needs no `node_modules`.

2. Tell Forge to upload `dist` without bundling (Forge "manual packaging", currently a Preview feature) in `manifest.yml`:

   ```yaml
   app:
     package:
       bundler: manual@2026
       path: dist
   ```

   The function handler stays `index.handler` (the file `dist/index.js`, export `handler`).

3. Deploy with `npm run bundle:resolver --workspace @planning-poker/jira-forge && forge deploy`, and add the bundle step to CI before any deploy job. Manual packages are not type-checked or linted by Forge, so keep `npm run check` in front.

If manual packaging is unavailable for your CLI version, the alternative is to compile the workspace packages to JavaScript (`tsc` into each package's `dist`, with `exports` pointing there) so the default bundler sees only JavaScript. Record whichever works in [ARCHITECTURE.md](ARCHITECTURE.md) and remove this section.

The Custom UI is unaffected: Vite bundles it into `static/main/build` before deploy.

## 9. Acceptance checklist (Jira development site)

Use four browsers or profiles: **Admin** (Jira administrator), **Moderator**, **Member A** and **Member B** (Member B cannot browse one project, "SECRET"). Tick each item on the development site (or staging) and note the date.

### M1 — Foundation

- [ ] `forge deploy` and `forge install` succeed; storage indexes become active.
- [ ] **Apps → Planning Poker** opens with no console errors; the page follows Jira's light and dark themes.
- [ ] `forge logs` shows no errors after opening each page (Home, Teams, Planning Sessions, Session History, Reports, Settings).

### M2 — Teams and permissions

- [ ] Admin sees Settings; Moderator and members see no administration controls.
- [ ] Admin assigns Moderator as an application moderator in Settings; the audit records it.
- [ ] Moderator creates a team, adds Member A and Member B; user search finds them by name.
- [ ] Members cannot create teams or search the directory (the buttons are absent; calls are refused).
- [ ] Only the Admin can assign or unassign team moderators; a team always keeps one moderator.
- [ ] An archived team is read-only and cannot host new sessions.

### M3 — Session builder

- [ ] Moderator creates a draft, invites Member A as voter and Member B as observer, chooses a deck with ∞ ? ☕ cards and a custom deck.
- [ ] The draft is invisible to Members (Home, Planning Sessions, a direct link).
- [ ] Readiness lists missing items (no tickets, no voter, missing mapping) and blocks publishing until fixed.
- [ ] Publishing shows the session to invitees with a pending invitation; editing a ready session returns it to draft.

### M4 — Jira ticket import

- [ ] Import by key (`PROJ-1, PROJ-2`) and by JQL search with paging and autocomplete.
- [ ] Unknown keys and keys from projects the Moderator cannot see are reported as "not found, or you do not have access".
- [ ] Descriptions with formatting, links, mentions and `<script>`-like text appear as plain text.
- [ ] Extra display fields (up to five) appear on tickets.
- [ ] Member B sees "Restricted work item" (no summary or description) for a SECRET ticket; Member A and the Moderator see it normally.

### M5 — Voting and realtime

- [ ] Members join; votes are hidden ("voted" only) until every required voter has voted; the round then reveals automatically for everyone within a few seconds, without reloading.
- [ ] The result shows values and counts only, never names; each person sees only their own card.
- [ ] Observers and the facilitator cannot vote and do not block the round.
- [ ] Pre-votes on upcoming tickets stay hidden and count when that ticket opens.
- [ ] Two voters clicking their last cards at the same moment produce exactly one reveal.
- [ ] Realtime: in the browser's network tab the subscription uses a token from `getRealtimeToken`; an outsider (no invitation) gets "Session not found" from `getRealtimeToken` and receives no updates; after an hour (token expiry) the room still updates live.

### M6 — Facilitator controls

- [ ] Skip a voter for a ticket and for the session; the round reveals without them; restoring before reveal makes them required again and discards their vote.
- [ ] Restart a round, start another round after a disputed reveal, skip a ticket, move to the next or any ticket, pause and resume (voting waits while paused), complete and cancel.
- [ ] Override a result with a required reason; accept a unanimous result when auto-finalize is off.
- [ ] Invite during an active session (when allowed), change roles, revoke an invitation; changes never join an open round.

### M7 — Jira field write-back

- [ ] Admin adds Story points (and a single-select field) to the allowlist in Settings.
- [ ] Moderator maps the destination field (and card → option for the single-select field); publishing is blocked while a regular card has no option.
- [ ] A unanimous result with auto-finalize writes the value to the Jira issue (check the issue's history).
- [ ] When a voter without edit permission completes the round, the write fails visibly and the Moderator's **Retry** writes it (see the open decision in PRODUCT_RULES.md).
- [ ] Change the field in Jira after import: the write stops with a conflict; **Overwrite Jira value** writes it after confirmation.
- [ ] Remove the field from the allowlist: later writes fail with a clear message.
- [ ] Special cards are never written to number fields; retries do not double-write.

### M8 — Reports and history

- [ ] Session History lists published, completed and cancelled sessions the person can view, with team, status and date filters.
- [ ] A completed session's summary shows participants by category, ticket outcomes, overrides with reasons and Jira results; it never changes afterwards.
- [ ] Team reports are visible to the team's moderators and the Admin only; the application report to the Admin only.
- [ ] The audit log is visible to session moderators only and shows no card choices.

### M9 — Quality and deployment

- [ ] `npm run check`, `npm run build`, `npm run test:e2e` pass locally and in CI (both jobs).
- [ ] The complete workflow above runs on the development site with real users, without errors in `forge logs`.
- [ ] Logs contain no tokens, account emails or Jira response bodies (`forge logs --since 1d | grep -i -E "token|bearer|@"` finds nothing sensitive).
- [ ] A user from another site (or an uninvited user on this site) cannot open a session by ID, subscribe to its channel, or see its reports.
- [ ] Forge bundling works with workspace packages, or the esbuild fallback above is in place and documented.
- [ ] Deploy to staging and install on a second site; repeat a short session there.

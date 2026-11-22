# Architecture boundaries

A platform-independent modular monolith. Jira is the first integration, not the foundation of the domain model.

## Dependency direction

```
apps/jira-forge (Forge resolver + Custom UI)
  ├─> packages/ui ──────────> packages/contracts
  └─> packages/application ─> packages/domain
                           └> packages/contracts
      application ports <── adapters (Jira, Forge storage, Forge Realtime)
```

- **domain** — teams, sessions, participation, invitations, skips, decks, rounds, votes, reveal/consensus, decisions, sync state. Pure functions over immutable data; no dependencies.
- **contracts** — JSON-safe view and event types for clients. No dependencies.
- **application** — use cases (`SessionService`, `TeamService`, `ReportService`), server-side authorization, auditing, view projection, ports. In-memory adapters in `src/testing`.
- **ui** — React components and design tokens. Uses only contracts and the `PlanningPokerApi` interface.
- **persistence/forge** — `ForgeTeamRepository`, `ForgeSessionRepository`, `ForgeParticipantRepository` (roster index), `ForgeVoteRepository`, `ForgeApplicationSettingsRepository`, `ForgeAuditRepository`, `ForgeAtomicOperation`, all over a small `EntityStore` interface (`KvsEntityStore` in production, `InMemoryEntityStore` in contract tests).
- **integrations/jira** — `AtlassianIdentityProvider` and `ForgeJiraUserApi` (Jira REST v3 `/user/bulk`, `/user/search`, `/mypermissions`); `JiraWorkItemProvider` (`POST /issue/bulkfetch`, `POST /search/jql` with `nextPageToken`, `/jql/autocompletedata` and its `/suggestions`, `/field`), ADF-to-text conversion and JQL completion. Imports run `asUser`; identity lookups run `asApp`.
- **apps/jira-forge** — Forge manifest, resolver wiring, request handlers and the Custom UI entry.

ESLint enforces these boundaries (`no-restricted-imports` in `eslint.config.mjs`).

## Ports

`WorkItemProvider`, `IdentityProvider`, `TeamRepository`, `SessionRepository`, `ParticipantRepository`, `VoteRepository`, `AuditRepository`, `EventPublisher`, `AtomicOperation`, `Clock`, `IdGenerator` — see `packages/application/src/ports.ts`.

## Identity and tenancy

- Tenant = the Forge installation context (`installContext`). Forge storage is already per installation; records also carry `tenantId` and reads check it.
- Internal user IDs are derived from the identity provider: `atlassian:<accountId>`. The mapping is deterministic and reversible, so it needs no stored record and cannot race; another provider gets its own prefix.
- The actor (user, tenant, role) comes only from Forge's invocation context plus server lookups, never from the client payload.

## Rules

- Server state is authoritative for permissions, votes, reveals and final estimates. Clients never send roles or eligibility.
- Every session change runs in `AtomicOperation` keyed by session. Repositories save with optimistic versions and throw `ConcurrencyConflict`; the atomic operation retries (see "Concurrency" below).
- Individual votes live only in `VoteRepository`, never in the session record, views, events or Jira issue properties.
- Realtime events are notifications without hidden state; clients re-fetch their authorized view.
- External writes: claim (`pending → syncing`) inside the session lock, call the provider outside it, record the outcome inside it again.
- Do not pass vendor DTOs into application or domain code; map them in the adapter.
- Add an interface when it protects a real boundary, not merely to make more layers.

## Chosen stack

- TypeScript (strict) npm-workspaces monorepo; packages export TypeScript source and are bundled by their consumers (Vite, Vitest, Forge).
- React 19 + Vite for Custom UI; Vitest for tests.
- Atlassian Forge: `jira:globalPage` Custom UI, `@forge/resolver`, `@forge/bridge`; runtime `nodejs24.x`.
- Storage: Forge Custom Entity Store via `@forge/kvs`. Versioned records; updates are conditional transactions on `version`. The KVS client exposes no distinct error code for a failed condition, so after a failed write the adapter re-reads the record to decide whether it was a conflict.
- Realtime: `ForgeRealtimePublisher` (`apps/jira-forge/src/realtime.ts`, `@forge/realtime` `publish`) and `realtime.subscribe` from `@forge/bridge` in the Custom UI, on the channel from `sessionChannel(sessionId)` in contracts. Events are notifications only; the UI re-fetches `getSession` on each event, when the page becomes visible again, and on a slow fallback timer (30 s without realtime, 2 min with). A failed publish is logged and never fails the change.
- Realtime channels are token-restricted (Milestone 9, see "Authorized realtime subscriptions" below). Payloads hold IDs and voted/required counts only.
- Estimate write-back (M7): `JiraFieldWriter` (`packages/integrations/jira/src/jira-field-writer.ts`) uses `GET /issue/{id}/editmeta` (editability, single-select allowed values), `GET /issue/{id}?fields=…` (current value) and `PUT /issue/{id}`, all `asUser`; scope `write:jira-work`. Field contexts/options endpoints are not used (they need _Administer Jira_ and `manage:jira-configuration`). Error bodies are never logged; only short field messages reach users.
- Future adapters (PostgreSQL, other providers) are added only when needed.

## Storage notes

- A session is one versioned record (roster, skips, tickets, rounds, decisions), so every session change is a single conditional write. Very large sessions (hundreds of tickets with many rounds) may approach Forge's per-value size limit; split tickets into their own records if that happens.
- Votes are separate records keyed `roundId:userId`. Reveal checks read them by key, because entity-store gets are strongly consistent and index queries are only eventually consistent; reading by the frozen roster guarantees the last voter sees every vote.
- The roster index (`sessionmember`) is derived from the session record after each save.
- The writable-field allowlist lives in the `appsettings` record (`writableFieldIds`); records saved before M7 read as an empty allowlist.

## Reports (Milestone 8)

- `summarizeSession`, `participantCategories` (`packages/domain/src/session-summary.ts`) and `participantStatistics`, `disagreementHistory`, `overrideHistory`, `combineTotals` (`session-statistics.ts`) are pure functions over the session aggregate. They never read votes: the anonymous `RoundResult` of each revealed round plus its frozen roster is enough.
- `ReportService` (`packages/application/src/report-service.ts`) authorizes, loads sessions through the existing `listForTeams`/`listByIds` and audit events through `listForSession`, and maps names. No new ports, entities or Forge indexes.
- Reports filter and page in memory after loading a team's sessions. That is fine for hundreds of sessions per team; if tenants grow far beyond that, add a completion-date range index on `session` (it cannot be removed after a production deploy, so add it only when needed).

## Security (Milestone 9)

Threats and where each is handled. Tests: `tests/security` (authorization matrix over every resolver × seven kinds of user, payload fuzzing, privacy), `tests/concurrency`, `tests/integration`.

- **Server-side roles and session access.** The actor comes from Forge's context (`accountId`, `installContext`) plus Jira's `/mypermissions` and the app settings; payload fields such as `role` or `userId` are never trusted for identity. `authorization.ts` decides; sessions a person cannot view answer NOT_FOUND (same as missing, so IDs cannot be probed), moderator actions by viewers answer FORBIDDEN.
- **Installation (tenant) isolation.** Forge storage is per installation; every record also carries `tenantId` and repositories drop records of another tenant. The matrix includes a Jira administrator of another installation.
- **Invitations and Jira content.** Ticket snapshots are imported with the moderator's permissions. `redactRestrictedTickets` (`packages/application/src/work-item-visibility.ts`) removes title, description, fields and link from every ticket the viewer cannot browse in Jira (session room, builder, home, lists, summaries, reports) before a view is built; a failed check hides everything. Jira: `POST /issue/bulkfetch` as the viewer, answers cached 30 s per installation, account and issue. An invitation therefore never grants issue content.
- **Voting eligibility and observers.** Enforced in the domain (`castVote`): only joined, non-skipped voters on the round's roster vote; observers and facilitators get NOT_ELIGIBLE.
- **Restricted vote access.** Votes are separate records read only by the application; views show counts and the viewer's own choice; events, reports and audit entries never pair a person with a value (tested against every output of a full session, including stored records).
- **Safe rendering.** Jira content is stored as plain text (ADF → text) and rendered by React as text; no `dangerouslySetInnerHTML` or similar exists in the UI (checked by a test).
- **Payload validation.** `handlers.ts` validates every field (types, non-empty bounded IDs, list and string limits) before a use case runs; fuzzing yields only VALIDATION or NOT_FOUND, never INTERNAL.
- **Least-privilege scopes.** See [DEPLOYMENT.md](DEPLOYMENT.md#4-permissions-least-privilege).
- **Auditing.** Team, settings, session, participant, ticket, round, estimate and sync changes append audit events with the actor; votes are not audited individually.
- **Safe external update retries.** Sync is claimed (`pending → syncing`) in a conditional write, so concurrent callers make one Jira write per decision; retries reuse the idempotency key and a value already present counts as written.
- **Logs.** Only an error's name and message are logged; Jira error bodies and tokens never reach logs or users.

### Authorized realtime subscriptions

Decision (Milestone 9): **channels are restricted with Forge Realtime tokens.**

- Forge delivers an event only to subscriptions whose token carries exactly the same claims as the publisher's token (Forge docs, "Authorizing realtime channels"); `signRealtimeToken` can only run in a resolver. Channels are also scoped to the installation and the module's context.
- `getRealtimeToken({ sessionId })` authorizes like `getSession` (NOT_FOUND for anyone who cannot view the session) and returns a **subscribe-only** token for `sessionChannel(sessionId)` with claims `{ app, tenant, session }` (`ForgeRealtimeTokens`, `apps/jira-forge/src/realtime.ts`).
- `ForgeRealtimePublisher` publishes every event with a **publish-only** token carrying the same claims, cached per warm function instance until a minute before expiry. If signing fails, the event is not sent (logged); clients keep their fallback refresh.
- The Custom UI (`static/main/src/forge-api.ts`) requests a token, subscribes with it, renews a minute before `expiresAt`, and on a subscription error re-requests a token and refreshes the view.
- Limits: a person removed from a session keeps receiving notifications until their token expires (they carry no data; every view re-fetch is authorized). Forge's per-installation limit (50 subscribe/publish/sign operations per second) covers signing too. Whether a tokenless subscriber receives token-published events is not stated in the docs; the acceptance checklist verifies it on a real site.

### Concurrency

Production has no lock: `ForgeAtomicOperation` re-runs a read-modify-write when a versioned conditional write fails, with randomized exponential backoff (6 attempts); a conflict that outlasts them is answered as CONFLICT ("try again"). Votes are separate records, so two extra guarantees close the gaps between them and the session record:

- A vote is written in one transaction with a check that the session is still at the version the voter read (`VoteGuard`), so it can never land in a round that was revealed, restarted or closed meanwhile.
- A save that reveals a round checks, in the same transaction, that every counted vote is still stored unchanged (`SessionSaveOptions.countedVotes`), so a vote changed while the round was being revealed makes the reveal retry instead of being lost. Forge allows 25 operations per transaction; rosters of 25 or more voters fall back to the vote guard alone (a vote changed in the instant between a reveal's read and its save could then be counted with its old value).
- The roster index is rewritten after each save and re-checked against the stored session, so an older rewrite finishing last cannot hide a newer invitation.

`tests/concurrency` runs these scenarios on the Forge repositories over a store that interleaves concurrent requests (randomly per seed, and in forced orders that reproduce each race).

## Known risk

Forge bundles the resolver from `apps/jira-forge/src`, which imports workspace packages that export TypeScript source. Whether the Forge bundler compiles TypeScript from symlinked workspace packages is unverified until the first `forge deploy`. The concrete fallback (esbuild pre-bundle plus Forge manual packaging) is in [DEPLOYMENT.md](DEPLOYMENT.md#known-risk-bundling-workspace-packages).

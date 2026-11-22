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
- Every session change runs in `AtomicOperation` keyed by session. Repositories save with optimistic versions and throw `ConcurrencyConflict`; the atomic operation retries.
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
- Realtime channels use the app's installation context and are not yet token-restricted. Payloads hold IDs and voted/required counts only, so nothing hidden leaks; restricting subscriptions with `signRealtimeToken` is a hardening item for Milestone 9.
- Planned (later milestones): Jira field contexts, options and `editmeta` for writing estimates (M7).
- Future adapters (PostgreSQL, other providers) are added only when needed.

## Storage notes

- A session is one versioned record (roster, skips, tickets, rounds, decisions), so every session change is a single conditional write. Very large sessions (hundreds of tickets with many rounds) may approach Forge's per-value size limit; split tickets into their own records if that happens.
- Votes are separate records keyed `roundId:userId`. Reveal checks read them by key, because entity-store gets are strongly consistent and index queries are only eventually consistent; reading by the frozen roster guarantees the last voter sees every vote.
- The roster index (`sessionmember`) is derived from the session record after each save.
- `JiraWorkItemProvider.validateUpdate`/`update` reject until M7 adds estimate write-back.

## Reports (Milestone 8)

- `summarizeSession`, `participantCategories` (`packages/domain/src/session-summary.ts`) and `participantStatistics`, `disagreementHistory`, `overrideHistory`, `combineTotals` (`session-statistics.ts`) are pure functions over the session aggregate. They never read votes: the anonymous `RoundResult` of each revealed round plus its frozen roster is enough.
- `ReportService` (`packages/application/src/report-service.ts`) authorizes, loads sessions through the existing `listForTeams`/`listByIds` and audit events through `listForSession`, and maps names. No new ports, entities or Forge indexes.
- Reports filter and page in memory after loading a team's sessions. That is fine for hundreds of sessions per team; if tenants grow far beyond that, add a completion-date range index on `session` (it cannot be removed after a production deploy, so add it only when needed).

## Known risk

Forge bundles the resolver from `apps/jira-forge/src`, which now imports workspace packages that export TypeScript source. Whether the Forge bundler compiles TypeScript from symlinked workspace packages is unverified until the first `forge deploy`. If it fails, add a pre-bundle step (e.g. esbuild into `apps/jira-forge/dist`) and point the function handler at it.

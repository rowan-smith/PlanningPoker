# Planning Poker — agent rules

Build a small, modular Planning Poker application. Optimise for correctness, clarity and easy integration with other platforms.

## Source of truth

- The full product specification (v2.1) is summarised in `docs/PRODUCT_RULES.md`; confirmed behaviour and recorded assumptions live there.
- Read only the relevant sections of `docs/PRODUCT_RULES.md`, `docs/ARCHITECTURE.md` and `docs/UI_STYLE.md` for the task.
- Follow more specific `AGENTS.md` rules in the directory you change.
- If a product decision is missing, don't silently invent a permanent rule. State the assumption or flag the decision.

## Layout

- `packages/domain` — pure business rules and types (`@planning-poker/domain`). No dependencies.
- `packages/contracts` — JSON-safe types shared by backend and UI. No dependencies.
- `packages/application` — use cases, authorization, ports; in-memory adapters under `src/testing`.
- `packages/ui` — React components and design tokens; talks to the backend through `PlanningPokerApi`.
- `packages/persistence/forge` — Forge Custom Entity Store repositories (`@planning-poker/persistence-forge`).
- `packages/integrations/jira` — Jira Cloud adapters, starting with identity (`@planning-poker/integration-jira`). Rules in `packages/integrations/AGENTS.md`.
- `apps/jira-forge` — the Forge app: manifest, resolver wiring (`src/index.ts`), request handlers (`src/handlers.ts`) and Custom UI (`static/main`). Every resolver returns `ResolverResult`; add new ones to `PlanningPokerResolvers` in contracts first.

## Boundaries

- Keep business rules in `packages/domain`; no framework, HTTP, database, Forge or Jira dependencies there.
- Keep storage and external platforms behind explicit ports/interfaces.
- Keep the UI separate from business rules; the server validates all permissions and state changes.
- Prefer a simple existing abstraction over a new one. No speculative plugin framework.

## Non-negotiable behaviour

- Enforce moderator/member permissions on the server.
- Keep each participant's vote choice hidden until that ticket's reveal conditions are met. Never expose identity-to-vote mappings to participants or moderators.
- Observers and skipped members must not block a round; only eligible voters determine completion.
- Support deck-specific values, including infinity and coffee, without assuming every card is numeric.
- Keep draft sessions separate from published sessions.
- Do not auto-advance unless that session has the option enabled and its consensus condition is met.

## Code style and checks

Prettier owns formatting; ESLint owns code quality and structure. Don't duplicate rules between them, and never hand-format against Prettier.

- Formatting (Prettier + `.editorconfig`): 2 spaces, single quotes, semicolons, 100-char lines, trailing commas, LF, final newline, arrow parens always.
- ESLint (`eslint.config.mjs`): braces on every control-flow statement, `===`/`!==`, `const` over `let`, no `var`, no unused variables/imports, no `any` (use `unknown` and narrow), no floating promises, no empty `catch`, no `console` (use the project logger), early returns over `else` after `return`, blank line after blocks, magic numbers flagged as warnings.
- Package boundaries are enforced by ESLint (`no-restricted-imports`): domain and contracts import nothing; application imports no platform, UI or Node APIs; UI imports only contracts.
- TypeScript runs in `strict` mode with `noUncheckedIndexedAccess`.
- Don't disable a lint rule without a comment explaining why.
- Prefer simple, readable code with descriptive names and small, focused functions. No unnecessary abstractions.

Scripts:

- `npm run lint` / `npm run lint:fix` — ESLint.
- `npm run format` / `npm run format:check` — Prettier.
- `npm run typecheck` — `tsc` for every package.
- `npm test` — Vitest (domain, application and acceptance scenarios A–J).
- `npm run build` — builds the Custom UI into `apps/jira-forge/static/main/build`.
- `npm run check` — lint, format check, type check and tests. CI runs this and the build on every push and pull request; run it before finishing a change.

## Delivery

- Keep changes scoped; avoid unrelated refactors.
- Add or update tests for changed domain rules, permissions and race-sensitive behaviour.
- Never commit credentials or expose tokens in logs.
- Run relevant checks when available; report what was changed, tested and left undecided.

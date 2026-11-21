---
name: build-feature
description: Implement a Planning Poker feature across domain, application and UI layers while preserving architecture and product rules.
---

# Build a feature

1. Read the relevant rules in `AGENTS.md`, `docs/PRODUCT_RULES.md` and `docs/ARCHITECTURE.md`.
2. Identify the feature's owner: core, application, integration or UI.
3. Define the smallest domain behaviour and public contract needed.
4. Implement only the required adapters and UI; follow `docs/UI_STYLE.md` for visible changes.
5. Test permissions, valid/invalid transitions and important edge cases.
6. Run `npm run check` and verify no dependency boundary was crossed.

Finish with a short summary of changes, tests and any unresolved product decision. Avoid unrelated refactoring.

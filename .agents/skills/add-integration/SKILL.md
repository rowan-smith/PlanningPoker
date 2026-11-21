---
name: add-integration
description: Add or change a Jira, ticket-source, storage or external-platform integration without leaking vendor details into the core.
---

# Add an integration

1. Read `docs/ARCHITECTURE.md` and `packages/integrations/AGENTS.md`.
2. Reuse an existing port; introduce a new one only when the capability differs.
3. Define the neutral data model passed to the application/core.
4. Implement mapping, auth, pagination and error handling inside the adapter.
5. Make imports idempotent and define behaviour for partial failures.
6. Add contract tests with representative responses and failures.
7. Check that no vendor SDK, JQL or storage-specific type entered core, and run `npm run check`.

Document setup requirements without committing secrets. Estimate write-back follows the finalization workflow in `docs/PRODUCT_RULES.md`; don't add other syncing unless requested.

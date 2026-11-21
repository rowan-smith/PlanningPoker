# Integrations — adapter rules

This directory connects Planning Poker to systems such as Jira and storage providers.

- Implement a defined port/interface; do not change core logic to fit one vendor.
- Translate external ticket, identity and error formats at the boundary.
- Keep JQL, Jira SDKs, credentials and API-specific pagination out of core.
- Make imports safe to retry and avoid duplicate tickets for the same imported source item.
- Handle timeouts, rate limits and partial failures explicitly.
- Never log secrets or raw access tokens.
- Write contract tests for the adapter and test empty, malformed and partially failing responses.
- Write estimates back only through `WorkItemProvider.validateUpdate`/`update`, honouring `expectedCurrentValue` for conflict detection and the idempotency key for retries.
- Verify Jira REST endpoints and Forge APIs against current Atlassian docs before implementing them. The REST reference pages render empty to fetchers; use the OpenAPI spec at `https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json`.
- Act as the user (`asUser`) whenever reading or writing issue content, so Jira permissions apply. Use `asApp` only for directory lookups.

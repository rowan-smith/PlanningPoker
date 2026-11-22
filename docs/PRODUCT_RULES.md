# Product rules

Source: _Planning Poker — Product & Engineering Specification v2.1_. This file records the rules the code implements and the assumptions made where the spec is silent. Change an assumption only as a product decision, and update the tests that pin it.

## Roles

- **Application roles:** administrator (settings, all teams, assigns moderators), moderator (creates teams, manages the teams they moderate), member.
- **Session participation is separate:** voter or observer. Facilitators are moderators running the session; they default to observing and can be made voters, keeping moderator controls either way.
- Team membership ≠ session participation. Each session keeps its own roster.

## Confirmed behaviour

- Sessions: `draft → ready → active → completed`, plus `active ⇄ paused` and `cancelled`. Draft and ready sessions are hidden from ordinary members. Any edit to a ready session sends it back to draft.
- Readiness (before publish): name, active team, ≥1 ticket, valid deck, valid field mappings, ≥1 intended voter, consistent invitations/roles. Missing destination field and special cards are warnings.
- Invitations are per session (invited → joined | declined | revoked) and never add anyone to the team or bypass Jira permissions.
- **Frozen roster:** every round snapshots its required voters when it opens. People can leave an open round (skip, become observer, decline, revoke) but never join one; new voters count from the next round or ticket, or when a moderator restarts the round.
- **Skipping:** per ticket or for the rest of the session. A skipped voter's existing vote stops counting and never appears in results; the audit records only that a vote existed. Skipping keeps session access.
- **Restoring** before reveal makes the voter required again and discards their earlier vote. Revealed rounds are never changed retroactively.
- **Reveal** happens automatically when every required voter has voted. With zero required voters nothing reveals, finalizes or advances.
- Voters may change their vote until reveal. A revealed ticket can be revoted with a new round.
- **Pre-voting:** joined voters may vote on future tickets. Those votes stay hidden and count only if the voter is on the roster when that ticket's round opens.
- **Results are anonymous:** values and counts ordered by the deck, never by voter. No view, event, report or audit entry pairs a person with a vote value.
- **Unanimous** = every counted vote is the same card. A unanimous regular, mappable card auto-finalizes when enabled. A unanimous special card (∞ ? ☕) needs a moderator decision. No averages or majorities.
- **Disagreement:** moderator starts a new round or overrides with a required reason.
- **Finalization and sync are separate state machines.** A ticket can be finalized while its write fails. Sync: `not-required | pending | syncing | succeeded | failed | conflict`. Conflicts (field changed since import) are never overwritten without explicit moderator confirmation. Retries reuse the decision's idempotency key.
- **Auto-advance** only after an automatic finalization, when enabled, and only once the write succeeded.
- Field IDs are discovered from the provider and never hardcoded. Special cards are never written to number fields.
- **Three separate field concepts:** display-only ticket fields (per session, M4); the administrator's **allowlist of writable fields** (Settings; number and single-select fields only); and each session's **destination mapping** (one allowlisted field, plus card → option for single-select fields). Readiness fails when the destination is not on the allowlist or a regular card has no option.
- Finalization order: final score → mapping check → allowlist check → edit permission and value check (editmeta) → external-change check (current value vs. the value captured at import or at the last mapping change) → write → record outcome → notify → auto-advance if allowed. The estimate stays final whatever the write outcome.
- All moderator actions that change requirements, estimates or outcomes are audited.

## Assumptions (not settled by the spec)

1. Voters who are invited but have not joined are on the round roster (the spec lists only declined/revoked as exclusions). They must join before voting; moderators skip absentees.
2. A voter switched to observer during an open round leaves that round; otherwise the round could never complete.
3. An override must be a regular card, and is allowed after any reveal, whether unanimous or disputed.
4. Auto-advance also happens when no destination field is configured (sync `not-required`).
5. Moving away from a ticket with an open round leaves the round open; returning resumes it with the same roster.
6. Skipping a ticket does not change the current ticket; the moderator moves on explicitly.
7. Only roster members (invited or joined) and moderators can view a published session; other team members cannot.
8. Assigning or unassigning team moderators is administrator-only.
9. Jira administrators (global ADMINISTER permission) are Planning Poker administrators. Application moderators are chosen by administrators in Settings. Everyone else is a member.
10. Moderators are team members: assigning a moderator adds them to the team. A team always keeps at least one moderator.
11. Only people who can manage at least one team (or create teams) may search the Jira user directory.
12. Archived teams are read-only and cannot host new sessions.
13. Publishing a valid draft marks it ready and publishes it in one step; the review screen shows the same readiness check first.
14. Removing someone from a draft deletes them from the roster; after publishing, "remove" revokes their invitation so the history keeps them.
15. Custom decks: up to 30 cards; numeric decks need every label to parse as a number.
16. A vote retried after its round already revealed (e.g. a concurrent-write retry) succeeds silently if it matches the stored vote.
17. Imports and searches run as the moderator, so Jira's issue permissions decide what can be imported. Keys that do not exist or are not visible are reported together as "not found, or you do not have access" — Jira does not distinguish them.
18. Up to 100 keys per import and 5 extra display fields per session. Changing display fields refreshes tickets already in the draft.
19. Descriptions and field values are stored as plain text (converted from Atlassian Document Format) and shown as text. Rich formatting such as tables and images is reduced to text.
20. Moderators can move to the next open ticket or to any chosen ticket, only while the session is active (not paused). Choosing a closed ticket just shows it; nothing reopens.
21. A voter must join before voting; invited voters still count as required for the round (assumption 1), so the room shows "Invited · waiting" for them.
22. An issue whose key changed since it was typed (moved between projects) is imported under its new key and the old key is also listed as not found.
23. Restarting an open round (a new round before reveal) discards that round's votes and freezes a fresh roster, so voters who joined late take part. Revoting after a reveal does the same and keeps the revealed round as history.
24. While a session is paused, moderators can still manage participants (invite, change roles, skip, restore), accept or override a revealed result and skip tickets. Voting, reveal, revote and moving between tickets wait for resume; a round that became complete while paused reveals on resume.
25. Manual reveal is offered, but uses the same condition as auto-reveal (every required voter has voted). To reveal without absent voters, the moderator skips them for the ticket.
26. With auto-finalize off, a moderator accepts a unanimous regular result explicitly. If the destination field cannot take that value, accepting is refused and the moderator overrides instead. Override reasons are limited to 500 characters and stored in the audit log.
27. Skipping a voter "for this ticket" needs an open round on the current ticket; "for the rest of the session" works at any time while the session runs.
28. (M7) Single-select options are read from each ticket's Jira edit metadata as the moderator (up to 10 tickets), not from field contexts, which need Jira administrator rights. Cards map to option **values**; writes send `{ "value": … }`, so one mapping works across projects whose contexts share option names.
29. (M7) A field that already holds the value being written counts as written (no conflict). This makes retries idempotent; Jira edits have no idempotency key.
30. (M7) A write stuck in `syncing` for 2 minutes (`STUCK_SYNC_AFTER_MS`) is treated as interrupted: a moderator may retry it, which closes the attempt as failed and writes again with the same idempotency key (safe by 29). Before that, retry is refused.
31. (M7) A field removed from the allowlist after publishing makes later writes fail visibly; publishing is blocked while the mapping points at it.
32. (M7) Missing edit permission is reported when Jira's edit metadata lists no editable fields; a field missing from it (not on the screen or context) is reported as invalid. HTTP 409/422/429/5xx are recorded as retryable failures; nothing is retried automatically.
33. (M7) Additional writable fields remain unsupported in the UI; only the destination field is written.

## Reports and history (Milestone 8)

Definitions used by session summaries, team reports and the application report. Categories can overlap.

- **Invited:** everyone who had an invitation, whatever their response. Facilitators are not invited.
- **Joined:** invitees who accepted. **Declined**, **revoked** (removed by a moderator) and **no response** are listed separately.
- **Voting:** people whose vote was counted in at least one revealed round. A round reveals only when every required voter has voted and revealed rounds never change, so these are exactly the required voters of revealed rounds; individual votes are never read for reports.
- **Observing:** joined observers and facilitators who did not vote.
- **Skipped:** anyone with a skip record (per ticket or for the session), including ones later restored.
- **Revotes:** rounds started after a ticket's first. **Disagreements:** revealed rounds whose votes differed. **Unanimous tickets:** the latest revealed round was unanimous (even if a moderator then overrode it).
- **Ticket outcome:** estimated (finalized), skipped, unresolved (open when the session completed) or in progress.
- **Moderator** on a summary is the session's creator; facilitators are listed separately.

Assumptions:

34. Summaries are available for any published or cancelled session to anyone who can view the session (the running ones are marked as not final); drafts have none. Summaries of the same session are computed from the stored aggregate on every request, so a completed session's summary never changes.
35. Session History lists published and cancelled sessions the person can view (assumption 7 applies), filed under completion, else publication, else creation date. Date filters are whole UTC days, inclusive.
36. Team and application reports count **completed** sessions only, filtered by completion date. Team reports are for the team's moderators and administrators; the application report is for administrators only. Application moderators who do not moderate a team cannot see its report.
37. "People who took part" in the application report = joined invitees plus facilitators.
38. The audit log is for session moderators (team moderators, facilitators, administrators). Audit views drop any detail that could hold a card choice; the override's chosen estimate is shown on the summary instead.
39. Anonymous distributions are shown per revealed round, as in the planning room. A round with a single voter therefore shows that voter's choice to anyone who knows they voted — the same as the live room.

## Open decisions

- What value is written to the "additional writable fields"? They are stored and validated but not written yet.
- Should team members who are not on the roster be able to observe a published session?

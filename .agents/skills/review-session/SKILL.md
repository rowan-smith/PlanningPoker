---
name: review-session
description: Review or change session lifecycle, invitation, skipping, anonymity, voting, reveal, consensus and moderator override behaviour.
---

# Review session behaviour

1. Read `docs/PRODUCT_RULES.md` and the core agent rules.
2. Identify which actors can perform each action and which session states allow it.
3. Check that only eligible voters count toward completion; observers/skipped members do not block it.
4. Check vote privacy before reveal and anonymous results after reveal.
5. Check current and future ticket voting without leaking unrevealed scores.
6. Check special cards, ties, overrides and optional consensus auto-advance.
7. Test duplicate/concurrent votes, late participation and conflicting state changes.

Report concrete issues and missing product decisions. If asked to implement a fix, make the smallest change and add regression tests.

# UI — experience rules

Build a clear, fast interface for moderators and participants.

- Follow `docs/UI_STYLE.md` for palette, spacing, states and copy.
- Reuse shared components and design tokens; avoid one-off colours and spacing.
- Show moderator controls only where appropriate, but never rely on the UI for authorisation.
- Clearly distinguish voting, waiting, revealed, skipped and observing states.
- Never display another person's choice before reveal or show who cast which vote afterward.
- Make voting cards keyboard-operable, touch-friendly and accessible without colour alone.
- Keep interfaces readable on phones and desktop screens.
- Keep domain calculations in core/application code, not in UI components.

# UI style guide

## Direction

A focused, friendly collaborative tool: playful voting cards, calm workspace, obvious facilitator controls. Avoid flashy effects that compete with estimation.

## Starter tokens (provisional)

- Background: `#12141A`
- Surface: `#20232E`
- Primary action: `#62E6D5`
- Highlight: `#FFC76A`
- Primary text: `#F4F6FA`

Use named design tokens; don't scatter these hex values through components. Revisit the palette once the app's visual identity is approved.

## Layout and components

- Use a consistent spacing scale; favour breathing room over dense dashboards.
- Use clear headings, readable body text and strong focus indicators.
- Prefer reusable buttons, vote cards, ticket lists, badges and dialogs.
- Keep the active ticket and voting action visually prominent.
- Distinguish moderator controls from participant actions.
- Design phone and desktop layouts together; no desktop-only interactions.

## Behaviour and accessibility

- Show clear states: ready to vote, selected, waiting, revealed, observing and skipped.
- Never signal a state by colour alone; include words or icons.
- All controls need useful labels, keyboard support and visible focus.
- Keep motion short and optional; respect reduced-motion preferences.
- Use concise, neutral UI copy: "Vote", "Waiting for votes", "Reveal", "Skip member".
- Do not display participant-to-vote associations, even after reveal.

If a component lacks a defined style, extend the existing system instead of inventing a one-off pattern.

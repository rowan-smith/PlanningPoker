# Planning Poker

Collaborative estimation for agile teams, built as a platform-independent TypeScript monorepo. The first integration is Jira Cloud via Atlassian Forge.

## Status

| Milestone                 | Code | Accepted                                   |
| ------------------------- | ---- | ------------------------------------------ |
| 1 — Foundation            | Done | No — not yet installed on a Jira dev site  |
| 2 — Teams and permissions | Done | No — needs a Jira dev site with real users |
| 3 — Session builder       | Done | No — needs a Jira dev site                 |
| 4 — Jira ticket import    | Done | No — needs real Jira issues on a dev site  |
| Voting engine (for M3–M6) | Done | Domain + application only; scenarios A–J   |

## Commands

```sh
npm install
npm run check      # lint, format check, type check, tests
npm test           # Vitest
npm run build      # Custom UI → apps/jira-forge/static/main/build
```

## Running locally with the mock backend

```sh
npm run dev:ui --workspace @planning-poker/jira-forge
```

Open http://localhost:5173/dev.html. The page runs the real resolver handlers and application services in the browser against in-memory storage, a seeded user directory (Ada Admin, Max Moderator, Mia Member, Sam Developer, Lee Tester), a fake Jira project with issues `PP-1` to `PP-8` (search it with any words, e.g. `project = PP` or `bug`; the fake ignores JQL syntax), one published session (Mia has a pending invitation) and one draft. Pick who you are with a query parameter:

- `dev.html?as=admin` (default) — Jira administrator: all teams, Settings, moderator assignment.
- `dev.html?as=moderator` — application moderator: can create teams and manage their own.
- `dev.html?as=member` — Mia: a member with a pending session invitation.
- `dev.html?as=sam` / `dev.html?as=observer` — Sam (joined voter) and Lee (invited observer).

Data resets on reload. `http://localhost:5173/` (without `dev.html`) is the real Forge entry and stays blank outside Jira.

## Public demo (GitHub Pages)

`.github/workflows/pages.yml` publishes the same in-browser demo as a static site on every push to `main` (or run it by hand from the Actions tab). It runs `npm run check` first and only publishes if that passes. The demo shows a banner and a switcher for viewing it as each sample person; it never calls Jira and stores nothing outside the visitor's browser.

One-time setup after pushing the repository to GitHub:

1. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
2. Push to `main`, or run **Demo site** from the Actions tab.
3. The site appears at `https://<owner>.github.io/<repository>/`; the workflow run shows the exact URL.

Pages on a private repository needs a paid GitHub plan; the demo itself (code and sample data) is public once published. Build and check it locally with:

```sh
npm run build:demo
npm run preview:demo --workspace @planning-poker/jira-forge   # http://localhost:4173
```

## Deploying to a Jira development site

Requires the Forge CLI (`npm install -g @forge/cli`) and an Atlassian developer account.

```sh
cd apps/jira-forge
forge login
forge register          # replaces the placeholder app.id in manifest.yml
npm run build --workspace @planning-poker/jira-forge
forge deploy
forge install           # choose Jira and your development site
```

Milestones 2–3 add scopes (`storage:app`, `read:jira-user`, `read:jira-work`) and storage entities. On a site where an earlier version is installed, run `forge install --upgrade` and approve the new scopes. Use `forge logs` to see resolver errors.

Then open **Apps → Planning Poker** in Jira.

## Docs

- [Product rules and assumptions](docs/PRODUCT_RULES.md)
- [Architecture boundaries](docs/ARCHITECTURE.md)
- [UI style guide](docs/UI_STYLE.md)
- [Agent and code-style rules](AGENTS.md)

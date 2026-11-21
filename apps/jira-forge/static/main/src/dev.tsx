/**
 * Runs Planning Poker outside Jira with an in-memory backend: the local preview (`npm run dev:ui`,
 * then open /dev.html) and the public demo site (`npm run build:demo`). `@forge/bridge` only works
 * inside Atlassian products, so this entry never imports it. Not part of the Forge build.
 */
import '@planning-poker/ui/styles.css';
import './demo.css';

import { App } from '@planning-poker/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createDevApi } from './dev-backend';

const ROLES = [
  { key: 'admin', label: 'Ada — Jira admin' },
  { key: 'moderator', label: 'Max — moderator' },
  { key: 'member', label: 'Mia — invited voter' },
  { key: 'sam', label: 'Sam — voter' },
  { key: 'observer', label: 'Lee — invited observer' },
] as const;

function DemoBanner({ current }: { readonly current: string }) {
  return (
    <aside className="pp-demo" aria-label="Demo">
      <p className="pp-demo-text">
        <strong>Demo</strong> — sample data in your browser only; it resets when you reload or
        switch person. In Jira, data comes from your site.
      </p>
      <nav aria-label="View the demo as">
        <ul className="pp-demo-roles">
          {ROLES.map((role) => (
            <li key={role.key}>
              <a
                className="pp-demo-role"
                href={`?as=${role.key}`}
                aria-current={role.key === current ? 'page' : undefined}
              >
                {role.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

const container = document.getElementById('root');

if (container === null) {
  throw new Error('Planning Poker could not find its root element.');
}

const root = container;
const requested = new URLSearchParams(window.location.search).get('as') ?? 'admin';
const current = ROLES.some((role) => role.key === requested) ? requested : 'admin';

void createDevApi(window.location.search).then((api) => {
  createRoot(root).render(
    <StrictMode>
      <DemoBanner current={current} />
      <App api={api} />
    </StrictMode>,
  );
});

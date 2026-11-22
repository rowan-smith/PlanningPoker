/**
 * Local preview of the Jira-styled app with the in-memory backend (`npm run dev:ui`, then open
 * /jira-dev.html; add `?as=moderator`, `member`, `sam` or `observer` to switch person). Mirrors
 * main.tsx without `@forge/bridge`. Not part of the Forge build or the public demo.
 */
import '@planning-poker/ui/styles.css';
import '@planning-poker/ui/themes/jira.css';

import { App } from '@planning-poker/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createDevApi } from './dev-backend';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('Planning Poker could not find its root element.');
}

const root = container;

void createDevApi(window.location.search).then(({ api }) => {
  createRoot(root).render(
    <StrictMode>
      <App api={api} sidebar={{ platformName: 'Jira Cloud' }} />
    </StrictMode>,
  );
});

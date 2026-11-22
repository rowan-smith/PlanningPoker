import '@planning-poker/ui/styles.css';
import '@planning-poker/ui/themes/jira.css';

import { App } from '@planning-poker/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { forgeApi } from './forge-api';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('Planning Poker could not find its root element.');
}

createRoot(container).render(
  <StrictMode>
    <App api={forgeApi} sidebar={{ platformName: 'Jira Cloud' }} />
  </StrictMode>,
);

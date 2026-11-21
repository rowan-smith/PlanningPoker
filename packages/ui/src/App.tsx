import type { HomeView } from '@planning-poker/contracts';
import { useCallback, useState } from 'react';

import type { PlanningPokerApi } from './api';
import { EmptyState } from './components/EmptyState';
import { ErrorMessage, Loading } from './components/Feedback';
import { HomePage } from './components/HomePage';
import type { PageKey } from './components/Navigation';
import { Navigation, PAGES } from './components/Navigation';
import { SessionsPage } from './components/SessionsPage';
import { SettingsPage } from './components/SettingsPage';
import { TeamsPage } from './components/TeamsPage';
import { useLoad } from './hooks';

export interface AppProps {
  readonly api: PlanningPokerApi;
}

export function App({ api }: AppProps) {
  const [page, setPage] = useState<PageKey>('home');
  /** Bumped on every navigation so pages remount fresh (and re-fetch) when revisited. */
  const [visit, setVisit] = useState(0);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const loadHome = useCallback(async () => await api.call('getHome', {}), [api]);
  const home = useLoad<HomeView>(loadHome);
  const pageLabel = PAGES.find((entry) => entry.key === page)?.label ?? '';
  const navigate = (next: PageKey, sessionId: string | null = null) => {
    setPage(next);
    setOpenSessionId(sessionId);
    setVisit((current) => current + 1);

    if (next === 'home') {
      home.reload();
    }
  };

  return (
    <div className="pp-app">
      <div className="pp-layout">
        <header className="pp-row">
          <h1 className="pp-page-title pp-row-main">Planning Poker</h1>
          {home.state.status === 'loaded' && (
            <span className="pp-muted">{home.state.value.user.displayName}</span>
          )}
        </header>
        <Navigation
          current={page}
          onNavigate={(next) => {
            navigate(next);
          }}
        />
        <main key={visit}>
          {page === 'home' && home.state.status === 'loading' && <Loading />}
          {page === 'home' && home.state.status === 'failed' && (
            <ErrorMessage message={home.state.message} />
          )}
          {page === 'home' && home.state.status === 'loaded' && (
            <HomePage
              api={api}
              home={home.state.value}
              onHomeChange={home.replace}
              onOpenSession={(sessionId) => {
                navigate('sessions', sessionId);
              }}
            />
          )}
          {page === 'teams' && <TeamsPage api={api} />}
          {page === 'sessions' && <SessionsPage api={api} initialSessionId={openSessionId} />}
          {page === 'settings' && <SettingsPage api={api} />}
          {(page === 'history' || page === 'reports') && (
            <section className="pp-page" aria-labelledby="pp-page-title">
              <h2 id="pp-page-title" className="pp-page-title">
                {pageLabel}
              </h2>
              <EmptyState title={`${pageLabel} is not available yet`} message="Coming soon." />
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

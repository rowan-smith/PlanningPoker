import type { HomeView } from '@planning-poker/contracts';
import { useCallback, useState } from 'react';

import type { PlanningPokerApi } from './api';
import { ErrorMessage, Loading } from './components/Feedback';
import { HomePage } from './components/HomePage';
import type { PageKey } from './components/Navigation';
import { Navigation, PAGES, Sidebar } from './components/Navigation';
import { ReportsPage } from './components/ReportsPage';
import { SessionHistoryPage } from './components/SessionHistoryPage';
import { SessionsPage } from './components/SessionsPage';
import { SettingsPage } from './components/SettingsPage';
import { TeamsPage } from './components/TeamsPage';
import { useLoad } from './hooks';

export interface AppProps {
  readonly api: PlanningPokerApi;
  /**
   * Show a full-height sidebar (brand, navigation, connection footer) instead of the stacked
   * header and button row. Used when a host such as Jira gives the app a whole page.
   */
  readonly sidebar?: { readonly platformName: string };
}

export function App({ api, sidebar }: AppProps) {
  const [page, setPage] = useState<PageKey>('home');
  /** Bumped on every navigation so pages remount fresh (and re-fetch) when revisited. */
  const [visit, setVisit] = useState(0);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const loadHome = useCallback(async () => await api.call('getHome', {}), [api]);
  const home = useLoad<HomeView>(loadHome);
  const pageLabel = PAGES.find((entry) => entry.key === page)?.label ?? '';
  const userName = home.state.status === 'loaded' ? home.state.value.user.displayName : null;
  const navigate = (next: PageKey, sessionId: string | null = null) => {
    setPage(next);
    setOpenSessionId(sessionId);
    setVisit((current) => current + 1);

    if (next === 'home') {
      home.reload();
    }
  };

  const content = (
    <main key={visit} className="pp-main">
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
      {page === 'history' && <SessionHistoryPage api={api} />}
      {page === 'reports' && <ReportsPage api={api} />}
    </main>
  );

  if (sidebar !== undefined) {
    return (
      <div className="pp-app pp-shell">
        <Sidebar
          current={page}
          platformName={sidebar.platformName}
          userName={userName}
          onNavigate={(next) => {
            navigate(next);
          }}
        />
        <div className="pp-shell-content">
          <h1 className="pp-visually-hidden">Planning Poker</h1>
          <p className="pp-crumbs">
            Planning Poker <span aria-hidden="true">/</span> {pageLabel}
          </p>
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="pp-app">
      <div className="pp-layout">
        <header className="pp-row">
          <h1 className="pp-page-title pp-row-main">Planning Poker</h1>
          {userName !== null && <span className="pp-muted">{userName}</span>}
        </header>
        <Navigation
          current={page}
          onNavigate={(next) => {
            navigate(next);
          }}
        />
        {content}
      </div>
    </div>
  );
}

export type PageKey = 'home' | 'teams' | 'sessions' | 'history' | 'reports' | 'settings';

export const PAGES: readonly { readonly key: PageKey; readonly label: string }[] = [
  { key: 'home', label: 'Home' },
  { key: 'teams', label: 'Teams' },
  { key: 'sessions', label: 'Planning Sessions' },
  { key: 'history', label: 'Session History' },
  { key: 'reports', label: 'Reports' },
  { key: 'settings', label: 'Settings' },
];

export interface NavigationProps {
  readonly current: PageKey;
  readonly onNavigate: (page: PageKey) => void;
}

export function Navigation({ current, onNavigate }: NavigationProps) {
  return (
    <nav aria-label="Planning Poker">
      <ul className="pp-nav" role="list">
        {PAGES.map((page) => (
          <li key={page.key}>
            <button
              type="button"
              className="pp-nav-item"
              aria-current={page.key === current ? 'page' : undefined}
              onClick={() => {
                onNavigate(page.key);
              }}
            >
              {page.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

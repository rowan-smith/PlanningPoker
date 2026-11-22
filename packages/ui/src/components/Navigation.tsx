export type PageKey = 'home' | 'teams' | 'sessions' | 'history' | 'reports' | 'settings';

export const PAGES: readonly {
  readonly key: PageKey;
  readonly label: string;
  /** Decorative glyph for the sidebar; the label always carries the meaning. */
  readonly glyph: string;
}[] = [
  { key: 'home', label: 'Home', glyph: '⌂' },
  { key: 'teams', label: 'Teams', glyph: '♧' },
  { key: 'sessions', label: 'Planning Sessions', glyph: '▤' },
  { key: 'history', label: 'Session History', glyph: '◷' },
  { key: 'reports', label: 'Reports', glyph: '▥' },
  { key: 'settings', label: 'Settings', glyph: '⚙' },
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

export interface SidebarProps extends NavigationProps {
  /** Platform the app runs in, e.g. "Jira Cloud"; shown under the brand and in the footer. */
  readonly platformName: string;
  readonly userName: string | null;
}

/** Vertical navigation with brand and footer, for hosts that give the app a full page. */
export function Sidebar({ current, onNavigate, platformName, userName }: SidebarProps) {
  return (
    <aside className="pp-sidebar">
      <div className="pp-brand">
        <span className="pp-brand-icon" aria-hidden="true">
          ♠
        </span>
        <div>
          <p className="pp-brand-name">Planning Poker</p>
          <p className="pp-brand-sub">for {platformName}</p>
        </div>
      </div>
      <nav aria-label="Planning Poker">
        <p className="pp-sidebar-section" aria-hidden="true">
          Workspace
        </p>
        <ul className="pp-sidebar-nav" role="list">
          {PAGES.map((page) => (
            <li key={page.key}>
              <button
                type="button"
                className="pp-sidebar-link"
                aria-current={page.key === current ? 'page' : undefined}
                onClick={() => {
                  onNavigate(page.key);
                }}
              >
                <span className="pp-sidebar-glyph" aria-hidden="true">
                  {page.glyph}
                </span>
                {page.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="pp-sidebar-footer">
        {userName !== null && <p className="pp-sidebar-user">{userName}</p>}
        <p className="pp-muted">
          Connected to {platformName}{' '}
          <span className="pp-status-dot" aria-hidden="true">
            ●
          </span>
        </p>
      </div>
    </aside>
  );
}

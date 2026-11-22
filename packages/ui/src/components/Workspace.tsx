import type { ApplicationRoleDto, HomeView } from '@planning-poker/contracts';
import { useId, useState } from 'react';

import type { IconName } from './Icon';
import { Icon } from './Icon';
import type { PageKey } from './Navigation';
import { PAGES } from './Navigation';

/** Branding for the standalone workspace layout (App `workspace` option). */
export interface WorkspaceOptions {
  readonly productName: string;
  /** Short line shown above every page title. */
  readonly tagline: string;
  /** Optional nav labels, e.g. "Dashboard" for Home. Pages keep their own headings. */
  readonly pageLabels?: Partial<Record<PageKey, string>>;
}

const PAGE_ICONS: Readonly<Record<PageKey, IconName>> = {
  home: 'home',
  teams: 'teams',
  sessions: 'sessions',
  history: 'history',
  reports: 'reports',
  settings: 'settings',
};

const ROLE_LABELS: Readonly<Record<ApplicationRoleDto, string>> = {
  administrator: 'Administrator',
  moderator: 'Moderator',
  member: 'Member',
};

const PROMO_POINTS = ['Align your team', 'Estimate with confidence', 'Keep delivery predictable'];

function pageLabel(options: WorkspaceOptions, key: PageKey): string {
  return options.pageLabels?.[key] ?? PAGES.find((page) => page.key === key)?.label ?? key;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function SpadeMark() {
  return (
    <svg className="pp-ws-logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="pp-ws-logo-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--pp-color-brand-start)" />
          <stop offset="1" stopColor="var(--pp-color-brand-end)" />
        </linearGradient>
      </defs>
      <path
        fill="url(#pp-ws-logo-fill)"
        d="M16 2.5C11 8.6 4 12.3 4 18.4a6.4 6.4 0 0 0 10.6 4.8L13 29.5h6l-1.6-6.3A6.4 6.4 0 0 0 28 18.4C28 12.3 21 8.6 16 2.5Z"
      />
    </svg>
  );
}

interface TopBarProps {
  readonly options: WorkspaceOptions;
  readonly home: HomeView | null;
  readonly onNavigate: (page: PageKey) => void;
}

/** Brand, a "go to page" box and the signed-in person. */
export function WorkspaceTopBar({ options, home, onNavigate }: TopBarProps) {
  const [query, setQuery] = useState('');
  const [notFound, setNotFound] = useState(false);
  const listId = useId();
  const invitations = home?.pendingInvitations.length ?? 0;
  const go = () => {
    const needle = query.trim().toLowerCase();
    const match = PAGES.find(
      (page) =>
        needle.length > 0 &&
        (pageLabel(options, page.key).toLowerCase().startsWith(needle) ||
          page.label.toLowerCase().startsWith(needle)),
    );
    setNotFound(match === undefined);

    if (match !== undefined) {
      setQuery('');
      onNavigate(match.key);
    }
  };

  return (
    <header className="pp-ws-topbar">
      <p className="pp-ws-brand">
        <SpadeMark />
        {options.productName}
      </p>
      <form
        className="pp-ws-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          go();
        }}
      >
        <Icon name="search" size={18} />
        <label className="pp-visually-hidden" htmlFor={`${listId}-input`}>
          Go to page
        </label>
        <input
          id={`${listId}-input`}
          className="pp-ws-search-input"
          list={listId}
          placeholder="Go to teams, sessions, reports…"
          value={query}
          aria-invalid={notFound}
          onChange={(event) => {
            setQuery(event.target.value);
            setNotFound(false);
          }}
        />
        <datalist id={listId}>
          {PAGES.map((page) => (
            <option key={page.key} value={pageLabel(options, page.key)} />
          ))}
        </datalist>
        <span className="pp-ws-kbd" aria-hidden="true">
          ↵
        </span>
        {notFound && (
          <span className="pp-visually-hidden" role="status">
            No page matches “{query}”.
          </span>
        )}
      </form>
      <button
        type="button"
        className="pp-ws-bell"
        onClick={() => {
          onNavigate('home');
        }}
      >
        <Icon name="bell" />
        <span className="pp-visually-hidden">
          {invitations === 0
            ? 'No pending invitations'
            : `${String(invitations)} pending invitation${invitations === 1 ? '' : 's'}`}
        </span>
        {invitations > 0 && (
          <span className="pp-ws-bell-count" aria-hidden="true">
            {invitations}
          </span>
        )}
      </button>
      {home !== null && (
        <div className="pp-ws-user">
          <span className="pp-avatar pp-avatar-initial pp-ws-user-avatar" aria-hidden="true">
            {initials(home.user.displayName)}
          </span>
          <span>
            <span className="pp-ws-user-name">{home.user.displayName}</span>
            <span className="pp-ws-user-role">{ROLE_LABELS[home.user.role]}</span>
          </span>
        </div>
      )}
    </header>
  );
}

interface NavProps {
  readonly options: WorkspaceOptions;
  readonly current: PageKey;
  readonly onNavigate: (page: PageKey) => void;
}

/** Icon navigation with a short product note underneath. */
export function WorkspaceNav({ options, current, onNavigate }: NavProps) {
  return (
    <aside className="pp-ws-sidebar">
      <nav aria-label="Planning Poker">
        <ul className="pp-ws-nav" role="list">
          {PAGES.map((page) => (
            <li key={page.key}>
              <button
                type="button"
                className="pp-ws-nav-link"
                aria-current={page.key === current ? 'page' : undefined}
                onClick={() => {
                  onNavigate(page.key);
                }}
              >
                <Icon name={PAGE_ICONS[page.key]} />
                {pageLabel(options, page.key)}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section className="pp-ws-promo" aria-label="About planning poker">
        <div className="pp-ws-promo-cards" aria-hidden="true">
          <span>3</span>
          <span>5</span>
          <span>8</span>
        </div>
        <p className="pp-ws-promo-title">Run better estimations with Planning Poker</p>
        <ul className="pp-ws-promo-points" role="list">
          {PROMO_POINTS.map((point) => (
            <li key={point}>
              <Icon name="check" size={16} />
              {point}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

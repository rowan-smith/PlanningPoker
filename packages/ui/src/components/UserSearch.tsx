import type { UserView } from '@planning-poker/contracts';
import { useEffect, useId, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { errorMessage } from '../api';
import { Avatar, ErrorMessage } from './Feedback';

const SEARCH_DELAY_MS = 300;

export interface UserSearchProps {
  readonly api: PlanningPokerApi;
  readonly label: string;
  readonly actionLabel: string;
  /** Users already chosen; shown but not selectable. */
  readonly excludeUserIds: readonly string[];
  readonly disabled?: boolean;
  readonly onSelect: (user: UserView) => void;
}

/** Searches Jira users as you type and offers an action for each result. */
export function UserSearch({
  api,
  label,
  actionLabel,
  excludeUserIds,
  disabled = false,
  onSelect,
}: UserSearchProps) {
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly UserView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      api.call('searchUsers', { query: trimmed }).then(
        (users) => {
          if (!cancelled) {
            setResults(users);
            setError(null);
          }
        },
        (caught: unknown) => {
          if (!cancelled) {
            setError(errorMessage(caught));
          }
        },
      );
    }, SEARCH_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, query]);

  return (
    <div className="pp-stack">
      <label htmlFor={inputId} className="pp-label">
        {label}
      </label>
      <input
        id={inputId}
        className="pp-input"
        type="search"
        autoComplete="off"
        placeholder="Search by name"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
      <ErrorMessage message={error} />
      {query.trim().length > 0 && results.length > 0 && (
        <ul className="pp-list" aria-label="Search results">
          {results.map((user) => {
            const alreadyAdded = excludeUserIds.includes(user.userId);

            return (
              <li key={user.userId} className="pp-row">
                <Avatar name={user.displayName} url={user.avatarUrl} />
                <span className="pp-row-main">{user.displayName}</span>
                {alreadyAdded ? (
                  <span className="pp-muted">Already added</span>
                ) : (
                  <button
                    type="button"
                    className="pp-button"
                    disabled={disabled}
                    onClick={() => {
                      onSelect(user);
                      setQuery('');
                    }}
                  >
                    {actionLabel}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

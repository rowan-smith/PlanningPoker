import type { SettingsView } from '@planning-poker/contracts';
import { useCallback } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction, useLoad } from '../hooks';
import { EmptyState } from './EmptyState';
import { Avatar, ErrorMessage, Loading } from './Feedback';
import { UserSearch } from './UserSearch';

export interface SettingsPageProps {
  readonly api: PlanningPokerApi;
}

export function SettingsPage({ api }: SettingsPageProps) {
  const load = useCallback(async () => await api.call('getSettings', {}), [api]);
  const { state, replace } = useLoad<SettingsView>(load);
  const action = useAction();
  const apply = (work: () => Promise<SettingsView>) => {
    void action.run(async () => {
      replace(await work());
    });
  };

  return (
    <section className="pp-page" aria-labelledby="pp-settings-title">
      <h2 id="pp-settings-title" className="pp-page-title">
        Settings
      </h2>
      {state.status === 'loading' && <Loading />}
      {state.status === 'failed' && <ErrorMessage message={state.message} />}
      {state.status === 'loaded' && !state.value.canAdminister && (
        <EmptyState
          title="Settings are for administrators"
          message="Only Jira administrators can change Planning Poker settings."
        />
      )}
      {state.status === 'loaded' && state.value.canAdminister && (
        <section className="pp-card pp-stack" aria-labelledby="pp-moderators-title">
          <h3 id="pp-moderators-title" className="pp-section-title">
            Moderators
          </h3>
          <p className="pp-muted">
            Moderators can create teams. Jira administrators always have full access.
          </p>
          <ErrorMessage message={action.error} />
          {state.value.moderators.length === 0 ? (
            <p className="pp-muted">No moderators yet.</p>
          ) : (
            <ul className="pp-list">
              {state.value.moderators.map((moderator) => (
                <li key={moderator.userId} className="pp-row">
                  <Avatar name={moderator.displayName} url={moderator.avatarUrl} />
                  <span className="pp-row-main">{moderator.displayName}</span>
                  <button
                    type="button"
                    className="pp-button"
                    disabled={action.pending}
                    onClick={() => {
                      apply(
                        async () =>
                          await api.call('unassignAppModerator', { userId: moderator.userId }),
                      );
                    }}
                  >
                    Remove
                    <span className="pp-visually-hidden"> {moderator.displayName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <UserSearch
            api={api}
            label="Add a moderator"
            actionLabel="Make moderator"
            disabled={action.pending}
            excludeUserIds={state.value.moderators.map((moderator) => moderator.userId)}
            onSelect={(user) => {
              apply(async () => await api.call('assignAppModerator', { userId: user.userId }));
            }}
          />
        </section>
      )}
    </section>
  );
}

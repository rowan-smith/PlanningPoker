import type { FieldAllowlistView } from '@planning-poker/contracts';
import { useCallback, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction, useLoad } from '../hooks';
import { ErrorMessage, Loading } from './Feedback';

const VALUE_TYPE_LABELS = { number: 'Number', option: 'Single select' } as const;

export interface WritableFieldsSettingsProps {
  readonly api: PlanningPokerApi;
}

/** Administrators choose which Jira fields sessions may write final estimates to. */
export function WritableFieldsSettings({ api }: WritableFieldsSettingsProps) {
  const load = useCallback(async () => await api.call('getFieldAllowlist', {}), [api]);
  const { state, replace } = useLoad<FieldAllowlistView>(load);

  return (
    <section className="pp-card pp-stack" aria-labelledby="pp-writable-fields-title">
      <h3 id="pp-writable-fields-title" className="pp-section-title">
        Fields for estimates
      </h3>
      <p className="pp-muted">
        Moderators can save final estimates to these Jira fields. Only number and single-select
        fields are supported.
      </p>
      {state.status === 'loading' && <Loading />}
      {state.status === 'failed' && <ErrorMessage message={state.message} />}
      {state.status === 'loaded' && (
        <FieldChoices api={api} allowlist={state.value} onSaved={replace} />
      )}
    </section>
  );
}

function FieldChoices({
  api,
  allowlist,
  onSaved,
}: {
  readonly api: PlanningPokerApi;
  readonly allowlist: FieldAllowlistView;
  readonly onSaved: (view: FieldAllowlistView) => void;
}) {
  const action = useAction();
  const availableIds = new Set(allowlist.available.map((field) => field.id));
  // Fields that disappeared from Jira are dropped on the next save.
  const saved = allowlist.selectedIds.filter((id) => availableIds.has(id));
  const [chosen, setChosen] = useState<readonly string[]>(saved);
  const changed = chosen.length !== saved.length || chosen.some((id) => !saved.includes(id));

  if (allowlist.available.length === 0) {
    return <p className="pp-muted">No number or single-select fields were found in Jira.</p>;
  }

  return (
    <form
      className="pp-stack"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          onSaved(await api.call('setFieldAllowlist', { fieldIds: chosen }));
        });
      }}
    >
      <fieldset className="pp-fieldset pp-stack">
        <legend className="pp-label">Allowed fields</legend>
        {allowlist.available.map((field) => (
          <label key={field.id} className="pp-check">
            <input
              type="checkbox"
              checked={chosen.includes(field.id)}
              onChange={(event) => {
                setChosen(
                  event.target.checked
                    ? [...chosen, field.id]
                    : chosen.filter((id) => id !== field.id),
                );
              }}
            />
            {field.name}
            <span className="pp-muted">
              {VALUE_TYPE_LABELS[field.valueType]} · <span className="pp-mono">{field.id}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ErrorMessage message={action.error} />
      <div className="pp-row">
        <button
          type="submit"
          className="pp-button pp-button-primary"
          disabled={action.pending || !changed}
        >
          Save fields
        </button>
        {!changed && !action.pending && action.error === null && (
          <span className="pp-muted" role="status">
            {saved.length === 0 ? 'No fields allowed yet.' : 'Saved.'}
          </span>
        )}
      </div>
    </form>
  );
}

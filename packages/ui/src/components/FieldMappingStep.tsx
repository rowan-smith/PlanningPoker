import type {
  FieldMappingView,
  SessionBuilderView,
  WritableFieldView,
} from '@planning-poker/contracts';
import { useCallback, useId } from 'react';

import type { PlanningPokerApi } from '../api';
import { useLoad } from '../hooks';
import { ErrorMessage, Loading } from './Feedback';

const VALUE_TYPE_LABELS: Readonly<Record<WritableFieldView['valueType'], string>> = {
  number: 'number',
  option: 'single select',
};

export interface FieldMappingStepProps {
  readonly api: PlanningPokerApi;
  readonly builder: SessionBuilderView;
  readonly pending: boolean;
  readonly apply: (work: () => Promise<SessionBuilderView>) => void;
}

/**
 * Where final estimates are saved: one field from the administrator's allowlist and, for
 * single-select fields, the option each card stands for. The server validates every choice.
 */
export function FieldMappingStep({ api, builder, pending, apply }: FieldMappingStepProps) {
  const fieldId = useId();
  const sessionId = builder.session.id;
  const load = useCallback(
    async () => await api.call('getFieldMapping', { sessionId }),
    [api, sessionId],
  );
  const { state, replace } = useLoad<FieldMappingView>(load);

  if (state.status === 'loading') {
    return <Loading />;
  }

  if (state.status === 'failed') {
    return <ErrorMessage message={state.message} />;
  }

  const { allowed, destination } = state.value;
  const save = (chosenFieldId: string | null, optionByCardId: Record<string, string>) => {
    apply(async () => {
      const result = await api.call('setFieldMapping', {
        sessionId,
        fieldId: chosenFieldId,
        optionByCardId,
      });
      replace(result.mapping);

      return result.builder;
    });
  };
  const disallowed =
    destination !== null && !allowed.some((field) => field.id === destination.fieldId);

  return (
    <fieldset className="pp-fieldset pp-stack">
      <legend className="pp-label">Save final estimates to Jira</legend>
      {allowed.length === 0 && destination === null ? (
        <p className="pp-muted">
          Your administrator has not allowed any Jira fields yet, so estimates stay in Planning
          Poker.
        </p>
      ) : (
        <div className="pp-stack">
          <label htmlFor={fieldId} className="pp-label">
            Field
          </label>
          <select
            id={fieldId}
            className="pp-input"
            value={destination?.fieldId ?? ''}
            disabled={pending}
            onChange={(event) => {
              save(event.target.value === '' ? null : event.target.value, {});
            }}
          >
            <option value="">Don&apos;t save to Jira</option>
            {allowed.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name} ({VALUE_TYPE_LABELS[field.valueType]})
              </option>
            ))}
            {disallowed && (
              <option value={destination.fieldId}>
                {destination.fieldName} (no longer allowed)
              </option>
            )}
          </select>
        </div>
      )}
      {destination?.valueType === 'number' && (
        <p className="pp-muted">
          Numeric cards are saved as numbers. Special cards (∞ ? ☕) are never saved to number
          fields; agreeing on one needs a moderator decision.
        </p>
      )}
      {destination?.valueType === 'option' && (
        <OptionMapping
          builder={builder}
          mapping={state.value}
          pending={pending}
          onChange={(optionByCardId) => {
            save(destination.fieldId, optionByCardId);
          }}
        />
      )}
    </fieldset>
  );
}

function OptionMapping({
  builder,
  mapping,
  pending,
  onChange,
}: {
  readonly builder: SessionBuilderView;
  readonly mapping: FieldMappingView;
  readonly pending: boolean;
  readonly onChange: (optionByCardId: Record<string, string>) => void;
}) {
  const baseId = useId();
  const current = mapping.destination?.optionByCardId ?? {};
  const cards = builder.scoring.cards.filter((card) => card.kind !== 'special');

  if (mapping.options.length === 0) {
    return (
      <p className="pp-muted">
        Add tickets first: the field&apos;s options are read from their Jira issues.
      </p>
    );
  }

  return (
    <div className="pp-stack">
      <p className="pp-muted">Choose the option each card saves. Every card needs one.</p>
      <ul className="pp-list">
        {cards.map((card) => (
          <li key={card.id} className="pp-row">
            <label htmlFor={`${baseId}-${card.id}`} className="pp-row-main">
              Card <strong>{card.label}</strong>
            </label>
            <select
              id={`${baseId}-${card.id}`}
              className="pp-input"
              value={current[card.id] ?? ''}
              disabled={pending}
              onChange={(event) => {
                const others = Object.entries(current).filter(([id]) => id !== card.id);
                const chosen: [string, string][] =
                  event.target.value === '' ? [] : [[card.id, event.target.value]];

                onChange(Object.fromEntries([...others, ...chosen]));
              }}
            >
              <option value="">Not mapped</option>
              {mapping.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}

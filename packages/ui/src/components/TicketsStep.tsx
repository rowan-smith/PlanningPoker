import type {
  DisplayFieldsView,
  QuerySuggestionView,
  SessionBuilderView,
  WorkItemPreviewView,
} from '@planning-poker/contracts';
import { useCallback, useEffect, useId, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction, useLoad } from '../hooks';
import { ErrorMessage, Loading } from './Feedback';
import { FieldMappingStep } from './FieldMappingStep';

const SUGGEST_DELAY_MS = 250;
const MAX_DISPLAY_FIELDS = 5;

export interface TicketsStepProps {
  readonly api: PlanningPokerApi;
  readonly builder: SessionBuilderView;
  readonly pending: boolean;
  readonly apply: (work: () => Promise<SessionBuilderView>) => void;
}

type Mode = 'keys' | 'jql';

/** Step 4: import by key or JQL, choose display fields, order the tickets, map the Jira field. */
export function TicketsStep({ api, builder, pending, apply }: TicketsStepProps) {
  const [mode, setMode] = useState<Mode>('keys');

  return (
    <div className="pp-stack">
      <div className="pp-row" role="group" aria-label="How to add tickets">
        <button
          type="button"
          className="pp-step"
          aria-pressed={mode === 'keys'}
          onClick={() => {
            setMode('keys');
          }}
        >
          By issue key
        </button>
        <button
          type="button"
          className="pp-step"
          aria-pressed={mode === 'jql'}
          onClick={() => {
            setMode('jql');
          }}
        >
          Search with JQL
        </button>
      </div>
      {mode === 'keys' ? (
        <KeyImport api={api} builder={builder} pending={pending} apply={apply} />
      ) : (
        <JqlSearch api={api} builder={builder} pending={pending} apply={apply} />
      )}
      <DisplayFields api={api} builder={builder} pending={pending} apply={apply} />
      <TicketList api={api} builder={builder} pending={pending} apply={apply} />
      <FieldMappingStep
        // Options come from the tickets and cards from the deck: reload when either changes.
        key={[
          ...builder.session.tickets.map((t) => t.id),
          ...builder.scoring.cards.map((c) => c.id),
        ].join()}
        api={api}
        builder={builder}
        pending={pending}
        apply={apply}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Import by key
// ---------------------------------------------------------------------------------------------

function KeyImport({ api, builder, pending, apply }: TicketsStepProps) {
  const keysId = useId();
  const [keys, setKeys] = useState('');
  const [missing, setMissing] = useState<readonly string[]>([]);

  return (
    <form
      className="pp-stack"
      onSubmit={(event) => {
        event.preventDefault();
        apply(async () => {
          const result = await api.call('importTickets', {
            sessionId: builder.session.id,
            keys: keys.split(/[\s,]+/).filter((key) => key.length > 0),
          });
          setMissing(result.missingKeys);
          setKeys('');

          return result.builder;
        });
      }}
    >
      <label htmlFor={keysId} className="pp-label">
        Jira issue keys
      </label>
      <textarea
        id={keysId}
        className="pp-input"
        rows={3}
        placeholder="PP-1, PP-2, PP-3"
        value={keys}
        onChange={(event) => {
          setKeys(event.target.value);
        }}
      />
      <div>
        <button type="submit" className="pp-button" disabled={pending || keys.trim() === ''}>
          Add tickets
        </button>
      </div>
      {missing.length > 0 && (
        <p className="pp-error" role="alert">
          Not found, or you do not have access: {missing.join(', ')}
        </p>
      )}
      <p className="pp-muted">
        Separate keys with commas, spaces or new lines. Duplicates are skipped.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// JQL search with autocomplete
// ---------------------------------------------------------------------------------------------

function JqlSearch({ api, builder, pending, apply }: TicketsStepProps) {
  const queryId = useId();
  const sessionId = builder.session.id;
  const [query, setQuery] = useState('');
  const [suggestFor, setSuggestFor] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<readonly QuerySuggestionView[]>([]);
  const [results, setResults] = useState<readonly WorkItemPreviewView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const search = useAction();

  // Suggestions are a typing aid: when they fail, the search itself still works, so the list
  // simply stays empty.
  useEffect(() => {
    if (suggestFor === null || suggestFor.trim() === '') {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      api.call('suggestQuery', { sessionId, query: suggestFor }).then(
        (found) => {
          if (!cancelled) {
            setSuggestions(found);
          }
        },
        () => {
          if (!cancelled) {
            setSuggestions([]);
          }
        },
      );
    }, SUGGEST_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, sessionId, suggestFor]);

  const runSearch = (from: string | null) => {
    void search.run(async () => {
      const page = await api.call('searchWorkItems', { sessionId, query, cursor: from });
      setResults(from === null ? page.items : [...(results ?? []), ...page.items]);
      setCursor(page.nextCursor);

      if (from === null) {
        setSelected(new Set());
      }
    });
  };
  const visibleSuggestions = suggestFor === null || suggestFor.trim() === '' ? [] : suggestions;

  return (
    <div className="pp-stack">
      <form
        className="pp-stack"
        onSubmit={(event) => {
          event.preventDefault();
          setSuggestFor(null);
          runSearch(null);
        }}
      >
        <label htmlFor={queryId} className="pp-label">
          JQL query
        </label>
        <input
          id={queryId}
          className="pp-input pp-mono"
          autoComplete="off"
          spellCheck={false}
          placeholder='project = PP AND status = "To Do"'
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSuggestFor(event.target.value);
          }}
        />
        {visibleSuggestions.length > 0 && (
          <ul className="pp-list" aria-label="Query suggestions">
            {visibleSuggestions.map((suggestion) => (
              <li key={suggestion.value}>
                <button
                  type="button"
                  className="pp-suggestion"
                  onClick={() => {
                    setQuery(suggestion.value);
                    setSuggestFor(null);
                    document.getElementById(queryId)?.focus();
                  }}
                >
                  {suggestion.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <button
            type="submit"
            className="pp-button"
            disabled={search.pending || query.trim() === ''}
          >
            Search
          </button>
        </div>
      </form>
      <ErrorMessage message={search.error} />

      {results !== null && results.length === 0 && (
        <p className="pp-muted" role="status">
          No issues match this query.
        </p>
      )}
      {results !== null && results.length > 0 && (
        <form
          className="pp-stack"
          aria-label="Search results"
          onSubmit={(event) => {
            event.preventDefault();
            const keys = [...selected];
            apply(async () => {
              const result = await api.call('importTickets', { sessionId, keys });
              setResults(
                results.map((item) =>
                  keys.includes(item.key) ? { ...item, alreadyAdded: true } : item,
                ),
              );
              setSelected(new Set());

              return result.builder;
            });
          }}
        >
          <ul className="pp-list">
            {results.map((item) => (
              <li key={item.key} className="pp-row">
                <label className="pp-check pp-row-main">
                  <input
                    type="checkbox"
                    disabled={item.alreadyAdded}
                    checked={item.alreadyAdded || selected.has(item.key)}
                    onChange={(event) => {
                      const next = new Set(selected);

                      if (event.target.checked) {
                        next.add(item.key);
                      } else {
                        next.delete(item.key);
                      }

                      setSelected(next);
                    }}
                  />
                  <span className="pp-badge">{item.key}</span>
                  <span>{item.title}</span>
                </label>
                <span className="pp-muted">
                  {[item.itemType, item.status].filter((part) => part !== null).join(' · ')}
                  {item.alreadyAdded && ' · Added'}
                </span>
              </li>
            ))}
          </ul>
          <div className="pp-row">
            <button
              type="submit"
              className="pp-button pp-button-primary"
              disabled={pending || selected.size === 0}
            >
              Add selected ({selected.size})
            </button>
            {cursor !== null && (
              <button
                type="button"
                className="pp-button"
                disabled={search.pending}
                onClick={() => {
                  runSearch(cursor);
                }}
              >
                Load more
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Display fields
// ---------------------------------------------------------------------------------------------

function DisplayFields({ api, builder, pending, apply }: TicketsStepProps) {
  const pickerId = useId();
  const sessionId = builder.session.id;
  const load = useCallback(
    async () => await api.call('getDisplayFields', { sessionId }),
    [api, sessionId],
  );
  const { state, replace } = useLoad<DisplayFieldsView>(load);
  const [choice, setChoice] = useState('');

  if (state.status === 'loading') {
    return <Loading />;
  }

  if (state.status === 'failed') {
    return <ErrorMessage message={state.message} />;
  }

  const { available, selectedIds } = state.value;
  const names = new Map(available.map((field) => [field.id, field.name]));
  const save = (fieldIds: readonly string[]) => {
    apply(async () => {
      const updated = await api.call('setDisplayFields', { sessionId, fieldIds });
      replace({ available, selectedIds: fieldIds });

      return updated;
    });
  };

  return (
    <fieldset className="pp-fieldset pp-stack">
      <legend className="pp-label">Extra fields shown on tickets</legend>
      {selectedIds.length === 0 ? (
        <p className="pp-muted">Only the summary, type, status and description are shown.</p>
      ) : (
        <ul className="pp-chips" aria-label="Chosen fields">
          {selectedIds.map((id) => (
            <li key={id} className="pp-chip pp-row">
              {names.get(id) ?? id}
              <button
                type="button"
                className="pp-chip-remove"
                disabled={pending}
                onClick={() => {
                  save(selectedIds.filter((selectedId) => selectedId !== id));
                }}
              >
                <span aria-hidden="true">✕</span>
                <span className="pp-visually-hidden">Remove {names.get(id) ?? id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedIds.length < MAX_DISPLAY_FIELDS && (
        <div className="pp-row">
          <label htmlFor={pickerId} className="pp-visually-hidden">
            Field to show
          </label>
          <select
            id={pickerId}
            className="pp-input pp-row-main"
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value);
            }}
          >
            <option value="">Choose a field…</option>
            {available
              .filter((field) => !selectedIds.includes(field.id))
              .map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="pp-button"
            disabled={pending || choice === ''}
            onClick={() => {
              save([...selectedIds, choice]);
              setChoice('');
            }}
          >
            Show field
          </button>
        </div>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------
// Ticket list with previews and ordering
// ---------------------------------------------------------------------------------------------

function TicketList({ api, builder, pending, apply }: TicketsStepProps) {
  const sessionId = builder.session.id;
  const tickets = builder.session.tickets;
  const move = (index: number, offset: number) => {
    const ids = tickets.map((ticket) => ticket.id);
    const [moved] = ids.splice(index, 1);

    if (moved !== undefined) {
      ids.splice(index + offset, 0, moved);
      apply(async () => await api.call('reorderTickets', { sessionId, ticketIds: ids }));
    }
  };

  if (tickets.length === 0) {
    return <p className="pp-muted">No tickets yet.</p>;
  }

  return (
    <ol className="pp-list" aria-label="Tickets in voting order">
      {tickets.map((ticket, index) => (
        <li key={ticket.id} className="pp-card pp-stack">
          <div className="pp-row">
            <span className="pp-badge">{ticket.displayKey}</span>
            <span className="pp-row-main">
              {ticket.url === null ? (
                ticket.title
              ) : (
                <a href={ticket.url} target="_blank" rel="noreferrer" className="pp-link">
                  {ticket.title}
                </a>
              )}
            </span>
            <button
              type="button"
              className="pp-button"
              disabled={pending || index === 0}
              onClick={() => {
                move(index, -1);
              }}
            >
              ↑<span className="pp-visually-hidden"> Move {ticket.displayKey} up</span>
            </button>
            <button
              type="button"
              className="pp-button"
              disabled={pending || index === tickets.length - 1}
              onClick={() => {
                move(index, 1);
              }}
            >
              ↓<span className="pp-visually-hidden"> Move {ticket.displayKey} down</span>
            </button>
            <button
              type="button"
              className="pp-button"
              disabled={pending}
              onClick={() => {
                apply(
                  async () => await api.call('removeTicket', { sessionId, ticketId: ticket.id }),
                );
              }}
            >
              Remove<span className="pp-visually-hidden"> {ticket.displayKey}</span>
            </button>
          </div>
          <p className="pp-muted">
            {[ticket.itemType, ticket.status].filter((part) => part !== null).join(' · ')}
            {Object.entries(ticket.displayFields).map(([name, value]) => (
              <span key={name}>
                {' · '}
                {name}: {value}
              </span>
            ))}
          </p>
          {ticket.description !== null && (
            <details>
              <summary className="pp-muted">Description</summary>
              {/* Plain text from the server, rendered as text: never as HTML. */}
              <p className="pp-description">{ticket.description}</p>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

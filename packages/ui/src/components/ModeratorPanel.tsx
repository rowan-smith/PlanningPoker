import type { SessionView, TicketView, TicketVotingStateDto } from '@planning-poker/contracts';
import { useId, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { TICKET_STATE_LABELS } from '../labels';
import { ConfirmButton } from './ConfirmButton';

const MAX_REASON_LENGTH = 500;
const CLOSED_STATES: readonly TicketVotingStateDto[] = ['finalized', 'skipped', 'unresolved'];

/** Runs a moderator call and shows the session view it returns. */
export type SessionChange = (load: () => Promise<SessionView>) => void;

export interface ModeratorPanelProps {
  readonly api: PlanningPokerApi;
  readonly session: SessionView;
  readonly pending: boolean;
  readonly onChange: SessionChange;
}

function isClosed(ticket: TicketView): boolean {
  return CLOSED_STATES.includes(ticket.votingState);
}

/**
 * Facilitator controls for a running session, grouped so ticket actions, moving between tickets
 * and session actions stay apart. Member actions (skip member, roles) live in ParticipantManager.
 * The server checks every action; this only hides what does not apply.
 */
export function ModeratorPanel({ api, session, pending, onChange }: ModeratorPanelProps) {
  const sessionId = session.id;
  const current = session.tickets.find((ticket) => ticket.id === session.currentTicketId);

  return (
    <section className="pp-card pp-stack" aria-labelledby="pp-moderate-title">
      <h3 id="pp-moderate-title" className="pp-section-title">
        Moderator controls
      </h3>
      {current !== undefined && (
        <TicketActions
          api={api}
          session={session}
          ticket={current}
          pending={pending}
          onChange={onChange}
        />
      )}
      {session.status === 'active' && (
        <MoveTicket api={api} session={session} pending={pending} onChange={onChange} />
      )}
      <div className="pp-control-group pp-stack" role="group" aria-labelledby="pp-session-actions">
        <h4 id="pp-session-actions" className="pp-label">
          Session
        </h4>
        <div className="pp-row">
          {session.status === 'active' ? (
            <button
              type="button"
              className="pp-button"
              disabled={pending}
              onClick={() => {
                onChange(async () => await api.call('pauseSession', { sessionId }));
              }}
            >
              <span aria-hidden="true">⏸ </span>Pause session
            </button>
          ) : (
            <button
              type="button"
              className="pp-button pp-button-primary"
              disabled={pending}
              onClick={() => {
                onChange(async () => await api.call('resumeSession', { sessionId }));
              }}
            >
              <span aria-hidden="true">▶ </span>Resume session
            </button>
          )}
          <ConfirmButton
            label="Complete session"
            confirmLabel="Yes, complete session"
            cancelLabel="Keep going"
            warning="Tickets without an estimate become unresolved. This cannot be undone."
            disabled={pending}
            onConfirm={() => {
              onChange(async () => await api.call('completeSession', { sessionId }));
            }}
          />
          <ConfirmButton
            label="Cancel session"
            confirmLabel="Yes, cancel session"
            cancelLabel="Keep session"
            warning="Voting stops and nothing more is estimated."
            disabled={pending}
            onConfirm={() => {
              onChange(async () => await api.call('cancelSession', { sessionId }));
            }}
          />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The current ticket: reveal, revote, accept, override, skip ticket
// ---------------------------------------------------------------------------------------------

function TicketActions({
  api,
  session,
  ticket,
  pending,
  onChange,
}: {
  readonly api: PlanningPokerApi;
  readonly session: SessionView;
  readonly ticket: TicketView;
  readonly pending: boolean;
  readonly onChange: SessionChange;
}) {
  const payload = { sessionId: session.id, ticketId: ticket.id };
  const round = ticket.round;
  const active = session.status === 'active';
  const closed = isClosed(ticket);
  const result = round?.status === 'revealed' ? round.result : null;
  const decided = ticket.estimate !== null;
  const consensus =
    result !== null && result.outcome === 'unanimous' && !result.requiresModeratorResolution
      ? result.distribution[0]
      : undefined;

  return (
    <div className="pp-control-group pp-stack" role="group" aria-labelledby="pp-ticket-actions">
      <h4 id="pp-ticket-actions" className="pp-label">
        Ticket actions — {ticket.displayKey}
      </h4>
      {round?.status === 'open' && (
        <p className="pp-muted" role="status">
          {round.requiredCount === 1
            ? '1 voter required this round'
            : `${String(round.requiredCount)} voters required this round`}
          {` · ${String(round.votedCount)} voted`}
        </p>
      )}
      {closed && (
        <p className="pp-muted">
          This ticket is closed. Move to another ticket to keep estimating.
        </p>
      )}
      {!active && !closed && (
        <p className="pp-muted">Resume the session to reveal, revote or move between tickets.</p>
      )}
      <div className="pp-row">
        {active && round?.status === 'open' && (
          <>
            {/* Usually revealed automatically; offered if a complete round is still open. */}
            {round.requiredCount > 0 && round.votedCount >= round.requiredCount && (
              <button
                type="button"
                className="pp-button pp-button-primary"
                disabled={pending}
                onClick={() => {
                  onChange(async () => await api.call('revealRound', payload));
                }}
              >
                Reveal results
              </button>
            )}
            <ConfirmButton
              label="Restart round"
              confirmLabel="Yes, restart round"
              cancelLabel="Keep round"
              warning="Votes in this round are discarded and everyone on the roster votes again."
              disabled={pending}
              onConfirm={() => {
                onChange(async () => await api.call('startNewRound', payload));
              }}
            />
          </>
        )}
        {consensus !== undefined && !decided && (
          <button
            type="button"
            className="pp-button pp-button-primary"
            disabled={pending}
            onClick={() => {
              onChange(async () => await api.call('acceptConsensus', payload));
            }}
          >
            Accept {consensus.label} as the estimate
          </button>
        )}
        {active && result !== null && !closed && (
          <button
            type="button"
            className="pp-button"
            disabled={pending}
            onClick={() => {
              onChange(async () => await api.call('startNewRound', payload));
            }}
          >
            Start another round
          </button>
        )}
        {!closed && (
          <ConfirmButton
            label="Skip ticket"
            confirmLabel="Yes, skip ticket"
            cancelLabel="Keep ticket"
            warning="The ticket closes without an estimate. To excuse a person instead, use Skip member."
            disabled={pending}
            onConfirm={() => {
              onChange(async () => await api.call('skipTicket', payload));
            }}
          />
        )}
      </div>
      {active && round?.status === 'open' && round.votedCount < round.requiredCount && (
        <p className="pp-muted">
          Results reveal automatically once every required voter has voted. Skip absent members to
          reveal without them.
        </p>
      )}
      {result !== null && !decided && !closed && (
        <OverrideForm
          session={session}
          pending={pending}
          onSubmit={(cardId, reason) => {
            onChange(
              async () => await api.call('overrideEstimate', { ...payload, cardId, reason }),
            );
          }}
        />
      )}
    </div>
  );
}

/** Sets the estimate by moderator decision. Only regular cards qualify; a reason is required. */
function OverrideForm({
  session,
  pending,
  onSubmit,
}: {
  readonly session: SessionView;
  readonly pending: boolean;
  readonly onSubmit: (cardId: string, reason: string) => void;
}) {
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [cardId, setCardId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const regularCards = session.deck.filter((card) => card.kind !== 'special');
  const ready = cardId !== null && reason.trim().length > 0;

  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="pp-button"
          disabled={pending}
          onClick={() => {
            setOpen(true);
          }}
        >
          Set estimate with a reason…
        </button>
      </div>
    );
  }

  return (
    <form
      className="pp-stack"
      aria-label="Set the estimate"
      onSubmit={(event) => {
        event.preventDefault();

        if (cardId !== null && ready) {
          onSubmit(cardId, reason.trim());
          setOpen(false);
          setCardId(null);
          setReason('');
        }
      }}
    >
      <fieldset className="pp-fieldset pp-stack">
        <legend className="pp-label">Final estimate</legend>
        <div className="pp-chips">
          {regularCards.map((card) => (
            <label key={card.id} className="pp-check">
              <input
                type="radio"
                name="pp-override-card"
                value={card.id}
                checked={cardId === card.id}
                onChange={() => {
                  setCardId(card.id);
                }}
              />
              {card.label}
            </label>
          ))}
        </div>
        <p className="pp-muted">Special cards (∞ ? ☕) cannot be the final estimate.</p>
      </fieldset>
      <label htmlFor={reasonId} className="pp-label">
        Reason (required, kept in the audit log)
      </label>
      <textarea
        id={reasonId}
        className="pp-input"
        rows={2}
        maxLength={MAX_REASON_LENGTH}
        required
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      <div className="pp-row">
        <button type="submit" className="pp-button pp-button-primary" disabled={pending || !ready}>
          Set estimate
        </button>
        <button
          type="button"
          className="pp-button"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Moving between tickets
// ---------------------------------------------------------------------------------------------

function MoveTicket({
  api,
  session,
  pending,
  onChange,
}: {
  readonly api: PlanningPokerApi;
  readonly session: SessionView;
  readonly pending: boolean;
  readonly onChange: SessionChange;
}) {
  const selectId = useId();
  const others = session.tickets.filter((ticket) => ticket.id !== session.currentTicketId);
  const [targetId, setTargetId] = useState('');
  const currentOrder =
    session.tickets.find((ticket) => ticket.id === session.currentTicketId)?.order ?? -1;
  const hasNext = session.tickets.some(
    (ticket) => ticket.order > currentOrder && !isClosed(ticket),
  );
  const target = others.find((ticket) => ticket.id === targetId);

  return (
    <div className="pp-control-group pp-stack" role="group" aria-labelledby="pp-move-actions">
      <h4 id="pp-move-actions" className="pp-label">
        Move between tickets
      </h4>
      <div className="pp-row">
        <button
          type="button"
          className="pp-button"
          disabled={pending || !hasNext}
          onClick={() => {
            onChange(async () => await api.call('advanceTicket', { sessionId: session.id }));
          }}
        >
          Next ticket
        </button>
        {!hasNext && <span className="pp-muted">No open tickets after this one.</span>}
      </div>
      {others.length > 0 && (
        <div className="pp-row">
          <label htmlFor={selectId} className="pp-visually-hidden">
            Ticket to move to
          </label>
          <select
            id={selectId}
            className="pp-input pp-row-main"
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
            }}
          >
            <option value="">Choose a ticket…</option>
            {others.map((ticket) => (
              <option key={ticket.id} value={ticket.id}>
                {ticket.displayKey} — {ticket.title} ({TICKET_STATE_LABELS[ticket.votingState]})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="pp-button"
            disabled={pending || target === undefined}
            onClick={() => {
              if (target !== undefined) {
                onChange(
                  async () =>
                    await api.call('setCurrentTicket', {
                      sessionId: session.id,
                      ticketId: target.id,
                    }),
                );
                setTargetId('');
              }
            }}
          >
            Go to ticket
          </button>
        </div>
      )}
    </div>
  );
}

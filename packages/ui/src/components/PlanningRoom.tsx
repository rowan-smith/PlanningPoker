import type { CardView, ParticipantView, SessionView, TicketView } from '@planning-poker/contracts';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction } from '../hooks';
import { STATUS_LABELS, TICKET_STATE_LABELS } from '../labels';
import { useLiveSession } from '../live-session';
import { ErrorMessage, Loading } from './Feedback';
import type { SessionChange } from './ModeratorPanel';
import { ModeratorPanel } from './ModeratorPanel';
import { ParticipantManager } from './ParticipantManager';

export interface PlanningRoomProps {
  readonly api: PlanningPokerApi;
  readonly sessionId: string;
  readonly onBack: () => void;
}

/** The live session: current ticket, voting deck, anonymous results, roster and queue. */
export function PlanningRoom({ api, sessionId, onBack }: PlanningRoomProps) {
  const live = useLiveSession(api, sessionId);
  const action = useAction();
  /** A future ticket the viewer is pre-voting on; null means the shared current ticket. */
  const [preVoteTicketId, setPreVoteTicketId] = useState<string | null>(null);

  const vote = (ticketId: string, cardId: string) => {
    void action.run(async () => {
      live.replace(await api.call('submitVote', { sessionId, ticketId, cardId }));
    });
  };
  const moderate: SessionChange = (load) => {
    void action.run(async () => {
      live.replace(await load());
      // The current ticket may have changed; go back to it.
      setPreVoteTicketId(null);
    });
  };
  const join = () => {
    void action.run(async () => {
      await api.call('respondToInvitation', { sessionId, response: 'joined' });
      live.refresh();
    });
  };

  return (
    <section className="pp-page" aria-labelledby="pp-room-title">
      <div>
        <button type="button" className="pp-button" onClick={onBack}>
          ← All sessions
        </button>
      </div>
      {live.state.status === 'loading' && <Loading />}
      {live.state.status === 'failed' && <ErrorMessage message={live.state.message} />}
      {live.state.status === 'loaded' && (
        <Room
          session={live.state.value}
          pending={action.pending}
          error={action.error}
          preVoteTicketId={preVoteTicketId}
          onPreVoteTicket={setPreVoteTicketId}
          onVote={vote}
          onJoin={join}
          moderatorControls={(session) => (
            <>
              <ModeratorPanel
                api={api}
                session={session}
                pending={action.pending}
                onChange={moderate}
              />
              <ParticipantManager
                api={api}
                session={session}
                pending={action.pending}
                onChange={moderate}
              />
            </>
          )}
        />
      )}
    </section>
  );
}

interface RoomProps {
  readonly session: SessionView;
  readonly pending: boolean;
  readonly error: string | null;
  readonly preVoteTicketId: string | null;
  readonly onPreVoteTicket: (ticketId: string | null) => void;
  readonly onVote: (ticketId: string, cardId: string) => void;
  readonly onJoin: () => void;
  readonly moderatorControls: (session: SessionView) => ReactNode;
}

function Room({
  session,
  pending,
  error,
  preVoteTicketId,
  onPreVoteTicket,
  onVote,
  onJoin,
  moderatorControls,
}: RoomProps) {
  const current = session.tickets.find((ticket) => ticket.id === session.currentTicketId);
  const preVoteTicket = session.tickets.find((ticket) => ticket.id === preVoteTicketId);
  const upcoming = session.tickets.filter(
    (ticket) =>
      ticket.id !== session.currentTicketId &&
      (ticket.votingState === 'pending' || ticket.votingState === 'voting'),
  );

  return (
    <>
      <header className="pp-stack">
        <h2 id="pp-room-title" className="pp-page-title">
          {session.name}
          <span className="pp-badge pp-badge-gap" data-status={session.status}>
            {STATUS_LABELS[session.status]}
          </span>
        </h2>
        <p className="pp-muted">{session.teamName}</p>
      </header>
      <ViewerNotice session={session} pending={pending} onJoin={onJoin} />
      <ErrorMessage message={error} />

      <div className="pp-room">
        <div className="pp-room-main pp-stack">
          {current === undefined ? (
            <p className="pp-card pp-muted">There is no current ticket.</p>
          ) : (
            <CurrentTicket
              session={session}
              ticket={current}
              pending={pending}
              onVote={(cardId) => {
                onVote(current.id, cardId);
              }}
            />
          )}
          {preVoteTicket !== undefined && (
            <section className="pp-card pp-stack" aria-labelledby="pp-prevote-title">
              <h3 id="pp-prevote-title" className="pp-section-title">
                Pre-vote: {preVoteTicket.displayKey}
              </h3>
              <p>{preVoteTicket.title}</p>
              <p className="pp-muted">
                Only you can see this choice. It counts when this ticket comes up, if you are on
                that round&apos;s roster, and stays hidden until everyone has voted.
              </p>
              <Deck
                deck={session.deck}
                selectedCardId={preVoteTicket.myVoteCardId}
                disabled={pending}
                label={`Cards for ${preVoteTicket.displayKey}`}
                onPick={(cardId) => {
                  onVote(preVoteTicket.id, cardId);
                }}
              />
              <div>
                <button
                  type="button"
                  className="pp-button"
                  onClick={() => {
                    onPreVoteTicket(null);
                  }}
                >
                  Done
                </button>
              </div>
            </section>
          )}
          {session.viewer.canModerate &&
            (session.status === 'active' || session.status === 'paused') &&
            moderatorControls(session)}
        </div>

        <aside className="pp-room-side pp-stack" aria-label="Session details">
          <Participants
            participants={session.participants}
            roundOpen={current?.round?.status === 'open'}
          />
          <Queue
            session={session}
            tickets={upcoming}
            selectedId={preVoteTicketId}
            onSelect={onPreVoteTicket}
          />
        </aside>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Who am I in this session?
// ---------------------------------------------------------------------------------------------

function ViewerNotice({
  session,
  pending,
  onJoin,
}: {
  readonly session: SessionView;
  readonly pending: boolean;
  readonly onJoin: () => void;
}) {
  const { viewer, status } = session;

  if (status === 'paused') {
    return (
      <p className="pp-note" role="status">
        <span aria-hidden="true">⏸</span> The session is paused. Voting resumes when the moderator
        continues.
      </p>
    );
  }

  if (status !== 'active') {
    return (
      <p className="pp-note" role="status">
        This session is {STATUS_LABELS[status].toLowerCase()}. Voting is closed.
      </p>
    );
  }

  if (viewer.invitationStatus === 'invited') {
    return (
      <div className="pp-note pp-row" role="status">
        <span className="pp-row-main">
          You are invited as {viewer.role === 'voter' ? 'a voter' : 'an observer'}. Join to take
          part.
        </span>
        <button
          type="button"
          className="pp-button pp-button-primary"
          disabled={pending}
          onClick={onJoin}
        >
          Join session
        </button>
      </div>
    );
  }

  if (viewer.role === 'observer' || viewer.role === null) {
    return (
      <p className="pp-note" role="status">
        <span aria-hidden="true">👁</span> Observing — voting disabled
      </p>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// Current ticket, voting and results
// ---------------------------------------------------------------------------------------------

function CurrentTicket({
  session,
  ticket,
  pending,
  onVote,
}: {
  readonly session: SessionView;
  readonly ticket: TicketView;
  readonly pending: boolean;
  readonly onVote: (cardId: string) => void;
}) {
  const round = ticket.round;
  const me = session.participants.find((p) => p.userId === session.viewer.userId);

  return (
    <section className="pp-card pp-stack" aria-labelledby="pp-current-title">
      <div className="pp-row">
        <span className="pp-badge">{ticket.displayKey}</span>
        <span className="pp-badge" data-tone={ticket.votingState}>
          {TICKET_STATE_LABELS[ticket.votingState]}
        </span>
        {round !== null && round.number > 1 && (
          <span className="pp-muted">Round {round.number}</span>
        )}
      </div>
      <h3 id="pp-current-title" className="pp-ticket-title">
        {ticket.url === null ? (
          ticket.title
        ) : (
          <a href={ticket.url} target="_blank" rel="noreferrer" className="pp-link">
            {ticket.title}
          </a>
        )}
      </h3>
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
          <p className="pp-description">{ticket.description}</p>
        </details>
      )}

      {round?.status === 'open' && (
        <Progress voted={round.votedCount} required={round.requiredCount} />
      )}

      {session.viewer.canVoteOnCurrentTicket && round?.status === 'open' && (
        <>
          <Deck
            deck={session.deck}
            selectedCardId={ticket.myVoteCardId}
            disabled={pending}
            label="Your vote"
            onPick={onVote}
          />
          <p className="pp-muted" role="status">
            {ticket.myVoteCardId === null
              ? 'Pick a card. Nobody sees it until everyone has voted.'
              : 'Vote recorded — waiting for votes. You can change it until the reveal.'}
          </p>
        </>
      )}
      {!session.viewer.canVoteOnCurrentTicket &&
        round?.status === 'open' &&
        session.status === 'active' &&
        session.viewer.role === 'voter' &&
        session.viewer.invitationStatus !== 'invited' && (
          <p className="pp-note" role="status">
            {me?.skippedForSession === true || me?.skippedForCurrentTicket === true
              ? 'You are skipped for this ticket.'
              : 'You joined after this round started. You can vote from the next round.'}
          </p>
        )}

      {round?.result !== null && round?.result !== undefined && <Results result={round.result} />}
      {ticket.estimate !== null && (
        <p className="pp-note" role="status">
          <strong>Final estimate: {ticket.estimate.label}</strong>
          {ticket.estimate.kind === 'override' ? ' (moderator decision)' : ' (consensus)'}
          {ticket.estimate.reason === null ? '' : ` — ${ticket.estimate.reason}`}
        </p>
      )}
    </section>
  );
}

function Progress({ voted, required }: { readonly voted: number; readonly required: number }) {
  if (required === 0) {
    return (
      <p className="pp-note" role="status">
        No one is required to vote on this ticket, so it will not reveal. A moderator needs to
        restore a voter, start a new round or skip the ticket.
      </p>
    );
  }

  return (
    <div className="pp-stack">
      <label className="pp-label" htmlFor="pp-vote-progress">
        {voted} of {required} voted
      </label>
      <progress id="pp-vote-progress" className="pp-progress" max={required} value={voted}>
        {voted} of {required}
      </progress>
    </div>
  );
}

function Deck({
  deck,
  selectedCardId,
  disabled,
  label,
  onPick,
}: {
  readonly deck: readonly CardView[];
  readonly selectedCardId: string | null;
  readonly disabled: boolean;
  readonly label: string;
  readonly onPick: (cardId: string) => void;
}) {
  return (
    <ul className="pp-deck" aria-label={label}>
      {deck.map((card) => {
        const selected = card.id === selectedCardId;

        return (
          <li key={card.id}>
            <button
              type="button"
              className="pp-vote-card"
              data-kind={card.kind}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => {
                onPick(card.id);
              }}
            >
              <span className="pp-vote-card-label">{card.label}</span>
              {selected && <span className="pp-vote-card-mark">Your vote</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Results({
  result,
}: {
  readonly result: NonNullable<NonNullable<TicketView['round']>['result']>;
}) {
  const [only] = result.distribution;
  const headline =
    result.outcome === 'unanimous' && only !== undefined
      ? `Everyone agreed: ${only.label}`
      : 'Votes differ';

  return (
    <section className="pp-stack" aria-labelledby="pp-results-title">
      <h4 id="pp-results-title" className="pp-label">
        Results — {headline}
      </h4>
      <p className="pp-muted">
        {result.voteCount === 1 ? '1 vote' : `${String(result.voteCount)} votes`}, shown without
        names: {result.values.join(', ')}
      </p>
      <ul className="pp-list" aria-label="Vote distribution">
        {result.distribution.map((entry) => (
          <li key={entry.cardId} className="pp-distribution">
            <span className="pp-distribution-label">{entry.label}</span>
            <meter
              className="pp-distribution-bar"
              min={0}
              max={result.voteCount}
              value={entry.count}
              aria-label={`${entry.label}: ${String(entry.count)} of ${String(result.voteCount)}`}
            />
            <span className="pp-muted">{entry.count}</span>
          </li>
        ))}
      </ul>
      {result.requiresModeratorResolution && (
        <p className="pp-note" role="status">
          {result.outcome === 'unanimous'
            ? 'Everyone chose a special card. The moderator decides what happens next.'
            : 'The moderator can start another round or set the estimate.'}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Sidebar: participants and the upcoming queue
// ---------------------------------------------------------------------------------------------

function participantState(
  participant: ParticipantView,
  roundOpen: boolean,
): { label: string; tone: string } {
  if (participant.invitationStatus === 'declined' || participant.invitationStatus === 'revoked') {
    return {
      label: participant.invitationStatus === 'declined' ? 'Declined' : 'Removed',
      tone: 'neutral',
    };
  }

  if (participant.skippedForSession || participant.skippedForCurrentTicket) {
    return { label: 'Skipped', tone: 'amber' };
  }

  if (participant.role === 'observer') {
    return { label: 'Observing', tone: 'blue' };
  }

  if (participant.voteStatus === 'voted') {
    return { label: '✓ Voted', tone: 'green' };
  }

  if (participant.voteStatus === 'pending') {
    return {
      label: participant.invitationStatus === 'invited' ? 'Invited · waiting' : 'Waiting',
      tone: 'amber',
    };
  }

  if (participant.invitationStatus === 'invited') {
    return { label: 'Invited', tone: 'neutral' };
  }

  // A voter outside an open round joined after it started; otherwise there is no round open.
  return roundOpen ? { label: 'Next round', tone: 'neutral' } : { label: 'Voter', tone: 'neutral' };
}

function Participants({
  participants,
  roundOpen,
}: {
  readonly participants: readonly ParticipantView[];
  readonly roundOpen: boolean;
}) {
  return (
    <section className="pp-card pp-stack" aria-labelledby="pp-people-title">
      <h3 id="pp-people-title" className="pp-section-title">
        Participants ({participants.length})
      </h3>
      <ul className="pp-list">
        {participants.map((participant) => {
          const state = participantState(participant, roundOpen);

          return (
            <li key={participant.userId} className="pp-row">
              <span className="pp-row-main">
                {participant.displayName}
                {participant.isFacilitator && <span className="pp-muted"> · Facilitator</span>}
              </span>
              <span className="pp-badge" data-tone={state.tone}>
                {state.label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Queue({
  session,
  tickets,
  selectedId,
  onSelect,
}: {
  readonly session: SessionView;
  readonly tickets: readonly TicketView[];
  readonly selectedId: string | null;
  readonly onSelect: (ticketId: string | null) => void;
}) {
  const labels = new Map(session.deck.map((card) => [card.id, card.label]));

  return (
    <section className="pp-card pp-stack" aria-labelledby="pp-queue-title">
      <h3 id="pp-queue-title" className="pp-section-title">
        Up next ({tickets.length})
      </h3>
      {tickets.length === 0 ? (
        <p className="pp-muted">No more tickets in the queue.</p>
      ) : (
        <ol className="pp-list">
          {tickets.map((ticket) => {
            const preVote = ticket.myVoteCardId === null ? null : labels.get(ticket.myVoteCardId);
            const canPreVote = session.viewer.canPreVote && ticket.round?.status === 'pending';

            return (
              <li key={ticket.id} className="pp-stack">
                <div className="pp-row">
                  <span className="pp-badge">{ticket.displayKey}</span>
                  <span className="pp-row-main">{ticket.title}</span>
                </div>
                {(canPreVote || preVote !== null) && (
                  <div className="pp-row">
                    {preVote !== null && preVote !== undefined && (
                      <span className="pp-muted pp-row-main">Your pre-vote: {preVote}</span>
                    )}
                    {canPreVote && (
                      <button
                        type="button"
                        className="pp-button"
                        aria-pressed={selectedId === ticket.id}
                        onClick={() => {
                          onSelect(selectedId === ticket.id ? null : ticket.id);
                        }}
                      >
                        {preVote === null ? 'Pre-vote' : 'Change pre-vote'}
                        <span className="pp-visually-hidden"> on {ticket.displayKey}</span>
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

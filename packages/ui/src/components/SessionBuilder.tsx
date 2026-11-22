import type {
  DeckChoice,
  DeckPresetDto,
  SessionBuilderView,
  SpecialCardDto,
} from '@planning-poker/contracts';
import { useCallback, useId, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction, useLoad } from '../hooks';
import { DECK_LABELS, SPECIAL_CARD_LABELS, STATUS_LABELS } from '../labels';
import { ErrorMessage, Loading } from './Feedback';
import { Roster } from './Roster';
import { TicketsStep } from './TicketsStep';
import { UserSearch } from './UserSearch';

const STEPS = [
  'Name and team',
  'Participants',
  'Scoring and voting',
  'Tickets',
  'Review and publish',
] as const;
/** Step indices into STEPS. */
const STEP = { details: 0, participants: 1, scoring: 2, tickets: 3, review: 4 } as const;
const SPECIAL_CARDS: readonly SpecialCardDto[] = ['infinity', 'unknown', 'coffee'];
const PRESETS = Object.keys(DECK_LABELS) as DeckPresetDto[];

type Apply = (work: () => Promise<SessionBuilderView>) => void;

export interface SessionBuilderProps {
  readonly api: PlanningPokerApi;
  readonly sessionId: string;
  readonly onBack: () => void;
  readonly onPublished: () => void;
}

export function SessionBuilder({ api, sessionId, onBack, onPublished }: SessionBuilderProps) {
  const [step, setStep] = useState(0);
  const load = useCallback(
    async () => await api.call('getSessionBuilder', { sessionId }),
    [api, sessionId],
  );
  const { state, replace } = useLoad<SessionBuilderView>(load);
  const action = useAction();
  const apply: Apply = (work) => {
    void action.run(async () => {
      replace(await work());
    });
  };

  return (
    <section className="pp-page" aria-labelledby="pp-builder-title">
      <div>
        <button type="button" className="pp-button" onClick={onBack}>
          ← All sessions
        </button>
      </div>
      {state.status === 'loading' && <Loading />}
      {state.status === 'failed' && <ErrorMessage message={state.message} />}
      {state.status === 'loaded' && (
        <>
          <h2 id="pp-builder-title" className="pp-page-title">
            {state.value.session.name}
            <span className="pp-badge pp-badge-gap" data-status={state.value.session.status}>
              {STATUS_LABELS[state.value.session.status]}
            </span>
          </h2>
          <nav aria-label="Session setup steps">
            <ol className="pp-steps">
              {STEPS.map((label, index) => (
                <li key={label}>
                  <button
                    type="button"
                    className="pp-step"
                    aria-current={index === step ? 'step' : undefined}
                    onClick={() => {
                      setStep(index);
                    }}
                  >
                    <span className="pp-step-number">{index + 1}</span> {label}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <ErrorMessage message={action.error} />
          <div className="pp-card pp-stack">
            <h3 className="pp-section-title">
              Step {step + 1} of {STEPS.length}: {STEPS[step]}
            </h3>
            {step === STEP.details && (
              <DetailsStep api={api} builder={state.value} pending={action.pending} apply={apply} />
            )}
            {step === STEP.participants && (
              <ParticipantsStep
                api={api}
                builder={state.value}
                pending={action.pending}
                apply={apply}
              />
            )}
            {step === STEP.scoring && (
              <ScoringStep
                key={JSON.stringify(state.value.scoring)}
                api={api}
                builder={state.value}
                pending={action.pending}
                apply={apply}
              />
            )}
            {step === STEP.tickets && (
              <TicketsStep api={api} builder={state.value} pending={action.pending} apply={apply} />
            )}
            {step === STEP.review && (
              <ReviewStep
                api={api}
                builder={state.value}
                pending={action.pending}
                onPublish={() => {
                  void action.run(async () => {
                    await api.call('publishSession', { sessionId });
                    onPublished();
                  });
                }}
              />
            )}
          </div>
          <div className="pp-row">
            <button
              type="button"
              className="pp-button"
              disabled={step === 0}
              onClick={() => {
                setStep(step - 1);
              }}
            >
              Back
            </button>
            {step < STEPS.length - 1 && (
              <button
                type="button"
                className="pp-button pp-button-primary"
                onClick={() => {
                  setStep(step + 1);
                }}
              >
                Next: {STEPS[step + 1]}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

interface StepProps {
  readonly api: PlanningPokerApi;
  readonly builder: SessionBuilderView;
  readonly pending: boolean;
  readonly apply: Apply;
}

// ---------------------------------------------------------------------------------------------
// Step 1 — name and team
// ---------------------------------------------------------------------------------------------

function DetailsStep({ api, builder, pending, apply }: StepProps) {
  const nameId = useId();
  const [name, setName] = useState(builder.session.name);
  const sessionId = builder.session.id;

  return (
    <form
      className="pp-stack"
      onSubmit={(event) => {
        event.preventDefault();
        apply(async () => await api.call('renameSession', { sessionId, name }));
      }}
    >
      <label htmlFor={nameId} className="pp-label">
        Session name
      </label>
      <input
        id={nameId}
        className="pp-input"
        required
        maxLength={120}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <p className="pp-muted">Team: {builder.session.teamName}</p>
      <div>
        <button type="submit" className="pp-button" disabled={pending}>
          Save name
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 2 — participants and invitations
// ---------------------------------------------------------------------------------------------

function ParticipantsStep({ api, builder, pending, apply }: StepProps) {
  const roleId = useId();
  const [inviteRole, setInviteRole] = useState<'voter' | 'observer'>('voter');
  const sessionId = builder.session.id;
  const invite = (userId: string, role: 'voter' | 'observer') => {
    apply(async () => await api.call('inviteParticipant', { sessionId, userId, role }));
  };

  return (
    <div className="pp-stack">
      <p className="pp-muted">
        Voters must vote before results reveal. Observers follow along and never block a round. You
        join as a non-voting facilitator unless you make yourself a voter.
      </p>
      <Roster
        participants={builder.session.participants}
        controls={{
          pending,
          removeLabel: 'Remove',
          onRoleChange: (userId, role) => {
            apply(async () => await api.call('changeParticipantRole', { sessionId, userId, role }));
          },
          onRemove: (userId) => {
            apply(async () => await api.call('removeParticipant', { sessionId, userId }));
          },
        }}
      />

      {builder.suggestedParticipants.length > 0 && (
        <section className="pp-stack" aria-labelledby="pp-suggested-title">
          <h4 id="pp-suggested-title" className="pp-label">
            From {builder.session.teamName}
          </h4>
          <ul className="pp-list">
            {builder.suggestedParticipants.map((user) => (
              <li key={user.userId} className="pp-row">
                <span className="pp-row-main">{user.displayName}</span>
                <button
                  type="button"
                  className="pp-button"
                  disabled={pending}
                  onClick={() => {
                    invite(user.userId, 'voter');
                  }}
                >
                  Add as voter
                  <span className="pp-visually-hidden"> ({user.displayName})</span>
                </button>
                <button
                  type="button"
                  className="pp-button"
                  disabled={pending}
                  onClick={() => {
                    invite(user.userId, 'observer');
                  }}
                >
                  Add as observer
                  <span className="pp-visually-hidden"> ({user.displayName})</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="pp-stack" aria-label="Invite someone else">
        <label htmlFor={roleId} className="pp-label">
          Invite others as
        </label>
        <select
          id={roleId}
          className="pp-input"
          value={inviteRole}
          onChange={(event) => {
            setInviteRole(event.target.value === 'observer' ? 'observer' : 'voter');
          }}
        >
          <option value="voter">Voter</option>
          <option value="observer">Observer</option>
        </select>
        <UserSearch
          api={api}
          label="Invite someone outside the team"
          actionLabel={inviteRole === 'voter' ? 'Invite as voter' : 'Invite as observer'}
          disabled={pending}
          excludeUserIds={builder.session.participants.map((participant) => participant.userId)}
          onSelect={(user) => {
            invite(user.userId, inviteRole);
          }}
        />
        <p className="pp-muted">
          Invitations are for this session only and do not add anyone to the team.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 3 — scoring and voting settings
// ---------------------------------------------------------------------------------------------

function ScoringStep({ api, builder, pending, apply }: StepProps) {
  const deckId = useId();
  const customNameId = useId();
  const customScaleId = useId();
  const customCardsId = useId();
  const { scoring } = builder;
  const initialCustom =
    scoring.deck.kind === 'custom'
      ? scoring.deck
      : { kind: 'custom' as const, name: 'Custom', scale: 'numeric' as const, labels: [] };
  const [deckKey, setDeckKey] = useState<string>(
    scoring.deck.kind === 'preset' ? scoring.deck.preset : 'custom',
  );
  const [customName, setCustomName] = useState(initialCustom.name);
  const [customScale, setCustomScale] = useState<'numeric' | 'categorical'>(initialCustom.scale);
  const [customCards, setCustomCards] = useState(initialCustom.labels.join(', '));
  const [specials, setSpecials] = useState<readonly SpecialCardDto[]>(scoring.specialCards);
  const [autoFinalize, setAutoFinalize] = useState(scoring.autoFinalize);
  const [autoAdvance, setAutoAdvance] = useState(scoring.autoAdvance);
  const [lateInvites, setLateInvites] = useState(scoring.allowInvitationsWhileActive);

  const deck: DeckChoice =
    deckKey === 'custom'
      ? {
          kind: 'custom',
          name: customName,
          scale: customScale,
          labels: customCards.split(',').map((label) => label.trim()),
        }
      : { kind: 'preset', preset: deckKey as DeckPresetDto };

  return (
    <form
      className="pp-stack"
      onSubmit={(event) => {
        event.preventDefault();
        apply(
          async () =>
            await api.call('configureScoring', {
              sessionId: builder.session.id,
              deck,
              specialCards: specials,
              autoFinalize,
              autoAdvance,
              allowInvitationsWhileActive: lateInvites,
            }),
        );
      }}
    >
      <label htmlFor={deckId} className="pp-label">
        Scoring deck
      </label>
      <select
        id={deckId}
        className="pp-input"
        value={deckKey}
        onChange={(event) => {
          setDeckKey(event.target.value);
        }}
      >
        {PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {DECK_LABELS[preset]}
          </option>
        ))}
        <option value="custom">Custom deck</option>
      </select>

      {deckKey === 'custom' && (
        <fieldset className="pp-fieldset pp-stack">
          <legend className="pp-label">Custom deck</legend>
          <label htmlFor={customNameId} className="pp-label">
            Name
          </label>
          <input
            id={customNameId}
            className="pp-input"
            value={customName}
            onChange={(event) => {
              setCustomName(event.target.value);
            }}
          />
          <label htmlFor={customScaleId} className="pp-label">
            Card type
          </label>
          <select
            id={customScaleId}
            className="pp-input"
            value={customScale}
            onChange={(event) => {
              setCustomScale(event.target.value === 'categorical' ? 'categorical' : 'numeric');
            }}
          >
            <option value="numeric">Numbers (can be written to number fields)</option>
            <option value="categorical">Labels (e.g. sizes)</option>
          </select>
          <label htmlFor={customCardsId} className="pp-label">
            Cards, separated by commas
          </label>
          <input
            id={customCardsId}
            className="pp-input"
            placeholder={customScale === 'numeric' ? '1, 2, 4, 8' : 'Small, Medium, Large'}
            value={customCards}
            onChange={(event) => {
              setCustomCards(event.target.value);
            }}
          />
        </fieldset>
      )}

      <fieldset className="pp-fieldset pp-stack">
        <legend className="pp-label">Special cards</legend>
        {SPECIAL_CARDS.map((card) => (
          <label key={card} className="pp-check">
            <input
              type="checkbox"
              checked={specials.includes(card)}
              onChange={(event) => {
                setSpecials(
                  event.target.checked
                    ? [...specials, card]
                    : specials.filter((entry) => entry !== card),
                );
              }}
            />
            {SPECIAL_CARD_LABELS[card]}
          </label>
        ))}
      </fieldset>

      <fieldset className="pp-fieldset pp-stack">
        <legend className="pp-label">Voting</legend>
        <label className="pp-check">
          <input
            type="checkbox"
            checked={autoFinalize}
            onChange={(event) => {
              setAutoFinalize(event.target.checked);
            }}
          />
          Finalize automatically when every voter picks the same card
        </label>
        <label className="pp-check">
          <input
            type="checkbox"
            checked={autoAdvance}
            disabled={!autoFinalize}
            onChange={(event) => {
              setAutoAdvance(event.target.checked);
            }}
          />
          Then move to the next ticket automatically
        </label>
        <label className="pp-check">
          <input
            type="checkbox"
            checked={lateInvites}
            onChange={(event) => {
              setLateInvites(event.target.checked);
            }}
          />
          Allow inviting people after the session starts
        </label>
      </fieldset>

      <div className="pp-stack">
        <span className="pp-label">Current deck: {scoring.deckName}</span>
        <ul className="pp-chips" aria-label="Cards in the current deck">
          {scoring.cards.map((card) => (
            <li key={card.id} className="pp-chip">
              {card.label}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <button type="submit" className="pp-button pp-button-primary" disabled={pending}>
          Save scoring
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 5 — review and publish
// ---------------------------------------------------------------------------------------------

function ReviewStep({
  builder,
  pending,
  onPublish,
}: Omit<StepProps, 'apply'> & { readonly onPublish: () => void }) {
  const { readiness, session, scoring } = builder;
  const voters = session.participants.filter((p) => p.role === 'voter').length;
  const errors = readiness.issues.filter((issue) => issue.severity === 'error');
  const warnings = readiness.issues.filter((issue) => issue.severity === 'warning');

  return (
    <div className="pp-stack">
      <dl className="pp-summary">
        <dt>Team</dt>
        <dd>{session.teamName}</dd>
        <dt>Participants</dt>
        <dd>
          {voters} voting, {session.participants.length - voters} observing
        </dd>
        <dt>Deck</dt>
        <dd>{scoring.deckName}</dd>
        <dt>Tickets</dt>
        <dd>{session.tickets.length}</dd>
      </dl>

      {errors.length > 0 && (
        <section aria-labelledby="pp-errors-title" className="pp-stack">
          <h4 id="pp-errors-title" className="pp-label">
            Fix before publishing
          </h4>
          <ul className="pp-list">
            {errors.map((issue) => (
              <li key={issue.code + issue.message} className="pp-issue pp-issue-error">
                <span aria-hidden="true">✕</span> <strong>Error:</strong> {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {warnings.length > 0 && (
        <section aria-labelledby="pp-warnings-title" className="pp-stack">
          <h4 id="pp-warnings-title" className="pp-label">
            Worth knowing
          </h4>
          <ul className="pp-list">
            {warnings.map((issue) => (
              <li key={issue.code + issue.message} className="pp-issue pp-issue-warning">
                <span aria-hidden="true">!</span> <strong>Warning:</strong> {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {readiness.ready && errors.length === 0 && (
        <p className="pp-issue" role="status">
          <span aria-hidden="true">✓</span> Ready to publish. Participants will see the session once
          it is published.
        </p>
      )}
      <div>
        <button
          type="button"
          className="pp-button pp-button-primary"
          disabled={pending || !readiness.ready}
          onClick={onPublish}
        >
          Publish session
        </button>
      </div>
    </div>
  );
}

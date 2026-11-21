import type { DeckChoice, ScoringSettingsView, SpecialCardDto } from '@planning-poker/contracts';
import type { DeckId, ScoringDeck, SessionSettings, SpecialCardType } from '@planning-poker/domain';
import {
  createCustomDeck,
  createPresetDeck,
  DECK_PRESETS,
  DomainError,
  isRegularCard,
} from '@planning-poker/domain';

const MAX_CUSTOM_CARDS = 30;

/** Builds a deck from the builder's choice. Custom numeric labels must parse as numbers. */
export function deckFromChoice(
  id: DeckId,
  choice: DeckChoice,
  specialCards: readonly SpecialCardType[],
): ScoringDeck {
  if (choice.kind === 'preset') {
    return createPresetDeck(id, choice.preset, specialCards);
  }

  const labels = choice.labels.map((label) => label.trim()).filter((label) => label.length > 0);

  if (labels.length > MAX_CUSTOM_CARDS) {
    throw new DomainError(
      'VALIDATION',
      `A deck can have at most ${String(MAX_CUSTOM_CARDS)} cards.`,
    );
  }

  return createCustomDeck({
    id,
    name: choice.name,
    scale: choice.scale,
    specialCards,
    cards: labels.map((label) => {
      if (choice.scale === 'categorical') {
        return { label };
      }

      const value = Number(label);

      if (!Number.isFinite(value)) {
        throw new DomainError('VALIDATION', `"${label}" is not a number.`);
      }

      return { label, numericValue: value };
    }),
  });
}

/** Recognises an unchanged preset deck so the builder can show it as that preset again. */
function choiceForDeck(deck: ScoringDeck): DeckChoice {
  const regular = deck.cards.filter(isRegularCard).map((card) => card.label);

  for (const preset of DECK_PRESETS) {
    const candidate = createPresetDeck(deck.id, preset);

    if (
      candidate.name === deck.name &&
      candidate.cards.length === regular.length &&
      candidate.cards.every((card, index) => card.label === regular[index])
    ) {
      return { kind: 'preset', preset };
    }
  }

  return { kind: 'custom', name: deck.name, scale: deck.scale, labels: regular };
}

export function scoringSettingsView(settings: SessionSettings): ScoringSettingsView {
  const { deck } = settings;

  return {
    deck: choiceForDeck(deck),
    deckName: deck.name,
    cards: [...deck.cards]
      .sort((a, b) => a.order - b.order)
      .map((card) => ({ id: card.id, label: card.label, kind: card.kind })),
    specialCards: deck.cards.flatMap((card): SpecialCardDto[] =>
      card.specialType === null ? [] : [card.specialType],
    ),
    autoFinalize: settings.autoFinalize,
    autoAdvance: settings.autoAdvance,
    allowInvitationsWhileActive: settings.allowInvitationsWhileActive,
  };
}

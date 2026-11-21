import { DomainError, ensure } from './errors';
import { asId } from './ids';
import type { CardId, DeckId } from './ids';

export type SpecialCardType = 'infinity' | 'unknown' | 'coffee';

/**
 * - `numeric`: a regular card with a numeric value (Fibonacci, powers of two…).
 * - `category`: a regular card without a numeric value (T-shirt sizes…).
 * - `special`: ∞, ? or ☕. Never treated as an estimate value automatically.
 */
export type CardKind = 'numeric' | 'category' | 'special';

export interface Card {
  readonly id: CardId;
  readonly label: string;
  readonly kind: CardKind;
  readonly numericValue: number | null;
  readonly specialType: SpecialCardType | null;
  readonly order: number;
  /** Optional value to write to an external single-select field, e.g. a Jira option ID. */
  readonly externalValue: string | null;
}

export type DeckScale = 'numeric' | 'categorical';

export interface ScoringDeck {
  readonly id: DeckId;
  readonly name: string;
  readonly scale: DeckScale;
  readonly cards: readonly Card[];
}

export const SPECIAL_CARD_LABELS: Readonly<Record<SpecialCardType, string>> = {
  infinity: '∞',
  unknown: '?',
  coffee: '☕',
};

const SPECIAL_CARD_ORDER: readonly SpecialCardType[] = ['infinity', 'unknown', 'coffee'];
const MIN_REGULAR_CARDS = 2;

export interface CustomCardInput {
  readonly label: string;
  readonly numericValue?: number | null;
  readonly externalValue?: string | null;
}

export interface CustomDeckInput {
  readonly id: DeckId;
  readonly name: string;
  readonly scale: DeckScale;
  readonly cards: readonly CustomCardInput[];
  readonly specialCards?: readonly SpecialCardType[];
}

function specialCards(types: readonly SpecialCardType[], firstOrder: number): Card[] {
  return SPECIAL_CARD_ORDER.filter((type) => types.includes(type)).map((type, index) => ({
    id: asId<CardId>(`special:${type}`),
    label: SPECIAL_CARD_LABELS[type],
    kind: 'special',
    numericValue: null,
    specialType: type,
    order: firstOrder + index,
    externalValue: null,
  }));
}

/** Builds a deck from regular cards plus any chosen special cards, then validates it. */
export function createCustomDeck(input: CustomDeckInput): ScoringDeck {
  const regular: Card[] = input.cards.map((card, index) => ({
    id: asId<CardId>(`card:${String(index)}`),
    label: card.label.trim(),
    kind: input.scale === 'numeric' ? 'numeric' : 'category',
    numericValue: input.scale === 'numeric' ? (card.numericValue ?? null) : null,
    specialType: null,
    order: index,
    externalValue: card.externalValue ?? null,
  }));
  const deck: ScoringDeck = {
    id: input.id,
    name: input.name.trim(),
    scale: input.scale,
    cards: [...regular, ...specialCards(input.specialCards ?? [], regular.length)],
  };
  const errors = validateDeck(deck);

  if (errors.length > 0) {
    throw new DomainError('VALIDATION', errors.join(' '));
  }

  return deck;
}

/** Returns human-readable problems with a deck; empty when the deck is usable. */
export function validateDeck(deck: ScoringDeck): string[] {
  const errors: string[] = [];
  const regular = deck.cards.filter(isRegularCard);

  if (deck.name.length === 0) {
    errors.push('Deck name is required.');
  }

  if (regular.length < MIN_REGULAR_CARDS) {
    errors.push(`A deck needs at least ${String(MIN_REGULAR_CARDS)} regular cards.`);
  }

  if (new Set(deck.cards.map((card) => card.id)).size !== deck.cards.length) {
    errors.push('Card identifiers must be unique.');
  }

  if (new Set(deck.cards.map((card) => card.label)).size !== deck.cards.length) {
    errors.push('Card labels must be unique.');
  }

  if (deck.cards.some((card) => card.label.length === 0)) {
    errors.push('Every card needs a label.');
  }

  for (const card of regular) {
    const expectedKind: CardKind = deck.scale === 'numeric' ? 'numeric' : 'category';

    if (card.kind !== expectedKind) {
      errors.push(`Card "${card.label}" does not match the ${deck.scale} deck scale.`);
    }

    if (card.kind === 'numeric' && (card.numericValue === null || !isFinite(card.numericValue))) {
      errors.push(`Numeric card "${card.label}" needs a finite numeric value.`);
    }
  }

  return errors;
}

export function isRegularCard(card: Card): boolean {
  return card.kind !== 'special';
}

export function findCard(deck: ScoringDeck, cardId: CardId): Card | undefined {
  return deck.cards.find((card) => card.id === cardId);
}

export function requireCard(deck: ScoringDeck, cardId: CardId): Card {
  const card = findCard(deck, cardId);
  ensure(card !== undefined, 'VALIDATION', 'That card is not part of this session’s deck.');

  return card;
}

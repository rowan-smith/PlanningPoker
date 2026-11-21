import { describe, expect, it } from 'vitest';

import {
  asId,
  createCustomDeck,
  createPresetDeck,
  DECK_PRESETS,
  DomainError,
  mapCardToField,
  validateDeck,
} from '../src';
import type { DeckId, FieldMapping } from '../src';

const deckId = asId<DeckId>('deck-1');

describe('scoring decks', () => {
  it('builds every preset as a valid deck', () => {
    for (const preset of DECK_PRESETS) {
      expect(validateDeck(createPresetDeck(deckId, preset))).toEqual([]);
    }
  });

  it('keeps numeric and categorical decks distinct', () => {
    const fibonacci = createPresetDeck(deckId, 'fibonacci');
    const tShirt = createPresetDeck(deckId, 't-shirt');

    expect(fibonacci.scale).toBe('numeric');
    expect(fibonacci.cards.every((card) => card.kind === 'numeric')).toBe(true);
    expect(tShirt.scale).toBe('categorical');
    expect(
      tShirt.cards.every((card) => card.kind === 'category' && card.numericValue === null),
    ).toBe(true);
  });

  it('adds special cards after regular cards without numeric values', () => {
    const deck = createPresetDeck(deckId, 'fibonacci', ['coffee', 'infinity', 'unknown']);
    const specials = deck.cards.filter((card) => card.kind === 'special');

    expect(specials.map((card) => card.label)).toEqual(['∞', '?', '☕']);
    expect(specials.every((card) => card.numericValue === null)).toBe(true);
    expect(Math.min(...specials.map((card) => card.order))).toBeGreaterThan(
      Math.max(...deck.cards.filter((card) => card.kind !== 'special').map((card) => card.order)),
    );
  });

  it('includes ½ in modified Fibonacci, in numeric order', () => {
    const deck = createPresetDeck(deckId, 'modified-fibonacci');

    expect(deck.cards.slice(0, 3).map((card) => card.label)).toEqual(['0', '½', '1']);
  });

  it('rejects invalid custom decks', () => {
    expect(() =>
      createCustomDeck({ id: deckId, name: 'Bad', scale: 'numeric', cards: [{ label: 'One' }] }),
    ).toThrow(DomainError);
    expect(() =>
      createCustomDeck({
        id: deckId,
        name: 'Duplicates',
        scale: 'categorical',
        cards: [{ label: 'S' }, { label: 'S' }],
      }),
    ).toThrow(/unique/);
  });
});

describe('field mapping', () => {
  const deck = createPresetDeck(deckId, 'fibonacci', ['coffee']);
  const numberField: FieldMapping = {
    fieldId: 'customfield_1',
    fieldName: 'Story points',
    valueType: 'number',
    optionByCardId: {},
  };
  const coffee = deck.cards.find((card) => card.specialType === 'coffee');
  const five = deck.cards.find((card) => card.label === '5');

  it('writes numeric cards to number fields', () => {
    expect(five && mapCardToField(five, numberField)).toEqual({ ok: true, value: 5 });
  });

  it('never writes special cards to number fields', () => {
    expect(coffee && mapCardToField(coffee, numberField).ok).toBe(false);
  });

  it('writes to option fields only when a card is mapped', () => {
    const tShirt = createPresetDeck(deckId, 't-shirt');
    const [small, medium] = tShirt.cards.filter((card) => card.label === 'S' || card.label === 'M');
    const optionField: FieldMapping = {
      fieldId: 'customfield_2',
      fieldName: 'Size',
      valueType: 'option',
      optionByCardId: small ? { [small.id]: 'opt-s' } : {},
    };

    expect(small && mapCardToField(small, optionField)).toEqual({ ok: true, value: 'opt-s' });
    expect(medium && mapCardToField(medium, optionField).ok).toBe(false);
  });
});

/* eslint-disable @typescript-eslint/no-magic-numbers -- preset card values are the domain data itself. */
import { createCustomDeck } from './deck';
import type { CustomCardInput, ScoringDeck, SpecialCardType } from './deck';
import type { DeckId } from './ids';

export type DeckPreset = 'fibonacci' | 'modified-fibonacci' | 'powers-of-two' | 't-shirt';

function numeric(values: readonly number[]): CustomCardInput[] {
  return values.map((value) => ({ label: String(value), numericValue: value }));
}

const PRESETS: Readonly<
  Record<DeckPreset, { name: string; scale: 'numeric' | 'categorical'; cards: CustomCardInput[] }>
> = {
  fibonacci: {
    name: 'Fibonacci',
    scale: 'numeric',
    cards: numeric([0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]),
  },
  'modified-fibonacci': {
    name: 'Modified Fibonacci',
    scale: 'numeric',
    cards: [
      { label: '½', numericValue: 0.5 },
      ...numeric([0, 1, 2, 3, 5, 8, 13, 20, 40, 100]),
    ].sort((a, b) => (a.numericValue ?? 0) - (b.numericValue ?? 0)),
  },
  'powers-of-two': {
    name: 'Powers of two',
    scale: 'numeric',
    cards: numeric([0, 1, 2, 4, 8, 16, 32, 64]),
  },
  't-shirt': {
    name: 'T-shirt sizes',
    scale: 'categorical',
    cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL'].map((label) => ({ label })),
  },
};

export const DECK_PRESETS: readonly DeckPreset[] = Object.keys(PRESETS) as DeckPreset[];

export function createPresetDeck(
  id: DeckId,
  preset: DeckPreset,
  specialCards: readonly SpecialCardType[] = [],
): ScoringDeck {
  const definition = PRESETS[preset];

  return createCustomDeck({
    id,
    name: definition.name,
    scale: definition.scale,
    cards: definition.cards,
    specialCards,
  });
}

import type { Card } from './deck';
import type { CardId, RoundId, TicketId, UserId } from './ids';

export interface Estimate {
  readonly cardId: CardId;
  readonly label: string;
  readonly numericValue: number | null;
}

/** `consensus`: every counted vote matched. `override`: a moderator chose the estimate. */
export type DecisionKind = 'consensus' | 'override';

export interface ConsensusDecision {
  readonly ticketId: TicketId;
  readonly roundId: RoundId;
  readonly kind: DecisionKind;
  readonly estimate: Estimate;
  readonly reason: string | null;
  /** `null` when the system finalized automatically. */
  readonly decidedBy: UserId | null;
  readonly decidedAt: Date;
}

export function estimateFromCard(card: Card): Estimate {
  return { cardId: card.id, label: card.label, numericValue: card.numericValue };
}

export type FieldValueType = 'number' | 'option';

/** Where a session writes final estimates in the work-item provider. Field IDs are discovered, never hardcoded. */
export interface FieldMapping {
  readonly fieldId: string;
  readonly fieldName: string;
  readonly valueType: FieldValueType;
  /** For `option` fields: which external option each card maps to. */
  readonly optionByCardId: Readonly<Partial<Record<CardId, string>>>;
}

export type FieldValue = number | string;

export type FieldMappingResult =
  | { readonly ok: true; readonly value: FieldValue }
  | { readonly ok: false; readonly reason: string };

/** Special cards are only written when explicitly mapped to an option; never into number fields. */
export function mapCardToField(card: Card, mapping: FieldMapping): FieldMappingResult {
  if (mapping.valueType === 'number') {
    if (card.kind === 'numeric' && card.numericValue !== null) {
      return { ok: true, value: card.numericValue };
    }

    return { ok: false, reason: `"${card.label}" cannot be written to the number field.` };
  }

  const option = mapping.optionByCardId[card.id] ?? card.externalValue;

  if (option === null) {
    return { ok: false, reason: `"${card.label}" has no option mapped in ${mapping.fieldName}.` };
  }

  return { ok: true, value: option };
}

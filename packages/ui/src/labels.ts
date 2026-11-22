import type {
  DeckPresetDto,
  SessionStatusDto,
  SpecialCardDto,
  TicketVotingStateDto,
} from '@planning-poker/contracts';

export const STATUS_LABELS: Readonly<Record<SessionStatusDto, string>> = {
  draft: 'Draft',
  ready: 'Ready',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const DECK_LABELS: Readonly<Record<DeckPresetDto, string>> = {
  fibonacci: 'Fibonacci (0, 1, 2, 3, 5, 8, 13…)',
  'modified-fibonacci': 'Modified Fibonacci (0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100)',
  'powers-of-two': 'Powers of two (0, 1, 2, 4, 8, 16…)',
  't-shirt': 'T-shirt sizes (XS–XXL)',
};

export const SPECIAL_CARD_LABELS: Readonly<Record<SpecialCardDto, string>> = {
  infinity: '∞ Infinity — too big to estimate',
  unknown: '? Unknown — not enough information',
  coffee: '☕ Coffee — I need a break',
};

export const TICKET_STATE_LABELS: Readonly<Record<TicketVotingStateDto, string>> = {
  pending: 'Upcoming',
  voting: 'Voting',
  revealed: 'Revealed',
  revoting: 'Revoting',
  finalized: 'Estimated',
  skipped: 'Skipped',
  unresolved: 'Unresolved',
};

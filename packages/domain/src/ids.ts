declare const brand: unique symbol;

/** A string identifier tagged with the kind of entity it identifies. */
export type Id<Kind extends string> = string & { readonly [brand]: Kind };

export type TenantId = Id<'Tenant'>;
export type UserId = Id<'User'>;
export type TeamId = Id<'Team'>;
export type SessionId = Id<'Session'>;
export type TicketId = Id<'Ticket'>;
export type RoundId = Id<'Round'>;
export type InvitationId = Id<'Invitation'>;
export type DeckId = Id<'Deck'>;
export type CardId = Id<'Card'>;
export type AuditEventId = Id<'AuditEvent'>;

/** Tags a raw string as an identifier. Use only at trust boundaries (storage, requests, tests). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the parameter selects the branded result type.
export function asId<T extends Id<string>>(value: string): T {
  return value as T;
}

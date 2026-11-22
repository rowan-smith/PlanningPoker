import { publish, signRealtimeToken } from '@forge/realtime';
import type { EventPublisher } from '@planning-poker/application';
import type { SessionEvent } from '@planning-poker/contracts';
import { sessionChannel } from '@planning-poker/contracts';

import type { RealtimeTokenIssuer } from './handlers';
import type { Logger } from './logger';

/** Publishes to a Forge Realtime channel; injected so the publisher can be tested without Forge. */
export type RealtimePublish = (
  channel: string,
  payload: Record<string, unknown>,
  options?: { readonly token?: string },
) => Promise<{ readonly errors?: unknown }>;

export type RealtimePermission = 'subscribe' | 'publish';

/** `signRealtimeToken` from `@forge/realtime`, injected for tests. */
export type SignRealtimeToken = (
  channel: string,
  claims: Record<string, string>,
  permissions: [RealtimePermission, ...RealtimePermission[]],
) => Promise<{ readonly token: unknown; readonly expiresAt: unknown; readonly errors?: unknown }>;

export interface SignedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/** Publish tokens are reused until this long before they expire. */
const REFRESH_MARGIN_MS = 60_000;
const MS_PER_SECOND = 1000;
/** Epoch values above this are already milliseconds. */
const EPOCH_MS_THRESHOLD = 1e12;

/**
 * Claims bound into every token for a session's channel. Forge delivers an event only to
 * subscriptions whose token carries exactly the same claims as the publisher's, so these must be
 * identical on both sides.
 */
export function sessionClaims(tenantId: string, sessionId: string): Record<string, string> {
  return { app: 'planning-poker', tenant: tenantId, session: sessionId };
}

/** Forge returns `expiresAt` in epoch seconds; accept milliseconds and ISO strings too. */
function expiryOf(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > EPOCH_MS_THRESHOLD ? value : value * MS_PER_SECOND);
  }

  if (typeof value === 'string') {
    const numeric = Number(value);

    if (Number.isFinite(numeric) && value.trim() !== '') {
      return expiryOf(numeric);
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

/**
 * Signs realtime tokens with `@forge/realtime` (backend only). Subscribers get subscribe-only
 * tokens, and only after the resolver checked they may view the session; the publisher signs
 * its own publish-only token. Signing errors are reported without their details, which could
 * echo request data.
 */
export class ForgeRealtimeTokens implements RealtimeTokenIssuer {
  private readonly sign: SignRealtimeToken;
  private readonly now: () => number;
  /** Per warm function instance; keyed by tenant and session, so installations never share. */
  private readonly publishTokens = new Map<string, SignedToken>();

  constructor(sign: SignRealtimeToken = signRealtimeToken, now: () => number = Date.now) {
    this.sign = sign;
    this.now = now;
  }

  async subscribeToken(tenantId: string, sessionId: string): Promise<SignedToken> {
    return await this.signFor(tenantId, sessionId, 'subscribe');
  }

  async publishToken(tenantId: string, sessionId: string): Promise<SignedToken> {
    const key = `${tenantId}|${sessionId}`;
    const cached = this.publishTokens.get(key);

    if (cached !== undefined && cached.expiresAt.getTime() - REFRESH_MARGIN_MS > this.now()) {
      return cached;
    }

    const signed = await this.signFor(tenantId, sessionId, 'publish');
    this.publishTokens.set(key, signed);

    return signed;
  }

  private async signFor(
    tenantId: string,
    sessionId: string,
    permission: RealtimePermission,
  ): Promise<SignedToken> {
    const result = await this.sign(sessionChannel(sessionId), sessionClaims(tenantId, sessionId), [
      permission,
    ]);
    const expiresAt = expiryOf(result.expiresAt);
    const failed = result.errors !== undefined && result.errors !== null;

    if (failed || typeof result.token !== 'string' || expiresAt === null) {
      throw new Error(`Realtime ${permission} token could not be signed.`);
    }

    return { token: result.token, expiresAt };
  }
}

/**
 * Session notifications over Forge Realtime. Each event is published with a publish-only token
 * carrying the session's claims, so only subscriptions holding a token for the same session —
 * which the resolver signs only for people allowed to view it — receive it. Payloads carry no
 * hidden state either way (no votes, no identity-to-vote pairs), and clients re-fetch their own
 * authorized view on every event. Realtime is not the source of truth, so a failed publish is
 * logged and never fails the change that caused it.
 */
export class ForgeRealtimePublisher implements EventPublisher {
  private readonly send: RealtimePublish;
  private readonly logger: Logger;
  private readonly tokens: ForgeRealtimeTokens;

  constructor(
    logger: Logger,
    tokens: ForgeRealtimeTokens = new ForgeRealtimeTokens(),
    send: RealtimePublish = publish,
  ) {
    this.logger = logger;
    this.tokens = tokens;
    this.send = send;
  }

  async publish(tenantId: string, sessionId: string, event: SessionEvent): Promise<void> {
    try {
      const { token } = await this.tokens.publishToken(tenantId, sessionId);
      const result = await this.send(sessionChannel(sessionId), { ...event }, { token });

      if (result.errors !== undefined && result.errors !== null) {
        this.logger.error(`Realtime publish rejected (${event.type})`);
      }
    } catch (error: unknown) {
      this.logger.error(`Realtime publish failed (${event.type})`, error);
    }
  }
}

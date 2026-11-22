import { publish } from '@forge/realtime';
import type { EventPublisher } from '@planning-poker/application';
import type { SessionEvent } from '@planning-poker/contracts';
import { sessionChannel } from '@planning-poker/contracts';

import type { Logger } from './logger';

/** Publishes to a Forge Realtime channel; injected so the publisher can be tested without Forge. */
export type RealtimePublish = (
  channel: string,
  payload: Record<string, unknown>,
) => Promise<{ readonly errors?: unknown }>;

/**
 * Session notifications over Forge Realtime. Channels are scoped to the app's installation
 * context; payloads carry no hidden state (no votes, no identity-to-vote pairs), and clients
 * re-fetch their own authorized view on every event. Realtime is not the source of truth, so a
 * failed publish is logged and never fails the change that caused it.
 */
export class ForgeRealtimePublisher implements EventPublisher {
  private readonly send: RealtimePublish;
  private readonly logger: Logger;

  constructor(logger: Logger, send: RealtimePublish = publish) {
    this.logger = logger;
    this.send = send;
  }

  async publish(_tenantId: string, sessionId: string, event: SessionEvent): Promise<void> {
    try {
      const result = await this.send(sessionChannel(sessionId), { ...event });

      if (result.errors !== undefined && result.errors !== null) {
        this.logger.error(`Realtime publish rejected (${event.type})`);
      }
    } catch (error: unknown) {
      this.logger.error(`Realtime publish failed (${event.type})`, error);
    }
  }
}

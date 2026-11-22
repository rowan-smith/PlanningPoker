import { describe, expect, it } from 'vitest';

import type { Logger } from '../src/logger';
import { ForgeRealtimePublisher } from '../src/realtime';

function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];

  return {
    lines,
    error(message) {
      lines.push(message);
    },
  };
}

describe('ForgeRealtimePublisher', () => {
  it('publishes the notification to the session channel', async () => {
    const sent: { channel: string; payload: Record<string, unknown> }[] = [];
    const publisher = new ForgeRealtimePublisher(recordingLogger(), (channel, payload) => {
      sent.push({ channel, payload });

      return Promise.resolve({});
    });

    await publisher.publish('tenant', 'session-1', {
      type: 'vote.status',
      ticketId: 't1',
      votedCount: 1,
      requiredCount: 3,
    });

    expect(sent).toEqual([
      {
        channel: 'planning-poker-session-session-1',
        payload: { type: 'vote.status', ticketId: 't1', votedCount: 1, requiredCount: 3 },
      },
    ]);
  });

  it('logs rejected or failing publishes without failing the change that caused them', async () => {
    const logger = recordingLogger();
    const rejecting = new ForgeRealtimePublisher(logger, () =>
      Promise.resolve({ errors: ['quota'] }),
    );
    const throwing = new ForgeRealtimePublisher(logger, () => Promise.reject(new Error('down')));

    await expect(
      rejecting.publish('tenant', 's', { type: 'round.revealed', ticketId: 't' }),
    ).resolves.toBeUndefined();
    await expect(
      throwing.publish('tenant', 's', { type: 'round.revealed', ticketId: 't' }),
    ).resolves.toBeUndefined();
    expect(logger.lines).toEqual([
      'Realtime publish rejected (round.revealed)',
      'Realtime publish failed (round.revealed)',
    ]);
  });
});

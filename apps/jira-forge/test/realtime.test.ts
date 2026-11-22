import { describe, expect, it } from 'vitest';

import type { Logger } from '../src/logger';
import type { RealtimePublish, SignRealtimeToken } from '../src/realtime';
import { ForgeRealtimePublisher, ForgeRealtimeTokens, sessionClaims } from '../src/realtime';

const NOW = Date.parse('2026-11-22T10:00:00.000Z');
const ONE_HOUR_S = 3600;

function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];

  return {
    lines,
    error(message, error) {
      lines.push(error instanceof Error ? `${message}: ${String(error)}` : message);
    },
  };
}

function fakeSigner() {
  const calls: { channel: string; claims: Record<string, string>; permissions: string[] }[] = [];
  let counter = 0;
  const sign: SignRealtimeToken = (channel, claims, permissions) => {
    calls.push({ channel, claims, permissions: [...permissions] });
    counter += 1;

    return Promise.resolve({
      token: `jwt-${String(counter)}`,
      expiresAt: NOW / 1000 + ONE_HOUR_S,
    });
  };

  return { calls, sign };
}

function recordingSend() {
  const sent: { channel: string; payload: Record<string, unknown>; token: string | undefined }[] =
    [];
  const send: RealtimePublish = (channel, payload, options) => {
    sent.push({ channel, payload, token: options?.token });

    return Promise.resolve({});
  };

  return { sent, send };
}

describe('ForgeRealtimeTokens', () => {
  it('signs subscribe-only tokens bound to the tenant and session', async () => {
    const signer = fakeSigner();
    const tokens = new ForgeRealtimeTokens(signer.sign, () => NOW);

    const signed = await tokens.subscribeToken('tenant-1', 'session-1');

    expect(signed).toEqual({
      token: 'jwt-1',
      expiresAt: new Date(NOW + ONE_HOUR_S * 1000),
    });
    expect(signer.calls).toEqual([
      {
        channel: 'planning-poker-session-session-1',
        claims: { app: 'planning-poker', tenant: 'tenant-1', session: 'session-1' },
        permissions: ['subscribe'],
      },
    ]);
  });

  it('reuses a publish token until shortly before it expires', async () => {
    const signer = fakeSigner();
    let now = NOW;
    const tokens = new ForgeRealtimeTokens(signer.sign, () => now);

    await tokens.publishToken('t', 's');
    await tokens.publishToken('t', 's');
    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]?.permissions).toEqual(['publish']);

    now = NOW + (ONE_HOUR_S - 30) * 1000;
    await tokens.publishToken('t', 's');
    expect(signer.calls).toHaveLength(2);

    // Another tenant's session with the same ID never reuses this tenant's token.
    await tokens.publishToken('other-tenant', 's');
    expect(signer.calls).toHaveLength(3);
    expect(signer.calls[2]?.claims).toEqual(sessionClaims('other-tenant', 's'));
  });

  it('refuses to hand out a token when signing fails', async () => {
    const tokens = new ForgeRealtimeTokens(
      () => Promise.resolve({ token: null, expiresAt: null, errors: [{ message: 'secret' }] }),
      () => NOW,
    );

    await expect(tokens.subscribeToken('t', 's')).rejects.toThrow(
      'Realtime subscribe token could not be signed.',
    );
  });
});

describe('ForgeRealtimePublisher', () => {
  it('publishes the notification with a publish token carrying the same claims', async () => {
    const signer = fakeSigner();
    const { sent, send } = recordingSend();
    const publisher = new ForgeRealtimePublisher(
      recordingLogger(),
      new ForgeRealtimeTokens(signer.sign, () => NOW),
      send,
    );

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
        token: 'jwt-1',
      },
    ]);
    expect(signer.calls[0]?.claims).toEqual(sessionClaims('tenant', 'session-1'));
  });

  it('logs rejected or failing publishes without failing the change that caused them', async () => {
    const logger = recordingLogger();
    const tokens = new ForgeRealtimeTokens(fakeSigner().sign, () => NOW);
    const rejecting = new ForgeRealtimePublisher(logger, tokens, () =>
      Promise.resolve({ errors: ['quota'] }),
    );
    const throwing = new ForgeRealtimePublisher(logger, tokens, () =>
      Promise.reject(new Error('down')),
    );
    const unsigned = new ForgeRealtimePublisher(
      logger,
      new ForgeRealtimeTokens(() => Promise.resolve({ token: null, expiresAt: null, errors: [] })),
      () => Promise.resolve({}),
    );

    for (const publisher of [rejecting, throwing, unsigned]) {
      await expect(
        publisher.publish('tenant', 's', { type: 'round.revealed', ticketId: 't' }),
      ).resolves.toBeUndefined();
    }

    expect(logger.lines).toEqual([
      'Realtime publish rejected (round.revealed)',
      'Realtime publish failed (round.revealed): Error: down',
      'Realtime publish failed (round.revealed): Error: Realtime publish token could not be signed.',
    ]);
  });
});

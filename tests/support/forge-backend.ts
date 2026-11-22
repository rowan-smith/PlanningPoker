/**
 * The production backend wiring (apps/jira-forge/src/index.ts) with Forge's platform pieces
 * swapped for test doubles: Forge storage → `InMemoryEntityStore` (optionally interleaving),
 * Jira REST → `FakeJira`, Forge Realtime → a recorder. Everything else is the real code: the
 * resolver handlers, application services, Forge repositories, `ForgeAtomicOperation` (no lock,
 * retries on conflict) and the Jira adapters. Every call builds request-scoped services from the
 * caller's account and installation, as the Forge resolver does.
 */
import type { ApplicationDependencies } from '@planning-poker/application';
import {
  ReportService,
  SessionService,
  SettingsService,
  TeamService,
} from '@planning-poker/application';
import { RecordingEventPublisher, SequentialIds } from '@planning-poker/application/testing';
import type { ResolverKey, ResolverResult, ResolverValue } from '@planning-poker/contracts';
import type { TenantId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';
import {
  AtlassianIdentityProvider,
  clearVisibilityCache,
  ForgeJiraUserApi,
  JiraWorkItemProvider,
} from '@planning-poker/integration-jira';
import type { EntityStore } from '@planning-poker/persistence-forge';
import {
  ForgeApplicationSettingsRepository,
  ForgeAtomicOperation,
  ForgeAuditRepository,
  ForgeParticipantRepository,
  ForgeSessionRepository,
  ForgeTeamRepository,
  ForgeVoteRepository,
} from '@planning-poker/persistence-forge';
import { InMemoryEntityStore, MANIFEST_INDEXES } from '@planning-poker/persistence-forge/testing';

import type { RealtimeTokenIssuer } from '../../apps/jira-forge/src/handlers';
import { createHandlers } from '../../apps/jira-forge/src/handlers';
import type { Logger } from '../../apps/jira-forge/src/logger';
import { FakeJira } from './fake-jira';
import { InterleavingEntityStore } from './interleaving-store';

export const SITE_1 = 'site-1';
export const SITE_2 = 'site-2';
const START = Date.parse('2026-11-02T09:00:00.000Z');
const ATTEMPTS = 12;

export interface BackendOptions {
  /** Interleave storage operations of concurrent calls (deterministic per seed). */
  readonly interleaveSeed?: number;
  readonly jira?: FakeJira;
}

/** Signs fake tokens and remembers who got one. */
export class RecordingTokenIssuer implements RealtimeTokenIssuer {
  readonly issued: { tenantId: string; sessionId: string }[] = [];

  subscribeToken(tenantId: string, sessionId: string) {
    this.issued.push({ tenantId, sessionId });

    return Promise.resolve({
      token: `token-${tenantId}-${sessionId}`,
      expiresAt: new Date(START + 3_600_000),
    });
  }
}

export type Caller = {
  readonly [K in ResolverKey]: (payload?: unknown) => Promise<ResolverResult<ResolverValue<K>>>;
};

export function createForgeBackend(options: BackendOptions = {}) {
  clearVisibilityCache();
  const jira = options.jira ?? new FakeJira();
  const memory = new InMemoryEntityStore(MANIFEST_INDEXES, 2);
  const interleaving =
    options.interleaveSeed === undefined
      ? null
      : new InterleavingEntityStore(memory, options.interleaveSeed);
  const store: EntityStore = interleaving ?? memory;
  const settings = new ForgeApplicationSettingsRepository(store);
  const events = new RecordingEventPublisher();
  const logged: string[] = [];
  const logger: Logger = {
    error(message, error) {
      logged.push(error instanceof Error ? `${message}: ${String(error)}` : message);
    },
  };
  let tick = 0;
  const shared = {
    settings,
    teams: new ForgeTeamRepository(store),
    sessions: new ForgeSessionRepository(store),
    participants: new ForgeParticipantRepository(store),
    votes: new ForgeVoteRepository(store),
    audit: new ForgeAuditRepository(store),
    events,
    atomic: new ForgeAtomicOperation(ATTEMPTS),
    // Strictly increasing, so every vote has its own timestamp.
    clock: {
      now: () => {
        tick += 1;

        return new Date(START + tick);
      },
    },
    ids: new SequentialIds(),
  } satisfies Omit<ApplicationDependencies, 'identity' | 'workItems'>;
  const tokens = new RecordingTokenIssuer();

  /** Request-scoped handlers, built like one Forge resolver invocation. */
  function handlersFor(accountId: string | undefined, installation: string) {
    const request = jira.requestFor(accountId);
    const identity = new AtlassianIdentityProvider(
      { tenantId: asId<TenantId>(installation), accountId },
      new ForgeJiraUserApi(request),
      settings,
    );
    const workItems = new JiraWorkItemProvider(
      { installationId: installation, accountId },
      request,
    );
    const deps: ApplicationDependencies = { ...shared, identity, workItems };
    return createHandlers(
      {
        identity,
        teams: new TeamService(deps),
        settings: new SettingsService(deps),
        sessions: new SessionService(deps),
        reports: new ReportService(deps),
        realtimeTokens: tokens,
      },
      logger,
    );
  }

  /** Resolver handlers for one signed-in Atlassian account on one installation. */
  function as(accountId: string | undefined, installation: string = SITE_1): Caller {
    // Each call gets fresh request-scoped services (identity is resolved per invocation).
    return new Proxy({} as Caller, {
      get: (_target, key: string) => async (payload: unknown) =>
        await handlersFor(accountId, installation)[key as ResolverKey](payload ?? {}),
    });
  }

  return { jira, memory, store, interleaving, events, logged, tokens, as, deps: shared };
}

/** Unwraps a resolver result, failing the test with the error if it was not ok. */
export function ok<T>(result: ResolverResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected ok, got ${result.error.code}: ${result.error.message}`);
  }

  return result.value;
}

export function userId(accountId: string): string {
  return `atlassian:${accountId}`;
}

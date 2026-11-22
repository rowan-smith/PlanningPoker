import Resolver from '@forge/resolver';
import type { ApplicationDependencies } from '@planning-poker/application';
import { SessionService, SettingsService, TeamService } from '@planning-poker/application';
import { RESOLVER_KEYS } from '@planning-poker/contracts';
import type { TenantId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';
import {
  AtlassianIdentityProvider,
  ForgeJiraUserApi,
  JiraWorkItemProvider,
} from '@planning-poker/integration-jira';
import {
  ForgeApplicationSettingsRepository,
  ForgeAtomicOperation,
  ForgeAuditRepository,
  ForgeParticipantRepository,
  ForgeSessionRepository,
  ForgeTeamRepository,
  ForgeVoteRepository,
  KvsEntityStore,
} from '@planning-poker/persistence-forge';

import type { BackendServices } from './handlers';
import { createHandlers } from './handlers';
import { consoleLogger } from './logger';
import { ForgeRealtimePublisher } from './realtime';

interface ForgeContext {
  readonly accountId?: string;
  readonly installContext?: string;
}

const store = new KvsEntityStore();
const settings = new ForgeApplicationSettingsRepository(store);
const shared = {
  settings,
  teams: new ForgeTeamRepository(store),
  sessions: new ForgeSessionRepository(store),
  participants: new ForgeParticipantRepository(store),
  votes: new ForgeVoteRepository(store),
  audit: new ForgeAuditRepository(store),
  events: new ForgeRealtimePublisher(consoleLogger),
  atomic: new ForgeAtomicOperation(),
  clock: { now: () => new Date() },
  ids: { next: () => crypto.randomUUID() },
} satisfies Omit<ApplicationDependencies, 'identity' | 'workItems'>;

/** Builds request-scoped services from Forge's invocation context (never the client payload). */
function servicesFor(context: ForgeContext): BackendServices {
  if (context.installContext === undefined) {
    throw new Error('Missing installation context.');
  }

  const identity = new AtlassianIdentityProvider(
    { tenantId: asId<TenantId>(context.installContext), accountId: context.accountId },
    new ForgeJiraUserApi(),
    settings,
  );
  const workItems = new JiraWorkItemProvider({ installationId: context.installContext });
  const deps: ApplicationDependencies = { ...shared, identity, workItems };

  return {
    identity,
    teams: new TeamService(deps),
    settings: new SettingsService(deps),
    sessions: new SessionService(deps),
  };
}

const resolver = new Resolver();

for (const key of RESOLVER_KEYS) {
  resolver.define(key, async ({ payload, context }) => {
    const handlers = createHandlers(servicesFor(context), consoleLogger);

    return await handlers[key](payload);
  });
}

export const handler = resolver.getDefinitions();

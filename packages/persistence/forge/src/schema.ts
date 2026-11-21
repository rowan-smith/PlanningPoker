/**
 * Entity and index names. They must match `app.storage.entities` in apps/jira-forge/manifest.yml.
 * Once deployed to staging or production, Forge entities and indexes cannot be deleted.
 */
export const ENTITIES = {
  team: { name: 'team', byTenant: 'by-tenant' },
  settings: { name: 'appsettings' },
  audit: { name: 'auditevent', byTeam: 'by-team', bySession: 'by-session' },
  session: { name: 'session', byTeam: 'by-team' },
  sessionMember: { name: 'sessionmember', byUser: 'by-user', bySession: 'by-session' },
  vote: { name: 'vote', byRound: 'by-round' },
} as const;

/** Stored in place of null for index attributes, which must be strings. */
export const NONE = '-';

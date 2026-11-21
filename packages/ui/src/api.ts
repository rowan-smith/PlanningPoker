import type {
  ErrorCode,
  ResolverKey,
  ResolverPayload,
  ResolverResult,
  ResolverValue,
} from '@planning-poker/contracts';

/**
 * What the UI needs from a backend. The Forge app implements it with `@forge/bridge`; the local
 * preview runs the same handlers in the browser against in-memory adapters.
 */
export interface PlanningPokerApi {
  call<K extends ResolverKey>(key: K, payload: ResolverPayload<K>): Promise<ResolverValue<K>>;
}

/** A failure the backend reported with a safe, user-facing message. */
export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export function unwrap<T>(result: ResolverResult<T>): T {
  if (!result.ok) {
    throw new ApiError(result.error.code, result.error.message);
  }

  return result.value;
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}

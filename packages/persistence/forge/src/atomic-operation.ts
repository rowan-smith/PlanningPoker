import type { AtomicOperation } from '@planning-poker/application';
import { ConcurrencyConflict } from '@planning-poker/application';

const DEFAULT_MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 15;
const BACKOFF_FACTOR = 2;

export type Delay = (milliseconds: number) => Promise<void>;

/** No platform timer here (the package has no Node or DOM types); the app injects one. */
const noDelay: Delay = () => Promise.resolve();

/**
 * Forge functions share no memory, so there is no lock to take. Safety comes from conditional
 * (versioned) writes in the repositories; this re-runs the whole read-modify-write when one of
 * them reports a conflict, after a short randomized backoff so callers that collided do not
 * collide again. When attempts run out the conflict reaches the resolver, which reports it as
 * CONFLICT ("try again").
 */
export class ForgeAtomicOperation implements AtomicOperation {
  private readonly maxAttempts: number;
  private readonly delay: Delay;
  private readonly random: () => number;

  constructor(
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    delay: Delay = noDelay,
    random: () => number = Math.random,
  ) {
    this.maxAttempts = maxAttempts;
    this.delay = delay;
    this.random = random;
  }

  async run<T>(_key: string, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error: unknown) {
        if (!(error instanceof ConcurrencyConflict) || attempt >= this.maxAttempts) {
          throw error;
        }

        // Full jitter: 0 … base·2^(attempt−1) ms.
        await this.delay(
          Math.floor(this.random() * BASE_DELAY_MS * BACKOFF_FACTOR ** (attempt - 1)),
        );
      }
    }
  }
}

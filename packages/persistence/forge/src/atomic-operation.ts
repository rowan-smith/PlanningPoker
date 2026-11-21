import type { AtomicOperation } from '@planning-poker/application';
import { ConcurrencyConflict } from '@planning-poker/application';

const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Forge functions share no memory, so there is no lock to take. Safety comes from conditional
 * (versioned) writes in the repositories; this re-runs the whole read-modify-write when one of
 * them reports a conflict.
 */
export class ForgeAtomicOperation implements AtomicOperation {
  private readonly maxAttempts: number;

  constructor(maxAttempts = DEFAULT_MAX_ATTEMPTS) {
    this.maxAttempts = maxAttempts;
  }

  async run<T>(_key: string, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error: unknown) {
        if (!(error instanceof ConcurrencyConflict) || attempt >= this.maxAttempts) {
          throw error;
        }
      }
    }
  }
}

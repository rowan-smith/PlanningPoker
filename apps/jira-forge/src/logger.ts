export interface Logger {
  error(message: string, error?: unknown): void;
}

/** Logs only an error's name and message: provider errors may embed request details. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
}

/** Forge captures console output in `forge logs`. This is the project's only console use. */
export const consoleLogger: Logger = {
  error(message, error) {
    // eslint-disable-next-line no-console -- the logger is the single sanctioned console sink.
    console.error(error === undefined ? message : `${message}: ${describe(error)}`);
  },
};

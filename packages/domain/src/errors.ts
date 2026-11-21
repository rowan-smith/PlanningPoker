export type DomainErrorCode =
  'VALIDATION' | 'INVALID_STATE' | 'NOT_ELIGIBLE' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function ensure(
  condition: boolean,
  code: DomainErrorCode,
  message: string,
): asserts condition {
  if (!condition) {
    throw new DomainError(code, message);
  }
}
